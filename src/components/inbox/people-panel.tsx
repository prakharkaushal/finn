"use client";

import { useState } from "react";
import { roleRank } from "@/lib/domain/classify";
import { shortDate } from "@/lib/format";
import type { PersonChange } from "@/lib/sources/xbrl";
import { UserIcon } from "@/components/icons";
import { Button, SourceLink } from "@/components/ui";

function linkedInSearch(name: string, company: string) {
  const bare = name.replace(/^(mr|ms|mrs|dr|shri|smt)\.?\s+/i, "");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${bare} ${company}`)}`;
}

function Person({ p, company }: { p: PersonChange; company: string }) {
  const [open, setOpen] = useState(false);
  const exit = /cessation|resign|retire/i.test(`${p.changeType} ${p.cessationCategory ?? ""}`);
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted" aria-hidden="true">
        <UserIcon size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-snug">
          {p.name} <span className="font-normal text-muted">· {p.role}</span>
        </p>
        <p className="mt-0.5 text-[13px] text-muted">
          <span className={exit ? "font-medium text-down" : "font-medium text-up"}>{p.cessationCategory ?? p.changeType}</span>
          {p.roleCategory && ` · ${p.roleCategory}`}
          {p.effectiveDate && ` · effective ${shortDate(p.effectiveDate)}`}
        </p>
        {exit && (p.resignationLetterReceived || p.detailedReasonGiven === false) && (
          <p className="mt-1 text-[13px] text-muted">
            {p.resignationLetterReceived && `Letter received ${shortDate(p.resignationLetterReceived)}. `}
            {p.detailedReasonGiven === false && <span className="text-warn">No detailed reason given in the resignation letter.</span>}
          </p>
        )}
        {p.briefProfile ? (
          <div className="mt-2">
            <p className={open ? "text-[14px] leading-relaxed text-ink" : "line-clamp-3 text-[14px] leading-relaxed text-ink"}>{p.briefProfile}</p>
            <Button variant="ghost" size="sm" className="-ml-3 mt-0.5" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Show less" : "Read full profile"}
            </Button>
            <p className="t-meta">From the filing: the company&apos;s own profile of this person, disclosed to NSE (Reg. 30 XBRL).</p>
          </div>
        ) : (
          !exit && <p className="mt-1 text-[13px] text-muted">The filing gives no profile.</p>
        )}
        {!exit && (
          <p className="t-meta mt-1">
            No outside biography retrieved — FINN does not use LinkedIn or news.{" "}
            <SourceLink href={linkedInSearch(p.name, company)} label={`Search LinkedIn for ${p.name} yourself (not checked by FINN)`}>
              Search LinkedIn yourself
            </SourceLink>
          </p>
        )}
      </div>
    </li>
  );
}

/** Who joined or left, with the company's own disclosed background on incoming people. */
export function PeoplePanel({ people, company }: { people: PersonChange[]; company: string }) {
  const [all, setAll] = useState(false);
  const ranked = [...people].sort((a, b) => roleRank(b.role) - roleRank(a.role));
  const shown = all ? ranked : ranked.slice(0, 2);
  return (
    <div>
      <ul className="divide-y divide-line">
        {shown.map((p) => (
          <Person key={`${p.name}-${p.role}`} p={p} company={company} />
        ))}
      </ul>
      {ranked.length > 2 && (
        <Button variant="ghost" size="sm" className="-ml-3 mt-1" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show fewer people" : `Show ${ranked.length - 2} more`}
        </Button>
      )}
    </div>
  );
}
