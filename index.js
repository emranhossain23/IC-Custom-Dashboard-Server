const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://dental-implant-machine-5977.vercel.app",
    "https://dental-implant-machine-server-cgfs.vercel.app",
  ],
  credentials: true,
  optionSuccessStatus: 200,
};

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
};

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

//middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wezoknx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("DentalImplant");
    const usersCollection = db.collection("users");
    const rolesCollection = db.collection("roles");
    const clinicCollection = db.collection("clinics");
    const urlReportCollection = db.collection("urlReport");

    // verification
    const verifyToken = async (req, res, next) => {
      const token = req.cookies?.token;
      // console.log(token)

      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          console.log(err);
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.user = decoded;
        // console.log('in verify',req.user);
        next();
      });
    };

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.user.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isAdmin = user?.role === "Admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // creating Token
    app.post("/jwt", async (req, res) => {
      const user = req.body;

      const token = jwt.sign(
        { email: user.email },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "1h" }
      );

      res.cookie("token", token, cookieOptions).send({ success: true, token });
    });

    // clear cookie
    app.post("/logout", async (req, res) => {
      res.clearCookie("token", cookieOptions).send({ success: true });
    });

    // -------- user -------
    // users
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      //   const { searchText } = req.query;
      //   const regex = new RegExp(searchText, "i");

      //   const query = {
      //     $or: [{ name: regex }, { email: regex }, { role: regex }],
      //   };

      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // single user
    app.get("/user/:email", async (req, res) => {
      const { email } = req.params;
      const result = await usersCollection.findOne({ email: email });
      res.send(result);
    });

    // User creation + update
    app.post("/user/onboard", verifyToken, verifyAdmin, async (req, res) => {
      const formData = req.body;
      const { email, name } = formData;
      const query = { email: email };

      try {
        const findUser = await usersCollection.findOne(query);

        if (!findUser) {
          const tempPassword = Math.random().toString(36).slice(-10) + "A1#";

          const user = await admin.auth().createUser({
            email,
            password: tempPassword,
            displayName: name,
          });

          const resetLink = await admin
            .auth()
            .generatePasswordResetLink(email, {
              url: "https://dental-implant-machine-5977.vercel.app",
            });

          await sendWelcomeEmail(email, name, tempPassword, resetLink);

          const db_user = await usersCollection.insertOne({
            ...formData,
            createdAt: Date.now(),
          });

          return res.json({ success: true, user, resetLink, db_user });
        } else {
          const updateDoc = {
            $set: { ...formData, updateAt: Date.now() },
          };
          const result = await usersCollection.updateOne(query, updateDoc);
          res.json({ success: true, updated: true, result });
        }
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // send mail
    const sendWelcomeEmail = async (email, name, tempPassword, resetLink) => {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const mailOptions = {
        from: '"DIM Dashboard" <no-reply@dim.com>',
        to: email,
        subject: "Welcome to DIM Dashboard!",
        html: `
      <h3>Welcome to DIM Dashboard!</h3>
      <p>Hello ${name}!</p>
      <p>Your account has been successfully created.</p>
      <p>🔐 Temporary Password: <b>${tempPassword}</b></p>
      <p>⚠️ You must change your password immediately after first login.</p>
      <p>Reset your password here: <a href="${resetLink}">Change Password</a></p>
    `,
      };

      await transporter.sendMail(mailOptions);
    };

    // update user
    app.patch("/update-user", verifyToken, verifyAdmin, async (req, res) => {
      const { email, selectedClients } = req.body;
      const filter = { email: email };
      const updateDoc = {
        $set: {
          selectedClients: selectedClients,
        },
      };

      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // delete user
    app.delete(
      "/delete-user/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { email } = req.body;
        const filter = { _id: new ObjectId(id) };

        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().deleteUser(user.uid);

        const result = await usersCollection.deleteOne(filter);
        res.send(result);
      }
    );

    // remove user client
    app.delete("/remove-client", verifyToken, verifyAdmin, async (req, res) => {
      const { id, user_id } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(user_id) },
        { $pull: { selectedClients: { id: id } } }
      );
      res.send(result);
    });

    // roles
    app.get("/roles", verifyToken, verifyAdmin, async (req, res) => {
      const result = await rolesCollection.find().toArray();
      res.send(result);
    });

    app.patch("/create-role", verifyToken, verifyAdmin, async (req, res) => {
      const info = req.body;
      const { id } = req.query;

      const query =
        id && id !== "undefined"
          ? { _id: new ObjectId(id) }
          : { name: info.name };

      delete info?._id;

      const doc = { $set: { ...info, createdAt: new Date() } };
      const option = { upsert: true };

      const result = await rolesCollection.updateOne(query, doc, option);
      res.send(result);
    });

    // delete role
    app.delete(
      "/delete-role/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const result = await rolesCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      }
    );

    // get clinics
    app.get("/clinics", verifyToken, verifyAdmin, async (req, res) => {
      const result = await clinicCollection.find().toArray();
      res.send(result);
    });

    // add clinic
    app.patch("/add-clinic", verifyToken, verifyAdmin, async (req, res) => {
      const info = req.body;
      const { id } = req.query;

      const query =
        id && id !== "undefined"
          ? { _id: new ObjectId(id) }
          : { email: info.email };

      delete info?._id;

      const doc = { $set: { ...info, createdAt: new Date() } };
      const option = { upsert: true };

      const result = await clinicCollection.updateOne(query, doc, option);
      res.send(result);
    });

    // delete clinic
    app.delete(
      "/delete-clinic/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };

        const result = await clinicCollection.deleteOne(filter);
        res.send(result);
      }
    );

    // get report url
    app.get("/all-url", verifyToken, verifyAdmin, async (req, res) => {
      const result = await urlReportCollection.find().toArray();
      res.send(result);
    });

    // add report url
    app.patch("/add-url", verifyToken, verifyAdmin, async (req, res) => {
      const info = req.body;
      const { id } = req.query;

      const query =
        id && id !== "undefined"
          ? { _id: new ObjectId(id) }
          : { email: info.email };

      delete info?._id;

      const doc = { $set: { ...info, createdAt: new Date() } };
      const option = { upsert: true };

      const result = await urlReportCollection.updateOne(query, doc, option);
      res.send(result);
    });

    // delete report url
    app.delete(
      "/delete-url/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };

        const result = await urlReportCollection.deleteOne(filter);
        res.send(result);
      }
    );

    // PATCH single clinic
    // app.patch("/clinics/:id", async (req, res) => {
    //   try {
    //     const id = req.params.id;
    //     const { selected } = req.body;

    //     const result = await clinicCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { selected } }
    //     );

    //     if (result.modifiedCount === 0)
    //       return res.status(404).json({ message: "Clinic not found" });

    //     res.json({ message: "Clinic updated successfully" });
    //   } catch (err) {
    //     console.error(err);
    //     res.status(500).json({ error: "Internal Server Error" });
    //   }
    // });

    // PATCH clinics select-all
    // app.patch("/clinics/select-all", async (req, res) => {
    //   try {
    //     const { selected } = req.body;

    //     const result = await clinicCollection.updateMany(
    //       {},
    //       { $set: { selected } }
    //     );

    //     res.json({
    //       message: selected ? "All clinics selected" : "All clinics deselected",
    //       modifiedCount: result.modifiedCount,
    //     });
    //   } catch (err) {
    //     console.error(err);
    //     res.status(500).json({ error: "Internal Server Error" });
    //   }
    // });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Alive Dental implant machine website serve");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
