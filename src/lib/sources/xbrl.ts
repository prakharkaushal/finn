import { cached, type Cached } from "@/lib/net/cache";
import { assertDocumentUrl, DOCUMENT_HOSTS, fetchText } from "@/lib/net/http";

/**
 * SEBI Reg-30 disclosures are filed as XBRL alongside the PDF. They are structured,
 * primary-source and tiny, so FINN reads them deterministically — no LLM involved.
 * This is where the incoming executive's "brief profile" comes from.
 */

export type XbrlFact = { name: string; group: string; value: string; unit?: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** "D_ChangeInManagement2" → "ChangeInManagement2"; "I_FooMember" → "Foo"; "MainI" → "Main". */
export function contextGroup(contextRef: string): string {
  if (/^Main[ID]?$/.test(contextRef)) return "Main";
  return contextRef.replace(/^[DI]_/, "").replace(/Member$/, "");
}

export function parseXbrlFacts(xml: string): XbrlFact[] {
  const facts: XbrlFact[] = [];
  // Facts are leaf elements carrying a contextRef; their body is plain text. Matching only
  // text bodies keeps the root <xbrli:xbrl> element from swallowing the whole document.
  const re = /<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)\b([^>]*?)>([^<]*)<\/\1:\2>/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[3];
    const ctx = attrs.match(/contextRef="([^"]+)"/);
    if (!ctx || m[1] === "xbrli") continue;
    const value = decode(m[4]);
    if (!value) continue;
    const unit = attrs.match(/unitRef="([^"]+)"/)?.[1];
    facts.push({ name: m[2], group: contextGroup(ctx[1]), value, unit });
  }
  return facts;
}

export type PersonChange = {
  name: string;
  changeType: string;
  cessationCategory?: string;
  role: string;
  roleCategory?: string;
  effectiveDate?: string;
  briefProfile?: string;
  remarks?: string;
  resignationLetterReceived?: string;
  detailedReasonGiven?: boolean;
};

export type OrderWin = {
  counterparty?: string;
  amountInr?: number;
  consideration?: string;
  nature?: string;
  executionPeriod?: string;
  geography?: string;
  ordinaryCourse?: boolean;
  relatedParty?: boolean;
  date?: string;
};

export type DealDetails = {
  eventType?: string;
  /** Present on update filings, e.g. "Transaction Completed". */
  update?: string;
  background?: string;
  amountInr?: number;
  completedOn?: string;
  acquirer?: string;
  target?: string;
  industry?: string;
  targetTurnoverInr?: number;
  targetNetWorthInr?: number;
  consideration?: string;
  relatedParty?: boolean;
  armsLength?: boolean;
  promoterInterest?: boolean;
  completion?: string;
  objects?: string;
};

export type CapitalChange = {
  event?: string;
  /** e.g. "ESOP/ESPS", "Preferential Issue", "QIP". */
  issuanceType?: string;
  security?: string;
  sharesBefore?: number;
  sharesAfter?: number;
  /** Share-count dilution in percent, computed from the before/after counts. */
  dilutionPct?: number;
};

export type XbrlDetails =
  | { kind: "management"; people: PersonChange[] }
  | { kind: "order"; orders: OrderWin[] }
  | { kind: "deal"; deal: DealDetails }
  | { kind: "capital"; capital: CapitalChange }
  | { kind: "generic"; fields: { label: string; value: string }[] };

export type XbrlDocument = {
  symbol?: string;
  bseCode?: string;
  companyName?: string;
  reportDate?: string;
  details: XbrlDetails;
};

/** Placeholders companies type into mandatory fields; they mean "not stated here". */
const NOT_APPLICABLE = /^(not applicable|na|n\.?a\.?|nil|none|-+|not disclosed|(please )?refer (to )?(the )?(above|below|press release|annexure).*)$/i;

function clean(v?: string): string | undefined {
  if (!v || NOT_APPLICABLE.test(v)) return undefined;
  return v;
}
function bool(v?: string): boolean | undefined {
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}
function num(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
/** Amounts of 0 in mandatory fields mean "not disclosed", not a zero-value contract. */
function amount(v?: string): number | undefined {
  const n = num(v);
  return n != null && n > 0 ? n : undefined;
}

function grouped(facts: XbrlFact[]) {
  const groups = new Map<string, Map<string, string>>();
  for (const f of facts) {
    let g = groups.get(f.group);
    if (!g) groups.set(f.group, (g = new Map()));
    if (!g.has(f.name)) g.set(f.name, f.value);
  }
  return groups;
}

/** Person facts are split across D_/I_ contexts with the same index; merge them by index. */
function managementChanges(facts: XbrlFact[]): PersonChange[] {
  const groups = grouped(facts);
  const people: PersonChange[] = [];
  const resignations = [...groups.entries()].filter(([k]) => /^ResignationOfDirector/.test(k)).map(([, g]) => g);
  for (const [key, g] of groups) {
    if (!/^ChangeInManagement\d*$/.test(key)) continue;
    const name = g.get("NameOfDesignatedPerson");
    if (!name) continue;
    const salutation = g.get("SalutationOfDesignatedPerson");
    const resignation = resignations.find((r) =>
      [...r.entries()].some(([k, v]) => k.startsWith("NameOf") && v.toLowerCase() === name.toLowerCase()),
    );
    people.push({
      name: salutation ? `${salutation} ${name}` : name,
      changeType: g.get("TypeOfChange") ?? "Change",
      cessationCategory: clean(g.get("CategoryOfCessation")),
      role: g.get("DesignationOfDesignatedPerson") ?? "Not stated in filing",
      roleCategory: clean(g.get("CategoryForChange")),
      effectiveDate: clean(g.get("EffectiveDateOfReasonOfChange")),
      briefProfile: clean(g.get("BriefProfile")),
      remarks: clean(g.get("RemarksForChangeInManagement") ?? g.get("ReasonForChange")),
      resignationLetterReceived: clean(resignation?.get("DateOnWhichTheResignationLetterWasReceived")),
      detailedReasonGiven: bool(resignation?.get("WhetherTheLetterOfResignationHasTheDetailedReasonForResignation")),
    });
  }
  return people;
}

function orderWins(facts: XbrlFact[]): OrderWin[] {
  const orders: OrderWin[] = [];
  for (const [, g] of grouped(facts)) {
    if (!g.has("AmountOfTheOrdersOrContracts") && !g.has("NameOfTheEntityAwardingTheOrdersOrContracts")) continue;
    orders.push({
      counterparty: clean(g.get("NameOfTheEntityAwardingTheOrdersOrContracts")),
      amountInr: amount(g.get("AmountOfTheOrdersOrContracts")),
      consideration: clean(g.get("BroadConsiderationForTheOrdersOrContracts")),
      nature: clean(g.get("NatureOfOrdersOrContracts")),
      executionPeriod: clean(g.get("TimePeriodByWhichTheOrdersOrContractsIsToBeExecuted")),
      geography: clean(g.get("WhetherOrdersOrContractsIsAwardedByDomesticOrInternationalEntity")),
      ordinaryCourse: bool(g.get("WhetherTheOrdersOrContractsIsOrdinaryCourseOfBusiness")),
      relatedParty: bool(g.get("WhetherTheOrderOrContractWouldFallWithinRelatedPartyTransactions")),
      date: clean(g.get("DateOfBaggingOrReceivingOfOrdersOrContracts")),
    });
  }
  return orders;
}

function first(facts: XbrlFact[], pattern: RegExp): string | undefined {
  return clean(facts.find((f) => pattern.test(f.name))?.value);
}

function deal(facts: XbrlFact[]): DealDetails {
  return {
    eventType: first(facts, /^(TypeOfEventOfAnnouncementPertainingToRegulation30\w*|UpdateForTheEvent)$/),
    update: first(facts, /^ReasonForUpdate$/),
    background: first(facts, /^BriefDetailsOfInitialAnnouncement$/),
    amountInr: amount(first(facts, /^AmountOfTransactionCompleted$/)),
    completedOn: first(facts, /^DateOfTransactionCompleted$/),
    acquirer: first(facts, /^NameOfAcquirer$/),
    target: first(facts, /^NameOfTheTargetEntity$/),
    industry: first(facts, /^IndustryToWhichTheEntityBeingAcquiredBelongs$/),
    targetTurnoverInr: num(first(facts, /^TurnoverOfTargetEntity$/)),
    targetNetWorthInr: num(first(facts, /^NetWorthOfTargetEntity$/)),
    consideration: first(facts, /^(NatureOfConsiderationForAcquisitionEvent|CostOfAcquisition\w*|PriceAtWhichTheSharesAreAcquired\w*)$/),
    relatedParty: bool(first(facts, /^WhetherTheAcquisitionWouldFallWithinRelatedPartyTransactions$/)),
    armsLength: bool(first(facts, /^WhetherAcquisitionEventIsDoneAtArmsLength$/)),
    promoterInterest: bool(first(facts, /^WhetherThePromoterOrPromoterGroup\w*InterestInTheEntityBeingAcquired$/)),
    completion: first(facts, /^IndicativeTimePeriodForCompletionOfTheAcquisition$/),
    objects: first(facts, /^ObjectsAndImpactOfAcquisition/),
  };
}

function capital(facts: XbrlFact[]): CapitalChange {
  const before = num(first(facts, /^NumberOfSharesPaidUpPreAllotmentOfSecurities$/));
  const after = num(first(facts, /^NumberOfSharesPaidUpPostAllotmentOfSecurities$/));
  return {
    event: first(facts, /^TypeOfEvent$/),
    issuanceType: first(facts, /^TypeOfIssuance\w*$/),
    security: first(facts, /^TypeOfSecuritiesAllotted\w*$/),
    sharesBefore: before,
    sharesAfter: after,
    dilutionPct: before && after && after >= before ? ((after - before) / before) * 100 : undefined,
  };
}

const BOILERPLATE = /^(NSESymbol|NameOfTheCompany|ScripCode|MSEISymbol|ISIN|DateOfReport|RelationshipWithTheListedEntity|WhetherDisclosureFiledForListedEntity|.*TimeOfBoardMeeting|TypeOfAnnouncement\w*)$/;

/** "NameOfTheTargetEntity" → "Name of the target entity". */
export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function genericFields(facts: XbrlFact[]): { label: string; value: string }[] {
  const seen = new Set<string>();
  const out: { label: string; value: string }[] = [];
  for (const f of facts) {
    if (BOILERPLATE.test(f.name) || seen.has(f.name) || f.value === "false" || NOT_APPLICABLE.test(f.value)) continue;
    seen.add(f.name);
    out.push({ label: humanize(f.name), value: f.value === "true" ? "Yes" : f.value });
    if (out.length >= 8) break;
  }
  return out;
}

export function interpretXbrl(xml: string): XbrlDocument {
  const facts = parseXbrlFacts(xml);
  const main = (n: string) => facts.find((f) => f.name === n)?.value;
  const header = {
    symbol: main("NSESymbol"),
    bseCode: main("ScripCode"),
    companyName: main("NameOfTheCompany"),
    reportDate: main("DateOfReport"),
  };
  const names = new Set(facts.map((f) => f.name));
  let details: XbrlDetails;
  if (names.has("NameOfDesignatedPerson")) details = { kind: "management", people: managementChanges(facts) };
  else if (names.has("AmountOfTheOrdersOrContracts") || names.has("NameOfTheEntityAwardingTheOrdersOrContracts"))
    details = { kind: "order", orders: orderWins(facts) };
  else if (
    names.has("NameOfTheTargetEntity") ||
    names.has("UpdateForTheEvent") ||
    [...names].some((n) => n.startsWith("TypeOfEventOfAnnouncementPertainingToRegulation30"))
  )
    details = { kind: "deal", deal: deal(facts) };
  else if ([...names].some((n) => n.startsWith("TypeOfIssuance")) || names.has("NumberOfSharesPaidUpPostAllotmentOfSecurities"))
    details = { kind: "capital", capital: capital(facts) };
  else details = { kind: "generic", fields: genericFields(facts) };
  return { ...header, details };
}

/**
 * XBRL documents are immutable once filed, so the raw XML is cached forever by URL and
 * interpreted on read — parser improvements apply to everything already cached.
 */
export async function loadXbrl(url: string): Promise<Cached<XbrlDocument>> {
  assertDocumentUrl(url);
  const raw = await cached(url, { namespace: "xbrl-raw", ttlMs: Infinity }, () =>
    fetchText(url, { source: "NSE XBRL filing", timeoutMs: 10_000, retries: 1, allowHosts: DOCUMENT_HOSTS }),
  );
  return { ...raw, value: interpretXbrl(raw.value) };
}
