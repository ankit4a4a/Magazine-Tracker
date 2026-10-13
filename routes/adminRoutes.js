const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Admin = require("../models/Admin");
const Magazine = require("../models/Magazine");
const User = require("../models/User");
const { requireAdmin } = require("../middleware/auth");
const { fetchTrackingStatus, getTrackCourierUsage, getSeventeenTrackUsage } = require("../utils/trackingService");
const { triggerAdminOpenTrackingRefresh } = require("../jobs/trackingRefresh");

// Builds a wa.me link so the admin can send login credentials straight to
// the user's WhatsApp. Assumes India (+91) when a bare 10-digit number is
// given, since that's how phone numbers are entered in this app.
function buildWhatsAppLink(req, name, phone, password) {
  let digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  else if (digits.length === 11 && digits.startsWith("0")) digits = "91" + digits.slice(1);



  
  const loginUrl = `${req.protocol}://${req.get("host")}/login`;
  const message =
    `Hi ${name}, here are your Magazine Tracker login credentials:\n` +
    `Phone: ${phone}\n` +
    `Password: ${password}\n` +
    `Login here: ${loginUrl}`;

  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/* ---------------- LOGIN ---------------- */
router.get("/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin/dashboard");
  res.render("admin/login", { error: null });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const admin = await Admin.findOne({ username });
    if (!admin) {
      return res.render("admin/login", { error: "Invalid username or password" });
    }
    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) {
      return res.render("admin/login", { error: "Invalid username or password" });
    }
    req.session.isAdmin = true;
    req.session.adminUsername = admin.username;
    res.redirect("/admin/dashboard");
  } catch (err) {
    res.render("admin/login", { error: "Something went wrong. Try again." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

/* ---------------- DASHBOARD (home) ---------------- */
router.get("/dashboard", requireAdmin, async (req, res) => {
  // Refresh pending shipments once per India calendar day whenever the admin
  // dashboard is opened. The job runs in the background.
  triggerAdminOpenTrackingRefresh();

  const total = await Magazine.countDocuments();
  const printed = await Magazine.countDocuments({ status: "Printed" });
  const inProgress = await Magazine.countDocuments({ status: "In Progress" });
  const delivered = await Magazine.countDocuments({ finalStatus: "Delivered" });

  res.render("admin/dashboard", {
    adminUsername: req.session.adminUsername,
    stats: { total, printed, inProgress, delivered },
  });
});

/* ---------------- LIVE TRACKING PREVIEW (called via AJAX from Add/Edit form) ---------------- */
router.get("/api/track/:trackingNumber", requireAdmin, async (req, res) => {
  // Prevent the browser (or any proxy in between) from caching this GET
  // response — otherwise clicking "Fetch Details" again for the same
  // tracking number can silently return the old cached result instead of
  // hitting the tracking provider for real.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const result = await fetchTrackingStatus(req.params.trackingNumber);
  res.json(result);
});

/* ---------------- TRACKING API KEY USAGE (TrackCourier + 17TRACK) ---------------- */
async function buildTrackingUsageKeys() {
  const [trackCourierKeys, seventeenTrackKeys] = await Promise.all([
    getTrackCourierUsage(),
    getSeventeenTrackUsage(),
  ]);

  const label = (provider, keyId) => {
    if (/legacy$/i.test(keyId)) return `${provider} · Primary key`;
    const num = (keyId.match(/(\d+)$/) || [])[1];
    return num ? `${provider} · Key ${num}` : `${provider} · ${keyId}`;
  };

  return [
    ...trackCourierKeys.map((k) => ({ ...k, provider: "TrackCourier", label: label("TrackCourier", k.keyId) })),
    ...seventeenTrackKeys.map((k) => ({ ...k, provider: "17TRACK", label: label("17TRACK", k.keyId) })),
  ];
}

router.get("/api/tracking-usage", requireAdmin, async (req, res) => {
  const keys = await buildTrackingUsageKeys();
  res.json({ keys, total: keys.length });
});

router.get("/tracking-usage", requireAdmin, async (req, res) => {
  const keys = await buildTrackingUsageKeys();
  res.render("admin/trackingUsage", { adminUsername: req.session.adminUsername, keys });
});

/* ---------------- USERS (employees who can log in and see their own clients) ---------------- */
router.get("/users", requireAdmin, async (req, res) => {
  const users = await User.find().sort({ name: 1 });
  res.render("admin/users", { adminUsername: req.session.adminUsername, users, error: null });
});

router.get("/users/add", requireAdmin, (req, res) => {
  res.render("admin/userAdd", { adminUsername: req.session.adminUsername, error: null });
});

router.post("/users/add", requireAdmin, async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const existing = await User.findOne({ phone: (phone || "").trim() });
    if (existing) {
      return res.render("admin/userAdd", {
        adminUsername: req.session.adminUsername,
        error: "A user with this phone number already exists.",
      });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ name, phone: (phone || "").trim(), passwordHash });

    const waLink = buildWhatsAppLink(req, name, (phone || "").trim(), password);
    res.render("admin/userCredentialsShare", {
      adminUsername: req.session.adminUsername,
      name,
      phone: (phone || "").trim(),
      password,
      waLink,
    });
  } catch (err) {
    res.render("admin/userAdd", {
      adminUsername: req.session.adminUsername,
      error: "Failed to add user: " + err.message,
    });
  }
});

router.get("/users/edit/:id", requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.redirect("/admin/users");
  res.render("admin/userEdit", { adminUsername: req.session.adminUsername, user, error: null });
});

router.post("/users/edit/:id", requireAdmin, async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect("/admin/users");

    const duplicate = await User.findOne({ phone: (phone || "").trim(), _id: { $ne: user._id } });
    if (duplicate) {
      return res.render("admin/userEdit", {
        adminUsername: req.session.adminUsername,
        user,
        error: "A user with this phone number already exists.",
      });
    }

    user.name = name;
    user.phone = (phone || "").trim();
    const passwordChanged = !!(password && password.trim());
    if (passwordChanged) {
      user.passwordHash = await bcrypt.hash(password, 10);
    }
    await user.save();

    // Keep the display name in sync on any magazines already linked to this user.
    await Magazine.updateMany({ userId: user._id }, { $set: { employeeName: user.name } });

    if (passwordChanged) {
      const waLink = buildWhatsAppLink(req, user.name, user.phone, password);
      return res.render("admin/userCredentialsShare", {
        adminUsername: req.session.adminUsername,
        name: user.name,
        phone: user.phone,
        password,
        waLink,
      });
    }

    res.redirect("/admin/users");
  } catch (err) {
    const user = await User.findById(req.params.id);
    res.render("admin/userEdit", {
      adminUsername: req.session.adminUsername,
      user,
      error: "Failed to update user: " + err.message,
    });
  }
});

router.post("/users/delete/:id", requireAdmin, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.redirect("/admin/users");
});

/* ---------------- ADD MAGAZINE ---------------- */
router.get("/add", requireAdmin, async (req, res) => {
  const users = await User.find().sort({ name: 1 });
  res.render("admin/add", { adminUsername: req.session.adminUsername, users, error: null });
});

router.post("/add", requireAdmin, async (req, res) => {
  try {
    const { employeeId, clientName, clientMobile, volumeNo, slotNo, status, trackingNumber, fetchedStatusJson } =
      req.body;

    const employee = await User.findById(employeeId);
    if (!employee) {
      const users = await User.find().sort({ name: 1 });
      return res.render("admin/add", {
        adminUsername: req.session.adminUsername,
        users,
        error: "Please select a valid employee (add one under Users first).",
      });
    }

    const magazine = new Magazine({
      employeeName: employee.name,
      userId: employee._id,
      clientName,
      clientMobile,
      volumeNo,
      slotNo,
      status,
      trackingNumber: status === "Printed" ? trackingNumber : "",
    });

    if (status === "Printed" && trackingNumber) {
      let result;
      // If the admin already used "Fetch Details" on the form, reuse that
      // result instead of calling the tracking API again (saves quota).
      if (fetchedStatusJson) {
        try {
          result = JSON.parse(fetchedStatusJson);
        } catch (e) {
          result = null;
        }
      }
      // Fallback: not fetched on the form yet -> fetch now
      if (!result) {
        result = await fetchTrackingStatus(trackingNumber);
      }
      magazine.currentStatus = result;
      if (result.summary && /delivered/i.test(result.summary)) {
        magazine.finalStatus = "Delivered";
      }
    }

    await magazine.save();
    res.redirect("/admin/list/all");
  } catch (err) {
    const users = await User.find().sort({ name: 1 });
    res.render("admin/add", {
      adminUsername: req.session.adminUsername,
      users,
      error: "Failed to save entry: " + err.message,
    });
  }
});

/* ---------------- LIST (All / Printed / Not Printed) ---------------- */
// filterType = all | printed | not-printed
router.get("/list/:filterType", requireAdmin, async (req, res) => {
  const { filterType } = req.params;
  const q = (req.query.q || "").trim();

  let query = {};
  if (filterType === "printed") query.status = "Printed";
  if (filterType === "not-printed") query.status = "In Progress";

  if (q) {
    query.$or = [
      { clientName: new RegExp(q, "i") },
      { clientMobile: new RegExp(q, "i") },
      { employeeName: new RegExp(q, "i") },
    ];
  }

  const magazines = await Magazine.find(query).sort({ createdAt: -1 });

  res.render("admin/list", {
    adminUsername: req.session.adminUsername,
    magazines,
    filterType,
    q,
  });
});

/* ---------------- EDIT ---------------- */
router.get("/view/:id", requireAdmin, async (req, res) => {
  const magazine = await Magazine.findById(req.params.id);
  if (!magazine) return res.redirect("/admin/list/all");
  res.render("admin/view", { adminUsername: req.session.adminUsername, magazine });
});

router.get("/edit/:id", requireAdmin, async (req, res) => {
  const magazine = await Magazine.findById(req.params.id);
  if (!magazine) return res.redirect("/admin/list/all");
  const users = await User.find().sort({ name: 1 });
  res.render("admin/edit", { adminUsername: req.session.adminUsername, magazine, users, error: null });
});

router.post("/edit/:id", requireAdmin, async (req, res) => {
  try {
    const { employeeId, clientName, clientMobile, volumeNo, slotNo, status, trackingNumber, finalStatus, fetchedStatusJson } =
      req.body;

    const magazine = await Magazine.findById(req.params.id);
    if (!magazine) return res.redirect("/admin/list/all");

    const employee = await User.findById(employeeId);
    if (!employee) {
      const users = await User.find().sort({ name: 1 });
      return res.render("admin/edit", {
        adminUsername: req.session.adminUsername,
        magazine,
        users,
        error: "Please select a valid employee (add one under Users first).",
      });
    }

    // BUG FIX: previously this only re-fetched tracking when the tracking
    // number was DIFFERENT from what was already saved, so re-entering the
    // same number (e.g. to check if a shipment has since been delivered)
    // kept showing the old cached result. Now we always fetch a fresh
    // status on save whenever the shipment is Printed + has a tracking
    // number, UNLESS it's already marked Delivered with the same tracking
    // number (nothing left to update, so no need to burn API quota).
    const sameTrackingAlreadyDelivered =
      magazine.finalStatus === "Delivered" && trackingNumber === magazine.trackingNumber;
    const shouldFetchTracking = status === "Printed" && trackingNumber && !sameTrackingAlreadyDelivered;

    magazine.employeeName = employee.name;
    magazine.userId = employee._id;
    magazine.clientName = clientName;
    magazine.clientMobile = clientMobile;
    magazine.volumeNo = volumeNo;
    magazine.slotNo = slotNo;
    magazine.status = status;
    magazine.trackingNumber = status === "Printed" ? trackingNumber : "";
    magazine.finalStatus = finalStatus || magazine.finalStatus;

    if (shouldFetchTracking) {
      let result;
      // Reuse the AJAX "Fetch Details" preview only if it was fetched for
      // THIS exact tracking number in this same request — otherwise it's
      // stale and we fetch fresh from the API.
      if (fetchedStatusJson) {
        try {
          const parsed = JSON.parse(fetchedStatusJson);
          if (parsed && parsed.trackingNumber === trackingNumber) {
            result = parsed;
          }
        } catch (e) {
          result = null;
        }
      }
      if (!result) {
        result = await fetchTrackingStatus(trackingNumber, magazine.currentStatus);
      }
      magazine.currentStatus = result;
      magazine.finalStatus =
        result.summary && /delivered/i.test(result.summary) ? "Delivered" : (finalStatus || magazine.finalStatus);
    }

    await magazine.save();
    res.redirect("/admin/list/all");
  } catch (err) {
    const magazine = await Magazine.findById(req.params.id);
    const users = await User.find().sort({ name: 1 });
    res.render("admin/edit", {
      adminUsername: req.session.adminUsername,
      magazine,
      users,
      error: "Failed to update: " + err.message,
    });
  }
});

/* ---------------- REFRESH TRACKING (re-fetch from India Post) ---------------- */
router.post("/refresh/:id", requireAdmin, async (req, res) => {
  const magazine = await Magazine.findById(req.params.id);
  if (magazine && magazine.trackingNumber) {
    const result = await fetchTrackingStatus(magazine.trackingNumber, magazine.currentStatus);
    magazine.currentStatus = result;
    if (result.summary && /delivered/i.test(result.summary)) {
      magazine.finalStatus = "Delivered";
    }
    await magazine.save();
  }
  res.redirect("back");
});

/* ---------------- DELETE ---------------- */
router.post("/delete/:id", requireAdmin, async (req, res) => {
  await Magazine.findByIdAndDelete(req.params.id);
  res.redirect("back");
});

module.exports = router;
