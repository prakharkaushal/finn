"use client";

import Link from "next/link";
import { useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { describeChange, type Change } from "@/lib/domain/numbers";
import { clock, dateTime, istDay, shortDate } from "@/lib/format";
import { useClientNow } from "@/components/client-time";
import { ExternalIcon } from "@/components/icons";

/** Shared primitives. Components compose these instead of restyling buttons and labels ad hoc. */

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---- Buttons ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "md" | "sm" | "icon";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink text-bg hover:opacity-90",
  secondary: "border border-line-strong bg-surface text-ink hover:border-ink",
  ghost: "text-muted hover:bg-surface-2 hover:text-ink",
  danger: "border border-down/50 bg-surface text-down hover:border-down",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 text-sm",
  sm: "min-h-10 px-3 text-[13px]",
  icon: "size-10 shrink-0",
};

/**
 * `extra` must not restate a property set here: Tailwind resolves same-property conflicts by
 * stylesheet order, not class order. Use `wrap` for long labels and responsive variants
 * (`max-sm:…`) for per-breakpoint overrides.
 */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string, wrap = false) {
  return cx(BUTTON_BASE, wrap ? "whitespace-normal text-left" : "whitespace-nowrap", BUTTON_VARIANT[variant], BUTTON_SIZE[size], extra);
}

export function Button({
  variant = "secondary",
  size = "md",
  wrap = false,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; wrap?: boolean }) {
  return <button type="button" className={buttonClass(variant, size, className, wrap)} {...rest} />;
}

export function ButtonLink({ href, variant = "secondary", size = "md", className, children }: { href: string; variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

// ---- Segmented control (a radiogroup with arrow-key navigation) ---------------------------

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next].value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex rounded-lg border border-line-strong bg-surface p-0.5", className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cx(
              "min-h-10 min-w-12 rounded-md px-3 text-[13px] font-medium tabular-nums transition-colors",
              checked ? "bg-ink text-bg" : "text-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- Labels -------------------------------------------------------------------------------

export type Tone = "neutral" | "signal" | "accent" | "up" | "down" | "warn" | "sample";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  signal: "bg-signal-soft text-signal",
  accent: "bg-surface-2 text-accent",
  up: "bg-up-soft text-up",
  down: "bg-down-soft text-down",
  warn: "bg-warn-soft text-warn",
  sample: "bg-sample-soft text-sample",
};

export function Tag({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-medium leading-4", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** Where a piece of data came from. The UI never shows cached or demo data unlabelled. */
export type DisplayProvenance = "live" | "cache" | "stale" | "snapshot" | "demo" | "sample" | "error";

const PROVENANCE: Record<DisplayProvenance, { label: string; dot: string; explain: string }> = {
  live: { label: "Live", dot: "bg-up", explain: "Fetched from the source just now" },
  cache: { label: "Cached", dot: "bg-up", explain: "From FINN's short-lived cache of the live source" },
  stale: { label: "Stale", dot: "bg-warn", explain: "The live source failed; showing the last copy FINN fetched" },
  snapshot: { label: "Snapshot", dot: "bg-warn", explain: "From FINN's committed snapshot, not fetched live" },
  demo: { label: "Demo", dot: "bg-sample", explain: "Demo mode: replayed from FINN's committed capture, not live" },
  sample: { label: "Sample", dot: "bg-sample", explain: "Sample data for design and testing — not real-time" },
  error: { label: "Unavailable", dot: "bg-down", explain: "The source could not be reached" },
};

export function provenanceLabel(p: DisplayProvenance, archive = false) {
  return p === "snapshot" && archive ? "Archive" : PROVENANCE[p].label;
}

/** "14:05" for today (IST); "26 Oct, 14:05" otherwise, so an old capture never reads as today's. */
function stamp(iso: string, now: number | null): string {
  const t = Date.parse(iso);
  if (now != null && Number.isFinite(t) && istDay(t) === istDay(now)) return clock(iso);
  return `${shortDate(iso)}, ${clock(iso)}`;
}

export function ProvenanceBadge({
  provenance,
  asOf,
  archive,
  withTime,
  label,
}: {
  provenance: DisplayProvenance;
  asOf?: string;
  archive?: boolean;
  withTime?: boolean;
  /** Overrides the generic label, e.g. "Partly cached" for a mix of sources. */
  label?: string;
}) {
  const now = useClientNow();
  const meta = PROVENANCE[provenance];
  const when = asOf ? ` · ${dateTime(asOf)}` : "";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted" title={`${meta.explain}${when}`}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} aria-hidden="true" />
      {label ?? provenanceLabel(provenance, archive)}
      {withTime && asOf && <span className="num text-faint">{stamp(asOf, now)}</span>}
      <span className="sr-only">{`: ${meta.explain}${when}`}</span>
    </span>
  );
}

export function ProvenanceDot({ provenance }: { provenance: DisplayProvenance }) {
  return <span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", PROVENANCE[provenance].dot)} aria-hidden="true" />;
}

// ---- States ------------------------------------------------------------------------------

export function StatusNotice({
  tone,
  title,
  children,
  action,
}: {
  tone: "error" | "warn" | "info" | "sample";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    error: "border-down/40 bg-down-soft",
    warn: "border-warn/30 bg-warn-soft",
    info: "border-line bg-surface",
    sample: "border-sample/30 bg-sample-soft",
  }[tone];
  const titleColor = { error: "text-down", warn: "text-warn", info: "text-ink", sample: "text-sample" }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-xl border px-4 py-3", styles)}>
      <p className={cx("text-sm font-semibold", titleColor)}>{title}</p>
      {children && <div className="mt-1 text-[13.5px] leading-relaxed text-ink">{children}</div>}
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-center">
      <p className="t-title text-[19px]">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

export function SectionHeading({ id, title, count, hint, children }: { id?: string; title: string; count?: number; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 pb-2.5">
      <div className="min-w-0">
        <h2 id={id} className="t-kicker">
          {title}
          {count != null && <span className="num ml-2 font-medium text-faint">{count}</span>}
        </h2>
        {hint && <p className="mt-0.5 text-[13px] text-faint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** A bordered list container: items separated by hairlines, not floated as cards. */
export function Ledger({ children, className, labelledBy, id }: { children: ReactNode; className?: string; labelledBy?: string; id?: string }) {
  return (
    <ul id={id} aria-labelledby={labelledBy} className={cx("divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface", className)}>
      {children}
    </ul>
  );
}

export function SourceLink({ href, children, className, label }: { href: string; children: ReactNode; className?: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cx("text-accent underline-offset-2 hover:underline", className)}
    >
      {children}
      {/* Word joiner: a wrapped title keeps the icon on its last line instead of orphaning it. */}
      <span className="whitespace-nowrap">
        &#8288;
        <ExternalIcon size={12} className="ml-1 inline-block align-[-1px] opacity-80" />
      </span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

// ---- Numbers -----------------------------------------------------------------------------

function compactChange(c: Change): string {
  switch (c.kind) {
    case "pct":
      return `${c.value > 0 ? "+" : c.value < 0 ? "−" : ""}${Math.abs(c.value).toFixed(1)}%`;
    case "turned_positive":
      return "to profit";
    case "turned_negative":
      return "to loss";
    case "loss_narrowed":
      return "loss ↓";
    case "loss_widened":
      return "loss ↑";
    default:
      return "—";
  }
}

export function changeTone(c: Change): "up" | "down" | "flat" {
  if ((c.kind === "pct" && c.value > 0) || c.kind === "turned_positive" || c.kind === "loss_narrowed") return "up";
  if ((c.kind === "pct" && c.value < 0) || c.kind === "turned_negative" || c.kind === "loss_widened") return "down";
  return "flat";
}

/** Signed change in colour; the sign or words (never colour alone) carry direction. */
export function ChangeText({ change, className }: { change: Change; className?: string }) {
  const tone = changeTone(change);
  return (
    <span title={describeChange(change)} className={cx("num whitespace-nowrap", tone === "up" && "text-up", tone === "down" && "text-down", tone === "flat" && "text-muted", className)}>
      {compactChange(change)}
    </span>
  );
}

export function Pct({ value, digits = 1, className }: { value: number | null | undefined; digits?: number; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={cx("num text-muted", className)}>—</span>;
  return (
    <span className={cx("num whitespace-nowrap", value > 0 && "text-up", value < 0 && "text-down", className)}>
      {value > 0 ? "+" : value < 0 ? "−" : ""}
      {Math.abs(value).toFixed(digits)}%
    </span>
  );
}

/**
 * Shape only, in a neutral ink: the signed number beside it carries direction and colour. (A line
 * coloured by its own first-to-last trend contradicted the day's move next to it.) The dot is the
 * latest close.
 */
export function Sparkline({ values, width = 64, height = 22, className, label }: { values: number[]; width?: number; height?: number; className?: string; label?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 1, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx("text-muted", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2} fill="var(--ink)" />
    </svg>
  );
}
