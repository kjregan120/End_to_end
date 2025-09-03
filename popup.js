async function load() {
  const { resortData } = await chrome.storage.local.get("resortData");
  if (!resortData) return;

  const fmt = (s) => (s == null || s === "" ? "—" : s);
  document.getElementById("resort").textContent = fmt(resortData.resort);
  document.getElementById("in").textContent     = fmt(resortData.checkIn);
  document.getElementById("out").textContent    = fmt(resortData.checkOut);
  document.getElementById("url").textContent    = fmt(resortData.url);
  document.getElementById("count").textContent  = String(resortData.foundSourcesCount ?? 0);

  if (resortData.lastUpdated) {
    const d = new Date(resortData.lastUpdated);
    document.getElementById("ts").textContent = d.toLocaleString();
  }
}

load();

async function loadApi() {
  const { lastApiPayload, lastApiData, lastApiUrl, lastApiFetchedAt } = await chrome.storage.local.get(["lastApiPayload","lastApiData","lastApiUrl","lastApiFetchedAt"]);
  const meta = document.getElementById("api-meta");
  const list = document.getElementById("api-rows");
  const totalEl = document.getElementById("api-total");
  list.innerHTML = "";
  totalEl.textContent = "";
  meta.textContent = "";

  if (!lastApiData) {
    meta.textContent = "No API data yet.";
    return;
  }

  if (lastApiFetchedAt) {
    const d = new Date(lastApiFetchedAt);
    meta.textContent = `Fetched ${d.toLocaleString()}${lastApiUrl ? " • " + lastApiUrl : ""}`;
  }

  const rows = lastApiData.per_product || [];
  const fmt = (cents) => (Math.round((cents||0)/100)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  for (const r of rows) {
    const li = document.createElement("li");
    li.textContent = `${r.label}: $${fmt(r.total)} (total)`;
    list.appendChild(li);
  }
  if (typeof lastApiData.total === "number") {
    totalEl.textContent = `Stay Total: $${fmt(lastApiData.total)}`;
  }
}

async function reapply() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "REAPPLY" });
  }
}

document.getElementById("btn-reapply").addEventListener("click", reapply);

loadApi();
