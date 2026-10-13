// Re-fetch all CURRENT (not delivered) tracking numbers from Ship24 and
// REPLACE their saved tracking data with Ship24's data.
//
//   npm run resync-ship24            -> DRY RUN (count only, nothing changes)
//   npm run resync-ship24:apply      -> really does it
//
// Options (after --):
//   --limit=N   only process the first N shipments (good for a small test)
//   --force     also redo shipments that are already on Ship24 data
//
// Ship24 ONLY: TrackCourier/17TRACK are never used here. If every Ship24 key
// hits its monthly limit the script stops; run it again next month (or add
// more keys) and it continues with the ones not yet converted.
// Run it from your PC (Git Bash) - it uses MONGO_URI from your local .env.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Magazine = require("../models/Magazine");
const { fetchShip24Status, getShip24KeyCount } = require("../utils/trackingService");




const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

(async () => {
  const keyCount = getShip24KeyCount();
  if (!keyCount) {
    console.error("No Ship24 API key found in .env (SHIP24_API_KEY_1 ...). Add at least one first.");
    process.exit(1);
  }

  await connectDB();

  const filter = {
    status: "Printed",
    finalStatus: { $ne: "Delivered" },
    trackingNumber: { $exists: true, $nin: [null, ""] },
    ...(force ? {} : { "currentStatus.provider": { $ne: "Ship24" } }),
  };

  let query = Magazine.find(filter).sort({ createdAt: -1 });
  if (limit > 0) query = query.limit(limit);
  const items = await query;

  console.log(`Ship24 keys configured: ${keyCount}`);
  console.log(`Shipments to move to Ship24: ${items.length}`);
  console.log(`Note: every NEW shipment uses 1 Ship24 shipment-quota (free plan = 10/month per key, so about ${keyCount * 10} with your keys).`);

  if (!items.length) {
    await mongoose.disconnect();
    return;
  }
  if (!apply) {
    console.log("DRY RUN - nothing changed. Run 'npm run resync-ship24:apply' to do it.");
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let delivered = 0;
  let noData = 0;
  let stoppedAt = -1;

  for (let i = 0; i < items.length; i += 1) {
    const m = items[i];
    const r = await fetchShip24Status(m.trackingNumber, m.currentStatus);

    if (r.ok) {
      m.currentStatus = r.data; // full replace with Ship24 data
      if (/delivered/i.test(r.data.summary || "")) {
        m.finalStatus = "Delivered";
        delivered += 1;
      }
      await m.save();
      done += 1;
      console.log(`[${i + 1}/${items.length}] ${m.trackingNumber} -> ${r.data.summary}`);
      continue;
    }

    if (r.unusable) {
      stoppedAt = i;
      console.log(`\n⛔ ${r.error}`);
      break;
    }

    noData += 1;
    console.log(`[${i + 1}/${items.length}] ${m.trackingNumber} -> skipped (${r.error}) - old data kept`);
  }

  console.log(`\n✅ Updated from Ship24: ${done} (of which now Delivered: ${delivered})`);
  console.log(`⚠️  Skipped (Ship24 had no data yet): ${noData}`);
  if (stoppedAt >= 0) console.log(`⏸️  Stopped: ${items.length - stoppedAt} shipments remain (Ship24 limit reached). Run again later / with more keys.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
