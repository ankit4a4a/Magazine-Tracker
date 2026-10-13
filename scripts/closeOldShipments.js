// One-time cleanup: mark old shipments as Delivered.
//
//   npm run close-old              -> DRY RUN (only shows how many would change)
//   npm run close-old:apply        -> actually updates them
//
// Options (after --):   --days=10   --all
//   --days=N  entries created more than N days ago (default 10)
//   --all     also include "In Progress" (not printed) entries.
//             Default = only "Printed" entries.
//
// Run from your PC (Git Bash) - it uses MONGO_URI from your local .env.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Magazine = require("../models/Magazine");




const args = process.argv.slice(2);
const apply = args.includes("--apply");
const includeAll = args.includes("--all");
const daysArg = args.find((a) => a.startsWith("--days="));
const days = daysArg ? Number(daysArg.split("=")[1]) : 10;

(async () => {
  if (!Number.isFinite(days) || days < 0) {
    console.error("Invalid --days value.");
    process.exit(1);
  }

  await connectDB();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const filter = {
    createdAt: { $lt: cutoff },
    finalStatus: { $ne: "Delivered" },
    ...(includeAll ? {} : { status: "Printed" }),
  };

  const count = await Magazine.countDocuments(filter);
  console.log(`Found ${count} entr${count === 1 ? "y" : "ies"} older than ${days} days that are not Delivered${includeAll ? "" : " (Printed only)"}.`);

  if (!count) {
    await mongoose.disconnect();
    return;
  }

  if (!apply) {
    console.log("DRY RUN - nothing changed. Run 'npm run close-old:apply' to mark them Delivered.");
    await mongoose.disconnect();
    return;
  }

  const stageLabels = ["Booked", "Dispatched", "In Transit", "Out for Delivery", "Delivered"];
  const result = await Magazine.updateMany(filter, {
    $set: {
      finalStatus: "Delivered",
      "currentStatus.summary": `Delivered (auto-closed: older than ${days} days)`,
      "currentStatus.statusCode": "Delivered",
      "currentStatus.stage": 4,
      "currentStatus.stageLabels": stageLabels,
      "currentStatus.manuallyConfirmed": true,
      "currentStatus.lastFetchedAt": new Date(),
    },
  });

  console.log(`✅ Marked ${result.modifiedCount} entr${result.modifiedCount === 1 ? "y" : "ies"} as Delivered.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
