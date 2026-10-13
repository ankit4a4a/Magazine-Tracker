const mongoose = require("mongoose");

const trackingApiKeyUsageSchema = new mongoose.Schema(
  {
    keyId: { type: String, required: true, unique: true, index: true },
    used: { type: Number, default: 0 },
    quota: { type: Number, default: 100 },
    exhausted: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    lastUsedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    // Month (India time, "YYYY-MM") these counters belong to; resets on a new month.
    period: { type: String, default: "" },
  },
  { timestamps: true }
);



module.exports = mongoose.model("TrackingApiKeyUsage", trackingApiKeyUsageSchema);
