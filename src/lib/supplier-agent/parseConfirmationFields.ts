export type EvidenceSource = 'pdf' | 'email' | 'none'

export type ParsedField<T> = {
  value: T | null
  confidence: number // 0..1
  evidence_snippet: string | null
  source: EvidenceSource
  attachment_id: string | null
  message_id: string | null
}

export type ParsedConfirmationFieldsV1 = {
  supplier_order_number: ParsedField<string>
  confirmed_delivery_date: ParsedField<string> // ISO YYYY-MM-DD if possible
  confirmed_quantity: ParsedField<number>
  evidence_source: EvidenceSource
  raw_excerpt: string | null
}

export type ParseInput = {
  poNumber?: string
  lineId?: string
  emailText?: string
  pdfTexts?: Array<{ attachment_id: string; text: string | null }>
}

type Candidate<T> = {
  value: T
  confidence: number
  evidence_snippet: string
  source: EvidenceSource
  attachment_id?: string
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function normalizeWs(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\u00a0/g, ' ').trim()
}

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
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
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

export function toIsoDate(raw: string): string | null {
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

  return null
}

function makeLineSnippet(lines: string[], idx: number): string {
  const start = Math.max(0, idx - 1)
  const end = Math.min(lines.length, idx + 2)
  return lines
    .slice(start, end)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function makeSnippetAroundIndex(text: string, index: number): string {
  const start = Math.max(0, index - 120)
  const end = Math.min(text.length, index + 220)
  return text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function best<T>(cands: Candidate<T>[]): Candidate<T> | null {
  if (cands.length === 0) return null
  cands.sort((a, b) => b.confidence - a.confidence)
  return cands[0]
}

function matchAllSafe(text: string, re: RegExp): RegExpMatchArray[] {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  const global = new RegExp(re.source, flags)
  return Array.from(text.matchAll(global))
}

function parseFromText(textRaw: string, source: EvidenceSource, opts: { poNumber?: string; lineId?: string }): {
  supplierOrder: Candidate<string> | null
  deliveryDate: Candidate<string> | null
  quantity: Candidate<number> | null
} {
  const text = normalizeWs(textRaw)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const lowerLines = lines.map(l => l.toLowerCase())

  const supplierOrderCandidates: Candidate<string>[] = []
  const dateCandidates: Candidate<string>[] = []
  const qtyCandidates: Candidate<number>[] = []

  const po = opts.poNumber?.trim()
  const lineId = opts.lineId?.trim()

  const anchorIndices: number[] = []
  if (po) {
    const poRe = new RegExp(`\\b${po.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i')
    for (let i = 0; i < lines.length; i++) {
      if (poRe.test(lines[i])) anchorIndices.push(i)
    }
  }
  if (lineId && /^\d+$/.test(lineId)) {
    const lineRe = new RegExp(`\\b(?:line\\s*#?\\s*)?${lineId}\\b`, 'i')
    for (let i = 0; i < lines.length; i++) {
      if (lineRe.test(lines[i])) anchorIndices.push(i)
    }
  }

  const distanceBoost = (i: number) => {
    if (anchorIndices.length === 0) return 0
    const d = Math.min(...anchorIndices.map(a => Math.abs(a - i)))
    if (d <= 2) return 0.18
    if (d <= 5) return 0.12
    if (d <= 12) return 0.06
    return 0
  }

  // Supplier order number patterns (line-based)
  const soPatterns: Array<{ re: RegExp; base: number }> = [
    { re: /\b(?:supplier\s*)?(?:sales\s*)?order\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.9 },
    { re: /\b(?:so|s\/o)\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.75 },
    { re: /\b(?:acknowledg(?:e)?ment|ack)\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.75 },
    { re: /\border\s*(?:no\.|#|number|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.55 },
  ]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const p of soPatterns) {
      const m = line.match(p.re)
      if (!m) continue
      const raw = cleanToken(String(m[1] ?? ''))
      if (!isPlausibleOrderNumber(raw)) continue
      const conf = clamp01(p.base + distanceBoost(i))
      supplierOrderCandidates.push({
        value: raw,
        confidence: conf,
        evidence_snippet: makeLineSnippet(lines, i),
        source,
      })
    }
  }

  // Supplier order fallback: scan whole text (handles label/value split across lines or flattened)
  for (const p of soPatterns) {
    const re = new RegExp(p.re.source, 'gi')
    for (const m of matchAllSafe(text, re)) {
      const raw = cleanToken(String(m[1] ?? ''))
      if (!isPlausibleOrderNumber(raw)) continue
      const idx = typeof m.index === 'number' ? m.index : 0
      supplierOrderCandidates.push({
        value: raw,
        confidence: clamp01(p.base - 0.05),
        evidence_snippet: makeSnippetAroundIndex(text, idx),
        source,
      })
    }
  }

  // Delivery/ship date patterns
  const dateLabelRe = /\b(?:ship\s*date|delivery\s*date|deliver(?:y)?\s*by|expected\s*(?:ship|delivery)|promise(?:d)?\s*date|expected\s*delivery)\b/i
  const dateTokenRe =
    /(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{1,2}(?:,)?\s+\d{4}\b)/g

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!dateLabelRe.test(line)) continue
    const dm = line.match(dateTokenRe) || []
    for (const dRaw of dm) {
      const iso = toIsoDate(dRaw)
      if (!iso) continue
      const base = /delivery/i.test(line) ? 0.9 : /ship/i.test(line) ? 0.82 : 0.75
      dateCandidates.push({
        value: iso,
        confidence: clamp01(base + distanceBoost(i)),
        evidence_snippet: makeLineSnippet(lines, i),
        source,
      })
    }
  }

  // Date fallback: find label in whole text, then scan window after it (handles label/value split)
  for (const m of matchAllSafe(text, dateLabelRe)) {
    const labelIdx = typeof m.index === 'number' ? m.index : 0
    const window = text.slice(labelIdx, labelIdx + 200)
    const dm = window.match(dateTokenRe) || []
    for (const dRaw of dm) {
      const iso = toIsoDate(dRaw)
      if (!iso) continue
      const base = /delivery/i.test(m[0]) ? 0.85 : /ship/i.test(m[0]) ? 0.77 : 0.7
      dateCandidates.push({
        value: iso,
        confidence: clamp01(base),
        evidence_snippet: makeSnippetAroundIndex(text, labelIdx),
        source,
      })
    }
  }

  // Quantity: explicit label first
  const qtyLabelRe =
    /\b(?:confirmed\s*qty|order(?:ed)?\s*qty|order\s*qty|qty|quantity|shipped|balance|total|pieces)\b/i
  // Improved pattern: handles "Qty: 140", "Quantity 140", "Order Qty 140", numbers with commas
  const qtyCaptureRe =
    /\b(?:confirmed\s*qty|order(?:ed)?\s*qty|order\s*qty|qty|quantity|shipped|balance|total|pieces)\b[^0-9]{0,20}([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\b/i

  // Debug: log quantity keyword windows if extraction fails later
  const qtyKeywordMatches: Array<{ keyword: string; window: string; lineIdx: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const keywordMatch = line.match(/\b(qty|quantity|order\s*qty|shipped|balance|total|pieces)\b/i)
    if (keywordMatch) {
      const start = Math.max(0, i - 1)
      const end = Math.min(lines.length, i + 2)
      const window = lines.slice(start, end).join(' ')
      qtyKeywordMatches.push({
        keyword: keywordMatch[0],
        window: window.slice(0, 200),
        lineIdx: i,
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(qtyCaptureRe)
    if (!m) continue
    // Remove commas from number string before parsing
    const numStr = String(m[1]).replace(/,/g, '')
    const n = Number(numStr)
    if (!Number.isFinite(n) || n <= 0 || n > 1e7) continue
    const base =
      /confirmed/i.test(line) ? 0.92 : /order\s*qty|ordered/i.test(line) ? 0.88 : /qty|quantity/i.test(line) ? 0.82 : 0.7
    qtyCandidates.push({
      value: n,
      confidence: clamp01(base + distanceBoost(i)),
      evidence_snippet: makeLineSnippet(lines, i),
      source,
    })
  }

  // Quantity fallback: scan whole text (handles flattened PDFs)
  for (const m of matchAllSafe(text, qtyCaptureRe)) {
    // Remove commas from number string before parsing
    const numStr = String(m[1]).replace(/,/g, '')
    const n = Number(numStr)
    if (!Number.isFinite(n) || n <= 0 || n > 1e7) continue
    const idx = typeof m.index === 'number' ? m.index : 0
    const base = /confirmed/i.test(m[0]) ? 0.87 : /order\s*qty|ordered/i.test(m[0]) ? 0.83 : /qty|quantity/i.test(m[0]) ? 0.77 : 0.65
    qtyCandidates.push({
      value: n,
      confidence: clamp01(base),
      evidence_snippet: makeSnippetAroundIndex(text, idx),
      source,
    })
  }
  
  // Debug logging: if quantity keywords found but no extraction succeeded, log windows
  if (qtyKeywordMatches.length > 0 && qtyCandidates.length === 0) {
    const firstMatch = qtyKeywordMatches[0]
    console.log('[QTY_TRACE] qty_keyword_window', {
      keyword: firstMatch.keyword,
      window: firstMatch.window,
      lineIdx: firstMatch.lineIdx,
      totalMatches: qtyKeywordMatches.length,
    })
  }

  // Quantity: implied table-ish (look for header with Qty/Quantity and parse next rows)
  const tableHeaderIdxs: number[] = []
  for (let i = 0; i < lowerLines.length; i++) {
    const l = lowerLines[i]
    const hasQty = /\b(qty|quantity|order\s*qty|ordered)\b/.test(l)
    const hasOtherCols = /\b(item|line|part|description|uom|unit|price|amount)\b/.test(l)
    if (hasQty && hasOtherCols) tableHeaderIdxs.push(i)
  }

  const looksLikeMoney = (token: string) => /\$/.test(token) || /\b\d+\.\d{2}\b/.test(token)
  const looksLikeDate = (token: string) => /\b\d{4}-\d{2}-\d{2}\b/.test(token) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(token)
  const looksLikeYear = (n: number) => n >= 1990 && n <= 2100

  for (const headerIdx of tableHeaderIdxs) {
    for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 12); i++) {
      const line = lines[i]
      if (qtyLabelRe.test(line)) continue // already captured as explicit
      const tokens = line.split(/\s+/).map(t => cleanToken(t)).filter(Boolean)
      const numericTokens = tokens.filter(t => /^[0-9]{1,9}(?:\.[0-9]+)?$/.test(t))
      if (numericTokens.length === 0) continue

      // Prefer integer-like tokens that are not likely year/date/money
      const numericValues = numericTokens
        .map(t => ({ token: t, value: Number(t) }))
        .filter(x => Number.isFinite(x.value) && x.value > 0 && x.value <= 1e7)
        .filter(x => !looksLikeYear(x.value))
        .filter(x => !looksLikeDate(x.token))

      if (numericValues.length === 0) continue

      const uomHint = /\b(ea|each|pcs|pc|units?)\b/i.test(line)

      // Heuristic: qty tends to be the "most qty-ish" number, not price/amount.
      // If multiple, prefer the largest integer-ish (common in order qty) but penalize very large.
      numericValues.sort((a, b) => {
        const ai = Number.isInteger(a.value) ? 1 : 0
        const bi = Number.isInteger(b.value) ? 1 : 0
        if (ai !== bi) return bi - ai
        return b.value - a.value
      })

      const pick = numericValues.find(x => !looksLikeMoney(x.token)) ?? numericValues[0]
      const base = uomHint ? 0.68 : 0.56
      qtyCandidates.push({
        value: pick.value,
        confidence: clamp01(base + distanceBoost(i) - (pick.value > 100000 ? 0.08 : 0)),
        evidence_snippet: makeLineSnippet(lines, i),
        source,
      })
    }
  }

  // If we have anchors, also try a local-window numeric scan near anchors (for implied qty in a row)
  // Also check for "DOM" description string as anchor
  const domAnchorIndices: number[] = []
  const domRe = /\bDOM\b/i
  for (let i = 0; i < lines.length; i++) {
    if (domRe.test(lines[i])) domAnchorIndices.push(i)
  }
  const allAnchors = [...anchorIndices, ...domAnchorIndices]
  
  if (allAnchors.length > 0) {
    for (const anchor of allAnchors) {
      const start = Math.max(0, anchor - 8)
      const end = Math.min(lines.length, anchor + 9)
      for (let i = start; i < end; i++) {
        const line = lines[i]
        if (qtyLabelRe.test(line)) continue
        // Improved numeric pattern: handles commas and decimals
        const numeric = line.match(/\b([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\b/g) || []
        for (const t of numeric) {
          // Remove commas before parsing
          const numStr = t.replace(/,/g, '')
          const v = Number(numStr)
          if (!Number.isFinite(v) || v <= 0 || v > 1e7) continue
          if (looksLikeYear(v)) continue
          if (looksLikeDate(t)) continue
          if (lineId && /^\d+$/.test(lineId) && String(v) === lineId) continue
          if (looksLikeMoney(t)) continue
          qtyCandidates.push({
            value: v,
            confidence: clamp01(0.5 + distanceBoost(i)),
            evidence_snippet: makeLineSnippet(lines, i),
            source,
          })
        }
      }
    }
  }

  return {
    supplierOrder: best(supplierOrderCandidates),
    deliveryDate: best(dateCandidates),
    quantity: best(qtyCandidates),
  }
}

function chooseBestField<T>(
  pdf: Candidate<T> | null,
  email: Candidate<T> | null
): ParsedField<T> {
  const cand = best([...(pdf ? [pdf] : []), ...(email ? [email] : [])])
  if (!cand) {
    return { value: null, confidence: 0, evidence_snippet: null, source: 'none', attachment_id: null, message_id: null }
  }
  return {
    value: cand.value,
    confidence: clamp01(cand.confidence),
    evidence_snippet: cand.evidence_snippet ?? null,
    source: cand.source,
    attachment_id: cand.source === 'pdf' ? (cand.attachment_id ?? null) : null,
    message_id: null,
  }
}

export function parseConfirmationFieldsV1(input: ParseInput): ParsedConfirmationFieldsV1 {
  const emailText = (input.emailText ?? '').trim()
  const pdfTexts = input.pdfTexts ?? []

  // Best PDF per field can come from different attachments; keep it simple: scan each attachment and keep best candidate.
  let bestPdfSupplier: Candidate<string> | null = null
  let bestPdfDate: Candidate<string> | null = null
  let bestPdfQty: Candidate<number> | null = null

  for (const p of pdfTexts) {
    const t = (p.text ?? '').trim()
    if (!t) continue
    const parsed = parseFromText(t, 'pdf', { poNumber: input.poNumber, lineId: input.lineId })
    if (parsed.supplierOrder && (!bestPdfSupplier || parsed.supplierOrder.confidence > bestPdfSupplier.confidence)) {
      bestPdfSupplier = { ...parsed.supplierOrder, attachment_id: p.attachment_id }
    }
    if (parsed.deliveryDate && (!bestPdfDate || parsed.deliveryDate.confidence > bestPdfDate.confidence)) {
      bestPdfDate = { ...parsed.deliveryDate, attachment_id: p.attachment_id }
    }
    if (parsed.quantity && (!bestPdfQty || parsed.quantity.confidence > bestPdfQty.confidence)) {
      bestPdfQty = { ...parsed.quantity, attachment_id: p.attachment_id }
    }
  }

  const emailParsed = emailText
    ? parseFromText(emailText, 'email', { poNumber: input.poNumber, lineId: input.lineId })
    : { supplierOrder: null, deliveryDate: null, quantity: null }

  const supplier_order_number = chooseBestField(bestPdfSupplier, emailParsed.supplierOrder)
  const confirmed_delivery_date = chooseBestField(bestPdfDate, emailParsed.deliveryDate)
  const confirmed_quantity = chooseBestField(bestPdfQty, emailParsed.quantity)

  const anyFound =
    supplier_order_number.value !== null ||
    confirmed_delivery_date.value !== null ||
    confirmed_quantity.value !== null

  const evidence_source: EvidenceSource = !anyFound
    ? 'none'
    : supplier_order_number.source === 'pdf' ||
      confirmed_delivery_date.source === 'pdf' ||
      confirmed_quantity.source === 'pdf'
      ? 'pdf'
      : 'email'

  const raw_excerpt =
    (supplier_order_number.evidence_snippet ||
      confirmed_delivery_date.evidence_snippet ||
      confirmed_quantity.evidence_snippet ||
      null)

  return {
    supplier_order_number,
    confirmed_delivery_date,
    confirmed_quantity,
    evidence_source,
    raw_excerpt,
  }
}

