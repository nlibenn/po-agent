import 'server-only'

export type ParsedConfirmationFields = {
  supplier_order_number?: string
  confirmed_delivery_date?: string
  confirmed_quantity?: string
  evidence_source: 'email' | 'pdf' | 'mixed' | 'none'
  evidence_attachment_id?: string
  evidence_message_id?: string
  raw_excerpt?: string
}

const STOPWORDS = new Set([
  'for',
  'the',
  'and',
  'or',
  'to',
  'of',
  'a',
  'an',
  'in',
  'on',
  'with',
  'from',
  'by',
])

function cleanToken(raw: string): string {
  return raw
    .replace(/^[\s:>#.,;()]+/, '')
    .replace(/[\s:>#.,;()]+$/, '')
    .trim()
}

function isPlausibleOrderNumber(token: string): boolean {
  const t = token.trim()
  if (t.length < 4) return false
  if (!/[0-9]/.test(t)) return false
  if (STOPWORDS.has(t.toLowerCase())) return false
  return true
}

function monthNameToNumber(m: string): number | null {
  const s = m.toLowerCase()
  const map: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  }
  return map[s] ?? null
}

function toIsoDate(raw: string): string | null {
  const s = raw.trim()

  // YYYY-MM-DD
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) {
    const [, y, m, d] = iso
    return `${y}-${m}-${d}`
  }

  // MM/DD/YYYY or M/D/YY
  const slash = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/)
  if (slash) {
    const mm = parseInt(slash[1], 10)
    const dd = parseInt(slash[2], 10)
    let yy = parseInt(slash[3], 10)
    if (yy < 100) {
      // conservative: interpret 00-69 as 2000s, else 1900s
      yy = yy <= 69 ? 2000 + yy : 1900 + yy
    }
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const m = String(mm).padStart(2, '0')
      const d = String(dd).padStart(2, '0')
      return `${yy}-${m}-${d}`
    }
  }

  // "Jan 14 2026" / "January 14, 2026"
  const named = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,)?\s+(\d{4})\b/)
  if (named) {
    const month = monthNameToNumber(named[1])
    const day = parseInt(named[2], 10)
    const year = parseInt(named[3], 10)
    if (month && day >= 1 && day <= 31) {
      const m = String(month).padStart(2, '0')
      const d = String(day).padStart(2, '0')
      return `${year}-${m}-${d}`
    }
  }

  // Fallback: let Date parse, but only accept if it yields a real date
  const dt = new Date(s)
  if (!Number.isNaN(dt.getTime())) {
    const year = dt.getFullYear()
    const month = String(dt.getMonth() + 1).padStart(2, '0')
    const day = String(dt.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  return null
}

type MatchWithIndex = { value: string; index: number; labelScore: number }

function findSupplierOrderNumber(text: string): MatchWithIndex | null {
  const patterns: Array<{ re: RegExp; score: number }> = [
    { re: /\b(?:supplier\s*)?(?:sales\s*)?order\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi, score: 30 },
    { re: /\b(?:acknowledg(?:e)?ment|ack)\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi, score: 25 },
    { re: /\border\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi, score: 10 },
  ]

  const candidates: MatchWithIndex[] = []
  for (const p of patterns) {
    for (const m of text.matchAll(p.re)) {
      const raw = cleanToken(String(m[1] ?? ''))
      if (!isPlausibleOrderNumber(raw)) continue
      const idx = typeof m.index === 'number' ? m.index : 0
      candidates.push({ value: raw, index: idx, labelScore: p.score })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.labelScore - a.labelScore)
  return candidates[0]
}

function findDeliveryDate(text: string): { value: string; index: number } | null {
  const label = /\b(?:ship\s*date|delivery\s*date|expected\s*(?:ship|delivery)|promise(?:d)?\s*date)\b/gi
  const dateRe =
    /(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{1,2}(?:,)?\s+\d{4}\b)/g

  for (const m of text.matchAll(label)) {
    const idx = typeof m.index === 'number' ? m.index : 0
    const window = text.slice(idx, idx + 200)
    const dm = window.match(dateRe)
    if (dm && dm[0]) {
      const raw = dm[0]
      const iso = toIsoDate(raw)
      return { value: iso ?? raw, index: idx }
    }
  }
  return null
}

function findQuantity(text: string): { value: string; index: number } | null {
  const re =
    /\b(?:confirmed\s*qty|ship\s*qty|qty|quantity)\b\s*(?:[:#])?\s*([0-9]{1,9}(?:\.[0-9]+)?)\s*([A-Za-z]{1,6})?/gi

  for (const m of text.matchAll(re)) {
    const idx = typeof m.index === 'number' ? m.index : 0
    const num = cleanToken(String(m[1] ?? ''))
    const uom = cleanToken(String(m[2] ?? ''))
    if (!num || !/^\d/.test(num)) continue
    const combined = uom ? `${num} ${uom}` : num
    // conservative: avoid tiny numbers that are likely page counts, etc.
    if (combined.length < 1) continue
    return { value: combined, index: idx }
  }
  return null
}

function makeExcerpt(text: string, index: number): string {
  const start = Math.max(0, index - 100)
  const end = Math.min(text.length, index + 120)
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function parseConfirmationFields(input: {
  emailText?: string
  pdfTexts?: Array<{ attachment_id: string; text: string | null }>
}): ParsedConfirmationFields {
  const emailText = (input.emailText ?? '').trim()
  const pdfTexts = input.pdfTexts ?? []

  const pdfCandidates = pdfTexts
    .map(p => ({ attachment_id: p.attachment_id, text: (p.text ?? '').trim() }))
    .filter(p => p.text.length > 0)

  const longPdf = pdfCandidates.filter(p => p.text.length >= 200)
  const hasLongPdf = longPdf.length > 0

  let selectedText = ''
  let evidence_source: ParsedConfirmationFields['evidence_source'] = 'none'
  let evidence_attachment_id: string | undefined

  if (hasLongPdf) {
    const best = longPdf.sort((a, b) => b.text.length - a.text.length)[0]
    selectedText = best.text
    evidence_source = 'pdf'
    evidence_attachment_id = best.attachment_id
  } else if (emailText.length >= 200) {
    selectedText = emailText
    evidence_source = 'email'
  } else if (pdfCandidates.length > 0 || emailText.length > 0) {
    // Mixed fallback: combine everything we have
    const bestPdf = pdfCandidates.sort((a, b) => b.text.length - a.text.length)[0]
    selectedText = [bestPdf?.text, emailText].filter(Boolean).join('\n\n')
    evidence_source = 'mixed'
    evidence_attachment_id = bestPdf?.attachment_id
  } else {
    return { evidence_source: 'none' }
  }

  const so = findSupplierOrderNumber(selectedText)
  const dd = findDeliveryDate(selectedText)
  const qty = findQuantity(selectedText)

  const excerptIndex = so?.index ?? dd?.index ?? qty?.index ?? 0
  const raw_excerpt = selectedText ? makeExcerpt(selectedText, excerptIndex) : undefined

  return {
    supplier_order_number: so?.value || undefined,
    confirmed_delivery_date: dd?.value || undefined,
    confirmed_quantity: qty?.value || undefined,
    evidence_source,
    evidence_attachment_id,
    raw_excerpt,
  }
}

