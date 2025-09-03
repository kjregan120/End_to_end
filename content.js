(function () {
  // Banner so you KNOW we loaded
  console.log(
    "%c[ResortScraper] content.js loaded on",
    "background:#222;color:#0f0;padding:2px 6px;border-radius:4px",
    location.href
  );

  const url = location.href;
  const resortMatch = url.match(/\/resorts\/([^\/]+)\/.*?rates-rooms\/?/i);
  const resort = resortMatch ? decodeURIComponent(resortMatch[1]) : null;

  const ISO = "\\d{4}-\\d{2}-\\d{2}";
  const US  = "\\d{2}\\/\\d{2}\\/\\d{4}";
  const RE_IN_OUT   = new RegExp(`check_in_date=(${ISO}|${US}).*?check_out_date=(${ISO}|${US})`, "gi");
  const RE_OUT_IN   = new RegExp(`check_out_date=(${ISO}|${US}).*?check_in_date=(${ISO}|${US})`, "gi");
  const RE_SINGLE_IN  = new RegExp(`check_in_date=(${ISO}|${US})`, "i");
  const RE_SINGLE_OUT = new RegExp(`check_out_date=(${ISO}|${US})`, "i");
  // ❌ was /g — causes flaky .test() due to lastIndex
  const RE_ANY_DATE  = new RegExp(`(${ISO}|${US})`);

  const normalize = (d) => {
    if (!d) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : d;
  };

  function extractFromString(str, source, results) {
    if (!str) return;

    // Using matchAll with global regex is fine
    for (const m of str.matchAll(RE_IN_OUT)) results.push({ source, checkIn: normalize(m[1]), checkOut: normalize(m[2]) });
    for (const m of str.matchAll(RE_OUT_IN)) results.push({ source, checkIn: normalize(m[2]), checkOut: normalize(m[1]) });

    // If not paired, capture singles too
    const inOnly  = str.match(RE_SINGLE_IN);
    const outOnly = str.match(RE_SINGLE_OUT);
    if (inOnly || outOnly) {
      results.push({
        source: source + " (single)",
        checkIn:  inOnly  ? normalize(inOnly[1])  : null,
        checkOut: outOnly ? normalize(outOnly[1]) : null
      });
    }
  }

  // Traverse light DOM + shadow DOM
  function* allNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    yield root;
    let n;
    while ((n = walker.nextNode())) {
      yield n;
      if (n.shadowRoot) yield* allNodes(n.shadowRoot);
    }
  }

  function scanOnce() {
    const results = [];

    // 1) Visible text (light DOM only – fast)
    extractFromString(document.body?.innerText || "", "text", results);

    // 2) Targeted selector (if present)
    document.querySelectorAll(".quick-quote-info-text").forEach(el => {
      extractFromString(el.innerText || "", ".quick-quote-info-text", results);
    });

    // 3) Attributes everywhere (including shadow roots)
    for (const el of allNodes(document.documentElement)) {
      if (el.attributes) {
        for (const attr of el.attributes) {
          extractFromString(attr.value, `attr:${attr.name}<${el.tagName.toLowerCase()}>`, results);
        }
      }
      // Also some widgets stash values in textContent of tiny nodes
      if (el !== document.documentElement && el.childElementCount === 0) {
        const txt = el.textContent?.trim();
        if (txt && RE_ANY_DATE.test(txt) && (txt.includes("check_in") || txt.includes("check-out") || txt.includes("check_out") || txt.includes("check in") || txt.includes("check out"))) {
          extractFromString(txt, `leafText<${el.tagName.toLowerCase()}>`, results);
        }
      }
    }

    // Choose the best pair
    let best =
      results.find(r => r.checkIn && r.checkOut)
      || (() => {
           const inHit  = results.find(r => r.checkIn);
           const outHit = results.find(r => r.checkOut);
           return inHit || outHit ? { checkIn: inHit?.checkIn || null, checkOut: outHit?.checkOut || null, source: "combined singles" } : null;
         })()
      || { checkIn: null, checkOut: null };

    const payload = {
      url,
      resort,
      checkIn: best.checkIn,
      checkOut: best.checkOut,
      foundSourcesCount: results.length,
      lastUpdated: Date.now()
    };

    // Use callback to avoid relying on Promise support
    try {
      chrome.storage.local.set({ resortData: payload }, () => {});
    } catch {}
    console.log("[ResortScraper] payload:", payload, { resultsPreview: results.slice(0, 5) });
    return payload;
  }

  // Initial + debounced rescans
  let runs = 0;
  const MAX_RUNS = 20;
  const DEBOUNCE_MS = 600;
  let timer;

  const observer = new MutationObserver(() => {
    if (runs >= MAX_RUNS) return observer.disconnect();
    clearTimeout(timer);
    timer = setTimeout(() => {
      runs++;
      const p = scanOnce();
      if (p && p.checkIn && p.checkOut) observer.disconnect();
    }, DEBOUNCE_MS);
  });

  // Kick off
  const first = scanOnce();
  if (!(first && first.checkIn && first.checkOut)) {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    // ❌ was: observer.takeRecords() || scanOnce()
    [700, 1500, 3000].forEach(ms =>
      setTimeout(() => { observer.takeRecords(); scanOnce(); }, ms)
    );
  }

  // === Injected augmentation: API fetch trigger + DOM replacement ===
  (function() {
    const NORM = s => (s || "").replace(/[–—\-]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
    const fmtDollarsNoDecimals = (cents) => {
      const dollars = Math.round(Number(cents || 0) / 100);
      return dollars.toLocaleString(undefined, { maximumFractionDigits: 0 });
    };

    let lastSentKey = null;
    let lastApiData = null;

    // Ask background to fetch whenever resortData becomes available/changes
    function requestFetchIfReady() {
      try {
        chrome.storage.local.get(["resortData"], ({ resortData }) => {
          if (!resortData || !resortData.resort || !resortData.checkIn || !resortData.checkOut) return;
          const payload = { resort: resortData.resort, checkIn: resortData.checkIn, checkOut: resortData.checkOut };
          const key = `${payload.resort}|${payload.checkIn}|${payload.checkOut}`;
          if (key !== lastSentKey) {
            lastSentKey = key;
            try {
              // Avoid relying on Promise return
              chrome.runtime.sendMessage({ type: "SCRAPE_UPDATED", payload }, () => {});
            } catch {}
          }
        });
      } catch {}
    }

    // Replace labels in DOM with "LABEL Or $TOTAL by renting"
    function applyPriceOverlays(data) {
      if (!data) return;
      const rows = (data && (data.per_product || data.products || data.rows || data["per-product"])) || data?.per_product;
      if (!Array.isArray(rows)) return;

      const roots = [document];
      // Optionally traverse shadow roots
      try {
        const allEls = document.querySelectorAll("*");
        for (const el of allEls) {
          if (el.shadowRoot) roots.push(el.shadowRoot);
        }
      } catch {}

      for (const { label, total } of rows) {
        if (!label) continue;
        const normLabel = NORM(label);
        const replacement = `${label} Or $${fmtDollarsNoDecimals(total)} by renting`;

        for (const root of roots) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
              const p = node.parentElement;
              if (!p) return NodeFilter.FILTER_REJECT;
              const tn = p.tagName;
              if (tn === "SCRIPT" || tn === "STYLE" || tn === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
              if (p.dataset && p.dataset.rentalOverlayApplied === "1") return NodeFilter.FILTER_REJECT;
              const t = NORM(node.textContent);
              if (!t) return NodeFilter.FILTER_REJECT;
              return (t === normLabel) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
          });
          let node;
          while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent) continue;
            node.textContent = replacement;
            parent.dataset.rentalOverlayApplied = "1";
          }
        }
      }
    }

    // Handle messages from background / popup
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "API_DATA_UPDATED" && msg.data) {
        lastApiData = msg.data;
        applyPriceOverlays(lastApiData);
      } else if (msg.type === "REAPPLY") {
        if (lastApiData) {
          applyPriceOverlays(lastApiData);
        } else {
          chrome.storage.local.get(["lastApiData"], (res) => {
            lastApiData = res.lastApiData || null;
            applyPriceOverlays(lastApiData);
          });
        }
      }
    });

    // Keep observing DOM and re-apply (debounced)
    let reapplyTimer = null;
    const debouncedReapply = () => {
      if (reapplyTimer) clearTimeout(reapplyTimer);
      reapplyTimer = setTimeout(() => {
        if (lastApiData) applyPriceOverlays(lastApiData);
      }, 200);
    };

    const globalObserver = new MutationObserver(debouncedReapply);
    try {
      globalObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch {}

    // Observe storage changes for resortData
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.resortData) {
          requestFetchIfReady();
        }
      });
    } catch {}

    // Kick off immediately on load
    requestFetchIfReady();

    // Also try to pull any cached data and apply (in case API already ran)
    try {
      chrome.storage.local.get(["lastApiData"], (res) => {
        if (res && res.lastApiData) {
          lastApiData = res.lastApiData;
          applyPriceOverlays(lastApiData);
        }
      });
    } catch {}
  })();
})();
