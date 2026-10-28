/** Number formatting used everywhere in the UI (one place, so every panel looks the same). */

const MINUS = '−'; // a real minus sign, easier to read than a hyphen

/** 0.523 -> "52%" */
export function pct(x: number | undefined | null, digits = 0): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '–';
  return `${(x * 100).toFixed(digits)}%`;
}

/** 0.0568 -> "5.68%" (for official turnout and vote shares, which are quoted with 2 decimals) */
export function pct2(x: number | undefined | null): string {
  return pct(x, 2);
}

/** Difference between two shares, in percentage points: -0.18 -> "−18 pts" */
export function pts(diff: number, digits = 0): string {
  if (!Number.isFinite(diff)) return '–';
  const v = diff * 100;
  const rounded = Number(v.toFixed(digits));
  if (rounded === 0) return `0 pts`;
  return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded).toFixed(digits)} pts`;
}

/** 2000 -> "2,000" */
export function int(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-GB');
}

/** Signed small number: 0.4 -> "+0.4" */
export function signed(x: number, digits = 1): string {
  const v = Number(x.toFixed(digits));
  if (v === 0) return '0';
  return `${v > 0 ? '+' : MINUS}${Math.abs(v).toFixed(digits)}`;
}

/** Metres, rounded to something a human would say: 640 -> "650 m", 1530 -> "1.5 km" */
export function metres(m: number): string {
  if (m < 1000) return `${Math.max(50, Math.round(m / 50) * 50)} m`;
  const km = (m / 1000).toFixed(1);
  return `${km.endsWith('.0') ? km.slice(0, -2) : km} km`;
}

/** "2024-02-04" -> "4 Feb 2024" */
export function niceDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Where a long sentence can stop and still read as a finished thought (EN and FR).
const CLAUSE_BREAK = /(?:[,;:]| [–—-]) | (?=(?:and|but|because|especially|which|although|while|et|mais|car|parce|surtout|notamment|donc|qui) )/g;
// Small words a cut sentence should not end on ("…character of…", "…zone de La…").
const DANGLING =
  /\s+(?:of|the|a|an|to|in|for|with|from|into|than|as|if|when|on|at|by|and|or|my|our|their|its|this|that|those|who|de|du|des|la|le|les|à|au|aux|en|pour|avec|sur|par|dans|chez|vers|sans|entre|comme|si|quand|et|ou|mon|ma|mes|notre|nos|leur|leurs|ce|cette|ceux|celles|un|une|qui|que)$/i;

/** First sentence of a text for a speech bubble. Longer than `max` characters: cut at the last
 *  clause break that keeps most of it (else the last whole word) and end with "…".
 *  The resident card always shows the full text. */
export function firstSentence(text: string, max = 90): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  let cut = -1;
  for (const b of head.matchAll(CLAUSE_BREAK)) if (b.index >= max * 0.45) cut = b.index;
  if (cut < 0) cut = head.lastIndexOf(' ');
  if (cut < max * 0.3) cut = max - 1; // one very long word
  let out = s.slice(0, cut).replace(/[\s,;:–—-]+$/, '');
  for (let k = 0; k < 3 && DANGLING.test(out); k++) out = out.replace(DANGLING, '');
  return `${out}…`;
}
