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
  confirmed_quantity: ParsedField<number> // Backward compatibility: represents ordered_quantity
  ordered_quantity: ParsedField<number> // From PO/system of record (expectedQty)
  supplier_confirmed_quantity: ParsedField<number> // Extracted from PDF/email evidence
  quantity_mismatch: { value: boolean | null; reason: string } // Mismatch flag if both exist and differ
  evidence_source: EvidenceSource
  raw_excerpt: string | null
  debug_candidates?: DebugCandidates // Only included when debug=true
  // Extended fields (optional, may be null)
  unit_price?: ParsedField<number> | null
  extended_price?: ParsedField<number> | null
  currency?: ParsedField<string> | null
  payment_terms?: ParsedField<string> | null
  freight_terms?: ParsedField<string> | null
  freight_cost?: ParsedField<number> | null
  subtotal?: ParsedField<number> | null
  tax_amount?: ParsedField<number> | null
  order_total?: ParsedField<number> | null
  notes?: ParsedField<string> | null
  backorder_status?: ParsedField<string> | null
  // Price change detection
  price_changed?: { value: boolean; price_delta?: number; price_delta_percent?: number } | null
}

export type ParseInput = {
  poNumber?: string
  lineId?: string
  emailText?: string
  pdfTexts?: Array<{ attachment_id: string; text: string | null }>
  debug?: boolean // If true, return debug_candidates in result
  expectedQty?: number | null // Expected PO line quantity for validation
  expectedUnitPrice?: number | null // Expected unit price for price change detection
}

// Debug candidates for inspection
export type DebugCandidates = {
  dateCandidates: Array<{ value: string; confidence: number; label: string; snippet: string }>
  qtyCandidates: Array<{ value: number; confidence: number; label: string; snippet: string; nearWeightUnit: boolean; excluded?: boolean; excludeReason?: string }>
  expectedQty?: number | null
  ordered_quantity?: number | null
  supplier_confirmed_quantity?: number | null
  quantity_mismatch?: { value: boolean | null; reason: string }
  qtyChosenReason: string
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

// ============================================================================
// LABEL-AWARE DATE EXTRACTION
// Priority: Confirmed Ship Date > Confirmed Delivery Date > Ship Date > Delivery Date
// Explicitly IGNORE "Order Date" unless no other ship/delivery date exists
// ============================================================================

type DateLabelConfig = {
  pattern: RegExp
  priority: number // Higher = more preferred
  label: string
}

const DATE_LABEL_CONFIGS: DateLabelConfig[] = [
  { pattern: /\bconfirmed\s+ship\s*(?:date)?\b/i, priority: 100, label: 'Confirmed Ship Date' },
  { pattern: /\bconfirmed\s+delivery\s*(?:date)?\b/i, priority: 95, label: 'Confirmed Delivery Date' },
  { pattern: /\bship\s*date\b/i, priority: 80, label: 'Ship Date' },
  { pattern: /\bdelivery\s*date\b/i, priority: 75, label: 'Delivery Date' },
  { pattern: /\bdeliver(?:y)?\s*by\b/i, priority: 70, label: 'Deliver By' },
  { pattern: /\bexpected\s+(?:ship|delivery)\b/i, priority: 65, label: 'Expected Ship/Delivery' },
  { pattern: /\bpromise(?:d)?\s*date\b/i, priority: 60, label: 'Promise Date' },
  // Order Date is lowest priority - only use if nothing else found
  { pattern: /\border\s*date\b/i, priority: 10, label: 'Order Date' },
]

type LabeledDateCandidate = {
  value: string // ISO date
  confidence: number
  label: string
  priority: number
  snippet: string
  index: number
}

function extractDatesWithLabels(text: string): LabeledDateCandidate[] {
  const candidates: LabeledDateCandidate[] = []
  const dateTokenRe = /(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{1,2}(?:,)?\s+\d{4}\b)/g

  for (const config of DATE_LABEL_CONFIGS) {
    for (const labelMatch of matchAllSafe(text, config.pattern)) {
      const labelIdx = labelMatch.index ?? 0
      // Look for date token within 100 chars after the label
      const windowStart = labelIdx
      const windowEnd = Math.min(text.length, labelIdx + 100)
      const window = text.slice(windowStart, windowEnd)
      
      const dateMatches = window.match(dateTokenRe) || []
      for (const dateRaw of dateMatches) {
        const iso = toIsoDate(dateRaw)
        if (!iso) continue
        
        // Confidence based on priority (higher priority = higher confidence)
        const baseConfidence = 0.5 + (config.priority / 200) // Range: 0.55 - 1.0
        
        candidates.push({
          value: iso,
          confidence: clamp01(baseConfidence),
          label: config.label,
          priority: config.priority,
          snippet: window.replace(/\s+/g, ' ').trim().slice(0, 100),
          index: labelIdx,
        })
      }
    }
  }

  // Sort by priority (descending), then by confidence
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    return b.confidence - a.confidence
  })

  return candidates
}

// ============================================================================
// LABEL-AWARE QUANTITY EXTRACTION
// Priority: Confirmed Qty > Qty/Quantity on line items > Order Qty
// De-prioritize numbers near weight/length units (LB, FT, GA, OD, ID, WT, etc.)
// ============================================================================

const WEIGHT_LENGTH_UNITS = /\b(lb|lbs|ft|feet|foot|ga|gauge|od|id|wt|weight|length|width|thickness|diameter|inch|inches|mm|cm|m|kg|g)\b/i

type LabeledQtyCandidate = {
  value: number
  confidence: number
  label: string
  priority: number
  snippet: string
  nearWeightUnit: boolean
  index: number
}

type QtyLabelConfig = {
  pattern: RegExp
  priority: number
  label: string
}

const QTY_LABEL_CONFIGS: QtyLabelConfig[] = [
  { pattern: /\bconfirmed\s+(?:qty|quantity)\b/i, priority: 100, label: 'Confirmed Qty' },
  { pattern: /\border(?:ed)?\s+(?:qty|quantity)\b/i, priority: 80, label: 'Order Qty' },
  { pattern: /\b(?:qty|quantity)\b/i, priority: 60, label: 'Qty' },
  { pattern: /\bshipped\b/i, priority: 50, label: 'Shipped' },
  { pattern: /\bbalance\b/i, priority: 40, label: 'Balance' },
]

// Pattern to detect numbers that are part of dimension/spec patterns (should be excluded from qty)
// Examples: "1.500 X .120 X 20/24", "A500", "B16.5", "4x10", "20/24"
const DIMENSION_PATTERN = /\d+\s*[xX×]\s*\d+/  // "20x24" or "4 X 10"
const FRACTION_PATTERN = /\d+\/\d+/  // "20/24"
const GRADE_PATTERN = /[A-Z]\d{2,}/i  // "A500", "B16"
const DECIMAL_SPEC_PATTERN = /\.\d{3,}/  // ".120" (3+ decimal digits = dimension)
const THICKNESS_PATTERN = /\.\d+\s*[xX×]/  // ".120 X" (thickness in dimensions)

// Extended type for qty candidates with exclusion info
type ExtendedQtyCandidate = LabeledQtyCandidate & {
  excluded?: boolean
  excludeReason?: string
}

function isNumberInDimensionContext(text: string, numPosInText: number, numRaw: string): { excluded: boolean; reason?: string } {
  // Get context around the number (50 chars before and after)
  const contextStart = Math.max(0, numPosInText - 30)
  const contextEnd = Math.min(text.length, numPosInText + numRaw.length + 30)
  const context = text.slice(contextStart, contextEnd)
  
  // Get immediate characters before and after the number (for alphanumeric detection)
  const charBefore = numPosInText > 0 ? text[numPosInText - 1] : ''
  const charAfter = numPosInText + numRaw.length < text.length ? text[numPosInText + numRaw.length] : ''
  
  // Check if number has a letter immediately adjacent (no whitespace) - alphanumeric spec token
  // Examples: "A500", "B16", "500A", "16B"
  if (/[A-Za-z]/.test(charBefore) && !/\s/.test(charBefore)) {
    return { excluded: true, reason: 'alphanumeric spec token (letter before)' }
  }
  if (/[A-Za-z]/.test(charAfter) && !/\s/.test(charAfter)) {
    return { excluded: true, reason: 'alphanumeric spec token (letter after)' }
  }
  
  // Check for alphanumeric patterns like A500, B16.5 in context
  // Pattern: letter followed by 2-6 digits (with optional decimal)
  const alphanumericSpecRe = /\b[A-Za-z]{1,3}\d{2,6}(?:\.\d+)?\b/
  const numInAlphanumeric = context.match(alphanumericSpecRe)
  if (numInAlphanumeric) {
    // Check if our number is part of this alphanumeric token
    const alphaToken = numInAlphanumeric[0]
    const digitsInToken = alphaToken.match(/\d+(?:\.\d+)?/)?.[0]
    if (digitsInToken === numRaw || digitsInToken?.includes(numRaw)) {
      return { excluded: true, reason: 'alphanumeric spec token' }
    }
  }
  
  // Check if number is part of a fraction pattern (e.g., "20/24")
  const fractionRe = new RegExp(`\\b${numRaw}\\s*/\\s*\\d+|\\d+\\s*/\\s*${numRaw}\\b`)
  if (fractionRe.test(context)) {
    return { excluded: true, reason: 'part of fraction pattern' }
  }
  
  // Check if number is between dimension markers (X or x)
  const dimMarkerRe = new RegExp(`[xX×]\\s*${numRaw}|${numRaw}\\s*[xX×]`)
  if (dimMarkerRe.test(context)) {
    return { excluded: true, reason: 'adjacent to dimension marker X' }
  }
  
  // Check if number is a decimal spec (.120, .065)
  if (numRaw.startsWith('.') || /^\.\d+$/.test(numRaw)) {
    return { excluded: true, reason: 'decimal spec value' }
  }
  
  // Check if this looks like a dimension spec line (has multiple X markers and/or decimals)
  const xCount = (context.match(/[xX×]/g) || []).length
  const decimalCount = (context.match(/\.\d{2,}/g) || []).length
  if (xCount >= 2 || (xCount >= 1 && decimalCount >= 1)) {
    // This line is a dimension spec, but only exclude if number is surrounded by specs
    const numIdx = context.indexOf(numRaw)
    const beforeNum = context.slice(0, numIdx)
    const afterNum = context.slice(numIdx + numRaw.length)
    if (/[xX×]\s*$/.test(beforeNum) || /^\s*[xX×]/.test(afterNum)) {
      return { excluded: true, reason: 'in dimension spec context' }
    }
  }
  
  return { excluded: false }
}

function extractQtysWithLabels(text: string, lineId?: string, expectedQty?: number | null): ExtendedQtyCandidate[] {
  const candidates: ExtendedQtyCandidate[] = []
  // Pattern to capture numbers with their position (with optional commas and decimals)
  const numCaptureReWithIndex = /([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\b/g

  for (const config of QTY_LABEL_CONFIGS) {
    for (const labelMatch of matchAllSafe(text, config.pattern)) {
      const labelIdx = labelMatch.index ?? 0
      // Look for number within 60 chars after the label
      const windowStart = labelIdx
      const windowEnd = Math.min(text.length, labelIdx + 60)
      const window = text.slice(windowStart, windowEnd)
      
      // Find all numbers with their positions within the window
      for (const numMatch of matchAllSafe(window, numCaptureReWithIndex)) {
        const numRaw = numMatch[1]
        const numStr = numRaw.replace(/,/g, '')
        const n = Number(numStr)
        
        // Skip invalid numbers
        if (!Number.isFinite(n) || n <= 0 || n > 1e7) continue
        // Skip if this looks like the line ID
        if (lineId && /^\d+$/.test(lineId) && String(Math.floor(n)) === lineId) continue
        // Skip if this looks like a year
        if (n >= 1990 && n <= 2100) continue
        // Skip if this looks like a price (has 2 decimal places typical of currency)
        if (/\d+\.\d{2}$/.test(numRaw) && n > 1) continue
        
        // Find the absolute position of this number in the original text
        const numPosInWindow = numMatch.index ?? 0
        const numPosInText = windowStart + numPosInWindow
        
        // Check if number is in dimension/spec context (should be excluded)
        const dimCheck = isNumberInDimensionContext(text, numPosInText, numRaw)
        
        // Get the same LINE containing this number to check for weight units
        let lineStart = numPosInText
        while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
          lineStart--
        }
        let lineEnd = numPosInText + numRaw.length
        while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
          lineEnd++
        }
        const numLine = text.slice(lineStart, lineEnd)
        
        // Check if weight/length units are on the SAME LINE as this number
        const nearWeightUnit = WEIGHT_LENGTH_UNITS.test(numLine)
        
        // Base confidence from priority
        let baseConfidence = 0.5 + (config.priority / 200)
        
        // Major penalty for being in dimension context (mark as excluded)
        if (dimCheck.excluded) {
          baseConfidence = 0.05 // Very low confidence, but keep for debug visibility
        }
        
        // Penalty for being near weight/length units
        if (nearWeightUnit) {
          baseConfidence -= 0.3
        }
        
        // Bonus for matching expected quantity (if provided)
        if (expectedQty !== null && expectedQty !== undefined && n === expectedQty) {
          baseConfidence += 0.4 // Strong boost for matching expected
        }
        
        // Bonus for reasonable line-item quantities (1-10000)
        if (n >= 1 && n <= 10000 && Number.isInteger(n)) {
          baseConfidence += 0.1
        }
        
        candidates.push({
          value: n,
          confidence: clamp01(baseConfidence),
          label: config.label,
          priority: config.priority,
          snippet: window.replace(/\s+/g, ' ').trim().slice(0, 100),
          nearWeightUnit,
          index: labelIdx,
          excluded: dimCheck.excluded,
          excludeReason: dimCheck.reason,
        })
      }
    }
  }

  // Sort by:
  // 1. Not excluded (prefer non-excluded)
  // 2. Not near weight unit (prefer those NOT near weight units)
  // 3. Priority (descending)
  // 4. Confidence (descending)
  // 5. For tie-breakers, prefer smaller plausible integers (line qty vs totals)
  candidates.sort((a, b) => {
    // First: prefer candidates NOT excluded
    if (a.excluded !== b.excluded) {
      return a.excluded ? 1 : -1
    }
    // Then: prefer candidates NOT near weight units
    if (a.nearWeightUnit !== b.nearWeightUnit) {
      return a.nearWeightUnit ? 1 : -1
    }
    // Then by priority
    if (a.priority !== b.priority) return b.priority - a.priority
    // Then by confidence
    if (Math.abs(a.confidence - b.confidence) > 0.05) return b.confidence - a.confidence
    // Tie-breaker: prefer smaller plausible integers (likely line qty vs totals)
    if (a.value <= 10000 && b.value <= 10000) {
      return a.value - b.value
    }
    return 0
  })

  return candidates
}

function parseFromText(textRaw: string, source: EvidenceSource, opts: { poNumber?: string; lineId?: string; debug?: boolean; expectedQty?: number | null }): {
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
  // Note: Handles "No:", "No.", "No", "#", "Number:", "Number", or just ":"
  const soPatterns: Array<{ re: RegExp; base: number }> = [
    { re: /\b(?:supplier\s*)?(?:sales\s*)?order\s*(?:no[.:]?|#|number[.:]?|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.9 },
    { re: /\b(?:so|s\/o)\s*(?:no[.:]?|#|number[.:]?|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.75 },
    { re: /\b(?:acknowledg(?:e)?ment|ack)\s*(?:no[.:]?|#|number[.:]?|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.75 },
    { re: /\border\s*(?:no[.:]?|#|number[.:]?|:)?\s*([A-Z0-9][A-Z0-9\-\/]{3,})\b/i, base: 0.55 },
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

  // ============================================================================
  // LABEL-AWARE DATE EXTRACTION (NEW)
  // Uses priority-based label matching: Confirmed Ship > Ship Date > Delivery Date > Order Date
  // ============================================================================
  const labeledDateCandidates = extractDatesWithLabels(text)
  
  for (const ldc of labeledDateCandidates) {
    dateCandidates.push({
      value: ldc.value,
      confidence: clamp01(ldc.confidence + distanceBoost(0)), // Apply distance boost if relevant
      evidence_snippet: ldc.snippet,
      source,
    })
  }

  // Legacy fallback: Delivery/ship date patterns (kept for backwards compatibility)
  const dateLabelRe = /\b(?:ship\s*date|delivery\s*date|deliver(?:y)?\s*by|expected\s*(?:ship|delivery)|promise(?:d)?\s*date|expected\s*delivery)\b/i
  const dateTokenRe =
    /(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{1,2}(?:,)?\s+\d{4}\b)/g

  // Only use legacy extraction if label-aware found nothing
  if (dateCandidates.length === 0) {
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

  // ============================================================================
  // LABEL-AWARE QUANTITY EXTRACTION (NEW)
  // Uses priority-based label matching and de-prioritizes weight/length units
  // ============================================================================
  const labeledQtyCandidates = extractQtysWithLabels(text, lineId, opts.expectedQty)
  
  for (const lqc of labeledQtyCandidates) {
    // Skip excluded candidates (dimension specs, fractions, grade codes)
    if (lqc.excluded) continue
    
    qtyCandidates.push({
      value: lqc.value,
      confidence: clamp01(lqc.confidence + distanceBoost(0)),
      evidence_snippet: lqc.snippet,
      source,
    })
  }

  // Legacy fallback: Quantity extraction (kept for backwards compatibility)
  const qtyLabelRe =
    /\b(?:confirmed\s*qty|order(?:ed)?\s*qty|order\s*qty|qty|quantity|shipped|balance|total|pieces)\b/i
  const qtyCaptureRe =
    /\b(?:confirmed\s*qty|order(?:ed)?\s*qty|order\s*qty|qty|quantity|shipped|balance|total|pieces)\b[^0-9]{0,20}([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\b/i

  // Only use legacy extraction if label-aware found nothing
  if (qtyCandidates.length === 0) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(qtyCaptureRe)
    if (!m) continue
    const numStr = String(m[1]).replace(/,/g, '')
    const n = Number(numStr)
    if (!Number.isFinite(n) || n <= 0 || n > 1e7) continue
      // Check for weight/length units nearby
      const nearWeightUnit = WEIGHT_LENGTH_UNITS.test(line)
      let base = /confirmed/i.test(line) ? 0.92 : /order\s*qty|ordered/i.test(line) ? 0.88 : /qty|quantity/i.test(line) ? 0.82 : 0.7
      if (nearWeightUnit) base -= 0.3
    qtyCandidates.push({
      value: n,
      confidence: clamp01(base + distanceBoost(i)),
      evidence_snippet: makeLineSnippet(lines, i),
      source,
    })
  }
  }

  // Quantity: implied table-ish (look for header with Qty/Quantity and parse next rows)
  const tableHeaderIdxs: number[] = []
  const qtyUnitPriceExtendedHeaders: number[] = []
  
  for (let i = 0; i < lowerLines.length; i++) {
    const l = lowerLines[i]
    const hasQty = /\b(qty|quantity|order\s*qty|ordered)\b/.test(l)
    const hasOtherCols = /\b(item|line|part|description|uom|unit|price|amount)\b/.test(l)
    if (hasQty && hasOtherCols) tableHeaderIdxs.push(i)
    
    // Special case: "Qty Unit Price Extended" header pattern
    if (/\bqty\b.*\bunit\s*price\b.*\bextended\b/i.test(l)) {
      qtyUnitPriceExtendedHeaders.push(i)
    }
  }

  const looksLikeMoney = (token: string) => /\$/.test(token) || /\b\d+\.\d{2}\b/.test(token)
  const looksLikeDate = (token: string) => /\b\d{4}-\d{2}-\d{2}\b/.test(token) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(token)
  const looksLikeYear = (n: number) => n >= 1990 && n <= 2100
  
  // Pattern to match unit price: $X.XX or X.XX (with 2 decimal places)
  const unitPricePattern = /\$?\d+\.\d{2}\b/
  // Pattern to match extended price: $X,XXX.XX or $X,XXX or X,XXX.XX
  const extendedPricePattern = /\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/

  // Special handling for "Qty Unit Price Extended" table pattern
  for (const headerIdx of qtyUnitPriceExtendedHeaders) {
    for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 12); i++) {
      const line = lines[i]
      if (qtyLabelRe.test(line)) continue // already captured as explicit
      
      // Find unit price and extended price positions
      const unitPriceMatch = line.match(unitPricePattern)
      const extendedPriceMatch = line.match(extendedPricePattern)
      
      if (!unitPriceMatch && !extendedPriceMatch) continue
      
      // Extract quantity as the number immediately before unit price or extended price
      // Look for numbers before the price patterns
      const priceStart = unitPriceMatch ? (unitPriceMatch.index ?? line.length) : (extendedPriceMatch?.index ?? line.length)
      const beforePrice = line.slice(0, priceStart)
      
      // Extract all numbers from the part before price
      const numbersBeforePrice: Array<{ value: number; position: number; token: string }> = []
      const numPattern = /\b([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\b/g
      let match
      while ((match = numPattern.exec(beforePrice)) !== null) {
        const numStr = match[1].replace(/,/g, '')
        const n = Number(numStr)
        if (Number.isFinite(n) && n > 0 && n <= 1e7 && !looksLikeYear(n)) {
          numbersBeforePrice.push({
            value: n,
            position: match.index ?? 0,
            token: match[1],
          })
        }
      }
      
      if (numbersBeforePrice.length === 0) continue
      
      // Exclude numbers that appear right after line index and part number pattern
      // Pattern: single digit or small number (line index) followed by larger number (part number)
      // e.g., "1 18195" - exclude 18195
      const filteredNumbers = numbersBeforePrice.filter((num, idx) => {
        // Check if this number is likely a part number (appears right after a small line index)
        if (idx > 0) {
          const prevNum = numbersBeforePrice[idx - 1]
          // If previous number is small (1-10, likely line index) and current is much larger, exclude current (part number)
          if (prevNum.value <= 10 && num.value > prevNum.value * 10 && num.value > 1000) {
            // This looks like part number pattern (e.g., "1 18195"), exclude it
            return false
          }
        }
        
        // Check if this is in dimension/spec context (fractions, dimensions like "20/24", "1.500", ".120")
        const numStart = num.position
        const numEnd = numStart + num.token.length
        const contextBefore = beforePrice.slice(Math.max(0, numStart - 10), numStart)
        const contextAfter = beforePrice.slice(numEnd, Math.min(beforePrice.length, numEnd + 10))
        
        // Exclude if appears in fraction pattern (X/Y)
        if (/\d+\s*\/\s*\d+/.test(contextBefore + num.token + contextAfter)) {
          return false
        }
        
        // Exclude if appears with dimension markers (SQ, X, etc.)
        if (/\b(sq|sq\.|x|×|in|inch|ft|feet|mm|cm|m)\b/i.test(contextBefore + contextAfter)) {
          return false
        }
        
        // Exclude alphanumeric spec tokens (like A500C) - but only if the number is directly adjacent to letters
        // Check if number is part of a code (e.g., "A500C" where 500 is part of code)
        const beforeMatch = contextBefore.match(/[A-Za-z]\s*$/)
        const afterMatch = contextAfter.match(/^\s*[A-Za-z]/)
        if (beforeMatch && afterMatch) {
          // Number is sandwiched between letters, likely part of a code
          return false
        }
        
        return true
      })
      
      if (filteredNumbers.length === 0) continue
      
      // Quantity should be the number closest to the price (right before it)
      // Sort by position (closest to price = highest position)
      filteredNumbers.sort((a, b) => b.position - a.position)
      const qtyCandidate = filteredNumbers[0]
      
      // High confidence for this pattern since it's a structured table
      const base = 0.85
      const bonus = opts.expectedQty && qtyCandidate.value === opts.expectedQty ? 0.1 : 0
      
      qtyCandidates.push({
        value: qtyCandidate.value,
        confidence: clamp01(base + bonus + distanceBoost(i)),
        evidence_snippet: makeLineSnippet(lines, i),
        source,
      })
    }
  }

  // General table parsing (for other table patterns)
  for (const headerIdx of tableHeaderIdxs) {
    // Skip if already processed as "Qty Unit Price Extended" pattern
    if (qtyUnitPriceExtendedHeaders.includes(headerIdx)) continue
    
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
  const debug = input.debug ?? false
  const expectedQty = input.expectedQty ?? null

  // Collect debug candidates if requested
  const debugDateCandidates: Array<{ value: string; confidence: number; label: string; snippet: string }> = []
  const debugQtyCandidates: Array<{ value: number; confidence: number; label: string; snippet: string; nearWeightUnit: boolean; excluded?: boolean; excludeReason?: string }> = []
  let qtyChosenReason = 'no candidates found'

  // Best PDF per field can come from different attachments; keep it simple: scan each attachment and keep best candidate.
  let bestPdfSupplier: Candidate<string> | null = null
  let bestPdfDate: Candidate<string> | null = null
  let bestPdfQty: Candidate<number> | null = null

  for (const p of pdfTexts) {
    const t = (p.text ?? '').trim()
    if (!t) continue
    const parsed = parseFromText(t, 'pdf', { poNumber: input.poNumber, lineId: input.lineId, debug, expectedQty })
    if (parsed.supplierOrder && (!bestPdfSupplier || parsed.supplierOrder.confidence > bestPdfSupplier.confidence)) {
      bestPdfSupplier = { ...parsed.supplierOrder, attachment_id: p.attachment_id }
    }
    if (parsed.deliveryDate && (!bestPdfDate || parsed.deliveryDate.confidence > bestPdfDate.confidence)) {
      bestPdfDate = { ...parsed.deliveryDate, attachment_id: p.attachment_id }
    }
    if (parsed.quantity && (!bestPdfQty || parsed.quantity.confidence > bestPdfQty.confidence)) {
      bestPdfQty = { ...parsed.quantity, attachment_id: p.attachment_id }
    }
    
    // Collect debug candidates from each PDF
    if (debug) {
      const labeledDates = extractDatesWithLabels(t)
      for (const ldc of labeledDates) {
        debugDateCandidates.push({
          value: ldc.value,
          confidence: ldc.confidence,
          label: ldc.label,
          snippet: ldc.snippet,
        })
      }
      const labeledQtys = extractQtysWithLabels(t, input.lineId, expectedQty)
      for (const lqc of labeledQtys) {
        debugQtyCandidates.push({
          value: lqc.value,
          confidence: lqc.confidence,
          label: lqc.label,
          snippet: lqc.snippet,
          nearWeightUnit: lqc.nearWeightUnit,
          excluded: lqc.excluded,
          excludeReason: lqc.excludeReason,
        })
      }
    }
  }

  const emailParsed = emailText
    ? parseFromText(emailText, 'email', { poNumber: input.poNumber, lineId: input.lineId, debug, expectedQty })
    : { supplierOrder: null, deliveryDate: null, quantity: null }

  const supplier_order_number = chooseBestField(bestPdfSupplier, emailParsed.supplierOrder)
  const confirmed_delivery_date = chooseBestField(bestPdfDate, emailParsed.deliveryDate)
  
  // ============================================================================
  // QUANTITY HANDLING: Two quantities
  // 1. ordered_quantity: From PO/system of record (expectedQty)
  // 2. supplier_confirmed_quantity: Extracted from PDF/email evidence
  // ============================================================================
  
  // 1. Populate ordered_quantity from expectedQty (system of record)
  const ordered_quantity: ParsedField<number> = expectedQty !== null && expectedQty !== undefined
    ? {
        value: expectedQty,
        confidence: 1.0, // System of record - high confidence
        evidence_snippet: null,
        source: 'none', // Not from evidence, from system
        attachment_id: null,
        message_id: null,
      }
    : {
        value: null,
        confidence: 0,
        evidence_snippet: null,
        source: 'none',
        attachment_id: null,
        message_id: null,
      }
  
  // 2. Extract supplier_confirmed_quantity from PDF/email (evidence-based)
  // Use existing qty extraction but allow extraction even if expectedQty is null
  // Only extract when strongly indicated by table-ish row patterns (no guessing)
  // Minimum confidence threshold: 0.6 (ensures we only extract when strongly indicated)
  const MIN_SUPPLIER_QTY_CONFIDENCE = 0.6
  const rawQtyChoice = chooseBestField(bestPdfQty, emailParsed.quantity)
  
  let supplier_confirmed_quantity: ParsedField<number>
  let supplierQtyChosenReason = 'no candidates found'
  
  if (rawQtyChoice.value !== null && rawQtyChoice.confidence >= MIN_SUPPLIER_QTY_CONFIDENCE) {
    // Candidate found with sufficient confidence - use it (even if expectedQty is null, this is evidence from supplier)
    supplierQtyChosenReason = `extracted from ${rawQtyChoice.source}: ${rawQtyChoice.value} (confidence: ${Math.round(rawQtyChoice.confidence * 100)}%)`
    supplier_confirmed_quantity = rawQtyChoice
  } else if (rawQtyChoice.value !== null) {
    // Candidate found but confidence too low - don't use it (no guessing)
    supplierQtyChosenReason = `qty candidate found but confidence too low (${Math.round(rawQtyChoice.confidence * 100)}% < ${Math.round(MIN_SUPPLIER_QTY_CONFIDENCE * 100)}%) - not extracting`
    supplier_confirmed_quantity = {
      value: null,
      confidence: 0,
      evidence_snippet: null,
      source: 'none',
      attachment_id: null,
      message_id: null,
    }
  } else {
    // No candidates found
    supplierQtyChosenReason = 'no qty found in PDF/email evidence'
    supplier_confirmed_quantity = {
      value: null,
      confidence: 0,
      evidence_snippet: null,
      source: 'none',
      attachment_id: null,
      message_id: null,
    }
  }
  
  // 3. Compute quantity_mismatch
  let quantity_mismatch: { value: boolean | null; reason: string }
  if (ordered_quantity.value === null && supplier_confirmed_quantity.value === null) {
    quantity_mismatch = {
      value: null,
      reason: 'both quantities missing',
    }
  } else if (ordered_quantity.value === null) {
    quantity_mismatch = {
      value: null,
      reason: 'ordered_quantity missing',
    }
  } else if (supplier_confirmed_quantity.value === null) {
    quantity_mismatch = {
      value: null,
      reason: 'supplier_confirmed_quantity missing',
    }
  } else {
    // Both exist - check if they match
    const ordered = ordered_quantity.value
    const supplier = supplier_confirmed_quantity.value
    if (ordered === supplier) {
      quantity_mismatch = {
        value: false,
        reason: `both quantities match: ${ordered}`,
      }
    } else {
      quantity_mismatch = {
        value: true,
        reason: `mismatch: ordered=${ordered}, supplier=${supplier}`,
      }
    }
  }
  
  // 4. Backward compatibility: confirmed_quantity = ordered_quantity
  const confirmed_quantity: ParsedField<number> = ordered_quantity
  
  // Update qtyChosenReason for debug output
  if (expectedQty !== null && expectedQty !== undefined) {
    if (supplier_confirmed_quantity.value === expectedQty) {
      qtyChosenReason = `supplier qty ${supplier_confirmed_quantity.value} matches ordered qty ${expectedQty}`
    } else if (supplier_confirmed_quantity.value !== null) {
      qtyChosenReason = `supplier qty ${supplier_confirmed_quantity.value} differs from ordered qty ${expectedQty}`
    } else {
      qtyChosenReason = `ordered qty ${expectedQty} but no supplier qty found`
    }
  } else {
    qtyChosenReason = supplierQtyChosenReason
  }

  const anyFound =
    supplier_order_number.value !== null ||
    confirmed_delivery_date.value !== null ||
    supplier_confirmed_quantity.value !== null

  const evidence_source: EvidenceSource = !anyFound
    ? 'none'
    : supplier_order_number.source === 'pdf' ||
      confirmed_delivery_date.source === 'pdf' ||
      supplier_confirmed_quantity.source === 'pdf'
      ? 'pdf'
      : 'email'

  const raw_excerpt =
    (supplier_order_number.evidence_snippet ||
      confirmed_delivery_date.evidence_snippet ||
      supplier_confirmed_quantity.evidence_snippet ||
      null)

  const result: ParsedConfirmationFieldsV1 = {
    supplier_order_number,
    confirmed_delivery_date,
    confirmed_quantity, // Backward compatibility
    ordered_quantity,
    supplier_confirmed_quantity,
    quantity_mismatch,
    evidence_source,
    raw_excerpt,
  }

  // Include debug candidates if requested
  if (debug) {
    result.debug_candidates = {
      dateCandidates: debugDateCandidates,
      qtyCandidates: debugQtyCandidates,
      expectedQty,
      ordered_quantity: ordered_quantity.value,
      supplier_confirmed_quantity: supplier_confirmed_quantity.value,
      quantity_mismatch,
      qtyChosenReason: `${qtyChosenReason}; supplier_qty_reason: ${supplierQtyChosenReason}`,
    }
  }

  return result
}

/**
 * Parse confirmation fields using OpenAI LLM as fallback
 * Used when regex parsing is uncertain or fails
 */
export async function parseWithLLMFallback(
  pdfText: string,
  expectedFields?: { 
    supplier_order_number?: string
    delivery_date?: string
    quantity?: number
    expected_unit_price?: number
  }
): Promise<{
  supplier_order_number: string | null
  delivery_date: string | null // ISO YYYY-MM-DD format
  quantity: number | null
  unit_price: number | null
  extended_price: number | null
  currency: string | null
  payment_terms: string | null
  freight_terms: string | null
  freight_cost: number | null
  subtotal: number | null
  tax_amount: number | null
  order_total: number | null
  notes: string | null
  backorder_status: string | null
  confidence: number
  extraction_method: 'llm'
}> {
  const OpenAI = (await import('openai')).default
  
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured for LLM fallback')
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })

  // Truncate PDF text to avoid token limits (keep first 12000 chars for extended fields)
  const truncatedText = pdfText.slice(0, 12000)
  
  const prompt = `Extract ALL available fields from this sales order/confirmation. Return ONLY valid JSON, no other text.

Required format (JSON only):
{
  "supplier_order_number": "SO-XXX or null",
  "delivery_date": "YYYY-MM-DD or null",
  "quantity": 1000 or null,
  "unit_price": 1.25 or null,
  "extended_price": 1250.00 or null,
  "currency": "USD or null",
  "payment_terms": "NET 30 or null",
  "freight_terms": "FOB Origin or null",
  "freight_cost": 250.00 or null,
  "subtotal": 1250.00 or null,
  "tax_amount": 0.00 or null,
  "order_total": 1500.00 or null,
  "notes": "Any special instructions or null",
  "backorder_status": "No backorders or null"
}

CRITICAL: 
- All prices as numbers (no $ symbols, no commas)
- Dates as YYYY-MM-DD format
- If field not found, use null
- Do not hallucinate - only extract what you clearly see
- Currency codes should be 3-letter codes (USD, EUR, etc.)

Sales Order Text:
${truncatedText}`

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a data extraction assistant. Extract structured data from sales order confirmations. Return only valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1, // Low temperature for consistent extraction
      response_format: { type: 'json_object' },
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from OpenAI')
    }

    const parsed = JSON.parse(content)
    
    // Helper to parse price (remove $, commas, convert to number)
    const parsePrice = (value: any): number | null => {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value
      }
      if (typeof value === 'string') {
        const cleaned = value.replace(/[$,\s]/g, '')
        const num = parseFloat(cleaned)
        if (Number.isFinite(num) && num >= 0) {
          return num
        }
      }
      return null
    }
    
    // Validate and normalize the response
    const result = {
      supplier_order_number: parsed.supplier_order_number && typeof parsed.supplier_order_number === 'string' 
        ? parsed.supplier_order_number.trim() 
        : null,
      delivery_date: parsed.delivery_date && typeof parsed.delivery_date === 'string'
        ? parsed.delivery_date.trim()
        : null,
      quantity: typeof parsed.quantity === 'number' && Number.isFinite(parsed.quantity) && parsed.quantity > 0
        ? Math.floor(parsed.quantity)
        : null,
      unit_price: parsePrice(parsed.unit_price),
      extended_price: parsePrice(parsed.extended_price),
      currency: parsed.currency && typeof parsed.currency === 'string'
        ? parsed.currency.trim().toUpperCase()
        : null,
      payment_terms: parsed.payment_terms && typeof parsed.payment_terms === 'string'
        ? parsed.payment_terms.trim()
        : null,
      freight_terms: parsed.freight_terms && typeof parsed.freight_terms === 'string'
        ? parsed.freight_terms.trim()
        : null,
      freight_cost: parsePrice(parsed.freight_cost),
      subtotal: parsePrice(parsed.subtotal),
      tax_amount: parsePrice(parsed.tax_amount),
      order_total: parsePrice(parsed.order_total),
      notes: parsed.notes && typeof parsed.notes === 'string'
        ? parsed.notes.trim()
        : null,
      backorder_status: parsed.backorder_status && typeof parsed.backorder_status === 'string'
        ? parsed.backorder_status.trim()
        : null,
      confidence: 0.85, // LLM extraction gets high confidence
      extraction_method: 'llm' as const,
    }

    // Validate delivery_date format (should be YYYY-MM-DD)
    if (result.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(result.delivery_date)) {
      // Try to parse and reformat
      const date = new Date(result.delivery_date)
      if (!isNaN(date.getTime())) {
        result.delivery_date = date.toISOString().split('T')[0]
      } else {
        result.delivery_date = null
      }
    }

    // Check for price changes if expected_unit_price is provided
    if (expectedFields?.expected_unit_price && result.unit_price !== null) {
      const expectedPrice = expectedFields.expected_unit_price
      const actualPrice = result.unit_price
      if (Math.abs(actualPrice - expectedPrice) > 0.01) { // Allow small floating point differences
        const priceDelta = actualPrice - expectedPrice
        const priceDeltaPercent = (priceDelta / expectedPrice) * 100
        console.log('[PARSE] Price discrepancy detected', {
          expected: expectedPrice,
          actual: actualPrice,
          delta: priceDelta,
          deltaPercent: priceDeltaPercent.toFixed(2) + '%',
        })
        // Note: price_changed will be added in the smart parser merge step
      }
    }

    return result
  } catch (error) {
    console.error('[LLM_FALLBACK] Error parsing with LLM:', error)
    // Return nulls on error
    return {
      supplier_order_number: null,
      delivery_date: null,
      quantity: null,
      unit_price: null,
      extended_price: null,
      currency: null,
      payment_terms: null,
      freight_terms: null,
      freight_cost: null,
      subtotal: null,
      tax_amount: null,
      order_total: null,
      notes: null,
      backorder_status: null,
      confidence: 0,
      extraction_method: 'llm' as const,
    }
  }
}

/**
 * Smart hybrid parser: tries regex first, uses LLM fallback if uncertain
 */
export async function parseConfirmationFieldsSmart(
  input: ParseInput
): Promise<ParsedConfirmationFieldsV1> {
  console.log('[PARSE] DEBUG: pdfTexts present?', input.pdfTexts ? 'YES' : 'NO')
  console.log('[PARSE] DEBUG: pdfTexts length:', input.pdfTexts?.length || 0)
  console.log('[PARSE] Using smart parser (hybrid)')
  
  // FORCE LLM FOR PDFs - regex can't handle table columns
  if (input.pdfTexts && input.pdfTexts.length > 0) {
    console.log('[PARSE] PDF detected, forcing LLM parser for table accuracy')
    
    // Combine all PDF texts
    const allPdfText = input.pdfTexts
      .map(p => p.text)
      .filter((t): t is string => !!t)
      .join('\n\n')
    
    if (allPdfText && allPdfText.trim().length > 0) {
      console.log('[PARSE] DEBUG: PDF text length:', allPdfText.length)
      console.log('[PARSE] DEBUG: PDF text preview (first 200 chars):', allPdfText.slice(0, 200))
      try {
        console.log('[PARSE] DEBUG: Calling LLM with expected_unit_price:', input.expectedUnitPrice)
        const llmResult = await parseWithLLMFallback(allPdfText, {
          expected_unit_price: input.expectedUnitPrice || undefined,
        })
        
        console.log('[PARSE] DEBUG: LLM returned:', {
          hasResult: !!llmResult,
          supplier_order_number: llmResult?.supplier_order_number,
          delivery_date: llmResult?.delivery_date,
          quantity: llmResult?.quantity,
          unit_price: llmResult?.unit_price,
          confidence: llmResult?.confidence,
        })
        
        if (llmResult && (llmResult.supplier_order_number || llmResult.delivery_date || llmResult.quantity !== null)) {
          console.log('[PARSE] LLM result:', {
            supplier_order_number: llmResult.supplier_order_number,
            delivery_date: llmResult.delivery_date,
            quantity: llmResult.quantity,
            unit_price: llmResult.unit_price,
          })
          
          // Convert LLM result to ParsedConfirmationFieldsV1 format
          const attachmentId = input.pdfTexts[0]?.attachment_id || null
          const evidenceSnippet = allPdfText.slice(0, 200)
          
          // Helper to create ParsedField
          const createField = <T>(value: T | null): ParsedField<T> => ({
            value,
            confidence: llmResult.confidence,
            evidence_snippet: value !== null ? evidenceSnippet : null,
            source: 'pdf' as EvidenceSource,
            attachment_id: attachmentId,
            message_id: null,
          })
          
          // Check for price changes
          let priceChanged: { value: boolean; price_delta?: number; price_delta_percent?: number } | null = null
          if (input.expectedUnitPrice && llmResult.unit_price !== null) {
            const expectedPrice = input.expectedUnitPrice
            const actualPrice = llmResult.unit_price
            if (Math.abs(actualPrice - expectedPrice) > 0.01) {
              const priceDelta = actualPrice - expectedPrice
              const priceDeltaPercent = (priceDelta / expectedPrice) * 100
              priceChanged = {
                value: true,
                price_delta: priceDelta,
                price_delta_percent: priceDeltaPercent,
              }
              console.log('[PARSE] Price discrepancy detected', {
                expected: expectedPrice,
                actual: actualPrice,
                delta: priceDelta,
                deltaPercent: priceDeltaPercent.toFixed(2) + '%',
              })
            }
          }
          
          // Determine evidence source
          const evidenceSource: EvidenceSource = input.pdfTexts.length > 0 ? 'pdf' : 'email'
          
          // Get expected quantity for comparison
          const expectedQty = input.expectedQty || null
          const orderedQuantity: ParsedField<number> = expectedQty !== null
            ? createField(expectedQty)
            : { value: null, confidence: 0, evidence_snippet: null, source: 'none', attachment_id: null, message_id: null }
          
          const supplierConfirmedQty = createField(llmResult.quantity)
          
          // Check for quantity mismatch
          const quantityMismatch = {
            value: expectedQty !== null && llmResult.quantity !== null && expectedQty !== llmResult.quantity
              ? true
              : expectedQty !== null && llmResult.quantity !== null
              ? false
              : null,
            reason: expectedQty !== null && llmResult.quantity !== null && expectedQty !== llmResult.quantity
              ? `Expected ${expectedQty}, supplier confirmed ${llmResult.quantity}`
              : '',
          }
          
          const result: ParsedConfirmationFieldsV1 = {
            supplier_order_number: createField(llmResult.supplier_order_number),
            confirmed_delivery_date: createField(llmResult.delivery_date),
            confirmed_quantity: supplierConfirmedQty, // Backward compatibility
            ordered_quantity: orderedQuantity,
            supplier_confirmed_quantity: supplierConfirmedQty,
            quantity_mismatch: quantityMismatch,
            evidence_source: evidenceSource,
            raw_excerpt: allPdfText.slice(0, 500),
            // Extended fields
            unit_price: createField(llmResult.unit_price),
            extended_price: createField(llmResult.extended_price),
            currency: createField(llmResult.currency),
            payment_terms: createField(llmResult.payment_terms),
            freight_terms: createField(llmResult.freight_terms),
            freight_cost: createField(llmResult.freight_cost),
            subtotal: createField(llmResult.subtotal),
            tax_amount: createField(llmResult.tax_amount),
            order_total: createField(llmResult.order_total),
            notes: createField(llmResult.notes),
            backorder_status: createField(llmResult.backorder_status),
            price_changed: priceChanged,
          }
          
          const finalFields = {
            supplier_order_number: result.supplier_order_number.value,
            delivery_date: result.confirmed_delivery_date.value,
            quantity: result.supplier_confirmed_quantity.value,
            unit_price: result.unit_price?.value,
            price_changed: result.price_changed,
          }
          console.log('[PARSE] Final extracted fields (LLM forced):', finalFields)
          
          return result
        } else {
          console.log('[PARSE] LLM returned empty/null result, falling back to regex')
          console.log('[PARSE] DEBUG: LLM result was:', llmResult)
        }
      } catch (error) {
        console.error('[PARSE] LLM parsing failed, falling back to regex:', error)
        console.error('[PARSE] DEBUG: Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        // Continue to regex below
      }
    } else {
      console.log('[PARSE] DEBUG: No PDF text available (allPdfText empty or null)')
    }
  }
  
  // First, try regex-based parsing (with debug enabled to check for uncertain candidates)
  const regexResult = parseConfirmationFieldsV1({
    ...input,
    debug: true, // Enable debug to check for multiple candidates
  })

  // Determine if we need LLM fallback
  // Use LLM if:
  // 1. Any required field is missing with low confidence
  // 2. Multiple high-confidence candidates exist (uncertainty)
  // 3. Regex found something but confidence is borderline
  const missingFields = [
    !regexResult.supplier_order_number.value && regexResult.supplier_order_number.confidence < 0.6,
    !regexResult.confirmed_delivery_date.value && regexResult.confirmed_delivery_date.confidence < 0.6,
    regexResult.supplier_confirmed_quantity.value === null && regexResult.supplier_confirmed_quantity.confidence < 0.6,
  ].filter(Boolean).length

  const hasUncertainCandidates = regexResult.debug_candidates?.qtyCandidates && 
    regexResult.debug_candidates.qtyCandidates.length > 1 &&
    regexResult.debug_candidates.qtyCandidates[0].confidence - regexResult.debug_candidates.qtyCandidates[1].confidence < 0.15

  const needsLLMFallback = missingFields >= 1 || hasUncertainCandidates

  // If regex parsing is confident, return it
  if (!needsLLMFallback) {
    const finalFields = {
      supplier_order_number: regexResult.supplier_order_number.value,
      delivery_date: regexResult.confirmed_delivery_date.value,
      quantity: regexResult.supplier_confirmed_quantity.value,
    }
    console.log('[PARSE] Regex parsing confident, using regex result. Final extracted fields:', finalFields)
    return regexResult
  }

  // Use LLM fallback for uncertain cases
  console.log('[PARSE] Uncertainty detected, using LLM fallback', {
    missingFields,
    hasUncertainCandidates,
    regexResults: {
      supplier_order_number: regexResult.supplier_order_number.value,
      delivery_date: regexResult.confirmed_delivery_date.value,
      quantity: regexResult.supplier_confirmed_quantity.value,
    },
  })
  
  // Combine all PDF texts
  const allPdfText = (input.pdfTexts ?? [])
    .map(p => p.text)
    .filter((t): t is string => !!t)
    .join('\n\n---\n\n')

  if (!allPdfText || allPdfText.trim().length === 0) {
    // No PDF text available, return regex result
    return regexResult
  }

  try {
    const llmResult = await parseWithLLMFallback(allPdfText, {
      supplier_order_number: regexResult.supplier_order_number.value || undefined,
      delivery_date: regexResult.confirmed_delivery_date.value || undefined,
      quantity: regexResult.supplier_confirmed_quantity.value || undefined,
      expected_unit_price: input.expectedUnitPrice || undefined,
    })

    const llmFields = {
      supplier_order_number: llmResult.supplier_order_number,
      delivery_date: llmResult.delivery_date,
      quantity: llmResult.quantity,
      unit_price: llmResult.unit_price,
      extended_price: llmResult.extended_price,
      currency: llmResult.currency,
      payment_terms: llmResult.payment_terms,
      freight_terms: llmResult.freight_terms,
      freight_cost: llmResult.freight_cost,
      subtotal: llmResult.subtotal,
      tax_amount: llmResult.tax_amount,
      order_total: llmResult.order_total,
      notes: llmResult.notes,
      backorder_status: llmResult.backorder_status,
      confidence: llmResult.confidence,
    }
    console.log('[PARSE] LLM result:', llmFields)

    // Helper to create ParsedField from LLM result
    const createParsedField = <T>(value: T | null): ParsedField<T> | null => {
      if (value === null) return null
      return {
        value,
        confidence: llmResult.confidence,
        evidence_snippet: allPdfText.slice(0, 200),
        source: 'pdf' as EvidenceSource,
        attachment_id: input.pdfTexts?.[0]?.attachment_id || null,
        message_id: null,
      }
    }

    // Check for price changes
    let priceChanged: { value: boolean; price_delta?: number; price_delta_percent?: number } | null = null
    if (input.expectedUnitPrice && llmResult.unit_price !== null) {
      const expectedPrice = input.expectedUnitPrice
      const actualPrice = llmResult.unit_price
      if (Math.abs(actualPrice - expectedPrice) > 0.01) {
        const priceDelta = actualPrice - expectedPrice
        const priceDeltaPercent = (priceDelta / expectedPrice) * 100
        priceChanged = {
          value: true,
          price_delta: priceDelta,
          price_delta_percent: priceDeltaPercent,
        }
        console.log('[PARSE] Price discrepancy detected', {
          expected: expectedPrice,
          actual: actualPrice,
          delta: priceDelta,
          deltaPercent: priceDeltaPercent.toFixed(2) + '%',
        })
      }
    }

    // Merge LLM results with regex results, preferring LLM when it found values
    const merged: ParsedConfirmationFieldsV1 = {
      ...regexResult,
      supplier_order_number: llmResult.supplier_order_number
        ? {
            value: llmResult.supplier_order_number,
            confidence: llmResult.confidence,
            evidence_snippet: allPdfText.slice(0, 200),
            source: 'pdf' as EvidenceSource,
            attachment_id: input.pdfTexts?.[0]?.attachment_id || null,
            message_id: null,
          }
        : regexResult.supplier_order_number,
      confirmed_delivery_date: llmResult.delivery_date
        ? {
            value: llmResult.delivery_date,
            confidence: llmResult.confidence,
            evidence_snippet: allPdfText.slice(0, 200),
            source: 'pdf' as EvidenceSource,
            attachment_id: input.pdfTexts?.[0]?.attachment_id || null,
            message_id: null,
          }
        : regexResult.confirmed_delivery_date,
      supplier_confirmed_quantity: llmResult.quantity !== null
        ? {
            value: llmResult.quantity,
            confidence: llmResult.confidence,
            evidence_snippet: allPdfText.slice(0, 200),
            source: 'pdf' as EvidenceSource,
            attachment_id: input.pdfTexts?.[0]?.attachment_id || null,
            message_id: null,
          }
        : regexResult.supplier_confirmed_quantity,
      // Add extended fields from LLM
      unit_price: createParsedField(llmResult.unit_price),
      extended_price: createParsedField(llmResult.extended_price),
      currency: createParsedField(llmResult.currency),
      payment_terms: createParsedField(llmResult.payment_terms),
      freight_terms: createParsedField(llmResult.freight_terms),
      freight_cost: createParsedField(llmResult.freight_cost),
      subtotal: createParsedField(llmResult.subtotal),
      tax_amount: createParsedField(llmResult.tax_amount),
      order_total: createParsedField(llmResult.order_total),
      notes: createParsedField(llmResult.notes),
      backorder_status: createParsedField(llmResult.backorder_status),
      price_changed: priceChanged,
    }

    // Update confirmed_quantity for backward compatibility
    merged.confirmed_quantity = merged.supplier_confirmed_quantity

    const finalFields = {
      supplier_order_number: merged.supplier_order_number.value,
      delivery_date: merged.confirmed_delivery_date.value,
      quantity: merged.supplier_confirmed_quantity.value,
      unit_price: merged.unit_price?.value,
      extended_price: merged.extended_price?.value,
      currency: merged.currency?.value,
      payment_terms: merged.payment_terms?.value,
      freight_terms: merged.freight_terms?.value,
      freight_cost: merged.freight_cost?.value,
      subtotal: merged.subtotal?.value,
      tax_amount: merged.tax_amount?.value,
      order_total: merged.order_total?.value,
      notes: merged.notes?.value,
      backorder_status: merged.backorder_status?.value,
      price_changed: merged.price_changed,
    }
    console.log('[PARSE] Final extracted fields:', finalFields)

    return merged
  } catch (error) {
    console.error('[PARSE] LLM fallback failed, using regex result:', error)
    const finalFields = {
      supplier_order_number: regexResult.supplier_order_number.value,
      delivery_date: regexResult.confirmed_delivery_date.value,
      quantity: regexResult.supplier_confirmed_quantity.value,
    }
    console.log('[PARSE] Final extracted fields (regex fallback):', finalFields)
    // If LLM fails, return regex result
    return regexResult
  }
}

