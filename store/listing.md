# Chrome Web Store listing — POE Analyzer

Ready-to-paste texts for the Developer Dashboard. Limits: name ≤ 45 chars,
summary ≤ 132 chars, description ≤ 16 000 chars.

## Store listing

**Name:** `POE Analyzer`

**Summary (EN, ≤132):**
`Export an Amazon Product Opportunity Explorer niche as one JSON file: metrics, products, search terms, trends, Top Niche Insights.`

**Category:** Productivity → Tools (or "Workflow & Planning")
**Language:** English (add Ukrainian / Russian localized descriptions below if desired)

**Description (EN):**

```
POE Analyzer downloads the data of an Amazon Product Opportunity Explorer niche as a single JSON file for offline analysis.

A tool for Amazon sellers. Open a niche in Product Opportunity Explorer (Seller Central), click the extension button — get one JSON file with everything the niche page contains: niche metrics, launch potential, up to 67 ASINs with prices/ratings/click share, search terms with volumes and conversion, 100+ weekly trend points, customer review topics (PDR), and the text of all six Top Niche Insights tabs (Niche Overview, Top Product Features, Customer Reviews, Customer Demographics, Search Terms, Pricing).

How it works
• The extension passively reads the data the Product Opportunity Explorer page has already loaded in your browser, in your own account.
• Top Niche Insights tabs you have not opened are fetched only after you click "Download JSON" — from your own session, one at a time, with human-like pauses.
• Nothing is sent anywhere: data stays in your browser (last 8 niches) and leaves it only as the file you download yourself.

What you get
• One file per niche: POE_<niche>_<date>.json
• Stable schema (schemaVersion 1) — easy to feed into spreadsheets, scripts, or an LLM for analysis.
• Popup shows which Insights tabs are already captured and lets you download any of the last 8 niches.

Requirements
• A Seller Central account with access to Product Opportunity Explorer (Brand Registry).
• Works on all Seller Central regional domains.

Privacy
• No analytics, no telemetry, no third-party servers, no background worker. Full policy: https://github.com/Combivir1988/poe-analyzer/blob/main/PRIVACY.md

Open source: https://github.com/Combivir1988/poe-analyzer
```

**Description (UK):**

```
POE Analyzer зберігає дані ніші Amazon Product Opportunity Explorer одним JSON-файлом для офлайн-аналізу.

Інструмент для продавців Amazon. Відкрийте нішу в Product Opportunity Explorer (Seller Central), натисніть кнопку розширення — отримайте один JSON з усім, що є на сторінці ніші: метрики, launch potential, до 67 ASIN з цінами/рейтингами/click share, пошукові запити з обсягами й конверсією, понад 100 тижневих точок трендів, теми відгуків (PDR) і тексти всіх шести вкладок Top Niche Insights.

Як це працює
• Розширення пасивно читає дані, які сторінка POE вже завантажила у вашому браузері, у вашому акаунті.
• Вкладки Top Niche Insights, яких ви не відкривали, дозбираються лише після натискання «Завантажити JSON» — від вашої сесії, по одній, з паузами.
• Дані нікуди не надсилаються: вони лишаються в браузері (останні 8 ніш) і покидають його тільки як файл, який ви самі завантажили.

Політика конфіденційності: https://github.com/Combivir1988/poe-analyzer/blob/main/PRIVACY.md
Відкритий код: https://github.com/Combivir1988/poe-analyzer
```

**Description (RU):**

```
POE Analyzer скачивает данные ниши Amazon Product Opportunity Explorer одним файлом JSON для последующего анализа.

Инструмент для продавцов Amazon. Откройте нишу в Product Opportunity Explorer (Seller Central), нажмите кнопку расширения — получите один JSON-файл со всеми данными ниши: метрики, товары, поисковые запросы, тренды и тексты Top Niche Insights. Файл используется для офлайн-анализа ниши.

Как это работает
• Расширение пассивно читает данные, которые страница Product Opportunity Explorer уже загрузила в вашем браузере, в вашем аккаунте.
• Недостающие вкладки Top Niche Insights догружаются только после нажатия кнопки «Скачать JSON» — вручную, от вашей сессии, в человеческом темпе.
• Данные никуда не отправляются: они хранятся локально в браузере (последние 8 ниш) и покидают его только как файл, который вы скачали сами.

Политика конфиденциальности: https://github.com/Combivir1988/poe-analyzer/blob/main/PRIVACY.md
```

## Privacy practices tab (answers)

**Single purpose description:**
`Export the data of the currently open Amazon Product Opportunity Explorer niche (metrics, products, search terms, trends, Top Niche Insights text) as one JSON file for offline analysis.`

**Permission justifications:**

- `storage` — "Keeps the last 8 captured niches in chrome.storage.local so the user can download them from the popup; cleared by the user via the popup's Clear link."
- Host permissions `https://sellercentral.amazon.*/*` — "The extension must run on Seller Central pages to read the Product Opportunity Explorer responses the page loads, and, on the user's click, to request missing Top Niche Insights tabs from the same first-party endpoint using the user's own session. No other hosts are accessed."
- Content scripts / MAIN world — "Response bodies of the page's own fetch/XHR calls are only readable from the page world; the MAIN-world script observes them and forwards to the isolated script. It makes no requests of its own."

**Remote code:** No, I am not using remote code.

**Data usage — what user data do you collect?** None of the listed categories. (The extension processes website content locally and does not transmit it. If the reviewer insists: "Website content" — used for the app's core functionality, not sold, not transferred, not used for unrelated purposes.)

**Certifications:** tick all three (not sold, only for the described purpose, not for creditworthiness/lending).

**Privacy policy URL:** `https://github.com/Combivir1988/poe-analyzer/blob/main/PRIVACY.md`

## Assets

| Asset | Size | File |
|---|---|---|
| Icon | 128×128 | `icons/icon128.png` |
| Screenshot | 1280×800 | `store/screenshot_1280x800.png` (generated from `store/demo.html`) |
| Small promo tile | 440×280 | `store/promo_tile_440x280.png` (generated from `store/promo.html`) |
| Marquee (optional) | 1400×560 | — |

Regenerate with `python tools/render_store_assets.py` (needs Chrome installed).
