// Email delivery via Resend (https://resend.com)
// Required env:
//   RESEND_API_KEY  - API key from the Resend dashboard
//   RESEND_FROM     - verified sender, e.g. "ImplantConnect Dashboard <no-reply@yourdomain.com>"
// Optional env:
//   APP_URL         - dashboard URL used as the "continue" link after a password reset
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM =
  process.env.RESEND_FROM || "ImplantConnect Dashboard <onboarding@resend.dev>";

const APP_URL =
  process.env.APP_URL || "https://dental-implant-machine-5977.vercel.app";

const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const layout = (title, body) => `
<div style="background:#EEF1F3;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
    <h2 style="margin:0 0 16px;font-size:20px;color:#111827">${title}</h2>
    ${body}
    <p style="margin-top:32px;font-size:12px;color:#6B7280">
      ImplantConnect Dashboard · This is an automated message, please do not reply.
    </p>
  </div>
</div>`;

const button = (href, label) => `
<p style="margin:24px 0">
  <a href="${href}" style="background:#247CFF;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;display:inline-block;font-weight:bold">${label}</a>
</p>
<p style="font-size:12px;color:#6B7280;word-break:break-all">If the button doesn't work, copy this link into your browser:<br/>${href}</p>`;

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured on the server");
  }
  const { data, error } = await resend.emails.send({
    from: FROM,
    to,
    subject,
    html,
  });
  if (error) {
    throw new Error(error.message || "Resend failed to send the email");
  }
  return data;
}

const sendWelcomeEmail = (email, name, tempPassword, resetLink) =>
  sendEmail({
    to: email,
    subject: "Welcome to ImplantConnect Dashboard!",
    html: layout(
      "Welcome to ImplantConnect Dashboard!",
      `<p>Hello ${escapeHtml(name)},</p>
       <p>Your account has been created.</p>
       <p>Temporary password: <b>${escapeHtml(tempPassword)}</b></p>
       <p>Please set your own password before you start using the dashboard.</p>
       ${button(resetLink, "Set my password")}`,
    ),
  });

const sendPasswordResetEmail = (email, name, resetLink) =>
  sendEmail({
    to: email,
    subject: "Reset your ImplantConnect Dashboard password",
    html: layout(
      "Password reset request",
      `<p>Hello ${escapeHtml(name || "")},</p>
       <p>We received a request to reset the password for your account. Click the button below to choose a new password.</p>
       ${button(resetLink, "Reset password")}
       <p style="font-size:13px;color:#4B5563">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
    ),
  });

const sendAdminTempPasswordEmail = (email, name, tempPassword, resetLink) =>
  sendEmail({
    to: email,
    subject: "Your ImplantConnect Dashboard password was reset",
    html: layout(
      "Your password was reset",
      `<p>Hello ${escapeHtml(name || "")},</p>
       <p>An administrator reset the password for your account.</p>
       <p>Temporary password: <b>${escapeHtml(tempPassword)}</b></p>
       <p>Please log in and change it right away, or set a new one now:</p>
       ${button(resetLink, "Set a new password")}`,
    ),
  });

module.exports = {
  APP_URL,
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendAdminTempPasswordEmail,
};
