// background.js (MV3 service worker)
const API_BASE = "https://autumn-night-8572.kjregan120.workers.dev/api/price";
const K_PARAM = 100; // default per user example

// Cache last fetch per key to avoid duplicate concurrent calls
const inflight = new Map();

function buildUrl({ resort, checkIn, checkOut }) {
  const params = new URLSearchParams();
  params.set(resort, resort); // dynamic key
  params.set("checkin", checkIn);
  params.set("checkout", checkOut);
  params.set("k", String(K_PARAM));
  return `${API_BASE}?${params.toString()}`;
}

function keyFromPayload(p) {
  return `${p.resort}|${p.checkIn}|${p.checkOut}`;
}

async function fetchPrices(payload) {
  const url = buildUrl(payload);
  const res = await fetch(url, { method: "GET", credentials: "omit" });
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return { url, data, fetchedAt: Date.now() };
}

async function handleFetchRequest(payload, sender) {
  const key = keyFromPayload(payload);
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const { url, data, fetchedAt } = await fetchPrices(payload);
      const store = {
        lastApiKey: key,
        lastApiUrl: url,
        lastApiFetchedAt: fetchedAt,
        lastApiData: data,
        lastApiPayload: payload
      };
      await chrome.storage.local.set(store);

      // Notify originating tab if available
      if (sender && sender.tab && sender.tab.id !== undefined) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "API_DATA_UPDATED",
          payload,
          data
        }).catch(() => {});
      } else {
        // Broadcast to disneyworld pages just in case
        const tabs = await chrome.tabs.query({ url: "*://disneyworld.disney.go.com/*" });
        for (const t of tabs) {
          try { await chrome.tabs.sendMessage(t.id, { type: "API_DATA_UPDATED", payload, data }); } catch {}
        }
      }
    } catch (err) {
      console.warn("[background] fetch failed:", err);
      await chrome.storage.local.set({ lastApiError: String(err), lastApiErrorAt: Date.now() });
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;  
  if (msg.type === "SCRAPE_UPDATED" && msg.payload) {
    handleFetchRequest(msg.payload, sender);
  } else if (msg.type === "REFETCH_API" && msg.payload) {
    handleFetchRequest(msg.payload, sender);
  } else if (msg.type === "POPUP_REQUEST_LATEST") {
    chrome.storage.local.get(["lastApiPayload", "lastApiData", "lastApiUrl", "lastApiFetchedAt"], (res) => {
      sendResponse(res);
    });
    return true; // async
  }
});