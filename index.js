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

const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  credentials: true,
  optionSuccessStatus: 200,
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

    // user
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // User creation + update
    app.post("/user/onboard", async (req, res) => {
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

    // delete user
    app.delete("/delete-user/:id", async (req, res) => {
      const { id } = req.params;
      const filter = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(filter);
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

// const express = require("express");
// const cors = require("cors");
// const connectDB = require("./config/db");

// const app = express();

// // Middleware
// app.use(cors());
// app.use(express.json());

// // Connect to DB
// let db;
// connectDB().then((database) => {
//   db = database;
// });

// // Routes
// app.get("/", (req, res) => {
//   res.send("Server is running");
// });

// // user
// app.get("/users", async (req, res) => {
//   try {
//     const users = await db.collection("users").find({}).toArray();
//     res.json(users);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/user")

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
