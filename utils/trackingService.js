const axios = require("axios");
const TrackingApiKeyUsage = require("../models/TrackingApiKeyUsage");

const BASE_URL = "https://api.17track.net/track/v2.4";
const TRACKCOURIER_URL = "https://api.trackcourier.io/v1";
const SHIP24_URL = "https://api.ship24.com/public/v1";
// First Ship24 call fetches from the courier synchronously (can take up to ~1 min).
const SHIP24_TIMEOUT = 65000;
const INDIA_POST_TRACK_URL = "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx";
const DEFAULT_TIMEOUT = 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));



// Current month key in India time, e.g. "2026-10". Used to reset key usage
// (used / exhausted / disabled) automatically when a new month starts, so the
// keys are tried again from the FIRST one.
function currentPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}`;
}

function clean(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && clean(value) !== "") return value;
  }
  return "";
}

function getTrackCourierKeys() {
  const keys = [];

  // Preferred format: TRACKCOURIER_API_KEY_1 ... TRACKCOURIER_API_KEY_20
  for (let i = 1; i <= 20; i += 1) {
    const value = clean(process.env[`TRACKCOURIER_API_KEY_${i}`]);
    if (value) keys.push({ keyId: `key${i}`, key: value });
  }

  // Backward compatibility: the old single-key variable is also supported.
  const legacy = clean(process.env.TRACKCOURIER_API_KEY);
  if (legacy && !keys.some((item) => item.key === legacy)) {
    keys.unshift({ keyId: "legacy", key: legacy });
  }

  // Optional comma-separated format if someone prefers one env variable.
  const list = clean(process.env.TRACKCOURIER_API_KEYS);
  if (list) {
    list.split(",").map((v) => v.trim()).filter(Boolean).forEach((key, index) => {
      if (!keys.some((item) => item.key === key)) {
        keys.push({ keyId: `list${index + 1}`, key });
      }
    });
  }

  return keys;
}

function trackCourierHeaders(apiKey) {
  return {
    "X-API-Key": apiKey,
    "Accept": "application/json",
  };
}

async function getKeyState(keyId) {
  try {
    const period = currentPeriod();
    const state = await TrackingApiKeyUsage.findOne({ keyId }).lean();
    if (!state) return null;

    // Old records (created before monthly reset existed): just stamp the month.
    if (!state.period) {
      await TrackingApiKeyUsage.updateOne({ keyId }, { $set: { period } });
      return { ...state, period };
    }

    // New month -> reset this key so it can be used again from the start.
    if (state.period !== period) {
      return await TrackingApiKeyUsage.findOneAndUpdate(
        { keyId },
        { $set: { period, used: 0, exhausted: false, disabled: false, lastError: "" } },
        { new: true }
      ).lean();
    }

    return state;
  } catch (_) {
    // Tracking should still work if the usage counter cannot be read.
    return null;
  }
}

async function updateKeyUsage(keyId, usage, extra = {}) {
  try {
    const remoteUsed = Number(usage?.used);
    const remoteQuota = Number(usage?.quota);
    const update = {
      $set: {
        ...(Number.isFinite(remoteUsed) ? { used: remoteUsed } : {}),
        ...(Number.isFinite(remoteQuota) && remoteQuota > 0 ? { quota: remoteQuota } : {}),
        lastUsedAt: new Date(),
        period: currentPeriod(),
        ...(extra.lastError !== undefined ? { lastError: extra.lastError } : {}),
        ...(extra.exhausted !== undefined ? { exhausted: extra.exhausted } : {}),
        ...(extra.disabled !== undefined ? { disabled: extra.disabled } : {}),
      },
      $setOnInsert: { keyId },
    };

    if (!Number.isFinite(remoteUsed)) {
      update.$inc = { used: 1 };
    }

    return await TrackingApiKeyUsage.findOneAndUpdate(
      { keyId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (_) {
    return null;
  }
}

async function markKeyFailure(keyId, message, { exhausted = false, disabled = false } = {}) {
  try {
    return await TrackingApiKeyUsage.findOneAndUpdate(
      { keyId },
      {
        $set: {
          ...(exhausted ? { exhausted: true } : {}),
          ...(disabled ? { disabled: true } : {}),
          lastError: message,
          lastUsedAt: new Date(),
          period: currentPeriod(),
        },
        $inc: { used: 1 },
        $setOnInsert: { keyId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (_) {
    return null;
  }
}

async function reserveNextKey(keys) {
  for (const item of keys) {
    const state = await getKeyState(item.keyId);
    if (state?.disabled || state?.exhausted) continue;
    if (Number.isFinite(state?.quota) && state.quota > 0 && Number(state.used) >= state.quota) {
      await markKeyFailure(item.keyId, "Monthly quota reached.", { exhausted: true });
      continue;
    }
    return item;
  }
  return null;
}

function normalizeTrackCourier(data, trackingNumber) {
  const d = data?.data || {};
  const summaryInfo = d?.ShipmentSummary || d?.shipment_summary || {};
  const checkpoints = Array.isArray(d?.Checkpoints)
    ? d.Checkpoints
    : (Array.isArray(d?.checkpoints) ? d.checkpoints : []);

  const history = checkpoints.map((cp) => {
    const date = clean(cp?.Date || cp?.date || cp?.timestamp || cp?.Timestamp);
    const time = clean(cp?.Time || cp?.time);
    return {
      date: date && time ? `${date} ${time}` : date || time,
      status: clean(cp?.Activity || cp?.activity || cp?.status || cp?.Status),
      location: clean(cp?.Location || cp?.location),
      state: clean(cp?.CheckpointState || cp?.checkpointState || cp?.state),
      courier: clean(cp?.CourierName || cp?.courierName || cp?.courier),
    };
  }).filter((x) => x.date || x.status || x.location);

  const statusMap = {
    pending: "InfoReceived",
    in_transit: "InTransit",
    intransit: "InTransit",
    out_for_delivery: "OutForDelivery",
    outfordelivery: "OutForDelivery",
    delivered: "Delivered",
    exception: "Exception",
  };
  const shipmentState = clean(d?.ShipmentState || d?.shipment_state || d?.status).toLowerCase();
  const statusCode = statusMap[shipmentState] || clean(d?.MostRecentStatus) || clean(d?.Result);
  const latest = history[0] || {};
  const summary = clean(d?.MostRecentStatus || d?.ShipmentSummary?.status) || clean(latest.status) || statusCode || "Tracking information available.";

  // India Post data returned by TrackCourier is nested under ShipmentSummary.
  // Keep flexible fallbacks for older/alternate response casing.
  const bookedOnDate = pick(summaryInfo, ["booked_on_date", "BookedOnDate", "bookedDate"]);
  const bookedOnTime = pick(summaryInfo, ["booked_on_time", "BookedOnTime", "bookedTime"]);
  const deliveredOnDate = pick(summaryInfo, ["delivered_on_date", "DeliveredOnDate", "deliveredDate"]);
  const deliveredOnTime = pick(summaryInfo, ["delivered_on_time", "DeliveredOnTime", "deliveredTime"]);

  const bookedOn = bookedOnDate
    ? `${clean(bookedOnDate)}${bookedOnTime ? ` ${clean(bookedOnTime)}` : ""}`
    : clean(history[history.length - 1]?.date);
  const deliveredOn = deliveredOnDate
    ? `${clean(deliveredOnDate)}${deliveredOnTime ? ` ${clean(deliveredOnTime)}` : ""}`
    : (shipmentState === "delivered" ? clean(latest.date) : "");

  const additionalInfo = clean(d?.AdditionalInfo || d?.additional_info);
  const bookedAtFromInfo = (additionalInfo.match(/Booked at:\s*([^;]+)/i) || [])[1] || "";
  const destinationFromInfo = (additionalInfo.match(/Destination:\s*([^;]+)/i) || [])[1] || "";
  const articleFromInfo = (additionalInfo.match(/Type:\s*([^;]+)/i) || [])[1] || "";

  const bookedAt = clean(summaryInfo?.booked_at) || clean(summaryInfo?.BookedAt) || clean(bookedAtFromInfo) || clean(d?.OriginCity);
  const destination = clean(summaryInfo?.destination) || clean(summaryInfo?.Destination) || clean(destinationFromInfo) || clean(d?.DestinationCity);
  const articleType = clean(summaryInfo?.article_type) || clean(summaryInfo?.ArticleType) || clean(articleFromInfo) || clean(d?.ArticleType) || clean(d?.article_type);
  const originPincode = clean(summaryInfo?.origin_pincode) || clean(summaryInfo?.OriginPincode) || clean(d?.OriginPincode) || clean(d?.origin_pincode);
  const destinationPincode = clean(summaryInfo?.destination_pincode) || clean(summaryInfo?.DestinationPincode) || clean(d?.DestinationPincode) || clean(d?.destination_pincode);
  const tariff = clean(summaryInfo?.tariff) || clean(d?.Tariff) || clean(d?.tariff) || clean(d?.postage) || clean(d?.postage_amount);
  const latestLocation = clean(latest.location);

  let stage = -1;
  if (shipmentState === "delivered" || statusCode === "Delivered") stage = 4;
  else if (shipmentState === "outfordelivery" || statusCode === "OutForDelivery") stage = 3;
  else if (history.length) {
    const hasDispatched = history.some((h) => /dispatched/i.test(h.status));
    stage = hasDispatched ? 2 : 0;
  }

  return {
    provider: "TrackCourier",
    courier: clean(latest.courier) || "India Post",
    trackingNumber: clean(d?.tracking_number || d?.trackingNumber) || trackingNumber,
    summary,
    statusCode,
    subStatus: clean(d?.error_category || d?.sub_status),
    stage,
    stageLabels: STAGE_LABELS,
    originCity: bookedAt,
    destinationCity: destination,
    destinationAddress: destination,
    expectedDelivery: clean(d?.ExpectedDeliveryDate || d?.expected_delivery_date),
    currentLocation: latestLocation,
    service: "India Post",
    articleType,
    tariff,
    bookedAt,
    bookedOn,
    deliveredOn,
    originPincode,
    destinationPincode,
    history,
    historyChronological: [...history].reverse(),
    additionalInfo,
    apiUsage: d?.usage || data?.usage || null,
    raw: data,
    lastFetchedAt: new Date(),
  };
}

async function fetchTrackCourier(trackingNumber) {
  const keys = getTrackCourierKeys();
  if (!keys.length) {
    return { ok: false, configured: false, error: "No TrackCourier API key is configured." };
  }

  const tried = [];
  let remaining = [...keys];

  while (remaining.length) {
    const key = await reserveNextKey(remaining);
    if (!key) break;
    remaining = remaining.filter((item) => item.keyId !== key.keyId);
    tried.push(key.keyId);

    try {
      const res = await axios.get(`${TRACKCOURIER_URL}/track`, {
        params: { courier: "indiapost", tracking_number: trackingNumber },
        headers: trackCourierHeaders(key.key),
        timeout: DEFAULT_TIMEOUT,
      });
      const body = res.data;

      // TrackCourier returns account usage in successful responses.
      if (body?.data?.usage) {
        await updateKeyUsage(key.keyId, body.data.usage);
      } else if (body?.usage) {
        await updateKeyUsage(key.keyId, body.usage);
      } else {
        await updateKeyUsage(key.keyId, null);
      }

      if (body?.success === false) {
        const message = clean(body?.error?.message) || "TrackCourier could not fetch tracking data.";
        const lower = message.toLowerCase();
        if (/quota|limit|exhaust/i.test(lower)) {
          await markKeyFailure(key.keyId, message, { exhausted: true });
          continue;
        }
        return { ok: false, configured: true, error: message, triedKeys: tried };
      }

      if (!body?.success || !body?.data) {
        return { ok: false, configured: true, error: "TrackCourier returned no tracking data.", triedKeys: tried };
      }

      const normalized = normalizeTrackCourier(body, trackingNumber);
      normalized.trackingKey = key.keyId;
      normalized.trackingKeyUsage = body?.data?.usage || body?.usage || null;
      return { ok: true, configured: true, data: normalized };
    } catch (err) {
      const status = err.response?.status;
      const providerMessage = clean(err.response?.data?.error?.message) || clean(err.response?.data?.message);

      if (status === 401) {
        await markKeyFailure(key.keyId, "TrackCourier API key is invalid.", { disabled: true });
        continue;
      }
      if (status === 402) {
        await markKeyFailure(key.keyId, "TrackCourier monthly API quota has been exhausted.", { exhausted: true });
        continue;
      }
      if (status === 429) {
        await markKeyFailure(key.keyId, "TrackCourier rate limit reached.");
        continue;
      }
      if (status === 404) {
        // 404 means the key worked but the tracking number was not found.
        await updateKeyUsage(key.keyId, null);
        return { ok: false, configured: true, error: "TrackCourier could not find this India Post tracking number.", triedKeys: tried };
      }
      if (status === 504) {
        await updateKeyUsage(key.keyId, null);
        return { ok: false, configured: true, error: "TrackCourier timed out while querying India Post.", triedKeys: tried };
      }
      if (err.code === "ECONNABORTED") {
        await updateKeyUsage(key.keyId, null);
        return { ok: false, configured: true, error: "TrackCourier timed out. Please try again.", triedKeys: tried };
      }

      await updateKeyUsage(key.keyId, null, { lastError: providerMessage || err.message });
      return {
        ok: false,
        configured: true,
        error: `TrackCourier error: ${providerMessage || err.message}`,
        triedKeys: tried,
      };
    }
  }

  return {
    ok: false,
    configured: true,
    exhausted: true,
    error: `All configured TrackCourier API keys are exhausted or invalid. Tried: ${tried.join(", ") || "none"}.`,
    triedKeys: tried,
  };
}

function headers(apiKey) {
  return {
    "17token": apiKey,
    "Content-Type": "application/json",
  };
}

function getSeventeenTrackKeys() {
  const keys = [];

  // Preferred format: SEVENTEENTRACK_API_KEY_1 ... SEVENTEENTRACK_API_KEY_20
  for (let i = 1; i <= 20; i += 1) {
    const value = clean(process.env[`SEVENTEENTRACK_API_KEY_${i}`]);
    if (value) keys.push({ keyId: `17t_key${i}`, key: value });
  }

  // Backward compatibility: the old single-key variable is also supported.
  const legacy = clean(process.env.SEVENTEENTRACK_API_KEY);
  if (legacy && !keys.some((item) => item.key === legacy)) {
    keys.unshift({ keyId: "17t_legacy", key: legacy });
  }

  // Optional comma-separated format if someone prefers one env variable.
  const list = clean(process.env.SEVENTEENTRACK_API_KEYS);
  if (list) {
    list.split(",").map((v) => v.trim()).filter(Boolean).forEach((key, index) => {
      if (!keys.some((item) => item.key === key)) {
        keys.push({ keyId: `17t_list${index + 1}`, key });
      }
    });
  }

  return keys;
}

function eventDate(item) {
  if (!item) return "";
  if (typeof item.time_iso === "string" && item.time_iso.trim()) return item.time_iso.trim();
  if (typeof item.time_utc === "string" && item.time_utc.trim()) return item.time_utc.trim();
  if (item.time_raw && typeof item.time_raw === "object") {
    const d = clean(item.time_raw.date);
    const t = clean(item.time_raw.time);
    if (d) return t ? `${d} ${t}` : d;
  }
  return clean(item.date);
}

function normalizeCheckpoint(item) {
  if (!item || typeof item !== "object") return null;

  const date = eventDate(item);
  const status = clean(
    pick(item, ["description", "description_translation", "stage", "status", "sub_status"])
  );
  const location = clean(item.location) || clean(item.address?.city) || clean(item.address?.state);

  if (!date && !status && !location) return null;
  return { date, status, location };
}

function extractEvents(trackInfo) {
  const providers = trackInfo?.tracking?.providers;
  if (!Array.isArray(providers)) return [];

  const events = [];
  for (const provider of providers) {
    if (Array.isArray(provider?.events)) events.push(...provider.events);
  }
  return events.map(normalizeCheckpoint).filter(Boolean);
}

function sortHistory(history) {
  return [...history].sort((a, b) => {
    const da = Date.parse(a.date);
    const db = Date.parse(b.date);
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    return db - da;
  });
}

const STAGE_LABELS = ["Booked", "Dispatched", "In Transit", "Out for Delivery", "Delivered"];

function computeStage(mainStatus, subStatus) {
  switch (mainStatus) {
    case "InfoReceived": return 0;
    case "InTransit": return subStatus === "InTransit_PickedUp" ? 1 : 2;
    case "AvailableForPickup": return 2;
    case "OutForDelivery": return 3;
    case "Delivered": return 4;
    default: return -1;
  }
}

function getProvider(trackInfo) {
  const providers = trackInfo?.tracking?.providers;
  if (!Array.isArray(providers) || !providers.length) return {};
  return providers.find((p) => Array.isArray(p?.events) && p.events.length) || providers[0] || {};
}

function normalizeAcceptedItem(item, trackingNumber) {
  const trackInfo = item?.track_info || item?.tracking || item || {};
  const latestStatus = trackInfo?.latest_status || {};
  const latestEvent = trackInfo?.latest_event || {};
  const misc = trackInfo?.misc_info || {};
  const timeMetrics = trackInfo?.time_metrics || {};
  const shippingInfo = trackInfo?.shipping_info || {};
  const provider = getProvider(trackInfo);

  const history = sortHistory(extractEvents(trackInfo));
  const latest = history[0] || {};

  const mainStatus = clean(latestStatus?.status);
  const subStatus = clean(latestStatus?.sub_status);
  const description = clean(latestStatus?.sub_status_descr) || clean(latestEvent?.description);
  const summary = mainStatus || description || latest.status;

  const destinationCity = clean(shippingInfo?.recipient_address?.city) || clean(item?.destination_city);
  const originCity = clean(shippingInfo?.shipper_address?.city) || clean(item?.origin_country);
  const bookedOn = clean(pick(timeMetrics, ["booked_date", "booking_date"])) || clean(history[history.length - 1]?.date);
  const deliveredOn = clean(pick(timeMetrics, ["delivered_date", "delivery_date"])) ||
    (mainStatus === "Delivered" ? clean(latest.date) : "");
  const originPincode = clean(shippingInfo?.shipper_address?.postal_code) || clean(shippingInfo?.shipper_address?.zip) || clean(item?.origin_pincode);
  const destinationPincode = clean(shippingInfo?.recipient_address?.postal_code) || clean(shippingInfo?.recipient_address?.zip) || clean(item?.destination_pincode);

  return {
    provider: "17TRACK",
    courier: clean(provider?.provider?.name) || clean(item?.carrier_name) || "India Post",
    trackingNumber: clean(item?.number) || trackingNumber,
    summary: summary || "Registered — waiting for the carrier's first tracking update.",
    statusCode: mainStatus,
    subStatus,
    stage: computeStage(mainStatus, subStatus),
    stageLabels: STAGE_LABELS,
    originCity,
    destinationCity,
    destinationAddress: clean(shippingInfo?.recipient_address?.street) || destinationCity,
    expectedDelivery: clean(timeMetrics?.estimated_delivery_date?.to) || clean(misc?.expected_delivery),
    currentLocation: clean(latestEvent?.location) || clean(latest.location),
    service: clean(provider?.service_type) || clean(misc?.service_type),
    articleType: clean(misc?.service_type),
    tariff: clean(pick(misc, ["tariff", "postage", "postage_amount"])),
    bookedAt: originCity,
    bookedOn,
    deliveredOn,
    originPincode,
    destinationPincode,
    history,
    historyChronological: [...history].reverse(),
    raw: item,
    lastFetchedAt: new Date(),
  };
}

async function registerNumber(trackingNumber, apiKey) {
  try {
    const res = await axios.post(`${BASE_URL}/register`, [{ number: trackingNumber }], {
      headers: headers(apiKey), timeout: DEFAULT_TIMEOUT,
    });
    const body = res.data;
    if (body?.code !== 0) {
      return { ok: false, error: clean(body?.data?.errors?.[0]?.message) || "Registration failed." };
    }
    const rejected = body?.data?.rejected?.[0];
    if (rejected) {
      // -18019901 means already registered, which is fine.
      if (rejected.error?.code === -18019901) return { ok: true };
      return { ok: false, error: clean(rejected.error?.message) || "Could not register this tracking number." };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: describeAxiosError(err),
      invalidKey: err.response?.status === 401,
      rateLimited: err.response?.status === 429,
    };
  }
}

async function fetchTrackInfo(trackingNumber, apiKey) {
  try {
    const res = await axios.post(`${BASE_URL}/gettrackinfo`, [{ number: trackingNumber }], {
      headers: headers(apiKey), timeout: DEFAULT_TIMEOUT,
    });
    const body = res.data;
    if (body?.code !== 0) {
      return { ok: false, error: clean(body?.data?.errors?.[0]?.message) || "Could not fetch tracking info." };
    }
    const accepted = body?.data?.accepted?.[0];
    if (!accepted) {
      const rejected = body?.data?.rejected?.[0];
      return { ok: false, error: clean(rejected?.error?.message) || "No tracking data found yet." };
    }
    return { ok: true, data: accepted };
  } catch (err) {
    return {
      ok: false,
      error: describeAxiosError(err),
      invalidKey: err.response?.status === 401,
      rateLimited: err.response?.status === 429,
    };
  }
}

// Force a fresh carrier query. 17TRACK documents cacheLevel=1 as the
// immediate/real-time mode; it costs more quota than the standard cached mode.
async function fetchRealTimeTrackInfo(trackingNumber, apiKey) {
  try {
    const res = await axios.post(`${BASE_URL}/getRealTimeTrackInfo`, [
      { number: trackingNumber, cacheLevel: 1 },
    ], { headers: headers(apiKey), timeout: DEFAULT_TIMEOUT });
    const body = res.data;
    if (body?.code !== 0) {
      return { ok: false, error: clean(body?.data?.errors?.[0]?.message) || "Could not fetch real-time tracking info." };
    }
    const accepted = body?.data?.accepted?.[0];
    if (!accepted) {
      const rejected = body?.data?.rejected?.[0];
      return { ok: false, error: clean(rejected?.error?.message) || "No real-time tracking data found." };
    }
    return { ok: true, data: accepted };
  } catch (err) {
    return {
      ok: false,
      error: describeAxiosError(err),
      invalidKey: err.response?.status === 401,
      rateLimited: err.response?.status === 429,
    };
  }
}

function hasUsefulTracking(data) {
  const info = data?.track_info || {};
  const status = clean(info?.latest_status?.status);
  const events = extractEvents(info);
  return Boolean(events.length || (status && status !== "NotFound"));
}

function describeAxiosError(err) {
  const status = err.response?.status;
  if (status === 401) return "17TRACK API key is invalid, or this server's IP is not whitelisted in the 17TRACK dashboard.";
  if (status === 429) return "17TRACK rate limit reached. Please wait and try again.";
  if (err.code === "ECONNABORTED") return "17TRACK timed out. Please try again.";
  return `17TRACK error: ${clean(err.response?.data?.data?.errors?.[0]?.message) || err.message}`;
}

async function buildUsageRows(keys) {
  const rows = [];
  for (const item of keys) {
    const state = await getKeyState(item.keyId);
    const quota = Number(state?.quota) > 0 ? Number(state.quota) : 100;
    const used = Number(state?.used) >= 0 ? Number(state.used) : 0;
    rows.push({
      keyId: item.keyId,
      used,
      quota,
      remaining: Math.max(quota - used, 0),
      percent: quota ? Math.min(Math.round((used / quota) * 100), 100) : 0,
      exhausted: Boolean(state?.exhausted || used >= quota),
      disabled: Boolean(state?.disabled),
      lastUsedAt: state?.lastUsedAt || null,
      lastError: state?.lastError || "",
    });
  }
  return rows;
}

async function getTrackCourierUsage() {
  return buildUsageRows(getTrackCourierKeys());
}

async function getSeventeenTrackUsage() {
  return buildUsageRows(getSeventeenTrackKeys());
}

// Tries each configured 17TRACK key in turn (like TrackCourier does),
// skipping keys that are disabled/exhausted and moving on when a key turns
// out to be invalid or rate-limited, instead of giving up on the first key.
async function fetchSeventeenTrackWithKey(normalizedNumber, apiKey) {
  const reg = await registerNumber(normalizedNumber, apiKey);
  if (!reg.ok) {
    return { ok: false, error: reg.error, invalidKey: reg.invalidKey, rateLimited: reg.rateLimited };
  }

  let last = await fetchTrackInfo(normalizedNumber, apiKey);
  if (last.ok && hasUsefulTracking(last.data)) {
    return { ok: true, data: normalizeAcceptedItem(last.data, normalizedNumber) };
  }

  const realtime = await fetchRealTimeTrackInfo(normalizedNumber, apiKey);
  if (realtime.ok && hasUsefulTracking(realtime.data)) {
    return { ok: true, data: normalizeAcceptedItem(realtime.data, normalizedNumber) };
  }

  await sleep(2500);
  last = await fetchTrackInfo(normalizedNumber, apiKey);
  if (last.ok && hasUsefulTracking(last.data)) {
    return { ok: true, data: normalizeAcceptedItem(last.data, normalizedNumber) };
  }

  const providerErrors = [realtime.error, last.error].filter(Boolean);
  return {
    ok: false,
    invalidKey: Boolean(realtime.invalidKey || last.invalidKey),
    rateLimited: Boolean(realtime.rateLimited || last.rateLimited),
    error: providerErrors.length ? providerErrors.join(" | ") : "No tracking data found yet. Please try again shortly.",
  };
}

async function fetchSeventeenTrack(normalizedNumber) {
  const keys = getSeventeenTrackKeys();
  if (!keys.length) {
    return { ok: false, configured: false, error: "No 17TRACK API key is configured." };
  }

  const tried = [];
  let remaining = [...keys];

  while (remaining.length) {
    const key = await reserveNextKey(remaining);
    if (!key) break;
    remaining = remaining.filter((item) => item.keyId !== key.keyId);
    tried.push(key.keyId);

    const attempt = await fetchSeventeenTrackWithKey(normalizedNumber, key.key);

    if (attempt.invalidKey) {
      await markKeyFailure(key.keyId, "17TRACK API key is invalid, or this server's IP is not whitelisted.", { disabled: true });
      continue;
    }
    if (attempt.rateLimited) {
      await markKeyFailure(key.keyId, "17TRACK rate limit reached.");
      continue;
    }

    await updateKeyUsage(key.keyId, null, attempt.ok ? {} : { lastError: attempt.error });

    if (!attempt.ok) {
      return { ok: false, configured: true, error: attempt.error, triedKeys: tried };
    }

    attempt.data.trackingKey = key.keyId;
    return { ok: true, configured: true, data: attempt.data };
  }

  return {
    ok: false,
    configured: true,
    exhausted: true,
    error: `All configured 17TRACK API keys are exhausted or invalid. Tried: ${tried.join(", ") || "none"}.`,
    triedKeys: tried,
  };
}

/* ---------------------------------------------------------------------------
   Ship24 (LAST-RESORT fallback)
   Used ONLY when every TrackCourier key is exhausted/invalid AND 17TRACK also
   could not return anything. Ship24's free plan is tiny (10 shipments/month),
   so it is deliberately kept as the final option.

   Uses POST /trackers/track, which is idempotent: the first call creates the
   tracker + returns results, later calls with the SAME payload return the
   latest results without creating a new tracker (so no extra quota is used).
   IMPORTANT: always send the exact same payload ({ trackingNumber } only) -
   changing it would create a brand-new tracker and burn quota.
--------------------------------------------------------------------------- */
function ship24Time(event) {
  return clean(event?.occurrenceDatetime || event?.datetime);
}

function normalizeShip24(tracking, trackingNumber) {
  const shipment = tracking?.shipment || {};
  const milestone = clean(shipment.statusMilestone).toLowerCase();
  const rawEvents = Array.isArray(tracking?.events) ? tracking.events : [];

  const history = sortHistory(
    rawEvents
      .map((e) => ({
        date: ship24Time(e),
        status: clean(e?.status),
        location: clean(e?.location),
        state: "",
        courier: clean(e?.courierCode),
      }))
      .filter((x) => x.date || x.status || x.location)
  );

  const latest = history[0] || {};
  const delivered = milestone === "delivered";

  let summary = clean(latest.status) || clean(shipment.statusCategory) || "Tracking information available.";
  if (delivered && !/delivered/i.test(summary)) summary = `Delivered - ${summary}`;

  const milestoneStage = {
    info_received: 0,
    in_transit: history.some((h) => /dispatch/i.test(h.status)) ? 1 : 2,
    available_for_pickup: 2,
    out_for_delivery: 3,
    failed_attempt: 3,
    delivered: 4,
  };
  let stage = milestoneStage[milestone];
  if (stage === undefined) stage = history.length ? 0 : -1;

  const statusCodeMap = {
    info_received: "InfoReceived",
    in_transit: "InTransit",
    available_for_pickup: "AvailableForPickup",
    out_for_delivery: "OutForDelivery",
    failed_attempt: "Exception",
    exception: "Exception",
    delivered: "Delivered",
  };

  return {
    provider: "Ship24",
    courier: "India Post",
    trackingNumber: clean(tracking?.tracker?.trackingNumber) || trackingNumber,
    summary,
    statusCode: statusCodeMap[milestone] || clean(shipment.statusCode) || clean(shipment.statusCategory),
    subStatus: clean(shipment.statusCategory),
    stage,
    stageLabels: STAGE_LABELS,
    originCity: "",
    destinationCity: "",
    destinationAddress: "",
    expectedDelivery: clean(shipment?.delivery?.estimatedDeliveryDate),
    currentLocation: clean(latest.location),
    service: clean(shipment?.delivery?.service) || "India Post",
    articleType: "",
    tariff: "",
    bookedAt: "",
    bookedOn: clean(history[history.length - 1]?.date),
    deliveredOn: delivered ? clean(latest.date) : "",
    originPincode: "",
    destinationPincode: "",
    history,
    historyChronological: [...history].reverse(),
    additionalInfo: "",
    apiUsage: null,
    raw: tracking,
    lastFetchedAt: new Date(),
  };
}

async function fetchShip24WithKey(trackingNumber, apiKey) {
  const callShip24 = () =>
    axios.post(
      `${SHIP24_URL}/trackers/track`,
      { trackingNumber }, // keep payload constant - see note above
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: SHIP24_TIMEOUT,
      }
    );

  try {
    let res;
    try {
      res = await callShip24();
    } catch (e) {
      // 409 request_conflict: same request running in parallel - safe to retry.
      if (e.response?.status === 409) {
        await sleep(2500);
        res = await callShip24();
      } else {
        throw e;
      }
    }

    const tracking = res.data?.data?.trackings?.[0];
    if (!tracking) {
      return { ok: false, configured: true, error: "Ship24 returned no tracking data." };
    }

    const hasEvents = Array.isArray(tracking.events) && tracking.events.length > 0;
    const milestone = clean(tracking?.shipment?.statusMilestone);
    if (!hasEvents && (!milestone || milestone === "pending")) {
      return { ok: false, configured: true, error: "Ship24 has no tracking events for this number yet." };
    }

    return { ok: true, configured: true, data: normalizeShip24(tracking, trackingNumber) };
  } catch (err) {
    const status = err.response?.status;
    const errors = Array.isArray(err.response?.data?.errors) ? err.response.data.errors : [];
    const codes = errors.map((e) => clean(e?.code));
    const providerMessage = clean(errors[0]?.message) || clean(err.response?.data?.message);

    // "unusable" = Ship24 cannot serve us right now (monthly limit reached,
    // bad key, no active plan). Only then do we fall back to TrackCourier/17TRACK.
    if (codes.includes("quota_limit_reached")) {
      return { ok: false, configured: true, unusable: true, quota: true, error: "Ship24 monthly limit reached." };
    }
    if (codes.includes("no_active_subscription") || status === 401 || status === 403) {
      return { ok: false, configured: true, unusable: true, error: `Ship24 not usable (${providerMessage || `HTTP ${status}`}).` };
    }
    if (codes.includes("parcel_not_found")) {
      return { ok: false, configured: true, error: "Ship24 has no tracking events for this number yet." };
    }
    if (status === 429) return { ok: false, configured: true, error: "Ship24 rate limit reached. Please try again shortly." };
    if (err.code === "ECONNABORTED") return { ok: false, configured: true, error: "Ship24 timed out. Please try again." };
    return { ok: false, configured: true, error: `Ship24 error: ${providerMessage || err.message}` };
  }
}

// Ship24 keys: SHIP24_API_KEY (old single var), SHIP24_API_KEY_1 ... _20,
// or comma-separated SHIP24_API_KEYS.
function getShip24Keys() {
  const keys = [];

  for (let i = 1; i <= 20; i += 1) {
    const value = clean(process.env[`SHIP24_API_KEY_${i}`]);
    if (value) keys.push({ keyId: `s24_key${i}`, key: value });
  }

  const legacy = clean(process.env.SHIP24_API_KEY);
  if (legacy && !keys.some((item) => item.key === legacy)) {
    keys.unshift({ keyId: "s24_legacy", key: legacy });
  }

  const list = clean(process.env.SHIP24_API_KEYS);
  if (list) {
    list.split(",").map((v) => v.trim()).filter(Boolean).forEach((key, index) => {
      if (!keys.some((item) => item.key === key)) {
        keys.push({ keyId: `s24_list${index + 1}`, key });
      }
    });
  }

  return keys;
}

// Tries Ship24 keys in order. A shipment already tracked on a particular key
// is checked on THAT key first (its tracker lives in that Ship24 account, so
// re-checking is free). A key that hits its monthly limit / is invalid is
// marked for the current month and the next key is used. Non-key problems
// (e.g. "no events yet") stop right there without burning other keys.
async function fetchShip24(trackingNumber, previousStatus) {
  const keys = getShip24Keys();
  if (!keys.length) {
    return { ok: false, configured: false, error: "No Ship24 API key is configured." };
  }

  const ordered = [];
  const preferredId = previousStatus?.provider === "Ship24" ? clean(previousStatus.trackingKey) : "";
  const preferred = preferredId ? keys.find((k) => k.keyId === preferredId) : null;
  if (preferred) ordered.push(preferred);

  for (const item of keys) {
    if (preferred && item.keyId === preferred.keyId) continue;
    const state = await getKeyState(item.keyId);
    if (state?.exhausted || state?.disabled) continue;
    ordered.push(item);
  }

  const tried = [];
  for (const item of ordered) {
    tried.push(item.keyId);
    const attempt = await fetchShip24WithKey(trackingNumber, item.key);

    if (attempt.ok) {
      attempt.data.trackingKey = item.keyId;
      return attempt;
    }

    if (attempt.unusable) {
      await markKeyFailure(
        item.keyId,
        attempt.error,
        attempt.quota ? { exhausted: true } : { disabled: true }
      );
      continue;
    }

    return attempt; // real answer from Ship24 (not a key problem)
  }

  return {
    ok: false,
    configured: true,
    unusable: true,
    error: `All Ship24 keys are exhausted or invalid. Tried: ${tried.join(", ") || "none"}.`,
  };
}

// A short fingerprint of the parts of a status that actually change when a
// shipment moves forward. Used to detect when TrackCourier's latest response
// is identical to the one we already have saved (i.e. "no new response").
function statusFingerprint(status) {
  if (!status) return "";
  const history = Array.isArray(status.history) ? status.history : [];
  const top = history[0] || {};
  return JSON.stringify({
    summary: clean(status.summary),
    statusCode: clean(status.statusCode),
    stage: status.stage,
    historyCount: history.length,
    latest: `${clean(top.date)}|${clean(top.status)}|${clean(top.location)}`,
  });
}

// If true, a Ship24 "no events yet" / timeout also falls through to TrackCourier.
// Default false: TrackCourier/17TRACK are used only when Ship24 itself is
// unusable (monthly limit reached, invalid key, no plan, or not configured).
const SHIP24_FALLBACK_ON_NO_DATA = false;

// Emergency fallback to TrackCourier/17TRACK when ALL Ship24 keys are used up.
// On by default. Set ENABLE_COURIER_FALLBACK=false in .env to switch
// TrackCourier + 17TRACK off completely (Ship24 only).
const ENABLE_COURIER_FALLBACK = String(process.env.ENABLE_COURIER_FALLBACK || "true").toLowerCase() !== "false";

// previousStatus (optional) is the shipment's last saved currentStatus
// (e.g. magazine.currentStatus), used only to detect whether TrackCourier
// actually returned something new this time.
async function fetchTrackingStatus(trackingNumber, previousStatus) {
  const normalizedNumber = clean(trackingNumber).replace(/\s+/g, "").toUpperCase();
  if (!normalizedNumber) return { error: "No tracking number provided." };

  // 1) Ship24 FIRST. Repeat calls for a number already tracked on Ship24 do
  //    not use extra quota (one shipment = one tracker, followed until delivered).
  const ship24 = await fetchShip24(normalizedNumber, previousStatus);
  if (ship24.ok) return ship24.data;

  const ship24Unusable = !ship24.configured || ship24.unusable;
  if (!ship24Unusable && !SHIP24_FALLBACK_ON_NO_DATA) {
    return { error: ship24.error, indiaPostLink: INDIA_POST_TRACK_URL };
  }

  if (!ENABLE_COURIER_FALLBACK) {
    return {
      error: ship24.configured ? ship24.error : "Ship24 API key is not configured.",
      indiaPostLink: INDIA_POST_TRACK_URL,
    };
  }

  // 2) Ship24 limit reached (or not configured) -> TrackCourier keys, starting
  //    from key 1 (usage resets automatically every month).
  const tc = await fetchTrackCourier(normalizedNumber);
  const tcDelivered = tc.ok && /delivered/i.test(tc.data?.summary || "");

  // Trust TrackCourier immediately once it reports Delivered.
  if (tc.ok && tcDelivered) return tc.data;

  // 3) Cross-check / fall back to 17TRACK only when TrackCourier failed outright
  //    OR gave exactly the same response as last time (no progress).
  const hasPreviousFetch = Boolean(previousStatus && (previousStatus.provider || previousStatus.lastFetchedAt));
  const tcUnchanged =
    tc.ok && hasPreviousFetch && statusFingerprint(tc.data) === statusFingerprint(previousStatus);
  const shouldCheckSeventeen = !tc.ok || tcUnchanged;

  if (!shouldCheckSeventeen) return tc.data;

  const seventeen = await fetchSeventeenTrack(normalizedNumber);
  const seventeenDelivered = seventeen.ok && /delivered/i.test(seventeen.data?.summary || "");

  if (seventeen.ok && (seventeenDelivered || !tc.ok)) return seventeen.data;
  if (tc.ok) return tc.data;

  return {
    error:
      `Ship24: ${ship24.configured ? ship24.error : "not configured"} | ` +
      `TrackCourier: ${tc.error || "no data"} | 17TRACK: ${seventeen.error || "no data"}`,
    indiaPostLink: INDIA_POST_TRACK_URL,
  };
}

// Ship24 only (no TrackCourier/17TRACK fallback). Used by scripts/resyncShip24.js.
async function fetchShip24Status(trackingNumber, previousStatus) {
  const normalizedNumber = clean(trackingNumber).replace(/\s+/g, "").toUpperCase();
  if (!normalizedNumber) return { ok: false, configured: true, error: "No tracking number provided." };
  return fetchShip24(normalizedNumber, previousStatus);
}

module.exports = {
  fetchTrackingStatus,
  fetchShip24Status,
  getShip24KeyCount: () => getShip24Keys().length,
  getTrackCourierUsage,
  getSeventeenTrackUsage,
  INDIA_POST_TRACK_URL,
};
