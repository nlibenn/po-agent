/**
 * PO (Purchase Order) processing module
 * Handles normalization of raw CSV rows and exception detection
 */

export type ExceptionType = 'LATE_PO' | 'PARTIAL_OPEN' | 'ZOMBIE_PO' | 'UOM_AMBIGUITY' | null

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
