// POE Analyzer — пасивний спостерігач мережі (MAIN world, document_start).
//
// Ставиться раніше, ніж застосунок Product Opportunity Explorer ініціалізує свій
// мережевий шар, тому бачить усі його fetch/XHR. Читає ТІЛЬКИ відповіді, які
// сторінка й так завантажила у сесії користувача:
//   * /ox-api/graphql            operationName=getNiche  → дані ніші
//   * /insightswidget-api/growth promptId=OX_NICHE_*     → HTML вкладок Top Niche Insights
// Своїх запитів не робить. Знайдене пересилає мосту (bridge.js) через postMessage.
(() => {
  if (window.__poeAnalyzerHooked) return;
  window.__poeAnalyzerHooked = true;

  const MARK = "__poeAnalyzer";
  const OX_PATH = "/ox-api/graphql";
  const GROWTH_PATH = "/insightswidget-api/growth";
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
  const interesting = (url) => url.includes(OX_PATH) || url.includes(GROWTH_PATH);

  const htmlFromGrowth = (json) => {
    const msgs = json && Array.isArray(json.messages) ? json.messages : [];
    return msgs
      .map((m) => (m && typeof m.payload === "string" ? m.payload : ""))
      .filter(Boolean)
      .join("\n");
  };

  // Повертає обробник відповіді для запиту, який нас цікавить, або null.
  const classify = (url, bodyStr) => {
    const body = parse(bodyStr);
    if (!body) return null;

    if (url.includes(OX_PATH)) {
      // одиночна GraphQL-операція
      if (!Array.isArray(body)) {
        if (!WANTED_OPS.has(body.operationName)) return null;
        return (text) => {
          const j = parse(text);
          if (j && j.data) post({ kind: "niche", op: body.operationName, variables: body.variables || null, data: j.data });
        };
      }
      // батч операцій: відповідь — масив у тому ж порядку
      const idx = body.findIndex((op) => op && WANTED_OPS.has(op.operationName));
      if (idx < 0) return null;
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
      return (text) => {
        const html = htmlFromGrowth(parse(text));
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
    try { this.__poeaUrl = toStr(url); } catch (e) { /* ignore */ }
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__poeaUrl || "";
      if (interesting(url)) {
        const handle = classify(url, toStr(body));
        if (handle) {
          this.addEventListener("load", () => {
            try {
              const rt = this.responseType;
              let text = null;
              if (rt === "" || rt === "text") text = this.responseText;
              else if (rt === "json") text = JSON.stringify(this.response);
              if (text != null) handle(text);
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
            const handle = classify(url, bodyStr);
            if (!handle) return;
            p.then((res) => res.clone().text().then(handle).catch(noop)).catch(noop);
          }).catch(noop);
        }
      } catch (e) { /* ніколи не ламаємо сторінку */ }
      return p;
    };
  }
})();
