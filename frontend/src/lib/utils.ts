/* Pure helpers shared by the migrated UI. Mirrors shared/utils.js without the
   DOM-bound members (theme reads now live in React state). */

export function fmt(n: number): string {
  return Number(n).toLocaleString('en-US');
}

export function sortedEntries(o: Readonly<Record<string, number>>): Array<[string, number]> {
  return Object.entries(o).sort((a, b) => b[1] - a[1]);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function pct(v: number, t: number): string {
  return `${Math.round((100 * v) / (t || 1))}%`;
}

export function hourOf(dt: string): number {
  return parseInt(String(dt).slice(11, 13), 10);
}

export function isNight(dt: string): boolean {
  const h = hourOf(dt);
  return h < 6 || h >= 18;
}

/** Escape a value for any HTML that must be built as a string (map popups). */
export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
    return map[c] ?? c;
  });
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Format a month index within the analysis window as "Mon 'YY". */
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(ymValue: number): string {
  const y = Math.floor(ymValue / 12);
  const m = ((ymValue % 12) + 12) % 12;
  return `${MONTH_LABELS[m]} '${String(y).slice(2)}`;
}
