// POE Analyzer — пасивний спостерігач мережі (MAIN world, document_start).
//
// Ставиться раніше, ніж застосунок Product Opportunity Explorer ініціалізує свій
// мережевий шар, тому бачить усі його fetch/XHR. Читає ТІЛЬКИ відповіді, які
// сторінка й так завантажила у сесії користувача:
//   * /ox-api/graphql            operationName=getNiche  → дані ніші
//   * /insightswidget-api/*      promptId=OX_NICHE_*     → HTML вкладок Top Niche Insights
//     + робочий шаблон запиту (URL, заголовки, тіло) для дозбору на цьому маркетплейсі
// Своїх запитів не робить. Знайдене пересилає мосту (bridge.js) через postMessage.
(() => {
  if (window.__poeAnalyzerHooked) return;
  window.__poeAnalyzerHooked = true;

  const MARK = "__poeAnalyzer";
  const OX_PATH = "/ox-api/graphql";
  // Шлях growth-ендпоїнта може відрізнятися між маркетплейсами — ловимо весь
  // insightswidget-api, а належність до Top Niche Insights визначаємо по тілу.
  const GROWTH_PATH = "/insightswidget-api/";
  // Заголовки, які не можна або не треба повторювати з розширення.
  const SKIP_HEADERS = new Set(["content-length", "cookie", "host", "origin", "referer", "user-agent", "connection"]);
  const WANTED_OPS = new Set(["getNiche"]);
  const noop = () => {};

  const post = (payload) => {
    try {
      window.postMessage(Object.assign({ [MARK]: true }, payload), window.location.origin);
    } catch (e) { /* ignore */ }
  };
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const toStr = (b) => {
    if (b == null) return "";
    if (typeof b === "string") return b;
    try { return String(b); } catch (e) { return ""; }
  };
  const urlOf = (input) => {
    try { return typeof input === "string" ? input : (input && input.url) || ""; } catch (e) { return ""; }
  };
  const absUrl = (u) => { try { return new URL(u, window.location.href).href; } catch (e) { return u; } };
  const headersToObj = (h) => {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
      else if (Array.isArray(h)) h.forEach((pair) => { if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]); });
      else Object.keys(h).forEach((k) => { out[k.toLowerCase()] = String(h[k]); });
    } catch (e) { /* ignore */ }
    Object.keys(out).forEach((k) => { if (SKIP_HEADERS.has(k)) delete out[k]; });
    return out;
  };
  const interesting = (url) => url.includes(OX_PATH) || url.includes(GROWTH_PATH);

  const htmlFromGrowth = (json) => {
    const msgs = json && Array.isArray(json.messages) ? json.messages : [];
    return msgs
      .map((m) => (m && typeof m.payload === "string" ? m.payload : ""))
      .filter(Boolean)
      .join("\n");
  };

  // Повертає обробник відповіді для запиту, який нас цікавить, або null.
  // Будь-яка відповідь ox-api (пошук, категорії, «нещодавні») може містити посилання на ніші —
  // збираємо пари nicheId + назва, щоб попап міг запропонувати пакетний збір.
  const postRefs = (json) => {
    if (!json) return;
    const refs = [];
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 10 || refs.length > 200) return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof o.nicheId === "string" && !seen.has(o.nicheId)) {
        const title = o.nicheTitle || o.title || o.customerNeed || o.name || o.displayName || null;
        seen.add(o.nicheId);
        refs.push({ nicheId: o.nicheId, title: typeof title === "string" ? title : null,
          obfuscatedMarketplaceId: typeof o.obfuscatedMarketplaceId === "string" ? o.obfuscatedMarketplaceId : null });
      }
      Object.keys(o).forEach((k) => walk(o[k], depth + 1));
    };
    try { walk(json, 0); } catch (e) { /* ignore */ }
    if (refs.length) post({ kind: "nicheRefs", refs });
  };

  // meta = { headers, method } — щоб запам'ятати справжній формат запиту сторінки.
  const classify = (url, bodyStr, meta) => {
    const body = parse(bodyStr);
    if (!body) return null;

    if (url.includes(OX_PATH)) {
      // одиночна GraphQL-операція
      if (!Array.isArray(body)) {
        if (!WANTED_OPS.has(body.operationName)) return (text) => postRefs(parse(text));
        return (text, ok) => {
          const j = parse(text);
          if (j && j.data) post({ kind: "niche", op: body.operationName, variables: body.variables || null, data: j.data });
          // Робочий шаблон getNiche для пакетного збору ніш зі сторінки пошуку.
          if (ok && j && j.data && j.data.niche && j.data.niche.nicheId) {
            post({
              kind: "nicheTemplate",
              url: absUrl(url),
              method: (meta && meta.method) || "POST",
              headers: (meta && meta.headers) || {},
              body,
              nicheId: j.data.niche.nicheId,
              obfuscatedMarketplaceId: j.data.niche.obfuscatedMarketplaceId || null,
            });
          }
        };
      }
      // батч операцій: відповідь — масив у тому ж порядку
      const idx = body.findIndex((op) => op && WANTED_OPS.has(op.operationName));
      if (idx < 0) return (text) => postRefs(parse(text));
      return (text) => {
        const j = parse(text);
        const item = Array.isArray(j) ? j[idx] : null;
        if (item && item.data) post({ kind: "niche", op: body[idx].operationName, variables: body[idx].variables || null, data: item.data });
      };
    }

    if (url.includes(GROWTH_PATH)) {
      const pc = body.promptContext;
      const pid = pc && pc.promptId;
      if (typeof pid !== "string" || !pid.startsWith("OX_NICHE_")) return null;
      const ctx = (pc && pc.context) || {};
      return (text, ok, status) => {
        const html = htmlFromGrowth(parse(text));
        post({ kind: "pageGrowth", promptId: pid, status: status || (ok ? 200 : 0), message: ok ? undefined : String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300) });
        if (ok && html) {
          // Запит сторінки пройшов — це робочий шаблон для дозбору на цьому маркетплейсі.
          post({
            kind: "growthTemplate",
            url: absUrl(url),
            method: (meta && meta.method) || "POST",
            headers: (meta && meta.headers) || {},
            body,
          });
        }
        if (html) {
          post({
            kind: "insight",
            promptId: pid,
            nicheId: ctx.nicheId || null,
            obfuscatedMarketplaceId: ctx.obfuscatedMarketplaceId || null,
            html,
          });
        }
      };
    }
    return null;
  };

  // ---- XMLHttpRequest ----
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__poeaUrl = toStr(url); this.__poeaMethod = toStr(method).toUpperCase(); this.__poeaHeaders = {}; } catch (e) { /* ignore */ }
    return xhrOpen.apply(this, arguments);
  };

  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      const k = String(name).toLowerCase();
      if (this.__poeaHeaders && !SKIP_HEADERS.has(k)) this.__poeaHeaders[k] = String(value);
    } catch (e) { /* ignore */ }
    return xhrSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__poeaUrl || "";
      if (interesting(url)) {
        const handle = classify(url, toStr(body), { headers: this.__poeaHeaders || {}, method: this.__poeaMethod });
        if (handle) {
          this.addEventListener("load", () => {
            try {
              const rt = this.responseType;
              let text = null;
              if (rt === "" || rt === "text") text = this.responseText;
              else if (rt === "json") text = JSON.stringify(this.response);
              if (text != null) handle(text, this.status >= 200 && this.status < 300, this.status);
            } catch (e) { /* responseText може кинути InvalidStateError — пропускаємо */ }
          });
        }
      }
    } catch (e) { /* ніколи не ламаємо сторінку */ }
    return xhrSend.apply(this, arguments);
  };

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    const bodyOf = (input, init) => {
      if (init && init.body != null) return Promise.resolve(toStr(init.body));
      if (typeof Request !== "undefined" && input instanceof Request) {
        try { return input.clone().text().catch(() => ""); } catch (e) { return Promise.resolve(""); }
      }
      return Promise.resolve("");
    };

    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = urlOf(input);
        if (interesting(url)) {
          bodyOf(input, init).then((bodyStr) => {
            const isReq = typeof Request !== "undefined" && input instanceof Request;
            const headers = Object.assign({}, isReq ? headersToObj(input.headers) : {}, headersToObj(init && init.headers));
            const method = String((init && init.method) || (isReq && input.method) || "GET").toUpperCase();
            const handle = classify(url, bodyStr, { headers, method });
            if (!handle) return;
            p.then((res) => res.clone().text().then((t) => handle(t, res.ok, res.status)).catch(noop)).catch(noop);
          }).catch(noop);
        }
      } catch (e) { /* ніколи не ламаємо сторінку */ }
      return p;
    };
  }
})();
