// POE Analyzer — міст (ISOLATED world, document_start).
//
// 1) Приймає від interceptor.js (MAIN world) пасивно спіймані дані ніші та HTML
//    вкладок Top Niche Insights і складає їх у chrome.storage.local ПО nicheId
//    (останні MAX_NICHES ніш).
// 2) На запит попапу дозбирає відсутні вкладки Top Niche Insights для ніші,
//    відкритої в цій вкладці: послідовно, з людськими паузами, від сесії користувача.
//    Amazon тротлить паралельні запити до growth-ендпоїнта і віддає порожні
//    відповіді, тому паралельно не робимо ніколи.
(() => {
  const MARK = "__poeAnalyzer";
  const STORE_KEY = "poea_niches";
  const MAX_NICHES = 8;
  const SCHEMA_VERSION = 1;
  const SOURCE = "POE getNiche + Top Niche Insights (ox-api/graphql, insightswidget-api/growth)";
  const GROWTH_URL = window.location.origin + "/insightswidget-api/growth";

  const REQUEST_TIMEOUT_MS = 45000;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2500;
  const GAP_MIN_MS = 1200;
  const GAP_MAX_MS = 2800;

  const nowIso = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  let cache = {}; // nicheId -> { meta, variables, data, insights, updatedAt }
  let collecting = null; // nicheId, для якого зараз іде дозбір

  // ---- storage ----
  const readStore = () => new Promise((resolve) => {
    try { chrome.storage.local.get(STORE_KEY, (r) => resolve((r && r[STORE_KEY]) || {})); }
    catch (e) { resolve({}); }
  });
  const writeStore = (obj) => new Promise((resolve) => {
    try { chrome.storage.local.set({ [STORE_KEY]: obj }, () => resolve()); }
    catch (e) { resolve(); }
  });

  // Злиття двох записів однієї ніші: база — свіжіший; інсайти об'єднуються,
  // запис із текстом завжди важливіший за запис із помилкою.
  const mergeRecord = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const ts = (x) => String((x && x.updatedAt) || "");
    const base = ts(b) >= ts(a) ? b : a;
    const other = base === b ? a : b;
    const insights = Object.assign({}, other.insights || {}, base.insights || {});
    Object.keys(other.insights || {}).forEach((k) => {
      const o = other.insights[k];
      if (o && o.html && !(insights[k] && insights[k].html)) insights[k] = o;
    });
    return Object.assign({}, base, {
      meta: base.meta || other.meta || null,
      variables: base.variables || other.variables || null,
      data: base.data || other.data || null,
      insights,
    });
  };

  const mergeAll = (a, b) => {
    const out = Object.assign({}, a);
    Object.keys(b || {}).forEach((k) => { out[k] = mergeRecord(out[k], b[k]); });
    return out;
  };

  const trim = (map) => {
    const entries = Object.entries(map).sort((x, y) => String(y[1].updatedAt || "").localeCompare(String(x[1].updatedAt || "")));
    const kept = {};
    entries.slice(0, MAX_NICHES).forEach(([k, v]) => { kept[k] = v; });
    return kept;
  };

  // Кожна вкладка тримає свою копію cache → пишемо тільки через read-merge-write,
  // щоб вкладка зі старим знімком не затерла ніші, спіймані іншими вкладками.
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(async () => {
      const stored = await readStore();
      const merged = Object.assign({}, stored);
      Object.keys(cache).forEach((k) => { merged[k] = mergeRecord(stored[k], cache[k]); });
      cache = trim(merged);
      await writeStore(cache);
    }).catch(() => {});
    return chain;
  };

  readStore().then((s) => { cache = mergeAll(cache, s); });

  // ---- пасивний прийом ----
  const pickNonNull = (obj) => {
    const out = {};
    Object.keys(obj || {}).forEach((k) => { if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  };

  const handleNiche = (m) => {
    const data = m.data || {};
    const niche = data.niche || null;
    if (!niche || !niche.nicheId) return;
    const nid = niche.nicheId;
    const prev = cache[nid] || {};
    // getNiche може приходити кілька разів з різним набором полів — доливаємо,
    // а не затираємо: старі непорожні поля зберігаються.
    const prevNiche = prev.data && prev.data.niche ? prev.data.niche : {};
    const mergedNiche = Object.assign({}, prevNiche, pickNonNull(niche));
    const mergedData = Object.assign({}, prev.data || {}, data, { niche: mergedNiche });
    cache[nid] = {
      meta: {
        capturedAt: nowIso(),
        nicheId: nid,
        nicheTitle: mergedNiche.nicheTitle || (prev.meta && prev.meta.nicheTitle) || "niche",
        obfuscatedMarketplaceId: mergedNiche.obfuscatedMarketplaceId || (prev.meta && prev.meta.obfuscatedMarketplaceId) || null,
        pageUrl: m.pageUrl || window.location.href,
        schemaVersion: SCHEMA_VERSION,
        source: SOURCE,
      },
      variables: m.variables || prev.variables || null,
      data: mergedData,
      insights: prev.insights || {},
      updatedAt: nowIso(),
    };
    persist();
  };

  const handleInsight = (m) => {
    const nid = m.nicheId;
    if (!nid || !m.promptId || !m.html) return;
    if (!cache[nid]) cache[nid] = { meta: null, variables: null, data: null, insights: {}, updatedAt: nowIso() };
    cache[nid].insights = cache[nid].insights || {};
    cache[nid].insights[m.promptId] = { capturedAt: nowIso(), html: m.html, via: "passive" };
    cache[nid].updatedAt = nowIso();
    persist();
  };

  // ---- шаблон growth-запиту, підглянутий у самої сторінки (по origin) ----
  // Маркетплейси відрізняються формою запиту (на .co.uk типове тіло дає 400),
  // тому дозбір повторює саме той запит, який сторінка вже успішно зробила.
  const TPL_KEY = "poea_growth_tpl";
  const UNSUP_KEY = "poea_insights_unavailable";
  const ORIGIN = window.location.origin;
  const readTemplates = () => new Promise((resolve) => {
    try { chrome.storage.local.get(TPL_KEY, (r) => resolve((r && r[TPL_KEY]) || {})); } catch (e) { resolve({}); }
  });
  const handleTemplate = async (m) => {
    if (!m.url || !m.body || typeof m.body !== "object") return;
    const all = await readTemplates();
    all[ORIGIN] = { url: m.url, method: m.method || "POST", headers: m.headers || {}, body: m.body, capturedAt: nowIso() };
    try { chrome.storage.local.set({ [TPL_KEY]: all }); } catch (e) { /* ignore */ }
  };

  // Журнал власних growth-запитів сторінки (останні 10): чи вдалось їй самій завантажити Insights.
  const pageLog = [];
  const handlePageGrowth = (m) => {
    pageLog.push({ at: nowIso(), status: m.status, promptId: m.promptId || null, message: m.message || undefined });
    while (pageLog.length > 10) pageLog.shift();
  };

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m[MARK] !== true) return;
    if (m.kind === "niche") handleNiche(m);
    else if (m.kind === "insight") handleInsight(m);
    else if (m.kind === "growthTemplate") handleTemplate(m);
    else if (m.kind === "pageGrowth") handlePageGrowth(m);
    else if (m.kind === "nicheTemplate") handleNicheTemplate(m);
    else if (m.kind === "nicheRefs") handleRefs(m);
  });

  // ---- активний дозбір відсутніх інсайтів (на запит попапу) ----
  // CSRF-токен Seller Central, якщо сторінка його публікує (запасний шлях без шаблону).
  const csrfToken = () => {
    try {
      const el = document.querySelector('meta[name="anti-csrftoken-a2z"], meta[name="csrf-token"]');
      return el ? el.getAttribute("content") : null;
    } catch (e) { return null; }
  };

  const buildRequest = (tpl, promptId, nicheId, obfuscatedMarketplaceId) => {
    if (tpl) {
      const body = JSON.parse(JSON.stringify(tpl.body));
      body.promptContext = body.promptContext || {};
      body.promptContext.promptId = promptId;
      body.promptContext.context = body.promptContext.context || {};
      body.promptContext.context.nicheId = nicheId;
      if (obfuscatedMarketplaceId) body.promptContext.context.obfuscatedMarketplaceId = obfuscatedMarketplaceId;
      const headers = Object.assign({ "content-type": "application/json" }, tpl.headers || {});
      return { url: tpl.url, method: tpl.method || "POST", headers, body };
    }
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const t = csrfToken();
    if (t) headers["anti-csrftoken-a2z"] = t;
    return {
      url: GROWTH_URL,
      method: "POST",
      headers,
      body: {
        widgetContext: { from: "OX_WIDGET", to: "GROWTH_AGENT" },
        promptContext: { promptId, context: { nicheId, obfuscatedMarketplaceId } },
      },
    };
  };

  // Текст пояснення з відповіді growth-агента (messages[].payload / message / errors), без HTML.
  const amazonMessage = (raw) => {
    const j = (() => { try { return JSON.parse(raw); } catch (e) { return null; } })();
    if (!j) return "";
    const parts = [];
    (Array.isArray(j.messages) ? j.messages : []).forEach((m) => {
      if (!m) return;
      ["payload", "text", "message", "errorMessage"].forEach((k) => { if (typeof m[k] === "string") parts.push(m[k]); });
      if (m.type) parts.push("[" + m.type + "]");
    });
    ["message", "errorMessage", "error", "errorCode", "code", "reason"].forEach((k) => { if (typeof j[k] === "string") parts.push(j[k]); });
    if (Array.isArray(j.errors)) j.errors.forEach((e) => { if (e && e.message) parts.push(e.message); });
    return parts.join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  };

  const fetchInsight = async (req) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(req.url, {
        method: req.method,
        credentials: "include",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        let detail = "";
        let message = "";
        try {
          const raw = await r.text();
          detail = raw.replace(/\s+/g, " ").slice(0, 3000);
          message = amazonMessage(raw);
        } catch (e) { /* ignore */ }
        return { error: "http " + r.status, status: r.status, detail, message };
      }
      const j = await r.json();
      const msgs = j && Array.isArray(j.messages) ? j.messages : [];
      const html = msgs.map((x) => (x && typeof x.payload === "string" ? x.payload : "")).filter(Boolean).join("\n");
      return html ? { html } : { error: "empty" };
    } catch (e) {
      clearTimeout(timer);
      return { error: e && e.name === "AbortError" ? "timeout" : String(e) };
    }
  };

  // 400/401/403/404 від повтору нічого не виграють — повторюємо лише порожнє, 429, 5xx, таймаут.
  const retryable = (res) => !res.status || res.status === 429 || res.status >= 500;

  const notify = (payload) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: "poea:progress" }, payload), () => void chrome.runtime.lastError);
    } catch (e) { /* попап закрито — ок */ }
  };

  // Дозбір відсутніх Insights для однієї ніші. Захист від паралельних запусків — у викликачів.
  const runCollect = async ({ nicheId, obfuscatedMarketplaceId, promptIds }) => {
    const ids = Array.isArray(promptIds) ? promptIds : [];
    const insights = {};
    const steps = [];
    if (!ids.length) return { insights, steps };
    const tpl = (await readTemplates())[ORIGIN] || null;
    // Маркетплейс, де Amazon уже сказав «Unsupported Locale», більше не питаємо.
    const unsupported = await new Promise((resolve) => {
      try { chrome.storage.local.get(UNSUP_KEY, (r) => resolve(((r && r[UNSUP_KEY]) || {})[ORIGIN] || null)); } catch (e) { resolve(null); }
    });
    if (unsupported && !tpl) {
      ids.forEach((pid) => { insights[pid] = { error: "unavailable on this marketplace", via: "active" }; });
      return { insights, steps, unavailable: true, amazonMessage: unsupported.message };
    }
    let rejected = null; // перша «тверда» відмова без шаблону — далі не стукаємо
    try {
      for (let i = 0; i < ids.length; i++) {
        const pid = ids[i];
        if (rejected) { insights[pid] = { error: "skipped (" + rejected + ")", via: "active" }; continue; }
        notify({ nicheId, promptId: pid, done: i, total: ids.length });
        const req = buildRequest(tpl, pid, nicheId, obfuscatedMarketplaceId);
        let entry = { error: "no-response", via: "active" };
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const t0 = Date.now();
          const res = await fetchInsight(req);
          steps.push({
            promptId: pid, attempt, ms: Date.now() - t0,
            status: res.html ? "ok" : res.error, len: res.html ? res.html.length : 0,
            template: !!tpl, detail: res.detail || undefined, message: res.message || undefined,
          });
          if (res.html) { entry = { capturedAt: nowIso(), html: res.html, via: "active" }; break; }
          entry = { error: res.error, via: "active" };
          if (!retryable(res)) {
            if (!tpl && res.status >= 400 && res.status < 500) rejected = res.error;
            break;
          }
          if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        }
        insights[pid] = entry;
        if (!rejected && i < ids.length - 1) await sleep(jitter(GAP_MIN_MS, GAP_MAX_MS));
      }
      // Успішно дозібране зберігаємо: повторне завантаження не ганяє запити знову.
      const rec = cache[nicheId];
      if (rec) {
        rec.insights = rec.insights || {};
        Object.keys(insights).forEach((pid) => { if (insights[pid].html) rec.insights[pid] = insights[pid]; });
        rec.updatedAt = nowIso();
        await persist();
      }
      notify({ nicheId, done: ids.length, total: ids.length });
      const amazonSays = (steps.find((x) => x.message) || {}).message;
      const unavailable = !!(amazonSays && /unsupported\s*locale/i.test(amazonSays));
      if (unavailable) {
        try {
          chrome.storage.local.get(UNSUP_KEY, (r) => {
            const all = (r && r[UNSUP_KEY]) || {};
            all[ORIGIN] = { message: amazonSays, at: nowIso() };
            chrome.storage.local.set({ [UNSUP_KEY]: all });
          });
        } catch (e) { /* ignore */ }
      }
      return { insights, steps, templateUsed: !!tpl, rejected: rejected || undefined, amazonMessage: amazonSays, unavailable, pageRequests: pageLog.slice() };
    } finally { /* стан collecting веде викликач */ }
  };

  const collectMissing = async (args) => {
    if (collecting) return { insights: {}, steps: [], error: "busy" };
    collecting = args.nicheId;
    try { return await runCollect(args); } finally { collecting = null; }
  };

  // ---- пакетний збір кількох ніш зі сторінки пошуку ----
  // Кожну нішу запитуємо тим самим getNiche, яким сторінка відкриває нішу сама
  // (шаблон запам'ятовується при першому відкритті будь-якої ніші на цьому домені),
  // строго по одній, з людськими паузами. Стан черги — у storage, щоб попап можна було закрити.
  const NICHE_TPL_KEY = "poea_niche_tpl";
  const BATCH_KEY = "poea_batch";
  const BATCH_MAX = MAX_NICHES;
  const NICHE_GAP_MIN_MS = 3000;
  const NICHE_GAP_MAX_MS = 6000;
  const ALL_PROMPTS = [
    "OX_NICHE_MARKET_POTENTIAL_PROMPT", "OX_NICHE_PRODUCT_FEATURE_EXTRACTOR_PROMPT", "OX_NICHE_REVIEWS_ANALYZER_PROMPT",
    "OX_NICHE_CUSTOMER_DEMOGRAPHICS_PROMPT", "OX_NICHE_SEARCH_TERMS_PROMPT", "OX_NICHE_PRICING_ANALYSIS_PROMPT",
  ];

  const getKey = (key) => new Promise((resolve) => {
    try { chrome.storage.local.get(key, (r) => resolve((r && r[key]) || null)); } catch (e) { resolve(null); }
  });
  const setKey = (key, val) => new Promise((resolve) => {
    try { chrome.storage.local.set({ [key]: val }, () => resolve()); } catch (e) { resolve(); }
  });

  const handleNicheTemplate = async (m) => {
    if (!m.url || !m.body || !m.nicheId) return;
    const all = (await getKey(NICHE_TPL_KEY)) || {};
    all[ORIGIN] = { url: m.url, method: m.method || "POST", headers: m.headers || {}, body: m.body,
      nicheId: m.nicheId, obfuscatedMarketplaceId: m.obfuscatedMarketplaceId || null, capturedAt: nowIso() };
    await setKey(NICHE_TPL_KEY, all);
  };

  // nicheId → { nicheId, title, obfuscatedMarketplaceId, href }, з відповідей сторінки
  const refs = new Map();
  const handleRefs = (m) => {
    (m.refs || []).forEach((r) => {
      if (!r || !r.nicheId) return;
      const prev = refs.get(r.nicheId) || {};
      refs.set(r.nicheId, { nicheId: r.nicheId, title: r.title || prev.title || null,
        obfuscatedMarketplaceId: r.obfuscatedMarketplaceId || prev.obfuscatedMarketplaceId || null, href: window.location.href });
    });
  };

  const nicheIdFromHref = (href) => { const x = String(href || "").match(/\/niche\/([^/?#]+)/); return x ? decodeURIComponent(x[1]) : null; };

  // Ніші на поточній сторінці: посилання в таблиці + те, що прийшло у відповідях саме на цій сторінці.
  const listNiches = async () => {
    const out = new Map();
    try {
      document.querySelectorAll('a[href*="/niche/"]').forEach((a) => {
        const id = nicheIdFromHref(a.getAttribute("href"));
        if (!id) return;
        const title = (a.textContent || "").replace(/\s+/g, " ").trim();
        const prev = out.get(id);
        if (!prev || (!prev.title && title)) out.set(id, { nicheId: id, title: title || (prev && prev.title) || null });
      });
    } catch (e) { /* ignore */ }
    refs.forEach((r) => {
      if (r.href !== window.location.href) return;
      const prev = out.get(r.nicheId);
      out.set(r.nicheId, { nicheId: r.nicheId, title: (prev && prev.title) || r.title || null, obfuscatedMarketplaceId: r.obfuscatedMarketplaceId });
    });
    const current = nicheIdFromHref(window.location.href);
    if (current) out.delete(current);
    const tpl = ((await getKey(NICHE_TPL_KEY)) || {})[ORIGIN] || null;
    const unsup = ((await getKey(UNSUP_KEY)) || {})[ORIGIN] || null;
    return { niches: Array.from(out.values()), hasTemplate: !!tpl, insightsUnavailable: !!unsup, batch: await getKey(BATCH_KEY) };
  };

  // Замінити всі входження рядка from на to у глибокій копії.
  const substitute = (obj, from, to) => {
    if (!from || from === to) return JSON.parse(JSON.stringify(obj));
    const walk = (o) => {
      if (typeof o === "string") return o === from ? to : o;
      if (Array.isArray(o)) return o.map(walk);
      if (o && typeof o === "object") { const r = {}; Object.keys(o).forEach((k) => { r[k] = walk(o[k]); }); return r; }
      return o;
    };
    return walk(obj);
  };

  const fetchNiche = async (tpl, nicheId, mkt) => {
    let body = substitute(tpl.body, tpl.nicheId, nicheId);
    if (mkt && tpl.obfuscatedMarketplaceId) body = substitute(body, tpl.obfuscatedMarketplaceId, mkt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(tpl.url, {
        method: tpl.method || "POST", credentials: "include",
        headers: Object.assign({ "content-type": "application/json" }, tpl.headers || {}),
        body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      if (!r.ok) return { error: "http " + r.status, status: r.status, detail: text.replace(/\s+/g, " ").slice(0, 500) };
      const j = JSON.parse(text);
      if (j && j.data && j.data.niche && j.data.niche.nicheId) return { data: j.data, variables: body.variables || null };
      const err = j && Array.isArray(j.errors) && j.errors[0] && j.errors[0].message;
      return { error: err ? "graphql: " + err : "empty" };
    } catch (e) {
      clearTimeout(timer);
      return { error: e && e.name === "AbortError" ? "timeout" : String(e) };
    }
  };

  let batchStop = false;
  const saveBatch = (state) => setKey(BATCH_KEY, Object.assign({}, state, { updatedAt: nowIso() }));

  const runBatch = async ({ niches, withInsights }) => {
    const tpl = ((await getKey(NICHE_TPL_KEY)) || {})[ORIGIN];
    const list = (niches || []).slice(0, BATCH_MAX);
    const state = {
      origin: ORIGIN, status: "running", startedAt: nowIso(), withInsights: !!withInsights,
      total: list.length, done: 0, current: null,
      items: list.map((n) => ({ nicheId: n.nicheId, title: n.title || n.nicheId, status: "queued", insights: 0 })),
    };
    batchStop = false;
    await saveBatch(state);
    let insightsOff = !!(((await getKey(UNSUP_KEY)) || {})[ORIGIN]);
    try {
      for (let i = 0; i < list.length; i++) {
        if (batchStop) { state.status = "stopped"; break; }
        const n = list[i];
        const item = state.items[i];
        state.current = item.title;
        item.status = "niche";
        await saveBatch(state);

        const mkt = n.obfuscatedMarketplaceId || tpl.obfuscatedMarketplaceId;
        let res = await fetchNiche(tpl, n.nicheId, mkt);
        if (res.error && (!res.status || res.status === 429 || res.status >= 500)) {
          await sleep(RETRY_DELAY_MS * 2);
          res = await fetchNiche(tpl, n.nicheId, mkt);
        }
        if (res.error) {
          item.status = "error";
          item.error = res.error + (res.detail ? " — " + res.detail.slice(0, 200) : "");
        } else {
          handleNiche({
            data: res.data, variables: res.variables,
            pageUrl: ORIGIN + "/opportunity-explorer/explore/niche/" + encodeURIComponent(n.nicheId) + "/insights-trends",
          });
          await persist();
          const nid = res.data.niche.nicheId;
          item.nicheId = nid;
          item.title = res.data.niche.nicheTitle || item.title;
          item.status = "ok";
          if (withInsights && !insightsOff && !batchStop) {
            item.status = "insights";
            await saveBatch(state);
            const have = (cache[nid] && cache[nid].insights) || {};
            const missing = ALL_PROMPTS.filter((pid) => !(have[pid] && have[pid].html));
            const ins = await runCollect({ nicheId: nid, obfuscatedMarketplaceId: res.data.niche.obfuscatedMarketplaceId, promptIds: missing });
            if (ins.unavailable) insightsOff = true;
            item.status = "ok";
          }
          const rec = cache[nid];
          item.insights = rec && rec.insights ? ALL_PROMPTS.filter((pid) => rec.insights[pid] && rec.insights[pid].html).length : 0;
        }
        state.done = i + 1;
        state.insightsUnavailable = insightsOff;
        await saveBatch(state);
        if (i < list.length - 1 && !batchStop) await sleep(jitter(NICHE_GAP_MIN_MS, NICHE_GAP_MAX_MS));
      }
      if (state.status === "running") state.status = "done";
    } catch (e) {
      state.status = "error";
      state.error = String(e);
    } finally {
      state.current = null;
      state.finishedAt = nowIso();
      await saveBatch(state);
      collecting = null;
    }
  };

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || typeof req.type !== "string") return;
    if (req.type === "poea:ping") {
      sendResponse({ ok: true, origin: window.location.origin, href: window.location.href });
      return;
    }
    if (req.type === "poea:list") {
      listNiches().then(sendResponse).catch((e) => sendResponse({ niches: [], error: String(e) }));
      return true;
    }
    if (req.type === "poea:batchStart") {
      (async () => {
        if (collecting) return sendResponse({ error: "busy" });
        const tpl = ((await getKey(NICHE_TPL_KEY)) || {})[ORIGIN];
        if (!tpl) return sendResponse({ error: "no-template" });
        if (!Array.isArray(req.niches) || !req.niches.length) return sendResponse({ error: "empty" });
        collecting = "batch";
        runBatch(req); // іде у фоні на сторінці; прогрес — у storage
        sendResponse({ started: true });
      })();
      return true;
    }
    if (req.type === "poea:batchStop") {
      batchStop = true;
      sendResponse({ ok: true });
      return;
    }
    if (req.type === "poea:collect") {
      collectMissing(req).then(sendResponse).catch((e) => sendResponse({ insights: {}, steps: [], error: String(e) }));
      return true; // відповідь асинхронна
    }
  });
})();
