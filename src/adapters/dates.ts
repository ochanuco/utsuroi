/**
 * 日付正規化ユーティリティ。RSS(RFC 822) / Atom・Sitemap(RFC 3339 相当) を
 * ISO 8601 (UTC, `Date#toISOString()` 形式) へ変換する。
 */

const RFC822_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** RFC 822 で使われる代表的なタイムゾーン名の UTC からの分オフセット */
const RFC822_ZONES: Record<string, number> = {
  ut: 0,
  gmt: 0,
  utc: 0,
  z: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
};

const RFC822_PATTERN =
  /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:\([^)]*\))?\s*([+-]\d{4}|[A-Za-z]+)?\s*$/;

/**
 * RSS pubDate (RFC 822) を ISO 8601 へ正規化する。
 * 厳密な RFC822 として解釈できない場合は Date の一般パースへフォールバックする。
 * どちらも解釈不能なら null を返す。
 */
export function normalizeRfc822Date(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(RFC822_PATTERN);
  if (!m) {
    return fallbackParse(s);
  }
  const [, dayStr, monStr, yearStr, hourStr, minStr, secStr, zoneStr] = m;
  if (!dayStr || !monStr || !yearStr || !hourStr || !minStr) {
    return fallbackParse(s);
  }
  const month = RFC822_MONTHS[monStr.toLowerCase()];
  if (month === undefined) {
    return fallbackParse(s);
  }
  let year = parseInt(yearStr, 10);
  if (yearStr.length === 2) {
    year += year < 70 ? 2000 : 1900;
  }
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10);
  const second = secStr ? parseInt(secStr, 10) : 0;

  let offsetMinutes = 0;
  if (zoneStr) {
    if (/^[+-]\d{4}$/.test(zoneStr)) {
      const sign = zoneStr[0] === '-' ? -1 : 1;
      const zh = parseInt(zoneStr.slice(1, 3), 10);
      const zm = parseInt(zoneStr.slice(3, 5), 10);
      offsetMinutes = sign * (zh * 60 + zm);
    } else {
      offsetMinutes = RFC822_ZONES[zoneStr.toLowerCase()] ?? 0;
    }
  }

  const ms = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function fallbackParse(s: string): string | null {
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Atom updated/published、Sitemap lastmod など概ね RFC 3339 / ISO 8601 の
 * 日付文字列を正規化する。パース不能な場合は元の文字列をそのまま返す
 * (既に妥当な日付表現である可能性を優先し、情報を失わないため)。
 */
export function normalizeIsoDate(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : s;
}
