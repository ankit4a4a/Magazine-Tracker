const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Magazine = require("../models/Magazine");
const User = require("../models/User");
const { requireUser } = require("../middleware/auth");
const { triggerAdminOpenTrackingRefresh } = require("../jobs/trackingRefresh");

/* ---------------- USER LOGIN ---------------- */
router.get("/login", (req, res) => {
  if (req.session.isUser) return res.redirect("/");
  res.render("employee/login", { error: null });
});



router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  try {
    const user = await User.findOne({ phone: (phone || "").trim() });
    if (!user) {
      return res.render("employee/login", { error: "Invalid phone number or password" });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.render("employee/login", { error: "Invalid phone number or password" });
    }
    req.session.isUser = true;
    req.session.userId = user._id.toString();
    req.session.userName = user.name;
    res.redirect("/");
  } catch (err) {
    res.render("employee/login", { error: "Something went wrong. Try again." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

/* ---------------- EMPLOYEE DASHBOARD (root "/") — own clients only ---------------- */
router.get("/", requireUser, async (req, res) => {
  // Same daily auto-refresh job the admin dashboard triggers, so tracking
  // stays up to date even on days the admin never logs in.
  triggerAdminOpenTrackingRefresh();

  const q = (req.query.q || "").trim();
  const filter = req.query.filter || "all"; // all | printed | not-printed

  let query = { userId: req.session.userId };
  if (filter === "printed") query.status = "Printed";
  if (filter === "not-printed") query.status = "In Progress";

  if (q) {
    query.$or = [{ clientName: new RegExp(q, "i") }, { clientMobile: new RegExp(q, "i") }];
  }

  const magazines = await Magazine.find(query).sort({ createdAt: -1 });

  res.render("employee/index", { magazines, q, filter, userName: req.session.userName });
});

/* ---------------- VIEW SINGLE CLIENT DETAIL — own clients only ---------------- */
router.get("/view/:id", requireUser, async (req, res) => {
  const magazine = await Magazine.findById(req.params.id);
  // Guard: a user cannot open another user's client by guessing the URL.
  if (!magazine || !magazine.userId || magazine.userId.toString() !== req.session.userId) {
    return res.redirect("/");
  }
  res.render("employee/detail", { magazine, userName: req.session.userName });
});

/* ---------------- MARK AS DELIVERED (manual, employee-only) ----------------
   Used when TrackCourier/17TRACK can't find details, or the tracking status
   is stuck, but the employee has checked India Post directly (or otherwise
   confirmed with the client) and knows the parcel has actually arrived. This
   is a manual, human confirmation — never done automatically by the system. */
router.post("/mark-delivered/:id", requireUser, async (req, res) => {
  const magazine = await Magazine.findById(req.params.id);
  // Guard: a user cannot mark another user's client as delivered.
  if (!magazine || !magazine.userId || magazine.userId.toString() !== req.session.userId) {
    return res.redirect("/");
  }

  magazine.finalStatus = "Delivered";
  const prev = magazine.currentStatus?.toObject?.() || magazine.currentStatus || {};
  magazine.currentStatus = {
    ...prev,
    summary: "Delivered (confirmed manually)",
    statusCode: "Delivered",
    stage: 4,
    stageLabels: prev.stageLabels && prev.stageLabels.length ? prev.stageLabels : ["Booked", "Dispatched", "In Transit", "Out for Delivery", "Delivered"],
    manuallyConfirmed: true,
    lastFetchedAt: new Date(),
  };
  await magazine.save();

  res.redirect(`/view/${magazine._id}`);
});

module.exports = router;
