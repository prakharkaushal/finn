# Product decisions

FINN is designed for one person: a portfolio investor checking a phone between meetings on a trading day. Every screen is judged by whether that person can tell, in a few seconds, **what needs them, why, and where the proof is** — and whether they can trust what they are looking at. This note records the main interaction choices, what was prioritised, and what was deliberately left out.

## 1. The first screen is for decisions

- **The inbox opens on a count and goes straight to the list.** "9 things need you", one row of controls (window, status, refresh), one row of filter chips, then the items. On a phone the first screen shows two or three items. Context — the portfolio's movers, the results calendar, routine paperwork, source details — comes *after* the decisions on a phone and sits in a sidebar on desktop. An earlier layout put seven rows of controls and context above the first headline.
- **Material filings and market moves are different kinds of signal, so they look different.** Results, deals, management changes and legal filings get full cards. Price and volume rules that fired get compact rows of their own: what fired, the move, its shape, and — when there is one — the filing that may explain it ("A filing may explain it — Q2 FY27 results"). A 52-week low should not take the same room as an insolvency filing, and the investor probably sees prices on a terminal already.
- **Routine paperwork is one collapsed line**, opening to one row per filing that links straight to the document.
- **Order is the explanation.** Items are ranked by FINN's priority score, which is shown point by point when a card is opened, not as a bare number on every card face (the number meant nothing at a glance).

## 2. Colour has to mean something

- The signal colour marks material filings (a thin rule on the card) and alerts that are **new since this device last looked**. On a first visit every alert is new, so none is marked; an alert already seen is a neutral tag with a small bolt. Before this pass every attention card carried an orange "New alert" tag, which made the whole list one colour.
- Green and red appear only on signed numbers, which always carry a sign. Sparklines are shape only, with a dot on the latest close: they used to be coloured by their own first-to-last trend, so a stock up 3.9% today could sit beside a red line.
- Research claims carry a **+ / −** glyph for favourable / unfavourable as well as colour, so the meaning survives colour-blindness and greyscale.

## 3. One tap to the evidence, and fact kept apart from interpretation

- Every filing card has a **Filing** button (40 px) beside **Done**. The link used to be a small text link that wrapped onto its own line.
- An opened card is split into **From the filing** and **FINN's reading**, and closes from the bottom (**Hide details**) as well as the top, returning the reader to where the card starts.
- In research, every figure links to its page in the annual report or results filing, or says that its citation is document-level. A "Reported" figure in *Narrative vs numbers* links to the table it came from. A one-line legend on each view says how to read it: plain text is FINN's arithmetic or rule; **Source says** is quoted verbatim from the company's document.
- The business snapshot's quote now opens at the company's own sentence. It used to open on a page heading that ran into it ("Redefining the Future of Integrated ESDM About Kaynes Technology Kaynes Technology India Limited…"). The quote is still a verbatim substring of the cited page.

## 4. Status is honest, and it comes first

- **One status per screen, exceptions per item.** The inbox shows *Live*, *Partly cached*, *Demo* or *Sample* with its time; an item repeats a label only when it differs (*Archive*, *Stale*, *Demo*, *Sample*). Labelling every live item "Live" was noise that hid the exceptions.
- **Cached is not live.** A research report served from FINN's six-hour cache is labelled *Cached · built 19:10*, not *Live*. Any badge for data that is not from today shows its date.
- **Data status leads with one sentence** of what was actually read and how many documents could not be read. On a phone it is folded to that sentence and opens to a row per source (annual report and pages read, transcripts, results filing, presentation, statements, prices, build time). On desktop it sits open in the sidebar. "Synthesis off" is shown as an absence, not a red failure: it is a configuration, and every view works without it.
- **Warnings come before data.** A source failure or stale feed is announced directly under the inbox header; it used to appear below the portfolio strip.

## 5. Every dead end offers a next step

- An unknown or uncovered ticker leads back to search; it no longer offers a retry that would fail the same way.
- A research build shows its live steps and says what to expect: a first report usually takes 15–40 seconds and is then kept for six hours.
- A quiet window offers to look back seven days. A document FINN could not read says why, and the Sources view lets the investor add a public link to it (the form has visible labels, because on a phone a placeholder such as "2026" read as a value already filled in).

## 6. Mobile first, not mobile squeezed

- Every interactive target is at least 24 px (WCAG 2.5.8), primary actions 40 px. Checked with a script at 320, 390 and 1280 px wide, light and dark: no horizontal overflow, no text under 12 px, no text below 4.5:1 contrast.
- **Report views are one pinned row of links at every width.** On desktop they used to sit in a side list below a tall status panel, off the first screen. They are real `?view=` links, so Back returns to the previous view and a view can be opened in a new tab or shared. A fade marks the row when more views follow off-screen.
- **Tables open on the latest columns** — the periods an investor reads first — with a frozen label column, a fade where columns scroll under it, and a note that earlier periods are to the left. Quarters are spelled "Q1 FY27", with a note that Q1 is April–June, so they are not read as calendar quarters. Chart captions carry units, and each chart has a full table beside it.

## Left out, on purpose

- **Push notifications and email.** Sending alerts while the app is closed needs a scheduled job, a server-side store of rules and alerts already sent, and a sender. FINN shows alerts in the app and says plainly, in Settings, that it does not send them.
- **A separate "top three" banner.** Once the controls moved out of the way, the ranked list shows the top items on the first screen; a banner would have repeated them.
- **Sort and layout options.** The order is the explanation; a second ordering would need its own explanation.
- **Axes, gridlines and dual-axis charts.** The charts are small bars with a tap-to-read value and a full table. Two measures of different scale are never put on one chart.
- **An in-app dark-mode switch.** FINN follows the system setting; both themes are tested.
- **A model-written summary at the top of research.** Every view is deterministic and cited. The optional synthesis needs an API key, sits at the end of *Bull vs bear*, and cites the same facts.
