# Feature Specification: POE Analyzer (Chrome extension)

**Feature Branch**: `001-poe-analyzer` · **Created**: 2026-09-15 · **Status**: Implemented (v1.0.0)

## Problem

Amazon Product Opportunity Explorer (POE) shows a niche's metrics, products, search
terms, trends and six AI-written "Top Niche Insights" tabs only inside Seller
Central. There is no export. Offline analysis (own scripts, LLM, spreadsheets)
needs all of it as one file, captured from the seller's own session, without
sending data to any third party.

Reference output: `POE_urinal_screen_deodorizer_2026-09-15.json` (schemaVersion 1)
produced by the Web Store extension "POE Collector" (which is gated behind a paid
community login). This project is an own, ungated implementation with the same
file format.

## User Scenarios

### US1 — Download the open niche as one JSON (P1)
Seller opens a niche page, waits for it to load, clicks the extension → one
`POE_<niche>_<date>.json` lands in Downloads with `meta`, `variables`, `data`
(full `getNiche` payload) and whatever Insights tabs were already loaded.

**Acceptance**: file contains `data.niche.asinMetrics`, `nicheSummary`,
`launchPotential`, `searchTermMetrics`, `trendsMetrics`, `nichePdr` exactly as the
page received them; `meta.nicheId` matches the URL.

### US2 — Missing Insights tabs are topped up on demand (P1)
If fewer than 6 Insights tabs were captured passively, clicking Download fetches
the missing ones from the user's session, sequentially, with human-like pauses,
and includes them with `via: "active"`.

**Acceptance**: requests never run in parallel; each missing tab retried up to 3×;
partial failure still yields a file with `_debug.collectResponse` explaining which
tabs failed; already-fetched tabs are persisted so a retry only fetches what is
still missing.

### US3 — Last niches stay available (P2)
The popup lists the last 8 captured niches; any of them can be downloaded as-is
(no active top-up, since that needs the niche page open).

**Acceptance**: storage capped at 8 by recency; two tabs capturing different niches
do not overwrite each other; "Clear" wipes storage.

### US4 — Collect several niches from a list page (P1, added 2026-10-01, v1.1.0)
On a POE search/list page the popup lists the niches found on the page (table
links + niche references in the page's own GraphQL responses), lets the seller
tick up to 8 and collects them in one run. Each niche is fetched by replaying the
page's own successful `getNiche` request (URL, headers, body; nicheId and
marketplace substituted), recorded the first time any niche is opened on that
origin. Strictly sequential, 3–6 s jitter between niches, optional Insights
top-up per niche (skipped where the marketplace reports "Unsupported Locale").
The queue runs in the page (popup may close), state in `chrome.storage.local`
(`poea_batch`), stop button, "download all" = one schemaVersion-1 file per niche.

**Acceptance**: without a recorded template the start button is blocked with a
one-time instruction; a failed niche does not stop the queue; every collected
niche gets its own `meta.pageUrl`.

## Functional Requirements

- FR-001 Passive capture of `POST */ox-api/graphql` with `operationName=getNiche`
  (single and batched bodies) via `fetch` and `XMLHttpRequest` hooks in the MAIN
  world at `document_start`. Page code must never break if hooks throw.
- FR-002 Passive capture of `POST */insightswidget-api/growth` where
  `promptContext.promptId` starts with `OX_NICHE_`; HTML = `messages[].payload`
  joined.
- FR-003 Storage keyed by `nicheId`, read-merge-write, max 8, insight entry with
  HTML always wins over an error entry; repeated `getNiche` responses merge
  non-null fields instead of overwriting.
- FR-004 Active top-up: same endpoint/body shape the page uses
  (`widgetContext {from: OX_WIDGET, to: GROWTH_AGENT}`, `promptContext {promptId,
  context {nicheId, obfuscatedMarketplaceId}}`), `credentials: include`, origin
  taken from the current page (works on every Seller Central regional domain).
- FR-005 Sequential only; jittered gap 1.2–2.8 s between tabs; 3 attempts with
  2.5 s retry delay; 45 s per-request timeout; one collection at a time per tab;
  progress messages to the popup.
- FR-006 Output file format = schemaVersion 1 (see README), key order preserved;
  extra `meta.generator` allowed.
- FR-007 No background service worker, no external hosts, no analytics; the only
  permission is `storage` plus Seller Central host permissions.
- FR-008 Popup states: not a POE page / not a niche page / niche not captured yet
  (ask to reload) / ready; explicit hint when the content script is missing
  ("Receiving end does not exist" → reload page).

## Success Criteria

- SC-1 On a freshly loaded niche page the downloaded file is byte-equivalent in
  structure to the reference file (same top-level keys, same `data.niche` sections).
- SC-2 With 1 of 6 Insights captured passively, one click yields 6 of 6 in
  ≥ 95 % of runs; failures are visible in `_debug`.
- SC-3 Offline smoke test (`tools/smoke_test.js`) passes: capture via fetch and
  XHR, persistence, sequential top-up with pauses, progress events.

## Out of Scope

- Web Store publication, licensing, auto-update.
- Parsing the Insights HTML into structured fields (downstream analysis job).
- Capturing list/search pages of POE (only niche detail pages).

## Key Decisions

- D1 Same two-layer content-script design as the reference (MAIN interceptor +
  ISOLATED bridge) because response bodies are only readable from the page world.
- D2 No license gate; no background worker at all (simpler, fewer permissions).
- D3 Regional Seller Central domains listed explicitly (match patterns cannot
  express `amazon.*`); growth URL derived from `location.origin`.
- D4 Human pacing via jitter rather than fixed 400 ms gap — closer to a person
  clicking tabs and less likely to trip throttling.
