// Офлайн smoke-тест перехоплювача та моста без браузера.
// Імітує window/fetch/XHR/chrome.* і проганяє реальний JSON ніші через обидва скрипти.
// Запуск: node tools/smoke_test.js path/to/POE_*.json
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const sample = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, "sample.json"), "utf8"));
const ORIGIN = "https://sellercentral.amazon.com";

// ---- фейкове середовище ----
const posted = [];
const storage = {};
const runtimeListeners = [];
const runtimeMessages = [];
const windowListeners = { message: [] };

class FakeResponse {
  constructor(text, ok = true, status = 200) { this._t = text; this.ok = ok; this.status = status; }
  clone() { return new FakeResponse(this._t, this.ok, this.status); }
  text() { return Promise.resolve(this._t); }
  json() { return Promise.resolve(JSON.parse(this._t)); }
}

const growthReply = (pid) => JSON.stringify({ messages: [{ payload: (sample.insights[pid] || {}).html || "" }] });

let growthCalls = [];
let growthHeaders = [];
let growthStatus = 200; // перемикач для сценарію «маркетплейс відхиляє запит»
const realFetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/ox-api/graphql")) return Promise.resolve(new FakeResponse(JSON.stringify({ data: sample.data })));
  if (url.includes("/insightswidget-api/growth")) {
    const body = JSON.parse(init.body);
    growthCalls.push(body.promptContext.promptId);
    growthHeaders.push(Object.assign({}, init.headers || {}));
    if (growthStatus !== 200) return Promise.resolve(new FakeResponse('{"message":"Bad Request"}', false, growthStatus));
    return Promise.resolve(new FakeResponse(growthReply(body.promptContext.promptId)));
  }
  return Promise.resolve(new FakeResponse("{}"));
};

class FakeXHR {
  open(m, url) { this._url = url; this._l = {}; this.responseType = ""; this._h = {}; }
  setRequestHeader(k, v) { this._h[k] = v; }
  addEventListener(ev, fn) { this._l[ev] = fn; }
  send(body) {
    realFetch(this._url, { body, headers: this._h }).then((r) => { this.status = r.status; return r.text(); }).then((t) => { this.responseText = t; if (this._l.load) this._l.load(); });
  }
}

const win = {
  location: { origin: ORIGIN, href: ORIGIN + "/opportunity-explorer/explore/niche/" + sample.meta.nicheId + "/insights-trends" },
  postMessage(msg, origin) { posted.push(msg); windowListeners.message.forEach((fn) => fn({ source: win, data: msg, origin })); },
  addEventListener(ev, fn) { (windowListeners[ev] = windowListeners[ev] || []).push(fn); },
  fetch: realFetch,
};
const chrome = {
  storage: { local: {
    get(k, cb) { cb({ [k]: storage[k] }); },
    set(obj, cb) { Object.assign(storage, JSON.parse(JSON.stringify(obj))); cb && cb(); },
  } },
  runtime: {
    onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
    sendMessage(msg, cb) { runtimeMessages.push(msg); cb && cb(); },
    lastError: null,
  },
};

const ctx = {
  window: win, XMLHttpRequest: FakeXHR, Request: class {}, AbortController, setTimeout, clearTimeout, console, JSON, Promise, Object, Array, String, Math, Date, chrome,
};
ctx.fetch = realFetch; // міст (ISOLATED) кличе глобальний fetch
vm.createContext(ctx);
// Скрипти звертаються до window.fetch / XMLHttpRequest.prototype як у браузері.
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "interceptor.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "bridge.js"), "utf8"), ctx);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

(async () => {
  // 1) getNiche через fetch (як на реальній сторінці)
  await win.fetch(ORIGIN + "/ox-api/graphql", { method: "POST", body: JSON.stringify({ operationName: "getNiche", variables: sample.variables, query: "query getNiche {...}" }) });
  await sleep(20);
  assert(posted.some((p) => p.kind === "niche"), "interceptor: getNiche пійманий через fetch");

  // 2) один інсайт пасивно через XHR
  const x = new FakeXHR();
  x.open("POST", ORIGIN + "/insightswidget-api/growth");
  x.setRequestHeader("Content-Type", "application/json");
  x.setRequestHeader("anti-csrftoken-a2z", "TOKEN123");
  x.send(JSON.stringify({ widgetContext: {}, promptContext: { promptId: "OX_NICHE_MARKET_POTENTIAL_PROMPT", context: { nicheId: sample.meta.nicheId, obfuscatedMarketplaceId: sample.meta.obfuscatedMarketplaceId } } }));
  await sleep(20);
  assert(posted.some((p) => p.kind === "insight" && p.promptId === "OX_NICHE_MARKET_POTENTIAL_PROMPT"), "interceptor: growth пійманий через XHR");

  // 3) міст зберіг у storage
  await sleep(20);
  const rec = storage.poea_niches[sample.meta.nicheId];
  assert(rec && rec.meta && rec.meta.nicheTitle === sample.meta.nicheTitle, "bridge: запис ніші у storage, title=" + (rec && rec.meta.nicheTitle));
  assert(rec.data.niche.asinMetrics.length === sample.data.niche.asinMetrics.length, "bridge: asinMetrics збережені повністю (" + rec.data.niche.asinMetrics.length + ")");
  assert(rec.insights.OX_NICHE_MARKET_POTENTIAL_PROMPT.via === "passive", "bridge: пасивний інсайт збережено");

  assert(storage.poea_growth_tpl && storage.poea_growth_tpl[ORIGIN] && storage.poea_growth_tpl[ORIGIN].headers["anti-csrftoken-a2z"] === "TOKEN123",
    "bridge: шаблон growth-запиту сторінки збережено разом із заголовками");

  // 4) активний дозбір решти 5 — послідовно, за шаблоном сторінки
  const missing = Object.keys(sample.insights).filter((k) => k !== "OX_NICHE_MARKET_POTENTIAL_PROMPT");
  growthCalls = []; // лічимо тільки активний дозбір
  const t0 = Date.now();
  const resp = await new Promise((resolve) => {
    runtimeListeners.forEach((fn) => fn({ type: "poea:collect", nicheId: sample.meta.nicheId, obfuscatedMarketplaceId: sample.meta.obfuscatedMarketplaceId, promptIds: missing }, {}, resolve));
  });
  const elapsed = Date.now() - t0;
  assert(Object.keys(resp.insights).length === 5 && Object.values(resp.insights).every((e) => e.html), "bridge: 5 інсайтів дозібрано активно");
  assert(JSON.stringify(growthCalls) === JSON.stringify(missing), "bridge: запити строго послідовні у заданому порядку");
  assert(elapsed >= 4 * 1200, "bridge: людські паузи між запитами (" + elapsed + " мс за 5 запитів)");
  assert(runtimeMessages.filter((m) => m.type === "poea:progress").length === 6, "bridge: прогрес надсилається попапу");
  assert(growthHeaders.every((h) => h["anti-csrftoken-a2z"] === "TOKEN123") && resp.templateUsed, "bridge: дозбір повторює заголовки зі шаблону сторінки");
  const rec2 = storage.poea_niches[sample.meta.nicheId];
  assert(Object.keys(rec2.insights).length === 6, "bridge: усі 6 інсайтів у storage після дозбору");

  // 4b) маркетплейс без шаблону відхиляє запит (як .co.uk) — одна спроба, далі не стукаємо
  delete storage.poea_growth_tpl;
  delete storage.poea_niches[sample.meta.nicheId].insights.OX_NICHE_PRICING_ANALYSIS_PROMPT;
  growthStatus = 400; growthCalls = [];
  const three = ["OX_NICHE_SEARCH_TERMS_PROMPT", "OX_NICHE_PRICING_ANALYSIS_PROMPT", "OX_NICHE_REVIEWS_ANALYZER_PROMPT"];
  const rej = await new Promise((resolve) => {
    runtimeListeners.forEach((fn) => fn({ type: "poea:collect", nicheId: sample.meta.nicheId, obfuscatedMarketplaceId: sample.meta.obfuscatedMarketplaceId, promptIds: three }, {}, resolve));
  });
  assert(growthCalls.length === 1 && rej.rejected === "http 400", "bridge: після 400 без шаблону — рівно 1 запит замість 9, причина у відповіді");
  assert(rej.steps[0].detail && rej.steps[0].detail.includes("Bad Request"), "bridge: текст відмови Amazon потрапляє в _debug");
  growthStatus = 200;

  // 5) ping
  const pong = await new Promise((resolve) => runtimeListeners.forEach((fn) => fn({ type: "poea:ping" }, {}, resolve)));
  assert(pong && pong.ok, "bridge: ping");

  console.log("\nALL OK");
})().catch((e) => { console.error(e); process.exit(1); });
