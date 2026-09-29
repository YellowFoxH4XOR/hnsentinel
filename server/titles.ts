/**
 * Converts a raw HN title into plain text.
 *
 * HN titles are HTML-escaped (`&amp;`, `&#x2F;`, …). Only character references are decoded —
 * numeric references and the named entities seen in practice. Markup is never interpreted, so
 * `<b>` stays literal text. Whitespace runs collapse to one space and the result is trimmed.
 */
export function decodeTitle(raw: string): string {
  const decoded = raw.includes('&') ? raw.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, replace) : raw
  return decoded.split(/\s+/u).filter(Boolean).join(' ')
}

function replace(match: string, body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X'
    const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
    // NUL, surrogates, and out-of-range code points stay literal.
    if (!Number.isFinite(value) || value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return match
    return String.fromCodePoint(value)
  }
  return NAMED[body] ?? match
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  plusmn: '±', micro: 'µ', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', le: '≤', ge: '≥', ne: '≠', infin: '∞',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', ograve: 'ò', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', ntilde: 'ñ', Ntilde: 'Ñ', ccedil: 'ç',
}

/** Lowercased host with one leading `www.` removed, for http(s) URLs only. */
export function domainOf(url: string | null): string | null {
  const parsed = safeUrl(url)
  if (!parsed) return null
  const host = parsed.hostname.toLowerCase()
  return host.startsWith('www.') ? host.slice(4) : host
}

/** Only http/https URLs with a host are kept; everything else falls back to the HN discussion. */
export function safeUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null
    return url
  } catch {
    return null
  }
}
