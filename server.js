require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const path = require("path");
const connectDB = require("./config/db");

const adminRoutes = require("./routes/adminRoutes");
const employeeRoutes = require("./routes/employeeRoutes");

const app = express();

connectDB();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));



app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// Employee dashboard sits at "/" (root)
app.use("/", employeeRoutes);

// Admin panel sits at "/admin/..."
app.use("/admin", adminRoutes);

// Auto-delete magazines delivered more than 15 days ago (on start, then every 6 hours).
const { deleteOldDelivered } = require("./jobs/trackingRefresh");
const runCleanup = () => deleteOldDelivered().catch((e) => console.error("[Cleanup] failed:", e.message));
setTimeout(runCleanup, 10 * 1000);
setInterval(runCleanup, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running:`);
  console.log(`   Employee Dashboard -> http://localhost:${PORT}/`);
  console.log(`   Admin Login        -> http://localhost:${PORT}/admin/login`);
});
