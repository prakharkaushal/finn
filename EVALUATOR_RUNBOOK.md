# Evaluator runbook — FINN in three minutes

**Where:**
- Deployed: [DEPLOYED URL — not yet verified]. Open it on a phone, or in a desktop browser at phone width.
- Locally: `npm install && npm run dev`, then http://localhost:3000.

**Which data:**
- The badge at the top right says **Live data** or **Demo data**.
- For a run that matches this script exactly, tap the badge → **Demo data** (Settings → *Data & models*). Every screen then replays FINN's capture of **28 Oct 2026, 09:56 IST**, and a banner says so.
- Live data works the same way with today's filings and prices.
- If a live source is rate-limited, the error says so and offers **Use demo data instead**.

The figures below are from the demo capture.

---

### 1 · The prioritised digest (0:00–0:40)

1. Open **Inbox**. The title reads **"13 things need you"**.
   - Under *Needs attention*, the results filings come first, ranked by priority score: CIPLA, SYNGENE, HOMEFIRST, LT, MARUTI, BAJAJ-AUTO.
   - Then key people changes, such as *HOMEFIRST — CFO appointed: Ms. Rinkoo Somani*.
   - Below them, **Price & volume alerts** are compact rows (CIPLA volume 4.2× average; HAVELLS and HDFCBANK at 52-week lows).
   - Routine filings are folded into one line.
2. Next to the 24h–30d control, the status says **Demo data 28 Oct, 09:56**: what the data is and when it was taken.

### 2 · One filing and its source (0:40–1:30)

1. Tap **CIPLA — Q2 FY27 results**.
   - **From the filing:** the exchange's description, then the headline numbers — Revenue ₹7,404 cr (+4.0% QoQ, −2.4% YoY), EBITDA ₹1,388 cr, PBT ₹1,177 cr, PAT ₹852 cr (−37.0% YoY). They are consolidated, in ₹ crore, against Q1 FY27 and Q2 FY26.
   - **Documents:** NSE links, with *"Demo data: a real NSE filing replayed from FINN's capture…"*.
   - **FINN's reading:** how it was classified, why it is an alert, and *How FINN ranked this* — the score as a sum of named points.
2. Tap **Filing** (on the card, or any document link). The NSE PDF opens, so a number can be checked against it.

### 3 · Change an alert threshold and see the calculation (1:30–2:15)

1. Tap **Rules** (top right). Under *Price & volume rules*, press **−** four times: *Daily price move beyond ±* goes from **4%** to **2%**.
2. Back in **Inbox**, the title reads **"17 things need you"**. New price rows appear: BAJAJ-AUTO *Rose 3.2%*, BHARTIARTL *Rose 3.2%*, TRENT *Rose 2.4%*, MARUTI *Rose 2.0%*.
3. Tap **BAJAJ-AUTO — Rose 3.2%**:
   - *From the source:* close ₹10,390.00, previous close ₹10,071.00. 10,390 ÷ 10,071 − 1 = **+3.17%**.
   - *Rules that fired:* "Moved +3.2% (rule: ±2%)".
   - *How FINN ranked this:* "Size · Moved +3.2%, 1.6× your ±2% rule **+6**".
4. MARUTI's results card now scores 117 instead of 112: *"Shares also tripped your rule +5"*.
5. Set the rule back to 4% (press **+** four times).

### 4 · Research a ticker and check the evidence (2:15–3:00)

1. Open **Research** and tap **Kaynes Technology** (precomputed, so it opens at once). The *Data status* line says what was read: the FY26 annual report (300 of 321 pages), 4 call transcripts, the Q1 FY27 results filing and the Aug 2026 presentation.
2. **Business:** *Source says* "Kaynes Technology India Limited ('Kaynes', 'Our Company' or 'We') is a leading end-to-end…". Tap **Annual report FY26 p. 10** and the PDF opens on that page.
3. **Financials:** "Revenue compounded at 53.9% a year over FY21–FY26 (₹420 cr → ₹3,626 cr)". Beside it, *Source says* "Revenue from Operations … 36,263.54", with the note that figures on that page are in ₹ million. Tap **p. 50**.
4. **Narrative vs numbers:** *FY26 Revenue target ₹4,500 cr — Missed*.
   - Management's own quote is cited to *Q4 FY26 call p. 8 · Viral Shah*.
   - The reported FY26 revenue is ₹3,626 cr, with the assessment "81% of the ₹4,500 cr promised".
5. **Any other company** (live data only): type a ticker such as `TITAN` and press Enter. The report builds from the company's own documents in about 15–40 seconds, with progress shown, and *Sources* lists every document found, read or not.

---

### What to notice along the way

- Nothing unlabelled: every screen and item says *Live*, *Cached*, *Archive*, *Snapshot*, *Demo* or *Sample*, with a time.
- Plain text is FINN's arithmetic or rule. *Source says* is quoted verbatim and links to its page. A figure FINN could not find on a page is marked *document-level*, never given a guessed page.
- No model writes any number. Without an API key the LLM steps are off, and every view still works.
- Every company in the inbox has a precomputed research report: tap its ticker on any card and the report opens at once, in live or demo data. Other tickers need live data.
