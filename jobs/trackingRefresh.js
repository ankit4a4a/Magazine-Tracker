const Magazine = require("../models/Magazine");
const { fetchTrackingStatus } = require("../utils/trackingService");

const INDIA_TIME_ZONE = "Asia/Kolkata";

function indiaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}



/**
 * Refresh all pending shipments once for the current India date.
 * This function is intentionally NOT scheduled at a fixed clock time.
 * It is triggered when an authenticated admin opens the admin dashboard.
 *
 * autoRefreshDate is claimed atomically before each API request, so even if
 * multiple admin requests/processes trigger this at the same time, each
 * shipment is refreshed at most once per India calendar day.
 */
async function refreshPendingTracking() {
  const today = indiaDateKey();
  const pending = await Magazine.find({
    status: "Printed",
    finalStatus: { $ne: "Delivered" },
    trackingNumber: { $exists: true, $nin: [null, ""] },
  }).select("_id trackingNumber finalStatus autoRefreshDate");

  if (!pending.length) {
    console.log(`[Tracking] Admin-open refresh: no pending shipments (${today}).`);
    return { refreshed: 0, skipped: 0, total: 0 };
  }

  let refreshed = 0;
  let skipped = 0;

  for (const item of pending) {
    // Atomic claim: one shipment can only be claimed once per India date.
    const claimed = await Magazine.findOneAndUpdate(
      {
        _id: item._id,
        status: "Printed",
        finalStatus: { $ne: "Delivered" },
        trackingNumber: item.trackingNumber,
        autoRefreshDate: { $ne: today },
      },
      { $set: { autoRefreshDate: today } },
      { new: true }
    );

    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      const result = await fetchTrackingStatus(claimed.trackingNumber, claimed.currentStatus);
      claimed.currentStatus = result;

      if (result.summary && /delivered/i.test(result.summary)) {
        claimed.finalStatus = "Delivered";
      }

      await claimed.save();
      refreshed += 1;

      console.log(
        `[Tracking] Admin-open refresh: ${claimed.trackingNumber} -> ${result.summary || result.error || "Updated"}`
      );
    } catch (error) {
      // Keep today's claim. The shipment will be eligible again tomorrow.
      claimed.currentStatus = {
        ...(claimed.currentStatus?.toObject?.() || claimed.currentStatus || {}),
        error: `Automatic refresh failed: ${error.message}`,
        lastFetchedAt: new Date(),
      };
      await claimed.save();
      refreshed += 1;

      console.error(
        `[Tracking] Admin-open refresh failed for ${claimed.trackingNumber}: ${error.message}`
      );
    }
  }

  console.log(
    `[Tracking] Admin-open refresh complete: ${refreshed} processed, ${skipped} already refreshed today.`
  );

  return { refreshed, skipped, total: pending.length };
}

/**
 * Start the daily refresh check when the admin dashboard is opened.
 * The refresh itself runs in the background so the dashboard does not wait
 * for all TrackCourier requests to finish loading.
 */
function triggerAdminOpenTrackingRefresh() {
  refreshPendingTracking().catch((error) => {
    console.error(`[Tracking] Admin-open refresh job failed: ${error.message}`);
  });
}

const DELIVERED_RETENTION_DAYS = 15;

/**
 * Delete magazines that have been Delivered for 15+ days.
 * Anything not Delivered is never touched. Delivered records that have no
 * deliveredAt yet (older data) get it stamped now, so their 15 days start today.
 */
async function deleteOldDelivered() {
  await Magazine.updateMany(
    { finalStatus: "Delivered", deliveredAt: null },
    { $set: { deliveredAt: new Date() } },
    { timestamps: false }
  );
  const cutoff = new Date(Date.now() - DELIVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await Magazine.deleteMany({
    finalStatus: "Delivered",
    deliveredAt: { $ne: null, $lte: cutoff },
  });
  if (res.deletedCount) {
    console.log(`[Cleanup] Deleted ${res.deletedCount} magazine(s) delivered more than ${DELIVERED_RETENTION_DAYS} days ago.`);
  }
  return res.deletedCount;
}

module.exports = { deleteOldDelivered, triggerAdminOpenTrackingRefresh, refreshPendingTracking, indiaDateKey };
