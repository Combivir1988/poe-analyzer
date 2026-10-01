// POE Analyzer — попап. Показує стан спійманої ніші для активної вкладки,
// за кнопкою дозбирає відсутні Top Niche Insights через міст і віддає один JSON.
const STORE_KEY = "poea_niches";
const COLLECT_TIMEOUT_MS = 180000;

const INSIGHTS = [
  ["OX_NICHE_MARKET_POTENTIAL_PROMPT", "Niche Overview"],
  ["OX_NICHE_PRODUCT_FEATURE_EXTRACTOR_PROMPT", "Top Product Features"],
  ["OX_NICHE_REVIEWS_ANALYZER_PROMPT", "Customer Reviews"],
  ["OX_NICHE_CUSTOMER_DEMOGRAPHICS_PROMPT", "Customer Demographics"],
  ["OX_NICHE_SEARCH_TERMS_PROMPT", "Search Terms"],
  ["OX_NICHE_PRICING_ANALYSIS_PROMPT", "Pricing"],
];
const TAB_OF = Object.fromEntries(INSIGHTS);

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const tabsEl = $("tabs");
const btn = $("download");
const othersEl = $("others");
const othersList = $("othersList");

const state = { tab: null, nicheId: null, record: null, byNiche: {} };

// ---- utils ----
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeName = (s) => (String(s || "niche").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "niche");
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return iso || ""; } };
const nicheIdFromUrl = (url) => { const m = String(url || "").match(/\/niche\/([^/?#]+)/); return m ? m[1] : null; };
const isPoeUrl = (url) => /^https:\/\/sellercentral(-europe|-japan)?\.amazon\.[a-z.]+\/opportunity-explorer/.test(String(url || ""));
const haveHtml = (rec, pid) => !!(rec && rec.insights && rec.insights[pid] && rec.insights[pid].html);
const countInsights = (rec) => INSIGHTS.filter(([pid]) => haveHtml(rec, pid)).length;

const activeTab = () => new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve((t && t[0]) || null)));
const readStore = () => new Promise((resolve) => chrome.storage.local.get(STORE_KEY, (r) => resolve((r && r[STORE_KEY]) || {})));
const writeStore = (obj) => new Promise((resolve) => chrome.storage.local.set({ [STORE_KEY]: obj }, resolve));

const askBridge = (tabId, message, timeoutMs) => new Promise((resolve, reject) => {
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("timeout")); } }, timeoutMs || 30000);
  chrome.tabs.sendMessage(tabId, message, (resp) => {
    if (done) return;
    done = true; clearTimeout(timer);
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(resp);
  });
});

const sectionSummary = (data) => {
  const n = (data && data.niche) || {};
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  return [
    n.nicheSummary ? "метрики" : null,
    n.launchPotential ? "launch potential" : null,
    len(n.asinMetrics) ? `товари (${len(n.asinMetrics)})` : null,
    len(n.searchTermMetrics) ? `search terms (${len(n.searchTermMetrics)})` : null,
    len(n.trendsMetrics) ? `тренди (${len(n.trendsMetrics)})` : null,
    n.nichePdr ? "PDR/відгуки" : null,
  ].filter(Boolean).join(", ");
};

// ---- вихідний файл (формат схеми v1) ----
const buildOutput = (rec, insightsMap, dbg) => {
  const m = rec.meta || {};
  const insights = {};
  INSIGHTS.forEach(([pid, tab]) => {
    const e = insightsMap[pid];
    if (e) insights[pid] = Object.assign({ tab }, e);
  });
  return {
    meta: {
      capturedAt: m.capturedAt,
      nicheId: m.nicheId,
      nicheTitle: m.nicheTitle,
      obfuscatedMarketplaceId: m.obfuscatedMarketplaceId,
      pageUrl: m.pageUrl,
      schemaVersion: m.schemaVersion || 1,
      source: m.source,
      generator: "POE Analyzer " + chrome.runtime.getManifest().version,
    },
    variables: rec.variables || null,
    data: rec.data,
    insights,
    _debug: dbg,
  };
};

const download = (obj, filename) => {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
};

const filenameFor = (rec) => `POE_${safeName(rec.meta.nicheTitle)}_${String(rec.meta.capturedAt || "").slice(0, 10)}.json`;

// ---- рендер ----
const setStatus = (html) => { statusEl.innerHTML = html; };

const renderTabs = (rec, inFlight) => {
  tabsEl.hidden = false;
  tabsEl.innerHTML = INSIGHTS.map(([pid, tab]) => {
    const cls = haveHtml(rec, pid) ? "have" : (inFlight === pid ? "active-fetch" : "");
    return `<li class="${cls}">${esc(tab)}</li>`;
  }).join("");
};

const renderOthers = () => {
  const rows = Object.values(state.byNiche)
    .filter((r) => r && r.meta && r.data && r.meta.nicheId !== state.nicheId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (!rows.length) { othersEl.hidden = true; return; }
  othersEl.hidden = false;
  othersList.innerHTML = rows.map((r) => `
    <div class="row">
      <span class="t" title="${esc(r.meta.nicheTitle)}">${esc(r.meta.nicheTitle)}</span>
      <span class="d">${esc(fmtDate(r.meta.capturedAt))} · ${countInsights(r)}/6</span>
      <button data-nid="${esc(r.meta.nicheId)}">JSON</button>
    </div>`).join("");
  othersList.querySelectorAll("button[data-nid]").forEach((b) => {
    b.addEventListener("click", () => {
      const r = state.byNiche[b.dataset.nid];
      if (!r) return;
      const got = countInsights(r);
      const out = buildOutput(r, r.insights || {}, {
        passiveInsights: got,
        missingCount: 6 - got,
        activeFetch: false,
        note: "downloaded from storage; missing insights not fetched (niche not open in active tab)",
        insightsFinal: got,
      });
      download(out, filenameFor(r));
    });
  });
};

const renderMain = () => {
  const rec = state.record;
  const m = rec.meta;
  const got = countInsights(rec);
  setStatus(
    `Ніша: <b>${esc(m.nicheTitle)}</b><br>` +
    `<span class="muted">Marketplace: ${esc(m.obfuscatedMarketplaceId || "?")} · знято: ${esc(fmtDate(m.capturedAt))}</span>` +
    `<div class="hint">Дані: ${esc(sectionSummary(rec.data) || "—")}</div>` +
    `<div class="hint">Top Niche Insights: <b>${got} з 6</b>${got < 6 ? " — решта дозбереться при завантаженні (послідовно, ~5–20 с)" : ""}</div>`
  );
  renderTabs(rec, null);
  btn.disabled = false;
};

const noData = (msg, cls) => {
  state.record = null;
  setStatus(`<span class="${cls || "muted"}">${esc(msg)}</span>`);
  tabsEl.hidden = true;
  btn.disabled = true;
};

// ---- init ----
async function init() {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  state.byNiche = await readStore();
  state.tab = await activeTab();
  const url = state.tab ? state.tab.url || "" : "";

  if (!isPoeUrl(url)) {
    noData("Відкрийте сторінку ніші в Product Opportunity Explorer (Seller Central), тоді відкрийте це вікно знову.");
    renderOthers();
    return;
  }
  state.nicheId = nicheIdFromUrl(url);
  if (!state.nicheId) {
    noData("Це не сторінка конкретної ніші. Відкрийте нішу (сторінка з метриками і Top Niche Insights).");
    renderOthers();
    return;
  }
  const rec = state.byNiche[state.nicheId];
  if (!rec || !rec.meta || !rec.data) {
    noData("Дані цієї ніші ще не спіймано. Оновіть сторінку (F5), дочекайтеся завантаження і відкрийте вікно знову.");
    renderOthers();
    return;
  }
  state.record = rec;
  renderMain();
  renderOthers();
}

// ---- прогрес дозбору від моста ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "poea:progress" || !state.record) return;
  if (msg.nicheId !== state.nicheId) return;
  if (msg.promptId) {
    setStatus(`<span class="muted">Дозбираю Top Niche Insights: <b>${esc(TAB_OF[msg.promptId] || msg.promptId)}</b> (${msg.done + 1} з ${msg.total})… Не закривайте вікно.</span>`);
    renderTabs(state.record, msg.promptId);
  }
});

// ---- завантаження ----
btn.addEventListener("click", async () => {
  const rec = state.record;
  if (!rec || !rec.meta) return;
  btn.disabled = true;

  const have = Object.assign({}, rec.insights || {});
  const missing = INSIGHTS.map(([pid]) => pid).filter((pid) => !(have[pid] && have[pid].html));
  const dbg = {
    passiveInsights: Object.keys(have).filter((k) => have[k] && have[k].html).length,
    missingCount: missing.length,
    activeTabId: state.tab && state.tab.id,
    steps: [],
  };

  if (missing.length) {
    setStatus(`<span class="muted">Дозбираю Top Niche Insights (${missing.length}) по одному, з паузами — так надійніше. Не закривайте вікно…</span>`);
    try {
      const tabId = state.tab.id;
      await askBridge(tabId, { type: "poea:ping" }, 3000);
      const resp = await askBridge(tabId, {
        type: "poea:collect",
        nicheId: rec.meta.nicheId,
        obfuscatedMarketplaceId: rec.meta.obfuscatedMarketplaceId,
        promptIds: missing,
      }, COLLECT_TIMEOUT_MS);
      if (resp && resp.error) dbg.collectError = resp.error;
      if (resp && resp.steps) dbg.steps = resp.steps;
      if (resp) { dbg.templateUsed = !!resp.templateUsed; if (resp.rejected) dbg.rejected = resp.rejected; }
      dbg.collectResponse = resp && resp.insights
        ? Object.keys(resp.insights).map((k) => k + "=" + (resp.insights[k].error ? "ERR:" + resp.insights[k].error : "ok/" + (resp.insights[k].html || "").length))
        : (resp ? "no insights key" : "null response");
      if (resp && resp.insights) Object.keys(resp.insights).forEach((k) => { if (resp.insights[k].html) have[k] = resp.insights[k]; });
    } catch (e) {
      dbg.collectError = String(e);
      if (/Receiving end does not exist|Could not establish connection/i.test(String(e))) dbg.needsReload = true;
    }
  }

  rec.insights = have;
  state.byNiche[state.nicheId] = rec;
  dbg.insightsFinal = countInsights(rec);

  download(buildOutput(rec, have, dbg), filenameFor(rec));
  renderMain();

  if (dbg.collectError) {
    statusEl.innerHTML += `<div class="hint err">${dbg.needsReload
      ? "Дозбір не вдався: сторінку ніші було відкрито до встановлення/оновлення розширення. Оновіть її (F5), дочекайтеся завантаження і завантажте ще раз."
      : "Дозбір не вдався (" + esc(dbg.collectError) + "). Файл збережено з тим, що вже спіймано."}</div>`;
  } else if (dbg.rejected) {
    statusEl.innerHTML += `<div class="hint err">Amazon відхилив запит Insights на цьому маркетплейсі (${esc(dbg.rejected)}), решту запитів не надсилав. ` +
      "Якщо на сторінці ніші є блок Top Niche Insights — відкрийте вручну будь-яку його вкладку і дочекайтеся тексту. " +
      "Розширення запам'ятає справжній формат запиту цього маркетплейсу, і наступне «Завантажити JSON» дозбере решту. " +
      "Якщо блоку немає — Insights тут недоступні, а всі інші дані ніші у файлі є.</div>";
  } else if (missing.length && dbg.insightsFinal < 6) {
    const failed = (Array.isArray(dbg.collectResponse) ? dbg.collectResponse : []).filter((s) => s.includes("ERR")).join(", ");
    statusEl.innerHTML += `<div class="hint err">Частину вкладок Amazon не віддав (${esc(failed)}). Спробуйте ще раз за хвилину — дозбираються лише відсутні.</div>`;
  }
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Видалити всі збережені ніші з пам'яті розширення?")) return;
  await writeStore({});
  state.byNiche = {};
  init();
});

init();
