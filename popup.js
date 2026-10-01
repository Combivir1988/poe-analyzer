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
    noData("Тут немає однієї ніші, але можна зібрати кілька ніш зі сторінки одразу.");
    btn.hidden = true;
    renderOthers();
    await initBatch();
    return;
  }
  const rec = state.byNiche[state.nicheId];
  if (!rec || !rec.meta || !rec.data) {
    try {
      const pong = await askBridge(state.tab.id, { type: "poea:ping" }, 3000);
      if (pong && pong.writeError) {
        noData("Дані ніші спіймано, але не записано: " + pong.writeError + ". Натисніть «Очистити» внизу й оновіть сторінку (F5).", "err");
        renderOthers();
        return;
      }
    } catch (e) { /* немає моста */ }
    noData("Дані цієї ніші ще не спіймано. Оновіть сторінку (F5), дочекайтеся завантаження і відкрийте вікно знову.");
    renderOthers();
    return;
  }
  state.record = rec;
  renderMain();
  renderOthers();
  try {
    const pong = await askBridge(state.tab.id, { type: "poea:ping" }, 3000);
    if (pong && pong.writeError) statusEl.innerHTML += `<div class="hint err">Розширення не може записати дані: ${esc(pong.writeError)}. Натисніть «Очистити» внизу й оновіть сторінку.</div>`;
    statusEl.innerHTML += pong && pong.hasNicheTemplate
      ? '<div class="hint ok">✓ Формат запиту ніші збережено — на сторінці пошуку можна збирати кілька ніш одразу.</div>'
      : '<div class="hint">Формат запиту ще не збережено: оновіть цю сторінку (F5) і дочекайтеся завантаження.</div>';
  } catch (e) { /* немає моста — підказка нижче при завантаженні */ }
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
      if (resp) {
        dbg.templateUsed = !!resp.templateUsed;
        if (resp.rejected) dbg.rejected = resp.rejected;
        if (resp.amazonMessage) dbg.amazonMessage = resp.amazonMessage;
        if (resp.unavailable) dbg.insightsUnavailable = true;
        if (resp.pageRequests) dbg.pageRequests = resp.pageRequests;
      }
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
  } else if (dbg.insightsUnavailable) {
    statusEl.innerHTML += `<div class="hint">Top Niche Insights на цьому маркетплейсі Amazon не надає (відповідь: «${esc(dbg.amazonMessage || "Unsupported Locale")}»). ` +
      "Файл містить усі інші дані ніші. Наступного разу розширення не витрачатиме на Insights жодного запиту.</div>";
  } else if (dbg.rejected) {
    const pageFailed = (dbg.pageRequests || []).filter((x) => x.status && x.status !== 200).length;
    const pageOk = (dbg.pageRequests || []).filter((x) => x.status === 200).length;
    statusEl.innerHTML += `<div class="hint err">Amazon відхилив запит Insights на цьому маркетплейсі (${esc(dbg.rejected)}), решту запитів не надсилав.` +
      (dbg.amazonMessage ? ` Відповідь Amazon: «${esc(dbg.amazonMessage)}».` : "") +
      (pageFailed && !pageOk ? ` Сама сторінка теж отримала відмову (${pageFailed}×) — схоже, на цьому маркетплейсі Insights недоступні.` : "") +
      " " +
      "Якщо на сторінці ніші є блок Top Niche Insights — відкрийте вручну будь-яку його вкладку і дочекайтеся тексту. " +
      "Розширення запам'ятає справжній формат запиту цього маркетплейсу, і наступне «Завантажити JSON» дозбере решту. " +
      "Якщо блоку немає — Insights тут недоступні, а всі інші дані ніші у файлі є.</div>";
  } else if (missing.length && dbg.insightsFinal < 6) {
    const failed = (Array.isArray(dbg.collectResponse) ? dbg.collectResponse : []).filter((s) => s.includes("ERR")).join(", ");
    statusEl.innerHTML += `<div class="hint err">Частину вкладок Amazon не віддав (${esc(failed)}). Спробуйте ще раз за хвилину — дозбираються лише відсутні.</div>`;
  }
});

// ---- пакетний збір ніш зі сторінки пошуку / списку ----
const BATCH_KEY = "poea_batch";
const BATCH_MAX = 8;
const batchEl = $("batch");
const batchList = $("batchList");
const batchHint = $("batchHint");
const batchStartBtn = $("batchStart");
const batchProg = $("batchProg");
const batchStopBtn = $("batchStop");
const batchDlBtn = $("batchDownload");
const ST = { queued: "у черзі", niche: "дані ніші…", insights: "Insights…", ok: "готово", error: "помилка" };

const checkedNiches = () => Array.from(batchList.querySelectorAll("input[type=checkbox]:checked")).map((c) => ({
  nicheId: c.dataset.nid, title: c.dataset.title || null, obfuscatedMarketplaceId: c.dataset.mkt || null,
}));

const updateStartBtn = () => {
  const n = checkedNiches().length;
  if (batchStartBtn.dataset.mode === "prepare") {
    batchStartBtn.textContent = "Підготувати збір";
    batchStartBtn.disabled = !n || batchStartBtn.dataset.blocked === "1";
    return;
  }
  batchStartBtn.textContent = n ? `Зібрати вибрані (${n})` : "Зібрати вибрані";
  batchStartBtn.disabled = !n || batchStartBtn.dataset.blocked === "1";
};

const renderBatchState = (b) => {
  if (!b || !b.items) { batchProg.hidden = true; batchStopBtn.hidden = true; batchDlBtn.hidden = true; return; }
  const running = b.status === "running";
  batchProg.hidden = false;
  const head = running
    ? `Збираю ${Math.min(b.done + 1, b.total)} з ${b.total}${b.current ? ": <b>" + esc(b.current) + "</b>" : ""}… Попап можна закрити, вкладку — ні.`
    : (b.status === "done" ? `Готово: ${b.items.filter((x) => x.status === "ok").length} з ${b.total} ніш.`
      : b.status === "stopped" ? `Зупинено: зібрано ${b.items.filter((x) => x.status === "ok").length} з ${b.total}.`
      : `Помилка збору: ${esc(b.error || "")}`);
  batchProg.innerHTML = `<div>${head}</div>` + b.items.map((x) => `
    <div class="row"><span title="${esc(x.error || x.title)}">${esc(x.title)}</span>
    <span class="st">${esc(ST[x.status] || x.status)}${x.status === "ok" && b.withInsights ? " · " + x.insights + "/6" : ""}</span></div>`).join("") +
    (b.insightsUnavailable && b.withInsights ? `<div class="hint">Top Niche Insights на цьому маркетплейсі недоступні — зібрано решту даних.</div>` : "") +
    (b.items.some((x) => x.status === "error") ? `<div class="hint err">Помилка: ${esc((b.items.find((x) => x.status === "error") || {}).error || "")}</div>` : "");
  batchStopBtn.hidden = !running;
  batchStartBtn.dataset.blocked = running ? "1" : "";
  updateStartBtn();
  const okCount = b.items.filter((x) => x.status === "ok").length;
  batchDlBtn.hidden = running || !okCount;
  batchDlBtn.textContent = `Завантажити всі (${okCount} файлів)`;
};

async function initBatch() {
  let info = null;
  try { info = await askBridge(state.tab.id, { type: "poea:list" }, 5000); }
  catch (e) {
    batchEl.hidden = false;
    batchHint.innerHTML = '<span class="err">Розширення ще не підключене до цієї вкладки — оновіть сторінку (F5) і відкрийте вікно знову.</span>';
    batchStartBtn.hidden = true;
    return;
  }
  batchEl.hidden = false;
  const niches = (info && info.niches) || [];
  if (info.writeError) {
    batchHint.innerHTML = `<span class="err">Розширення не може записати дані: ${esc(info.writeError)}. Натисніть «Очистити» внизу, оновіть сторінку (F5) і спробуйте знову.</span>`;
    batchStartBtn.dataset.blocked = "1";
  } else if (!info.hasTemplate && niches.length) {
    batchHint.innerHTML = "Спершу розширенню треба один раз побачити, як сторінка завантажує нішу. " +
      "Натисніть <b>«Підготувати збір»</b> — воно відкриє першу нішу у фоновій вкладці, запам'ятає формат і закриє її (до 40 с).";
    batchStartBtn.dataset.mode = "prepare";
  } else if (!info.hasTemplate) {
    batchHint.innerHTML = "Відкрийте будь-яку нішу на цьому маркетплейсі й дочекайтеся завантаження, потім поверніться сюди.";
    batchStartBtn.dataset.blocked = "1";
  } else if (!niches.length) {
    batchHint.textContent = "На сторінці не знайдено посилань на ніші. Відкрийте пошук або список ніш і дочекайтеся таблиці.";
    batchStartBtn.dataset.blocked = "1";
  } else {
    batchHint.innerHTML = `Знайдено ніш на сторінці: <b>${niches.length}</b>. За раз — до ${BATCH_MAX}, по одній, з паузами 3–6 с` +
      " (з Insights ~30–40 с на нішу). Старіші збережені ніші понад 8 витіснятимуться.";
  }
  if (info.insightsUnavailable) $("batchInsights").checked = false;
  batchList.innerHTML = niches.map((n, i) => `
    <label class="row"><input type="checkbox" data-nid="${esc(n.nicheId)}" data-title="${esc(n.title || "")}" data-mkt="${esc(n.obfuscatedMarketplaceId || "")}" ${i < BATCH_MAX ? "checked" : ""}>
    <span title="${esc(n.title || n.nicheId)}">${esc(n.title || n.nicheId)}</span></label>`).join("");
  batchList.hidden = !niches.length;
  batchList.querySelectorAll("input").forEach((c) => c.addEventListener("change", () => {
    if (checkedNiches().length > BATCH_MAX) c.checked = false;
    updateStartBtn();
  }));
  renderBatchState(info.batch);
  updateStartBtn();
}

// Відкрити першу вибрану нішу у фоновій вкладці, дочекатися запису шаблону getNiche, закрити вкладку.
async function prepareTemplate(niche) {
  const origin = new URL(state.tab.url).origin;
  const url = origin + "/opportunity-explorer/explore/niche/" + encodeURIComponent(niche.nicheId) + "/insights-trends";
  batchStartBtn.disabled = true;
  batchStartBtn.textContent = "Готую… (до 40 с)";
  batchHint.innerHTML = `Відкриваю «${esc(niche.title || niche.nicheId)}» у фоновій вкладці…`;
  const bg = await new Promise((resolve) => chrome.tabs.create({ url, active: false }, resolve));
  const ok = await new Promise((resolve) => {
    const done = (v) => { chrome.storage.onChanged.removeListener(onCh); clearTimeout(t); resolve(v); };
    const onCh = (changes, area) => {
      const tpl = area === "local" && changes.poea_niche_tpl && changes.poea_niche_tpl.newValue;
      if (tpl && tpl[origin]) done(true);
    };
    const t = setTimeout(() => done(false), 40000);
    chrome.storage.onChanged.addListener(onCh);
  });
  try { chrome.tabs.remove(bg.id); } catch (e) { /* ignore */ }
  if (ok) {
    batchStartBtn.dataset.mode = "";
    batchHint.innerHTML = '<span class="ok">✓ Формат запиту ніші збережено.</span> Тепер можна збирати.';
  } else {
    batchHint.innerHTML = '<span class="err">Не вдалося: фонова сторінка ніші за 40 с не віддала дані. ' +
      "Відкрийте цю нішу вручну, дочекайтеся графіків і подивіться в попапі на ній, що він пише — надішліть скриншот.</span>";
  }
  updateStartBtn();
}

batchStartBtn.addEventListener("click", async () => {
  const niches = checkedNiches();
  if (!niches.length) return;
  if (batchStartBtn.dataset.mode === "prepare") { await prepareTemplate(niches[0]); return; }
  batchStartBtn.disabled = true;
  try {
    const r = await askBridge(state.tab.id, { type: "poea:batchStart", niches, withInsights: $("batchInsights").checked }, 5000);
    if (r && r.error) batchHint.innerHTML = `<span class="err">Не вдалося почати: ${esc(r.error === "busy" ? "уже йде збір" : r.error === "no-template" ? "спершу відкрийте одну нішу на цьому маркетплейсі" : r.error)}</span>`;
  } catch (e) {
    batchHint.innerHTML = `<span class="err">Не вдалося почати: ${esc(String(e))}. Оновіть сторінку (F5).</span>`;
  }
  updateStartBtn();
});

batchStopBtn.addEventListener("click", async () => {
  try { await askBridge(state.tab.id, { type: "poea:batchStop" }, 3000); } catch (e) { /* ignore */ }
  batchStopBtn.disabled = true;
});

batchDlBtn.addEventListener("click", async () => {
  const b = await new Promise((resolve) => chrome.storage.local.get(BATCH_KEY, (r) => resolve(r && r[BATCH_KEY])));
  const store = await readStore();
  const recs = ((b && b.items) || []).filter((x) => x.status === "ok").map((x) => store[x.nicheId]).filter((r) => r && r.meta && r.data);
  for (const r of recs) {
    const got = countInsights(r);
    download(buildOutput(r, r.insights || {}, { batch: true, insightsFinal: got, missingCount: 6 - got }), filenameFor(r));
    await new Promise((res) => setTimeout(res, 400));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[BATCH_KEY] && !batchEl.hidden) renderBatchState(changes[BATCH_KEY].newValue);
  if (changes.poea_niches) { readStore().then((s2) => { state.byNiche = s2; renderOthers(); }); }
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Видалити всі збережені ніші з пам'яті розширення?")) return;
  await writeStore({});
  state.byNiche = {};
  init();
});

init();
