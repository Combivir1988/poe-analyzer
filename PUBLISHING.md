# Публікація POE Analyzer у Chrome Web Store

Що потрібно від вас (не автоматизується): Google-акаунт, одноразовий внесок
розробника **$5**, і 10–15 хвилин на форму. Модерація зазвичай 1–3 дні, для
розширень із host-дозволами й content scripts буває до тижня.

## 0. Підготовка (вже зроблено)

```
python tools/build_zip.py            # → dist/poe-analyzer-1.0.0.zip
python tools/render_store_assets.py  # → store/screenshot_1280x800.png, store/promo_tile_440x280.png
```

Тексти для форми: [store/listing.md](store/listing.md). Політика: [PRIVACY.md](PRIVACY.md)
(публічна за адресою `https://github.com/Combivir1988/poe-analyzer/blob/main/PRIVACY.md`).

## 1. Акаунт розробника

1. https://chrome.google.com/webstore/devconsole → увійти Google-акаунтом.
2. Прийняти Developer Agreement, сплатити $5 (картка).
3. **Account → Email**: вказати контактний email і **підтвердити** його (без цього
   не можна подати на модерацію).

## 2. Новий елемент

1. **+ New item** → перетягнути `dist/poe-analyzer-1.0.0.zip`.
2. Вкладка **Store listing**:
   - Title = `POE Analyzer` (з manifest, не редагується тут).
   - Summary, Description — з `store/listing.md` (EN; за бажанням додати UK/RU
     через **Add language**).
   - Category: *Productivity → Tools*. Language: *English*.
   - Icon 128 — підтягнеться з manifest.
   - Screenshots: `store/screenshot_1280x800.png` (мінімум 1, можна до 5).
   - Small promo tile: `store/promo_tile_440x280.png`.
   - Official URL / Homepage: `https://github.com/Combivir1988/poe-analyzer`.
3. Вкладка **Privacy**:
   - Single purpose, Permission justifications, Remote code = No — тексти в
     `store/listing.md` (розділ «Privacy practices tab»).
   - Data usage: нічого не збирається; поставити всі три галочки certifications.
   - Privacy policy URL: `https://github.com/Combivir1988/poe-analyzer/blob/main/PRIVACY.md`.
4. Вкладка **Distribution**:
   - Visibility: **Public** (або **Unlisted** — тільки за посиланням; для
     власного користування Unlisted достатньо і модерація м'якша).
   - Regions: All regions. Pricing: Free.
5. **Submit for review**. Галочку «Publish automatically after review» лишити.

## 3. Що може попросити модератор

| Зауваження | Відповідь / дія |
|---|---|
| «Broad host permissions» | Розширення працює лише на Seller Central; список доменів мінімальний і явний. Пояснення вже в justification. Якщо наполягатимуть — прибрати з manifest регіональні домени, лишити тільки `sellercentral.amazon.com`. |
| «Provide test account / instructions» | Написати: «Requires a Seller Central account with Product Opportunity Explorer access; open any niche page, reload, click the icon → Download JSON». Тестовий акаунт дати неможливо (Amazon ToS) — так і написати. |
| «Screenshot doesn't reflect functionality» | Замінити згенерований скриншот реальним: відкрити нішу, попап, `Win+Shift+S`, привести до 1280×800. |
| «Missing privacy policy» | Перевірити, що URL відкривається без логіну (репо публічне). |

## 4. Оновлення версії

1. Підняти `version` у `manifest.json` (наприклад `1.0.1`).
2. `python tools/build_zip.py` → новий zip.
3. Devconsole → елемент → **Package → Upload new package** → Submit.
4. `git tag v1.0.1 && git push --tags`.

## 5. Альтернатива без магазину

Для себе / команди достатньо **Load unpacked** (README) або zip з `dist/`, який
кожен розпаковує і підвантажує сам. Chrome не блокує unpacked-розширення в
Developer mode.
