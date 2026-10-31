/** Display formatting in Indian Standard Time. Client-safe. */

const IST = "Asia/Kolkata";

export function istDay(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24 && istDay(t) === istDay(now)) return `${hours}h ago`;
  if (istDay(t) === istDay(now - 86_400_000)) return `Yesterday ${clock(iso)}`;
  return `${shortDate(iso)}, ${clock(iso)}`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST });
}

export function shortDate(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00+05:30`) : new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: IST });
}

export function weekdayDate(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00+05:30`) : new Date(iso);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
}

export function dateTime(iso: string): string {
  return `${shortDate(iso)}, ${clock(iso)} IST`;
}

export function todayLabel(now = Date.now()): string {
  return new Date(now).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: IST });
}
