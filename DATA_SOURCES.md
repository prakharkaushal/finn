# Data sources

Every source FINN reads, what it is used for, whether it is primary, how often it is refreshed, what its parser cannot do, and what happens when it fails. The code for each is behind one adapter in `src/lib/sources/` and `src/lib/data/adapters/`.

**Primary** means the company's own disclosure or the exchange's own record. **Secondary** means a third party's compilation or market-data feed.

**Pull research uses primary sources only as evidence.** Every quote and every page citation comes from the company's annual report, call transcripts, investor presentation or results filing. screener.in is used only to *find* those documents and to supply standardised tables. It is labelled *secondary* wherever it is cited, and FINN traces the figures it uses back to a page of the filing where it can. No news, broker notes, research reports or model knowledge are used.

## Sources

| Source | Used for | Primary? | Refresh (cache) | Parsing limits | When it fails |
|---|---|---|---|---|---|
| [NSE corporate announcements](https://www.nseindia.com/companies-listing/corporate-filings-announcements), JSON behind the page: `www.nseindia.com/api/corporate-announcements?symbol=…&from_date=…&to_date=…` | Inbox: each company's filings for the chosen window | Primary (exchange) | 10 min per company and window | Undocumented endpoint. A row without a parsable time is dropped and counted. An HTML answer counts as a refusal. | Stops at the first refusal; the RSS feed and the archive fill in. The inbox labels it *Unavailable* and lists coverage gaps. |
| [NSE announcements RSS](https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml) | Inbox: today's filings across all companies | Primary (exchange) | 5 min | Holds the current day only (restarts at midnight). Truncated or HTML answers give no items. | API and archive cover it, labelled. |
| NSE Reg-30 XBRL disclosures (`nsearchives.nseindia.com`, linked from filings) | Inbox: people changes (name, role, effective date, the company's own profile of appointees), order wins, deals, allotments | Primary (exchange) | Forever (a filing never changes) | Only the XBRL types FINN knows are interpreted; others keep the exchange's subject line. | The card shows the filing without structured facts. |
| [NSE equity master list](https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv) (`EQUITY_L.csv`) | Validating tickers; search by name | Primary (exchange) | 1 day | Equities only: ETFs and BSE-only companies are reported as not listed. | Committed copy in `data/snapshot`, labelled. |
| NSE bhavcopy (`nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_…csv.zip`) | End-of-day prices (official, as traded) | Primary (exchange) | Settled days forever; the latest 30 min | About 31 sessions, so no 52-week checks; NSE listings only. | Yahoo, then the snapshot. `FINN_PRICE_PROVIDER=nse-bhavcopy` puts it first. |
| [Yahoo Finance chart](https://finance.yahoo.com) (`query1.finance.yahoo.com/v8/finance/chart/SYMBOL.NS`) | End-of-day prices and volumes, one year (rules, sparklines, 52-week range) | Secondary (market data) | 10 min in market hours, 2 h otherwise | Unofficial endpoint (its robots.txt disallows crawlers), so one cached request per company. A session listed without a close is skipped and reported, never filled. A session sent twice is counted once. | NSE bhavcopy, then the snapshot, labelled. |
| [screener.in](https://www.screener.in) company pages (`/company/SYMBOL/consolidated/`) | Standardised statements (results QoQ/YoY, research tables); links to annual reports, transcripts and presentations; BSE's latest filings | **Secondary** | 30 min | Only `/company/` pages are read (robots.txt allows them). Consolidated first, then standalone, never mixed. A page without the company ratio block (an error or access page) is refused, not parsed. A quarter screener has not added yet is shown as missing, not guessed. | Committed snapshot for the 24 seeded companies, labelled. Otherwise *Statements unavailable*, with the reason. |
| Company documents: annual reports, earnings-call transcripts, investor presentations (on `www.bseindia.com`, `nsearchives.nseindia.com` or the company's own site) | **Research evidence**: business snapshot, figure citations, guidance quotes, stated-vs-reported checks | **Primary** (the company) | Extracted text kept forever | Latest annual report read to 300 pages and 40 MB; transcripts to 60 pages; no OCR (scanned PDFs are marked unreadable); segment tables are quoted, not computed. A document that never names the company is set aside. | Each document's status (read, failed and why, not read and why) is listed under Sources. Views without evidence say so and offer *Add a primary source*. |
| Latest results filing (NSE announcements) | Research: the quarter's figures, cited to a page | **Primary** (exchange filing) | As NSE announcements | Very large PDFs (over the size cap) are refused with the reason. | Cited at document level, or listed as failed. |
| Links an investor adds (Sources → *Add a primary source*) | Research evidence the discovery missed | As stated by the investor, labelled *added by you* | Extracted text kept forever | Public `https` only (private hosts refused); must be a readable PDF; must name the company. | Listed as failed with the reason; the rest of the report is unaffected. |
| Committed snapshot (`data/snapshot/`, written by `npm run snapshot`) | Demo data; last-resort fallback; filings archive for older windows; 24 precomputed research reports | FINN's own capture of the sources above (28 Oct 2026) | Only when `npm run snapshot` is re-run | — | — (it is the fallback). Always labelled *Demo*, *Snapshot* or *Archive* with its capture time. |

## How requests are made

FINN identifies itself (`FINN_USER_AGENT`), caps concurrency and spaces requests per host, and retries server errors with backoff. A host that sends no response is not retried and is not asked again for a minute, so callers fall back at once to the labelled snapshot. FINN never uses cookies or header tricks to get past a block: BSE's announcements API answers 403 to a plain request, so it is not used.

## Checking a source from your machine

- `npm run probe` runs a small live sample against every provider.
- **Settings → Data & models** shows each provider's status, last error and caveat, and runs the same check. The same data is at `GET /api/status` (`?probe=1`, at most once every two minutes).
- `GET /api/data/SYMBOL` returns the normalised records one listing yields, with each provider's error.
