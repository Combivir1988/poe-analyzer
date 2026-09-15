# POE Analyzer — Privacy Policy

_Last updated: 2026-09-15_

POE Analyzer is a browser extension for Amazon sellers. It exports the data of a
niche opened in Amazon Product Opportunity Explorer (Seller Central) into a single
JSON file for offline analysis.

## What the extension does with data

- **Reads only what your browser already loaded.** While you browse a niche page
  in Seller Central, the extension observes the responses the page itself
  requested (niche metrics, products, search terms, trends, and the text of the
  "Top Niche Insights" tabs) and keeps a copy in your browser.
- **Fetches missing tabs only when you click "Download JSON".** If some
  "Top Niche Insights" tabs were not opened, the extension requests them from
  the same Seller Central endpoint the page uses, from your own session, one at a
  time, with pauses. No request is made without your click.
- **Stores locally.** Captured niches (the last 8) are kept in
  `chrome.storage.local` on your device. You can delete them at any time with
  the "Clear" link in the popup or by removing the extension.
- **Leaves your browser only as the file you download.** The JSON file is written
  to your Downloads folder by your browser. Nothing is uploaded anywhere.

## What the extension does NOT do

- No data is transmitted to the developer or to any third party.
- No analytics, telemetry, tracking, cookies, or remote code.
- No background service worker; the extension has no network access outside the
  Seller Central pages you open.
- It does not read, store, or transmit your Amazon credentials, personal
  information, buyer data, or anything from pages other than Product
  Opportunity Explorer.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Keep the last 8 captured niches in the browser until you download or clear them. |
| Host access to `sellercentral.amazon.*` | Run on Seller Central pages to observe the niche data the page loads and, on your click, request missing Insights tabs from your own session. |

## Data retention

Data stays on your device until you clear it in the popup, the niche is rotated
out by newer captures (only the last 8 are kept), or you uninstall the extension.

## Contact

Questions about this policy: open an issue at
https://github.com/Combivir1988/poe-analyzer/issues
