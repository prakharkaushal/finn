"use client";

import { useEffect, useRef, useState } from "react";
import { formatCroreInr } from "@/lib/domain/numbers";
import { cx } from "@/components/ui";

/**
 * Small single-axis bar charts. Thin bars with rounded data ends on the baseline, a 2px gap,
 * no number on every bar: tap or hover a bar to read its value in the line above the chart.
 * Width is capped so labels stay readable rather than scaling up on wide screens. A label may
 * hold a line break ("Q2\nFY25") so fiscal quarters are spelled out without crowding.
 */

type Series = { name: string; values: (number | null)[]; color: string };

function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function negPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w - rr}Q${x + w},${y + h} ${x + w},${y + h - rr}V${y}Z`;
}

const oneLine = (label: string) => label.replace("\n", " ");

export function BarChart({
  labels,
  series,
  format = (v) => formatCroreInr(v),
  height = 120,
  caption,
}: {
  labels: string[];
  series: Series[];
  format?: (v: number) => string;
  height?: number;
  caption: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  if (!all.length) return null;
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const W = 320;
  const top = 6;
  // Bars only: the axis labels are HTML below, so they keep their size however wide the chart is.
  const H = height - 18;
  const plotH = H - top - 1;
  const span = max - min || 1;
  const zeroY = top + (max / span) * plotH;
  const group = W / labels.length;
  const gap = 2;
  const barW = Math.max(3, Math.min(18, (group - 10 - gap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const shown = active ?? labels.length - 1;

  return (
    <figure className="mt-5 max-w-[460px]">
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-muted">
        <span className="font-medium text-ink">{caption}</span>
        {series.length > 1 &&
          series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
              {s.name}
            </span>
          ))}
      </figcaption>
      <p className="mt-1 text-[13px] text-muted" aria-live="polite">
        <span className="font-medium text-ink">{oneLine(labels[shown])}</span>
        {series.map((s) => (
          <span key={s.name}>
            {" · "}
            {series.length > 1 ? `${s.name} ` : ""}
            <span className="num whitespace-nowrap text-ink">{s.values[shown] == null ? "—" : format(s.values[shown]!)}</span>
          </span>
        ))}
        {active == null && <span className="text-faint"> · tap a bar to read it</span>}
      </p>
      <div className="mt-1.5" onMouseLeave={() => setActive(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`${caption}. Values are listed in the table below.`}>
          <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--line-strong)" strokeWidth={1} />
          {labels.map((label, i) => {
            const gx = i * group + (group - groupW) / 2;
            return (
              <g key={label} onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} className="cursor-pointer" opacity={active == null || active === i ? 1 : 0.45}>
                <rect x={i * group} y={0} width={group} height={H} fill="transparent" />
                {series.map((s, j) => {
                  const v = s.values[i];
                  if (v == null) return null;
                  const x = gx + j * (barW + gap);
                  const h = (Math.abs(v) / span) * plotH;
                  return <path key={s.name} d={v >= 0 ? barPath(x, zeroY - h, barW, h) : negPath(x, zeroY, barW, h)} fill={s.color} />;
                })}
                <title>{`${oneLine(label)}: ${series.map((s) => `${s.name} ${s.values[i] == null ? "—" : format(s.values[i]!)}`).join(", ")}`}</title>
              </g>
            );
          })}
        </svg>
        {/* Equal-width cells line up under the bars' equal-width groups. The table carries the values for assistive tech. */}
        <div className="flex" aria-hidden="true">
          {labels.map((label, i) => {
            const [first, second] = label.split("\n");
            return (
              <div
                key={label}
                onMouseEnter={() => setActive(i)}
                onClick={() => setActive(i)}
                className={cx("min-w-0 flex-1 cursor-pointer pt-1 text-center text-[12px] leading-tight", active != null && active !== i && "opacity-45")}
              >
                <span className="block text-muted">{first}</span>
                {second && <span className="block text-faint">{second}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </figure>
  );
}

/**
 * Compact numeric table — the accessible twin of every chart. On a narrow screen it opens on the
 * latest columns (what an investor reads first) and scrolls back for earlier periods.
 */
export function SeriesTable({
  caption,
  labels,
  rows,
}: {
  caption: string;
  labels: string[];
  rows: { name: string; values: (number | null)[]; format: (v: number) => string }[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  // Where the frozen label column ends, while columns are scrolled under it: a fade there keeps a
  // half-hidden cell ("126" of "₹1,126") from reading as a number.
  const [under, setUnder] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    const update = () => {
      setScrolls(el.scrollWidth > el.clientWidth + 1);
      setUnder(el.scrollLeft > 1 ? (el.querySelector("th")?.getBoundingClientRect().width ?? 0) : null);
    };
    const id = requestAnimationFrame(update);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(id);
      el.removeEventListener("scroll", update);
    };
  }, [labels.length]);
  return (
    <div className="mt-4">
      <div className="relative">
        {under != null && <span aria-hidden="true" className="pointer-events-none absolute inset-y-px z-10 w-9 bg-linear-to-r from-surface to-transparent" style={{ left: under + 1 }} />}
        <div ref={box} className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={`${caption} (scrolls sideways)`}>
          <table className="w-full min-w-[440px] text-[13px]">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="bg-surface-2/60">
                <th scope="col" className="sticky left-0 bg-surface-2 shadow-[inset_-1px_0_0_var(--line)] px-3 py-2 text-left font-medium text-muted">
                  <span className="sr-only">Metric</span>
                </th>
                {labels.map((l) => (
                  <th key={l} scope="col" className="num whitespace-nowrap px-3 py-2 text-right font-medium text-muted">
                    {oneLine(l)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-line">
                  <th scope="row" className="sticky left-0 whitespace-nowrap bg-surface shadow-[inset_-1px_0_0_var(--line)] px-3 py-2 text-left font-normal text-muted">
                    {r.name}
                  </th>
                  {r.values.map((v, i) => (
                    <td key={i} className={cx("num whitespace-nowrap bg-surface px-3 py-2 text-right", v != null && v < 0 && "text-down")}>
                      {v == null ? "—" : r.format(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {scrolls && <p className="t-meta mt-1">Earlier {labels[0]?.startsWith("Q") ? "quarters" : "years"} are to the left — swipe the table.</p>}
    </div>
  );
}
