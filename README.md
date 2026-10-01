# POE Analyzer

Розширення Chrome (Manifest V3) для продавців Amazon: відкрий нішу в
**Product Opportunity Explorer** (Seller Central), натисни кнопку — отримай один
JSON-файл з усіма даними ніші (метрики, товари, пошукові запити, тренди, тексти
шести вкладок Top Niche Insights) для офлайн-аналізу.

## Установка (без Web Store)

1. `chrome://extensions` → увімкнути **Developer mode** (праворуч зверху).
2. **Load unpacked** → вибрати теку `poe-analyzer/`.
3. Закріпити іконку на панелі (пазл → пін).
4. **Обов'язково перезавантажити** вже відкриті вкладки Seller Central: content
   scripts ставляться тільки при завантаженні сторінки.

## Як користуватися

1. Відкрити нішу: `sellercentral.amazon.com/opportunity-explorer/explore/niche/<id>/...`
2. Дочекатися, поки сторінка завантажить метрики. Вкладки Top Niche Insights, які
   ви відкривали, підхоплюються пасивно (● у списку попапу).
3. Натиснути іконку → **Завантажити JSON**. Відсутні вкладки Insights дозбираються
   **послідовно з паузами 1,2–2,8 с** (Amazon тротлить паралельні запити і віддає
   порожні відповіді), потім файл `POE_<ніша>_<дата>.json` падає в Downloads.
4. У попапі також видно останні 8 ніш — будь-яку можна скачати «як є» (без дозбору,
   бо дозбір працює лише для ніші, відкритої в активній вкладці).

## Кілька ніш одразу (з 1.1.0)

1. **Один раз на маркетплейс:** відкрийте будь-яку нішу і дочекайтеся завантаження. Розширення запам'ятає справжній запит, яким сторінка отримує дані ніші.
2. Відкрийте пошук або будь-який список ніш (наприклад, «Matching niches for …»), дочекайтеся таблиці.
3. Іконка → список знайдених ніш із галочками (за раз до 8) → **Зібрати вибрані**. Галочка «також дозбирати Top Niche Insights» — за бажанням.
4. Ніші запитуються строго по одній, з паузами 3–6 с, від вашої сесії. Попап можна закрити, вкладку — ні. Прогрес видно при наступному відкритті попапу; **Зупинити** перериває чергу.
5. **Завантажити всі** — по одному JSON на нішу, у звичному форматі (FBA Launch Evaluator приймає до 8 таких файлів і сам їх об'єднує). Chrome може один раз спитати дозвіл на кілька завантажень.

## Як це працює

| Шар | Файл | Світ | Що робить |
|---|---|---|---|
| Перехоплювач | `src/interceptor.js` | MAIN, `document_start` | Обгортає `fetch` і `XMLHttpRequest`, читає відповіді `POST /ox-api/graphql` (`operationName=getNiche`) та `POST /insightswidget-api/growth` (`promptContext.promptId=OX_NICHE_*`, відповідь `messages[].payload` = HTML). Своїх запитів не робить. |
| Міст | `src/bridge.js` | ISOLATED, `document_start` | Приймає повідомлення перехоплювача, складає їх у `chrome.storage.local` по `nicheId` (read-merge-write, останні 8). На запит попапу дозбирає відсутні інсайти: по одному, 3 спроби, таймаут 45 с. |
| Попап | `popup.html`, `popup.js` | extension | Показує стан ніші активної вкладки, запускає дозбір, збирає JSON у форматі схеми v1, віддає файл через `<a download>`. |

Фонового service worker немає: усе живе у content scripts і попапі.

### Формат файлу (schemaVersion 1)

```
meta       { capturedAt, nicheId, nicheTitle, obfuscatedMarketplaceId, pageUrl, schemaVersion, source, generator }
variables  { nicheInput: { nicheId, obfuscatedMarketplaceId } }      // як у запиті getNiche
data       { niche: { asinMetrics[], launchPotential, nichePdr, nicheSummary, searchTermMetrics[], trendsMetrics[], … } }
insights   { OX_NICHE_*_PROMPT: { tab, capturedAt, html, via: "passive" | "active" } }   // до 6 вкладок
_debug     { passiveInsights, missingCount, steps[], collectResponse[], insightsFinal, … }
```

Вкладки Top Niche Insights ↔ prompt id:

| promptId | tab |
|---|---|
| `OX_NICHE_MARKET_POTENTIAL_PROMPT` | Niche Overview |
| `OX_NICHE_PRODUCT_FEATURE_EXTRACTOR_PROMPT` | Top Product Features |
| `OX_NICHE_REVIEWS_ANALYZER_PROMPT` | Customer Reviews |
| `OX_NICHE_CUSTOMER_DEMOGRAPHICS_PROMPT` | Customer Demographics |
| `OX_NICHE_SEARCH_TERMS_PROMPT` | Search Terms |
| `OX_NICHE_PRICING_ANALYSIS_PROMPT` | Pricing |

## Приватність

- Дані нікуди не надсилаються. Розширення не має фонового воркера і жодних
  зовнішніх хостів у дозволах, крім самих доменів Seller Central.
- Усе зберігається в `chrome.storage.local` (останні 8 ніш) і покидає браузер лише
  як файл, який ви самі завантажили. «Очистити» в попапі стирає сховище.
- Активні запити йдуть тільки після вашого натискання, від вашої сесії, до того ж
  ендпоїнта, який сторінка POE викликає сама, коли ви клацаєте вкладку.

## Розробка

```
node --check src/interceptor.js src/bridge.js popup.js   # синтаксис
node tools/smoke_test.js path/to/POE_*.json              # офлайн-прогін на реальному файлі
python tools/make_icons.py                               # перегенерувати іконки
```

Smoke-тест імітує `window.fetch`/`XMLHttpRequest`/`chrome.storage` і проганяє
реальний JSON ніші через перехоплювач і міст: перевіряє пасивне захоплення,
збереження, послідовний дозбір із паузами й прогрес.

## Типові проблеми

| Симптом | Причина / що робити |
|---|---|
| «Дані цієї ніші ще не спіймано» | Сторінка була відкрита до встановлення розширення → F5. |
| «Receiving end does not exist» при дозборі | Те саме: content script відсутній у вкладці → F5 і повторити. |
| Попап: «Unsupported Locale» (UK) | Amazon не надає Top Niche Insights на цьому маркетплейсі, блоку на сторінці немає. Решта даних ніші у файлі повна; розширення запам'ятовує це і більше не надсилає запитів Insights на цей домен. |
| Усі інсайти `ERR:http 400` без пояснення | Маркетплейс приймає інший формат запиту. Відкрийте вручну одну вкладку Top Niche Insights і дочекайтеся тексту: розширення запам'ятає справжній запит сторінки для цього домену, і наступне завантаження дозбере решту. Після першої відмови розширення більше не стукає. Немає блоку Insights на сторінці — на цьому маркетплейсі його немає. |
| Частина інсайтів `ERR:empty` | Amazon тротлить growth-ендпоїнт. Зачекати хвилину і натиснути ще раз — дозбираються лише відсутні. |
| Файл без `data` | Спіймано лише інсайт, а `getNiche` — ні (SPA-навігація між нішами без reload). Оновити сторінку ніші. |

## Web Store

Пакет: `python tools/build_zip.py` → `dist/`. Тексти лістингу: [store/listing.md](store/listing.md), політика: [PRIVACY.md](PRIVACY.md), покрокова інструкція публікації: [PUBLISHING.md](PUBLISHING.md).
