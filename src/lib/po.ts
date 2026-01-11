/**
 * PO (Purchase Order) processing module
 * Handles normalization of raw CSV rows and exception detection
 */

export type ExceptionType = 'LATE_PO' | 'PARTIAL_OPEN' | 'ZOMBIE_PO' | 'UOM_AMBIGUITY' | null

export type TriageStatus = 'OK' | 'Review' | 'Action'

export interface TriageResult {
  status: TriageStatus
  signals: string[]
  next_step: string | null
}

export interface NormalizedPORow {
  po_id: string
  line_id: string
  supplier_id: string
  supplier_name: string
  part_num: string
  description: string
  order_qty: number | null
  unit_price: number | null
  line_open: boolean
  receipt_date: string | null
  due_date: Date | null
  order_date: Date | null
  rawRow: Record<string, any>
}

export interface Exception {
  id: string
  po_id: string
  line_id: string
  supplier_name: string
  exception_type: ExceptionType
  due_date: Date | null
  days_late: number | null
  evidence: string[]
  rowData: NormalizedPORow
}

/**
 * Helper to get value with flexible column name matching
 */
function getValue(row: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return String(row[key]).trim()
    }
  }
  return ''
}

/**
 * Helper to check boolean value (robust parsing)
 */
function isTrue(value: any): boolean {
  if (value === true) return true
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase()
    return ['TRUE', '1', 'YES', 'Y'].includes(normalized)
  }
  return false
}

/**
 * Helper to get numeric value
 */
function getNumericValue(row: Record<string, any>, keys: string[]): number | null {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      const value = row[key]
      if (typeof value === 'number') return value
      const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''))
      if (!isNaN(parsed)) return parsed
    }
  }
  return null
}

/**
 * Helper to parse date string
 */
function parseDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr || typeof dateStr !== 'string') return null
  const trimmed = dateStr.trim()
  if (trimmed === '') return null
  
  const date = new Date(trimmed)
  if (isNaN(date.getTime())) return null
  
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * Normalizes a raw CSV row into a canonical PO row format
 */
export function normalizeRow(rawRow: Record<string, any>): NormalizedPORow {
  const poId = getValue(rawRow, ['po_id', 'po id', 'PO_ID', 'PO ID', 'poId', 'PO', 'po'])
  const lineId = getValue(rawRow, ['line_id', 'line id', 'LINE_ID', 'LINE ID', 'lineId', 'Line', 'line'])
  const supplierId = getValue(rawRow, ['supplier_id', 'supplier id', 'SUPPLIER_ID', 'Supplier ID', 'supplierId', 'SupplierId'])
  const supplierName = getValue(rawRow, ['supplier_name', 'supplier name', 'SUPPLIER_NAME', 'Supplier Name', 'supplier', 'Supplier'])
  const partNum = getValue(rawRow, ['part_num', 'part num', 'PART_NUM', 'Part Num', 'PartNum', 'part_number', 'part number', 'PART_NUMBER', 'Part Number'])
  const description = getValue(rawRow, ['description', 'Description', 'DESCRIPTION', 'desc', 'Desc'])
  
  const orderQty = getNumericValue(rawRow, ['order_qty', 'order qty', 'ORDER_QTY', 'Order Qty', 'ordered_qty', 'ordered qty', 'qty', 'Qty', 'quantity', 'Quantity'])
  const unitPrice = getNumericValue(rawRow, ['unit_price', 'unit price', 'UNIT_PRICE', 'Unit Price', 'price', 'Price'])
  
  const lineOpen = isTrue(
    rawRow.line_open || rawRow['line_open'] || rawRow['line open'] || rawRow['LINE_OPEN'] || rawRow['Line Open'] || rawRow['LineOpen']
  )
  
  const receiptDateStr = getValue(rawRow, ['receipt_date', 'receipt date', 'RECEIPT_DATE', 'Receipt Date', 'ReceiptDate'])
  const receiptDate = receiptDateStr ? receiptDateStr : null
  
  const dueDateStr = getValue(rawRow, ['due_date', 'due date', 'DUE_DATE', 'Due Date', 'DueDate'])
  const dueDate = parseDate(dueDateStr)
  
  const orderDateStr = getValue(rawRow, ['order_date', 'order date', 'ORDER_DATE', 'Order Date', 'OrderDate'])
  const orderDate = parseDate(orderDateStr)
  
  return {
    po_id: poId,
    line_id: lineId,
    supplier_id: supplierId,
    supplier_name: supplierName,
    part_num: partNum,
    description,
    order_qty: orderQty,
    unit_price: unitPrice,
    line_open: lineOpen,
    receipt_date: receiptDate,
    due_date: dueDate,
    order_date: orderDate,
    rawRow
  }
}

/**
 * Detects UoM ambiguity by checking for dimensional language in description
 * Returns true if dimensional language is detected
 */
export function detectUoMAmbiguity(description: string): boolean {
  if (!description || description.trim() === '') return false
  
  const desc = description.toLowerCase()
  
  // Dimension keywords
  const dimensionKeywords = [
    'length', 'width', 'height', 'depth', 'thickness', 'diameter', 'radius',
    'dimension', 'dimensions', 'size', 'measurement', 'measurements',
    'x', '×', 'by', 'x', 'mm', 'cm', 'm', 'inch', 'inches', 'in', 'ft', 'feet',
    'square', 'sq', 'cubic', 'cu', 'area', 'volume'
  ]
  
  // Check for dimension keywords
  for (const keyword of dimensionKeywords) {
    if (desc.includes(keyword)) {
      return true
    }
  }
  
  // Check for dimension patterns like "50mm", "2x3", "10x20x30", "5.5in", etc.
  const dimensionPatterns = [
    /\d+\.?\d*\s*(mm|cm|m|inch|inches|in|ft|feet|'|")/i,  // e.g., "50mm", "2.5in"
    /\d+\.?\d*\s*[x×]\s*\d+\.?\d*/i,  // e.g., "2x3", "10.5x20"
    /\d+\.?\d*\s*[x×]\s*\d+\.?\d*\s*[x×]\s*\d+\.?\d*/i,  // e.g., "10x20x30"
    /\d+\.?\d*\s*(x|×)\s*\d+\.?\d*\s*(x|×)\s*\d+\.?\d*/i,  // e.g., "10 x 20 x 30"
  ]
  
  for (const pattern of dimensionPatterns) {
    if (pattern.test(desc)) {
      return true
    }
  }
  
  return false
}

/**
 * Extracts description cues for pricing basis analysis (context only, not displayed as signals)
 */
function extractDescriptionCues(description: string): {
  has_length_cue: boolean
  has_bundle_cue: boolean
  has_weight_cue: boolean
} {
  if (!description || description.trim() === '') {
    return { has_length_cue: false, has_bundle_cue: false, has_weight_cue: false }
  }
  
  const desc = description.toUpperCase()
  
  // Length cues: feet/inches markers
  const has_length_cue = /'|"|FT|FEET|INCH|INCHES|IN\b/.test(desc) || 
    /\d+\/\d+\s*'/.test(description) // Fractional feet like 17/24'
  
  // Bundle cues: packaging terms
  const has_bundle_cue = /\b(CASE|CS|BOX|BUNDLE|PK|PACK|COIL|SKID|PALLET)\b/.test(desc)
  
  // Weight cues: weight units
  const has_weight_cue = /\b(LB|LBS|#|TON|WT|WEIGHT)\b/.test(desc)
  
  return { has_length_cue, has_bundle_cue, has_weight_cue }
}

/**
 * Checks if order_qty looks count-like (near-integer and reasonable count range)
 */
function isCountLikeQuantity(qty: number | null): boolean {
  if (qty === null || qty <= 0) return false
  // Near-integer: difference from rounded value is small
  const diff = Math.abs(qty - Math.round(qty))
  return diff < 0.01 && qty <= 5000
}

/**
 * Builds a cohort key from description tokens for pricing comparison
 */
function buildCohortKey(description: string): string {
  if (!description || description.trim() === '') return ''
  
  const desc = description.toUpperCase()
  const tokens: string[] = []
  
  // Extract key identifiers
  // Material types (DOM, HREW, PIPE, TUBE, etc.)
  if (/\b(DOM|HREW|PIPE|TUBE|PLATE|SHEET|BAR|ROD|BEAM|CHANNEL|ANGLE)\b/.test(desc)) {
    const match = desc.match(/\b(DOM|HREW|PIPE|TUBE|PLATE|SHEET|BAR|ROD|BEAM|CHANNEL|ANGLE)\b/)
    if (match) tokens.push(match[1])
  }
  
  // ASTM codes (A513, A500, A135, etc.)
  const astmMatch = desc.match(/\bA\d{3,4}\b/)
  if (astmMatch) tokens.push(astmMatch[0])
  
  // Material grades (STAINLESS, 4130, 4140, etc.)
  if (/\bSTAINLESS\b/.test(desc)) tokens.push('STAINLESS')
  const gradeMatch = desc.match(/\b(4130|4140|1018|1020|1045|316|304)\b/)
  if (gradeMatch) tokens.push(gradeMatch[1])
  
  return tokens.length > 0 ? tokens.join('_') : ''
}

/**
 * Computes robust statistics (median and MAD) for a price array
 */
function computePriceStats(prices: number[]): { median: number; mad: number } {
  if (prices.length === 0) {
    return { median: 0, mad: 0 }
  }
  
  const sorted = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
  
  // Compute MAD (Median Absolute Deviation)
  const deviations = sorted.map(p => Math.abs(p - median))
  deviations.sort((a, b) => a - b)
  const madMid = Math.floor(deviations.length / 2)
  const mad = deviations.length % 2 === 0
    ? (deviations[madMid - 1] + deviations[madMid]) / 2
    : deviations[madMid]
  
  // Avoid division by zero - use 1% of median as minimum MAD
  const minMad = Math.max(median * 0.01, 0.01)
  
  return { median, mad: Math.max(mad, minMad) }
}

/**
 * Checks if unit_price is an outlier relative to cohort or global pricing
 */
function isPriceOutlier(
  unitPrice: number | null,
  description: string,
  allRows: NormalizedPORow[]
): boolean {
  if (!unitPrice || unitPrice <= 0) return false
  if (allRows.length === 0) return false
  
  const cohortKey = buildCohortKey(description)
  
  // Build cohort: rows with same cohort key and valid prices (exclude current row)
  let cohortPrices: number[] = []
  
  if (cohortKey) {
    cohortPrices = allRows
      .filter(row => {
        if (!row.unit_price || row.unit_price <= 0) return false
        // Skip if same row (by PO-line ID match if available, or by price match as fallback)
        if (row.description && buildCohortKey(row.description) === cohortKey) return true
        return false
      })
      .map(row => row.unit_price!)
  }
  
  // If cohort too small (< 3 items), use global stats (excluding current price)
  let stats: { median: number; mad: number }
  if (cohortPrices.length >= 3) {
    stats = computePriceStats(cohortPrices)
  } else {
    // Use global pricing stats (all valid prices)
    const globalPrices = allRows
      .filter(row => row.unit_price && row.unit_price > 0)
      .map(row => row.unit_price!)
    
    if (globalPrices.length < 2) return false // Need at least 2 prices for comparison
    
    stats = computePriceStats(globalPrices)
  }
  
  // Avoid edge case where median is 0 or MAD is 0
  if (stats.median <= 0 || stats.mad <= 0) return false
  
  // Outlier rule: abs(price - median) > 3 * MAD
  const deviation = Math.abs(unitPrice - stats.median)
  return deviation > 3 * stats.mad
}

/**
 * Checks if a line is overdue or old (more than 30 days past due date)
 */
function isOverdueOrOld(dueDate: Date | null, today: Date): boolean {
  if (!dueDate) return false
  
  const todayNormalized = new Date(today)
  todayNormalized.setHours(0, 0, 0, 0)
  
  const thirtyDaysAgo = new Date(todayNormalized)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  
  return dueDate < thirtyDaysAgo
}

/**
 * Computes triage classification for a single PO line
 * Returns status, signals, and next_step recommendation
 */
export function computeTriage(
  row: NormalizedPORow,
  today: Date = new Date(),
  allRowsForCohort: NormalizedPORow[] = []
): TriageResult {
  const signals: string[] = []
  
  // Signal 1: "Open after receipt"
  // High confidence: line_open is true AND receipt_date exists and is not empty
  const hasOpenAfterReceipt = row.line_open && row.receipt_date && row.receipt_date.trim() !== ''
  if (hasOpenAfterReceipt) {
    signals.push('Open after receipt')
  }
  
  // Signal 2: "Partial receipt"
  // Detected when: receipt_date exists but line is still open
  // This is the same condition as "Open after receipt" but tracked separately for Review logic
  if (hasOpenAfterReceipt) {
    signals.push('Partial receipt')
  }
  
  // Signal 3: "Missing critical fields"
  // supplier_name or description missing
  const hasSupplier = row.supplier_name && row.supplier_name.trim() !== ''
  const hasDescription = row.description && row.description.trim() !== ''
  if (!hasSupplier || !hasDescription) {
    signals.push('Missing critical fields')
  }
  
  // Signal 4: "Pricing basis check"
  // Conservative trigger: ALL must be true:
  // - Description has length/bundle/weight cues
  // - order_qty looks count-like (near-integer, <= 5000)
  // - unit_price is outlier in cohort
  if (row.description && row.unit_price && row.order_qty) {
    const cues = extractDescriptionCues(row.description)
    const hasAnyCue = cues.has_length_cue || cues.has_bundle_cue || cues.has_weight_cue
    
    if (hasAnyCue && isCountLikeQuantity(row.order_qty)) {
      // Only check price outlier if we have other rows for comparison
      if (allRowsForCohort.length > 0) {
        if (isPriceOutlier(row.unit_price, row.description, allRowsForCohort)) {
          signals.push('Pricing basis check')
        }
      }
    }
  }
  
  // Determine status using conservative rules
  let status: TriageStatus = 'OK'
  let next_step: string | null = null
  
  // Action: only when "Open after receipt" is present with high confidence
  if (signals.includes('Open after receipt')) {
    status = 'Action'
    next_step = 'Confirm receipt status and close line if complete'
  }
  // Review: when ("Partial receipt" AND overdue/old) OR ("Missing critical fields") OR ("Pricing basis check") OR (2+ signals present)
  else if (
    (signals.includes('Partial receipt') && isOverdueOrOld(row.due_date, today)) ||
    signals.includes('Missing critical fields') ||
    signals.includes('Pricing basis check') ||
    signals.length >= 2
  ) {
    status = 'Review'
    if (signals.includes('Missing critical fields')) {
      next_step = 'Complete missing supplier or description information'
    } else if (signals.includes('Pricing basis check')) {
      next_step = 'Verify pricing basis matches quantity basis (per piece vs per length/bundle/weight)'
    } else {
      next_step = 'Review line status and confirm next steps'
    }
  }
  // OK: otherwise
  else {
    status = 'OK'
    next_step = null
  }
  
  return {
    status,
    signals,
    next_step
  }
}

/**
 * Computes triage for all rows and logs summary statistics
 */
export function computeTriageForAll(rows: NormalizedPORow[], today: Date = new Date()): Map<string, TriageResult> {
  const results = new Map<string, TriageResult>()
  const statusCounts = { OK: 0, Review: 0, Action: 0 }
  let pricingBasisCheckCount = 0
  
  for (const row of rows) {
    if (!row.po_id || !row.line_id) {
      continue
    }
    
    const id = `${row.po_id}-${row.line_id}`
    // Pass all rows for cohort analysis
    const triage = computeTriage(row, today, rows)
    results.set(id, triage)
    
    statusCounts[triage.status]++
    if (triage.signals.includes('Pricing basis check')) {
      pricingBasisCheckCount++
    }
  }
  
  // Log summary with pricing basis check count
  console.log('[Triage Summary]', {
    OK: statusCounts.OK,
    Review: statusCounts.Review,
    Action: statusCounts.Action,
    Total: rows.length,
    'Pricing basis check': pricingBasisCheckCount
  })
  
  return results
}

/**
 * Derives exceptions from normalized PO rows
 * Returns a list of exceptions detected in the data
 */
export function deriveExceptions(normalizedRows: NormalizedPORow[], today: Date = new Date()): Exception[] {
  // Normalize today to start of day
  const todayNormalized = new Date(today)
  todayNormalized.setHours(0, 0, 0, 0)
  
  // Calculate 60 days ago for zombie PO detection
  const sixtyDaysAgo = new Date(todayNormalized)
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
  
  const exceptions: Exception[] = []
  
  for (const row of normalizedRows) {
    // Skip rows without required identifiers
    if (!row.po_id || !row.line_id) {
      continue
    }
    
    const id = `${row.po_id}-${row.line_id}`
    const exceptionTypes: ExceptionType[] = []
    
    // 1. Late PO: requires line_open == true AND due_date < today AND receipt_date is empty
    if (row.line_open && row.due_date && row.due_date < todayNormalized) {
      const receiptDateEmpty = !row.receipt_date || row.receipt_date.trim() === ''
      if (receiptDateEmpty) {
        exceptionTypes.push('LATE_PO')
      }
    }
    
    // 2. Partial Open: requires line_open == true AND receipt_date exists
    if (row.line_open && row.receipt_date && row.receipt_date.trim() !== '') {
      exceptionTypes.push('PARTIAL_OPEN')
    }
    
    // 3. Zombie PO: requires line_open == true AND due_date < today - 60 days
    if (row.line_open && row.due_date && row.due_date < sixtyDaysAgo) {
      exceptionTypes.push('ZOMBIE_PO')
    }
    
    // 4. UoM Ambiguity: detect dimensional language in description (works for open AND closed lines)
    if (row.description && row.description.trim() !== '' && detectUoMAmbiguity(row.description)) {
      exceptionTypes.push('UOM_AMBIGUITY')
    }
    
    // Priority order: LATE_PO > PARTIAL_OPEN > ZOMBIE_PO > UOM_AMBIGUITY
    // Take the first exception type in priority order
    let exceptionType: ExceptionType = null
    if (exceptionTypes.includes('LATE_PO')) {
      exceptionType = 'LATE_PO'
    } else if (exceptionTypes.includes('PARTIAL_OPEN')) {
      exceptionType = 'PARTIAL_OPEN'
    } else if (exceptionTypes.includes('ZOMBIE_PO')) {
      exceptionType = 'ZOMBIE_PO'
    } else if (exceptionTypes.includes('UOM_AMBIGUITY')) {
      exceptionType = 'UOM_AMBIGUITY'
    }
    
    // Only add if it's an exception
    if (exceptionType !== null) {
      // Calculate days late for LATE_PO
      let daysLate: number | null = null
      if (exceptionType === 'LATE_PO' && row.due_date) {
        const diffTime = todayNormalized.getTime() - row.due_date.getTime()
        daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
      }
      
      // Build evidence array based on exception type
      const evidence: string[] = []
      
      if (exceptionType === 'LATE_PO') {
        if (row.due_date) {
          const dueDateStr = row.due_date.toLocaleDateString()
          evidence.push(`Due date was ${dueDateStr}`)
        }
        if (daysLate !== null && daysLate > 0) {
          evidence.push(`Currently ${daysLate} day${daysLate !== 1 ? 's' : ''} past due`)
        }
        if (!row.receipt_date || row.receipt_date.trim() === '') {
          evidence.push('No receipt date recorded')
        }
        evidence.push('Line is still open')
      } else if (exceptionType === 'PARTIAL_OPEN') {
        if (row.receipt_date && row.receipt_date.trim() !== '') {
          evidence.push(`Receipt date recorded: ${row.receipt_date}`)
        }
        evidence.push('Line is still open despite receipt')
        if (row.order_qty !== null) {
          evidence.push(`Order quantity: ${row.order_qty}`)
        }
      } else if (exceptionType === 'ZOMBIE_PO') {
        if (row.due_date) {
          const dueDateStr = row.due_date.toLocaleDateString()
          evidence.push(`Due date was ${dueDateStr}`)
        }
        if (row.due_date && row.due_date < sixtyDaysAgo) {
          const daysPast = Math.ceil((todayNormalized.getTime() - row.due_date.getTime()) / (1000 * 60 * 60 * 24))
          evidence.push(`Over ${daysPast} days past due date`)
        }
        evidence.push('Line has been open for extended period')
      } else if (exceptionType === 'UOM_AMBIGUITY') {
        evidence.push('Description contains dimensional language')
        if (row.description) {
          evidence.push(`Description: "${row.description.substring(0, 100)}${row.description.length > 100 ? '...' : ''}"`)
        }
      }
      
      exceptions.push({
        id,
        po_id: row.po_id,
        line_id: row.line_id,
        supplier_name: row.supplier_name,
        exception_type: exceptionType,
        due_date: row.due_date,
        days_late: daysLate,
        evidence,
        rowData: row
      })
    }
  }
  
  return exceptions
}

/**
 * Generates a deterministic draft email message for an exception
 */
export function generateDraftMessage(exception: Exception): { subject: string; body: string } {
  const { exception_type, po_id, line_id, supplier_name, days_late, rowData } = exception
  const supplier = supplier_name || 'Supplier Team'
  
  let subject = ''
  let body = ''
  
  if (exception_type === 'LATE_PO') {
    subject = `Urgent: Late Delivery - PO ${po_id} Line ${line_id}`
    const dueDateStr = rowData.due_date ? rowData.due_date.toLocaleDateString() : 'the agreed date'
    const daysLateText = days_late !== null && days_late > 0 ? ` (${days_late} day${days_late !== 1 ? 's' : ''} past due)` : ''
    
    body = `Dear ${supplier},

I hope this message finds you well. I am writing to follow up on Purchase Order ${po_id}, Line ${line_id}, which was scheduled for delivery on ${dueDateStr}${daysLateText}.

Please confirm the ship date and expedite if needed to minimize further delay.

Our records show that this line item is still open and no receipt has been recorded. I would appreciate an update on:

1. The current status and expected ship date
2. Whether expedited shipping is available
3. Any measures to prevent similar delays in the future

Please provide an update at your earliest convenience.

Thank you for your attention to this matter.

Best regards,
Procurement Team`
  } else if (exception_type === 'PARTIAL_OPEN') {
    subject = `PO ${po_id} Line ${line_id} — Remaining Quantity Confirmation`
    const orderQty = rowData.order_qty !== null ? rowData.order_qty : 'the ordered quantity'
    const receiptDate = rowData.receipt_date || 'recently'
    
    body = `Dear ${supplier},

I hope this message finds you well. I am writing to follow up on Purchase Order ${po_id}, Line ${line_id}.

Our records indicate that this line item has been partially received (receipt recorded on ${receiptDate}) but remains open in our system. The original order quantity was ${orderQty}.

Please confirm the remaining quantity and whether the line can be closed if complete, or provide an update on the delivery schedule for any remaining items.

I would like to confirm:

1. The remaining quantity and expected delivery date
2. Whether all items for this line will be fulfilled
3. If the line can be closed if delivery is complete

Please provide an update at your earliest convenience so we can maintain accurate records and plan accordingly.

Thank you for your attention to this matter.

Best regards,
Procurement Team`
  } else if (exception_type === 'ZOMBIE_PO') {
    subject = `Review Required: Stale Purchase Order - ${po_id}`
    const dueDateStr = rowData.due_date ? rowData.due_date.toLocaleDateString() : 'the original due date'
    
    body = `Dear ${supplier},

I hope this message finds you well. I am writing to follow up on Purchase Order ${po_id}, Line ${line_id}.

This purchase order line has been open for an extended period (originally due ${dueDateStr}) with no recent activity. Please help us determine whether to close the line or revalidate demand.

I would like to review the current status:

1. Is this order still active and expected to be fulfilled?
2. If yes, what is the current status and expected completion date?
3. If no, can we proceed to close this line item?

Please provide an update at your earliest convenience so we can maintain accurate records.

Thank you for your attention to this matter.

Best regards,
Procurement Team`
  } else if (exception_type === 'UOM_AMBIGUITY') {
    subject = `Unit of Measure Clarification Needed - PO ${po_id} Line ${line_id}`
    const description = rowData.description || 'this item'
    
    body = `Dear ${supplier},

I hope this message finds you well. I am writing to follow up on Purchase Order ${po_id}, Line ${line_id}.

Before releasing this order, I need to confirm the unit of measure basis for ${description}. The description contains dimensional information, and I want to ensure we have the correct unit basis (e.g., per piece vs per foot, per unit vs per square foot).

Please confirm:

1. The unit of measure basis for pricing and quantity
2. How the quantity should be interpreted (per piece, per foot, per square foot, etc.)
3. Any additional clarification needed to process this order correctly

Please provide clarification at your earliest convenience so we can proceed with confidence.

Thank you for your attention to this matter.

Best regards,
Procurement Team`
  } else {
    subject = `Follow-up Required - PO ${po_id} Line ${line_id}`
    body = `Dear ${supplier},

I hope this message finds you well. I am writing to follow up on Purchase Order ${po_id}, Line ${line_id}.

Please provide an update on the current status of this order.

Thank you for your attention to this matter.

Best regards,
Procurement Team`
  }
  
  return { subject, body }
}
