/**
 * Shared formatting helpers — the server-side twins of the viewer page's
 * fmtDur/ago/fmtTokens (fia-viewer-page.mjs keeps its own copy inside the
 * PAGE string, which ships to the browser as client JS). Semantics must stay
 * in sync: the TUI and the web viewer describe the same run with the same
 * words ("7m 12s", "2.34M", "12min ago").
 */

/** Seconds → "8.4s" | "42s" | "7m 12s" | "2h 15m". null → "—". */
export function fmtDur(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  if (sec < 10) return sec.toFixed(1) + 's';
  const t = Math.round(sec);
  if (t < 60) return t + 's';
  if (t < 3600) return Math.floor(t / 60) + 'm ' + (t % 60) + 's';
  return Math.floor(t / 3600) + 'h ' + Math.floor((t % 3600) / 60) + 'm';
}

/** ISO timestamp → age like "45s" | "12min" | "5h" | "3d". Falsy → "". */
export function fmtAge(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

/** ISO timestamp → local wall clock "HH:MM:SS". Falsy → "". */
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Token count → "812" | "4.2k" | "2.34M". */
export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n < 1000) return String(n);
  const k = (n / 1000).toFixed(1);
  return k === '1000.0' ? '1.00M' : k + 'k';
}

/** Accumulated cost in dollars → "$12.40". null/0 → "—". */
export function fmtCost(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return '—';
  return '$' + n.toFixed(2);
}

/** Seconds between two ISO timestamps; a missing end falls back to `now`. */
export function durSec(startIso, endIso, now = Date.now()) {
  if (!startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}
