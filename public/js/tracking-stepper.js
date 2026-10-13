// Client-side version of the shared India Post tracking report.
// All provider values are inserted with textContent to avoid HTML injection.
function renderTrackingStepperCard(data) {
  const wrapper = document.createElement("div");
  wrapper.className = "tracking-card";

  const text = (value) => value === null || value === undefined ? "" : String(value).trim();
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };


  
  const header = el("div", "tracking-card-header");
  const heading = el("div");
  heading.appendChild(el("div", "tracking-eyebrow", "India Post Tracking"));
  const consignment = el("p", "tracking-consignment");
  consignment.append("Consignment No: ");
  consignment.appendChild(el("strong", "", text(data.trackingNumber) || "-"));
  heading.appendChild(consignment);

  const printBtn = el("button", "tracking-print-btn", "🖨️ Print Report");
  printBtn.type = "button";
  printBtn.addEventListener("click", () => window.print());
  header.append(heading, printBtn);
  wrapper.appendChild(header);

  if (text(data.summary)) {
    const status = el("div", "tracking-current-status");
    status.appendChild(el("span", "tracking-status-dot"));
    status.appendChild(el("span", "", text(data.summary)));
    wrapper.appendChild(status);
  }

  const labels = Array.isArray(data.stageLabels) && data.stageLabels.length
    ? data.stageLabels
    : ["Booked", "Dispatched", "In Transit", "Out for Delivery", "Delivered"];
  const stage = Number.isInteger(data.stage) ? data.stage : -1;

  if (stage >= 0) {
    const progress = el("div", "tracking-progress");
    labels.forEach((label, i) => {
      const reached = i <= stage;
      const item = el("div", "tracking-progress-item" + (reached ? " is-reached" : ""));
      item.appendChild(el("div", "tracking-progress-circle", reached ? "✓" : String(i + 1)));
      item.appendChild(el("span", "", label));
      progress.appendChild(item);
      if (i < labels.length - 1) {
        progress.appendChild(el("div", "tracking-progress-line" + (i < stage ? " is-reached" : "")));
      }
    });
    wrapper.appendChild(progress);
  } else {
    wrapper.appendChild(el("div", "tracking-warning", text(data.summary) || "Status: " + (text(data.statusCode) || "Unknown")));
  }

  const origin = text(data.bookedAt) || text(data.originCity);
  const destination = text(data.destinationCity);
  if (origin || destination) {
    const route = el("div", "tracking-route");

    const originPoint = el("div", "tracking-route-point");
    originPoint.appendChild(el("span", "tracking-route-dot"));
    const originText = el("div");
    originText.appendChild(el("span", "tracking-route-label", "Booked at"));
    originText.appendChild(el("strong", "", origin || "-"));
    originPoint.appendChild(originText);

    route.appendChild(originPoint);
    route.appendChild(el("div", "tracking-route-arrow", "→"));

    const destinationPoint = el("div", "tracking-route-point tracking-route-destination");
    const destinationText = el("div");
    destinationText.appendChild(el("span", "tracking-route-label", "Destination"));
    destinationText.appendChild(el("strong", "", destination || "-"));
    destinationPoint.appendChild(destinationText);
    destinationPoint.appendChild(el("span", "tracking-route-dot"));
    route.appendChild(destinationPoint);
    wrapper.appendChild(route);
  }

  const details = [
    ["Article Number", data.trackingNumber],
    ["Article Type", data.articleType],
    ["Tariff", data.tariff],
    ["Booked At", data.bookedAt || data.originCity],
    ["Booked On", data.bookedOn],
    ["Destination", data.destinationCity],
    ["Origin Pincode", data.originPincode],
    ["Delivered On", data.deliveredOn],
    ["Destination Pincode", data.destinationPincode],
  ].filter(([, value]) => text(value));

  if (details.length) {
    const grid = el("div", "tracking-details-grid");
    details.forEach(([label, value]) => {
      const cell = el("div", "tracking-detail-cell");
      cell.appendChild(el("span", "tracking-detail-label", label));
      cell.appendChild(el("strong", "tracking-detail-value", text(value)));
      grid.appendChild(cell);
    });
    wrapper.appendChild(grid);
  }

  const meta = el("div", "tracking-meta-grid");
  [
    ["Current Status", data.summary || data.statusCode],
    ["Latest Location", data.currentLocation],
    ["Service / Courier", data.service || data.courier || "India Post"],
    ["Expected Delivery", data.expectedDelivery],
  ].filter(([, value]) => text(value)).forEach(([label, value]) => {
    const cell = el("div", "tracking-meta-cell");
    cell.appendChild(el("span", "", label));
    cell.appendChild(el("strong", "", text(value)));
    meta.appendChild(cell);
  });
  if (meta.children.length) wrapper.appendChild(meta);

  const chrono = Array.isArray(data.historyChronological)
    ? data.historyChronological
    : (Array.isArray(data.history) ? [...data.history].reverse() : []);

  const title = el("div", "tracking-section-title");
  title.appendChild(el("span", "", "Routing Steps"));
  title.appendChild(el("small", "", `${chrono.length} update${chrono.length === 1 ? "" : "s"}`));
  wrapper.appendChild(title);

  if (chrono.length) {
    const timeline = el("div", "tracking-timeline");
    chrono.forEach((h, index) => {
      const event = el("div", "tracking-event");
      const date = el("div", "tracking-event-date");
      date.appendChild(el("strong", "", text(h.date) || "-"));

      const marker = el("div", "tracking-event-marker" + (index === chrono.length - 1 ? " is-last" : ""));
      marker.appendChild(el("span", "", "✓"));

      const content = el("div", "tracking-event-content");
      content.appendChild(el("strong", "", text(h.status) || "Tracking update"));
      if (text(h.location)) content.appendChild(el("span", "", "📍 " + text(h.location)));

      event.append(date, marker, content);
      timeline.appendChild(event);
    });
    wrapper.appendChild(timeline);
  } else {
    wrapper.appendChild(el("div", "tracking-no-events", "No routing updates are available yet."));
  }

  if (data.lastFetchedAt) {
    const lastFetched = el("div", "tracking-last-fetched");
    const date = new Date(data.lastFetchedAt);
    lastFetched.textContent = "Last fetched: " + (Number.isNaN(date.getTime()) ? text(data.lastFetchedAt) : date.toLocaleString("en-IN"));
    wrapper.appendChild(lastFetched);
  }

  return wrapper;
}
