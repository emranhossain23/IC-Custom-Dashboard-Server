// Call Report + Appointment Report endpoints, filterable by setter / staff.
//
// How a staff member is matched to GHL activity, per assigned clinic:
//   1. user.ghl_user_id (comma separated if they have several), if set
//   2. otherwise the userID stored on their clinic assignment
//   3. otherwise the clinic's own userID (the clinic's setter)
const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { ObjectId } = require("mongodb");

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TZ = "America/Denver";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pct = (num, den) => (den ? Number(((num / den) * 100).toFixed(2)) : 0);

const splitIds = (value) =>
  String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const tzOf = (clinic) => clinic?.timezone || DEFAULT_TZ;

function parseRange(req, res) {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "") || from > to) {
    res.status(400).send({ message: "from and to must be YYYY-MM-DD, from <= to" });
    return null;
  }
  const days = dayjs(to).diff(dayjs(from), "day") + 1;
  return { from, to, days };
}

function eachDate(from, to) {
  const out = [];
  let d = dayjs(from);
  const end = dayjs(to);
  while (!d.isAfter(end)) {
    out.push(d.format("YYYY-MM-DD"));
    d = d.add(1, "day");
  }
  return out;
}

module.exports = function registerReportRoutes({
  app,
  verifyToken,
  usersCollection,
  clinicCollection,
  messagesCollection,
}) {
  // Staff = every user that has at least one clinic assigned
  async function loadStaff() {
    const users = await usersCollection
      .find(
        { "selectedClients.0": { $exists: true } },
        {
          projection: {
            name: 1,
            email: 1,
            role: 1,
            ghl_user_id: 1,
            selectedClients: 1,
          },
        },
      )
      .sort({ name: 1 })
      .toArray();
    return users;
  }

  // Build [{ staff, clinic, ghlIds:Set }] for the requested staff filter
  async function buildAssignments(staffParam) {
    let staff = await loadStaff();
    if (staffParam && staffParam !== "all") {
      staff = staff.filter((s) => String(s._id) === String(staffParam));
    }

    const clinicIds = [
      ...new Set(
        staff.flatMap((s) => (s.selectedClients || []).map((c) => String(c.id))),
      ),
    ].filter((id) => ObjectId.isValid(id));

    const clinics = clinicIds.length
      ? await clinicCollection
          .find({ _id: { $in: clinicIds.map((id) => new ObjectId(id)) } })
          .toArray()
      : [];
    const clinicMap = new Map(clinics.map((c) => [String(c._id), c]));

    const assignments = [];
    for (const s of staff) {
      const ownIds = splitIds(s.ghl_user_id);
      for (const sc of s.selectedClients || []) {
        const clinic = clinicMap.get(String(sc.id));
        if (!clinic) continue;
        const ids = ownIds.length
          ? ownIds
          : splitIds(sc.userID || clinic.userID);
        assignments.push({ staff: s, clinic, ghlIds: new Set(ids) });
      }
    }
    return { staff, clinics, assignments };
  }

  // ---------------- Staff list (for the filter dropdown) ----------------
  app.get("/reports/staff", verifyToken, async (req, res) => {
    try {
      const staff = await loadStaff();
      res.send(
        staff.map((s) => ({
          _id: s._id,
          name: s.name,
          email: s.email,
          role: s.role,
          clinics: (s.selectedClients || []).map((c) => ({
            id: c.id,
            name: c.name,
          })),
        })),
      );
    } catch (err) {
      console.error("staff list error:", err);
      res.status(500).send({ message: "Failed to load staff" });
    }
  });

  // ---------------- Call Report ----------------
  app.get("/reports/calls", verifyToken, async (req, res) => {
    const range = parseRange(req, res);
    if (!range) return;
    const { from, to, days } = range;

    try {
      const { clinics, assignments } = await buildAssignments(req.query.staff);
      if (!clinics.length) {
        return res.send({ summary: null, rows: [], clinicRows: [], daily: [] });
      }

      const orConditions = clinics.map((clinic) => ({
        clinicId: clinic._id,
        dateAdded: {
          $gte: dayjs.tz(from, tzOf(clinic)).startOf("day").toDate(),
          $lte: dayjs.tz(to, tzOf(clinic)).endOf("day").toDate(),
        },
      }));

      const calls = await messagesCollection
        .find(
          { messageType: "TYPE_CALL", $or: orConditions },
          {
            projection: {
              clinicId: 1,
              contactId: 1,
              direction: 1,
              status: 1,
              userId: 1,
              dateAdded: 1,
              callDuration: 1,
            },
          },
        )
        .toArray();

      const clinicById = new Map(clinics.map((c) => [String(c._id), c]));
      const callsByClinic = new Map();
      for (const call of calls) {
        const key = String(call.clinicId);
        const clinic = clinicById.get(key);
        call._date = dayjs(call.dateAdded).tz(tzOf(clinic)).format("YYYY-MM-DD");
        if (!callsByClinic.has(key)) callsByClinic.set(key, []);
        callsByClinic.get(key).push(call);
      }

      const dates = eachDate(from, to);
      const daily = new Map(
        dates.map((d) => [
          d,
          {
            date: d,
            outbound: 0,
            outboundConnected: 0,
            inboundAnswered: 0,
            clinicInbound: 0,
            clinicMissed: 0,
          },
        ]),
      );

      // staff × clinic rows
      const rows = assignments.map(({ staff, clinic, ghlIds }) => {
        const clinicCalls = callsByClinic.get(String(clinic._id)) || [];
        const mine = clinicCalls.filter((c) => c.userId && ghlIds.has(c.userId));
        const outbound = mine.filter((c) => c.direction === "outbound");
        const outboundConnected = outbound.filter((c) => c.status === "completed");
        const inboundAnswered = mine.filter(
          (c) => c.direction === "inbound" && c.status === "completed",
        );
        const talkSeconds = [...outboundConnected, ...inboundAnswered].reduce(
          (sum, c) => sum + (Number(c.callDuration) || 0),
          0,
        );

        outbound.forEach((c) => daily.get(c._date) && daily.get(c._date).outbound++);
        outboundConnected.forEach(
          (c) => daily.get(c._date) && daily.get(c._date).outboundConnected++,
        );
        inboundAnswered.forEach(
          (c) => daily.get(c._date) && daily.get(c._date).inboundAnswered++,
        );

        const statusBreakdown = {};
        outbound.forEach((c) => {
          const s = c.status || "unknown";
          statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
        });

        return {
          staffId: staff._id,
          staff: staff.name,
          role: staff.role,
          clinicId: clinic._id,
          clinic: clinic.name,
          linkedUserIds: [...ghlIds],
          outbound: outbound.length,
          outboundConnected: outboundConnected.length,
          connectRate: pct(outboundConnected.length, outbound.length),
          outboundPerDay: Number((outbound.length / days).toFixed(2)),
          uniqueContactsDialed: new Set(outbound.map((c) => c.contactId)).size,
          inboundAnswered: inboundAnswered.length,
          totalCalls: outbound.length + inboundAnswered.length,
          talkMinutes: Math.round(talkSeconds / 60),
          statusBreakdown,
        };
      });

      // clinic-level inbound (calls ringing the office, regardless of who answers)
      const clinicRows = clinics.map((clinic) => {
        const clinicCalls = callsByClinic.get(String(clinic._id)) || [];
        const inbound = clinicCalls.filter((c) => c.direction === "inbound");
        const answered = inbound.filter((c) => c.status === "completed");
        inbound.forEach((c) => {
          const d = daily.get(c._date);
          if (!d) return;
          d.clinicInbound++;
          if (c.status !== "completed") d.clinicMissed++;
        });
        const outbound = clinicCalls.filter((c) => c.direction === "outbound");
        return {
          clinicId: clinic._id,
          clinic: clinic.name,
          inbound: inbound.length,
          inboundAnswered: answered.length,
          inboundMissed: inbound.length - answered.length,
          answerRate: pct(answered.length, inbound.length),
          outboundAllUsers: outbound.length,
        };
      });

      const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
      const outboundTotal = sum(rows, "outbound");
      const connectedTotal = sum(rows, "outboundConnected");
      const clinicInbound = sum(clinicRows, "inbound");
      const clinicAnswered = sum(clinicRows, "inboundAnswered");

      res.send({
        days,
        summary: {
          outbound: outboundTotal,
          outboundConnected: connectedTotal,
          connectRate: pct(connectedTotal, outboundTotal),
          outboundPerDay: Number((outboundTotal / days).toFixed(2)),
          inboundAnswered: sum(rows, "inboundAnswered"),
          talkMinutes: sum(rows, "talkMinutes"),
          clinicInbound,
          clinicMissed: clinicInbound - clinicAnswered,
          answerRate: pct(clinicAnswered, clinicInbound),
        },
        rows,
        clinicRows,
        daily: [...daily.values()].reverse(),
      });
    } catch (err) {
      console.error("call report error:", err);
      res.status(500).send({ message: "Call report failed" });
    }
  });

  // ---------------- Appointment Report ----------------
  // Appointments are read live from the GHL calendars API for each clinic's
  // calendarID list, cached for a few minutes to stay within rate limits.
  const eventCache = new Map();
  const CACHE_MS = 5 * 60 * 1000;

  async function fetchCalendarEvents(clinic, calendarId, startMs, endMs) {
    const key = `${clinic._id}|${calendarId}|${startMs}|${endMs}`;
    const hit = eventCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;

    const { data } = await axios.get(
      "https://services.leadconnectorhq.com/calendars/events",
      {
        params: {
          locationId: clinic.location_id,
          calendarId,
          startTime: startMs,
          endTime: endMs,
        },
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${clinic.authorization}`,
          Version: "2021-04-15",
        },
        timeout: 20000,
      },
    );
    const events = data?.events || [];
    eventCache.set(key, { at: Date.now(), events });
    if (eventCache.size > 500) eventCache.delete(eventCache.keys().next().value);
    return events;
  }

  const normaliseStatus = (s) => {
    const v = String(s || "").toLowerCase().replace(/[\s_-]/g, "");
    if (v === "showed" || v === "show") return "showed";
    if (v === "noshow") return "noshow";
    if (v === "cancelled" || v === "canceled") return "cancelled";
    if (v === "confirmed") return "confirmed";
    if (v === "invalid") return "invalid";
    return "new";
  };

  app.get("/reports/appointments", verifyToken, async (req, res) => {
    const range = parseRange(req, res);
    if (!range) return;
    const { from, to } = range;
    const staffParam = req.query.staff || "all";

    try {
      const { clinics, assignments } = await buildAssignments(staffParam);
      if (!clinics.length) {
        return res.send({ summary: null, rows: [], appointments: [], warnings: [] });
      }

      const warnings = [];
      const eventsByClinic = new Map();

      await Promise.all(
        clinics.map(async (clinic) => {
          const tz = tzOf(clinic);
          const startMs = dayjs.tz(from, tz).startOf("day").valueOf();
          const endMs = dayjs.tz(to, tz).endOf("day").valueOf();
          const calendarIds = (clinic.calendarID || []).filter(Boolean);

          if (!calendarIds.length) {
            warnings.push(`${clinic.name}: no Calendar ID configured`);
            eventsByClinic.set(String(clinic._id), []);
            return;
          }
          if (!clinic.location_id || !clinic.authorization) {
            warnings.push(`${clinic.name}: missing location ID or API key`);
            eventsByClinic.set(String(clinic._id), []);
            return;
          }

          const all = [];
          for (const calendarId of calendarIds) {
            try {
              const events = await fetchCalendarEvents(clinic, calendarId, startMs, endMs);
              all.push(...events);
            } catch (err) {
              warnings.push(
                `${clinic.name}: calendar ${calendarId} failed (${err.response?.status || err.message})`,
              );
            }
          }
          // de-dupe (an event can appear in more than one calendar query)
          const seen = new Set();
          eventsByClinic.set(
            String(clinic._id),
            all.filter((e) => (seen.has(e.id) ? false : seen.add(e.id))),
          );
        }),
      );

      const toAppointment = (e, clinic, staffName) => {
        const tz = tzOf(clinic);
        return {
          id: e.id,
          clinic: clinic.name,
          staff: staffName,
          title: e.title || "",
          status: normaliseStatus(e.appointmentStatus),
          rawStatus: e.appointmentStatus,
          start: e.startTime ? dayjs(e.startTime).tz(tz).format("YYYY-MM-DD HH:mm") : "",
          booked: e.dateAdded ? dayjs(e.dateAdded).tz(tz).format("YYYY-MM-DD HH:mm") : "",
          calendarId: e.calendarId,
          contactId: e.contactId,
        };
      };

      const matches = (e, ghlIds) =>
        (e.createdBy?.userId && ghlIds.has(e.createdBy.userId)) ||
        (e.assignedUserId && ghlIds.has(e.assignedUserId));

      const appointments = [];
      const claimed = new Map(); // clinicId -> Set(eventId)

      const summarise = (list) => {
        const c = { total: list.length, new: 0, confirmed: 0, showed: 0, noshow: 0, cancelled: 0, invalid: 0 };
        list.forEach((a) => (c[a.status] = (c[a.status] || 0) + 1));
        return {
          ...c,
          showRate: pct(c.showed, c.showed + c.noshow),
          cancelRate: pct(c.cancelled, c.total),
        };
      };

      const rows = assignments.map(({ staff, clinic, ghlIds }) => {
        const key = String(clinic._id);
        const events = (eventsByClinic.get(key) || []).filter((e) => matches(e, ghlIds));
        if (!claimed.has(key)) claimed.set(key, new Set());
        events.forEach((e) => claimed.get(key).add(e.id));
        const list = events.map((e) => toAppointment(e, clinic, staff.name));
        appointments.push(...list);
        return {
          staffId: staff._id,
          staff: staff.name,
          role: staff.role,
          clinicId: clinic._id,
          clinic: clinic.name,
          ...summarise(list),
        };
      });

      // When viewing everyone, keep clinic totals complete with an "Unattributed" row
      if (staffParam === "all") {
        for (const clinic of clinics) {
          const key = String(clinic._id);
          const taken = claimed.get(key) || new Set();
          const rest = (eventsByClinic.get(key) || []).filter((e) => !taken.has(e.id));
          if (!rest.length) continue;
          const list = rest.map((e) => toAppointment(e, clinic, "Unattributed"));
          appointments.push(...list);
          rows.push({
            staffId: null,
            staff: "Unattributed",
            role: "",
            clinicId: clinic._id,
            clinic: clinic.name,
            ...summarise(list),
          });
        }
      }

      // unique appointments for the summary (one event can match two staff)
      const unique = [...new Map(appointments.map((a) => [a.id, a])).values()];
      appointments.sort((a, b) => (a.start < b.start ? 1 : -1));

      res.send({
        summary: summarise(unique),
        rows,
        appointments,
        warnings,
      });
    } catch (err) {
      console.error("appointment report error:", err);
      res.status(500).send({ message: "Appointment report failed" });
    }
  });
};
