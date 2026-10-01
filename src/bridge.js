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
        pageUrl: window.location.href,
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

  const collectMissing = async ({ nicheId, obfuscatedMarketplaceId, promptIds }) => {
    const ids = Array.isArray(promptIds) ? promptIds : [];
    const insights = {};
    const steps = [];
    if (!ids.length) return { insights, steps };
    if (collecting) return { insights, steps, error: "busy" };
    collecting = nicheId;
    const tpl = (await readTemplates())[ORIGIN] || null;
    // Маркетплейс, де Amazon уже сказав «Unsupported Locale», більше не питаємо.
    const unsupported = await new Promise((resolve) => {
      try { chrome.storage.local.get(UNSUP_KEY, (r) => resolve(((r && r[UNSUP_KEY]) || {})[ORIGIN] || null)); } catch (e) { resolve(null); }
    });
    if (unsupported && !tpl) {
      collecting = null;
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
    } finally {
      collecting = null;
    }
  };

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || typeof req.type !== "string") return;
    if (req.type === "poea:ping") {
      sendResponse({ ok: true, origin: window.location.origin, href: window.location.href });
      return;
    }
    if (req.type === "poea:collect") {
      collectMissing(req).then(sendResponse).catch((e) => sendResponse({ insights: {}, steps: [], error: String(e) }));
      return true; // відповідь асинхронна
    }
  });
})();
