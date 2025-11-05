const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const fs = require("fs");
const nodemailer = require("nodemailer");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    // "https://dental-implant-machine-5977.vercel.app",
  ],
  credentials: true,
  optionSuccessStatus: 200,
};

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
};

// Service account credentials load
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebaseServiceAccount.json", "utf8")
);

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
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
      const email = req.user;
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
      const user = req.body.email;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET);

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
              url: "http://localhost:5173/login",
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
        const filter = { _id: new ObjectId(id) };
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
    app.get("/clinics", async (req, res) => {
      const result = await clinicCollection.find().toArray();
      res.send(result);
    });

    // add clinic
    app.post("/add-clinic", async (req, res) => {
      const info = req.body;
      const result = await clinicCollection.insertOne({
        ...info,
        createdAt: new Date(),
      });
      res.send(result);
    });

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
