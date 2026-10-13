const mongoose = require("mongoose");

const trackingHistorySchema = new mongoose.Schema(
  {
    date: String,
    status: String,
    location: String,
    state: String,
    courier: String,
  },
  { _id: false }
);



const magazineSchema = new mongoose.Schema(
  {
    employeeName: { type: String, required: true, trim: true },
    // Reference to the logged-in User (employee) this client belongs to.
    // Used to scope the employee dashboard so each user only sees their own clients.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    clientName: { type: String, required: true, trim: true },
    clientMobile: { type: String, required: true, trim: true },
    volumeNo: { type: String, trim: true },
    slotNo: { type: String, trim: true },
    status: {
      type: String,
      enum: ["In Progress", "Printed"],
      default: "In Progress",
    },
    trackingNumber: { type: String, trim: true, default: "" },
    currentStatus: {
      provider: { type: String, default: "" },
      courier: { type: String, default: "" },
      trackingNumber: { type: String, default: "" },
      summary: { type: String, default: "" },
      statusCode: { type: String, default: "" },
      subStatus: { type: String, default: "" },
      stage: { type: Number, default: -1 },
      stageLabels: { type: [String], default: [] },
      originCity: { type: String, default: "" },
      destinationCity: { type: String, default: "" },
      destinationAddress: { type: String, default: "" },
      currentLocation: { type: String, default: "" },
      expectedDelivery: { type: String, default: "" },
      service: { type: String, default: "" },
      articleType: { type: String, default: "" },
      tariff: { type: String, default: "" },
      bookedAt: { type: String, default: "" },
      bookedOn: { type: String, default: "" },
      deliveredOn: { type: String, default: "" },
      originPincode: { type: String, default: "" },
      destinationPincode: { type: String, default: "" },
      additionalInfo: { type: String, default: "" },
      apiUsage: { type: mongoose.Schema.Types.Mixed, default: null },
      history: { type: [trackingHistorySchema], default: [] },
      lastFetchedAt: { type: Date, default: null },
      raw: { type: mongoose.Schema.Types.Mixed, default: null },
      error: { type: String, default: "" },
      // True when the employee manually confirmed delivery themselves
      // (e.g. after checking India Post's site directly), instead of a
      // provider (TrackCourier/17TRACK) reporting it.
      manuallyConfirmed: { type: Boolean, default: false },
    },
    // India date on which the automatic daily tracking refresh last ran.
    // This prevents duplicate refreshes when multiple app processes are running.
    autoRefreshDate: { type: String, default: "" },
    finalStatus: {
      type: String,
      enum: ["Delivered", "Not Delivered"],
      default: "Not Delivered",
    },
  },
  { timestamps: true }
);

// Track when a magazine became Delivered so it can be auto-deleted later.
magazineSchema.add({ deliveredAt: { type: Date, default: null } });
magazineSchema.pre("save", function (next) {
  if (this.finalStatus === "Delivered") {
    if (!this.deliveredAt) this.deliveredAt = new Date();
  } else if (this.deliveredAt) {
    this.deliveredAt = null;
  }
  next();
});

magazineSchema.index({ clientName: "text", clientMobile: "text", employeeName: "text" });

module.exports = mongoose.model("Magazine", magazineSchema);
