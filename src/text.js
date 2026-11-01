// Small text utilities: HTML → plain text, entity decoding, truncation.
// Everything here is dependency-free so the plugin runs on Node built-ins only.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  eacute: 'é',
  copy: '©',
  reg: '®',
  trade: '™',
}

export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input ?? ''
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

const BLOCK_TAGS = /<\s*(br|p|div|li|ul|ol|h[1-6]|tr|section|article|blockquote)\b[^>]*>/gi

/** Convert an HTML fragment (or an HTML-escaped HTML string) to readable text. */
export function htmlToText(html) {
  if (!html) return ''
  let value = String(html)
  // Some ATS APIs double-encode: `&lt;p&gt;…`. Unescape once before stripping.
  if (/&lt;[a-z!/]/i.test(value) && !/<[a-z!/]/i.test(value)) value = decodeEntities(value)
  value = value.replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
  value = value.replace(/<\s*li\b[^>]*>/gi, '\n• ')
  value = value.replace(BLOCK_TAGS, '\n')
  value = value.replace(/<[^>]+>/g, ' ')
  value = decodeEntities(value)
  value = value.replace(/\r\n?/g, '\n')
  value = value.replace(/[ \t\u00a0]+/g, ' ')
  value = value.replace(/ *\n */g, '\n')
  value = value.replace(/\n{3,}/g, '\n\n')
  return value.trim()
}

/** Collapse any whitespace (including newlines) into single spaces. */
export function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncate(value, max) {
  const text = String(value ?? '')
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

/** Words that carry no signal in a job title match. */
export function normalizeTitle(title) {
  return oneLine(title)
    .toLowerCase()
    .replace(/[()[\]{},·|/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
