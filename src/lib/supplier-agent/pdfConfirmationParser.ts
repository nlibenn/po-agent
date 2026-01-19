/**
 * PDF Confirmation Parser
 * 
 * Extracts confirmation fields from PDF text using regex patterns.
 * 
 * SERVER-ONLY: This module uses Node.js APIs.
 * Do not import this in client components.
 */

import 'server-only'

export interface ParsedConfirmation {
  customer_po_number: string | null
  supplier_order_number: string | null
  order_date: string | null
  confirmed_ship_date: string | null
  confirmed_quantity: number | null
  confirmed_uom: string | null
  evidence: { matched: string[]; score: number }
}

export interface ParseOptions {
  poNumber?: string
}

/**
 * Normalize date string to ISO YYYY-MM-DD format
 */
function normalizeDate(dateStr: string): string | null {
  try {
    // Try MM/DD/YYYY or MM/DD/YY
    const mmddyyyyMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (mmddyyyyMatch) {
      const [, month, day, year] = mmddyyyyMatch
      const fullYear = year.length === 2 ? `20${year}` : year
      const monthPadded = month.padStart(2, '0')
      const dayPadded = day.padStart(2, '0')
      return `${fullYear}-${monthPadded}-${dayPadded}`
    }
    
    // Try YYYY-MM-DD (already ISO)
    const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoMatch) {
      return dateStr
    }
    
    // Try other common formats
    const date = new Date(dateStr)
    if (!isNaN(date.getTime())) {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
  } catch (e) {
    // Invalid date
  }
  
  return null
}

/**
 * Extract customer PO number from text
 */
function extractCustomerPONumber(text: string): string | null {
  // Pattern: "Customer PO Number 907255" or "Customer PO # 907255"
  const patterns = [
    /Customer\s+PO\s+(No\.|#|Number)?\s*[:\-]?\s*([A-Z0-9\-]+)/i,
  ]
  
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const candidate = (match[2] || match[1]).trim()
      if (candidate) {
        return candidate
      }
    }
  }
  
  return null
}

/**
 * Extract order date from text
 */
function extractOrderDate(text: string): string | null {
  // Pattern: "Order Date 11/03/2025" or "Order Date: 11/03/2025"
  const datePatterns = [
    /Order\s+Date\s*[:\-]?\s*([0-9\/\-]+)/i,
  ]
  
  for (const pattern of datePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const normalized = normalizeDate(match[1].trim())
      if (normalized) {
        return normalized
      }
    }
  }
  
  return null
}

/**
 * Extract supplier order number from text
 */
function extractSupplierOrderNumber(text: string, poNumber?: string): string | null {
  // Patterns in order of preference (Our Order Number > Sales Order > SO > Order No)
  const patterns = [
    // Our Order Number (highest priority)
    /Our\s+Order\s+(No\.|#|Number)?\s*[:\-]?\s*([A-Z0-9\-]+)/i,
    // Sales Order
    /Sales\s*Order\s*(No\.|#|Number)?\s*[:\-]?\s*([A-Z0-9\-]+)/i,
    // SO
    /\bSO\b\s*[:\-]?\s*([A-Z0-9\-]+)/i,
    // Order No / Order Number
    /Order\s*(No\.|#|Number)?\s*[:\-]?\s*([A-Z0-9\-]+)/i,
  ]
  
  let bestMatch: string | null = null
  let bestPriority = Infinity
  
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i])
    if (match) {
      // Pattern 0 and 2 have 2 capture groups, pattern 1 has 1
      const candidate = (match[2] || match[1]).trim()
      // Filter out common false positives (words that aren't order numbers)
      const falsePositives = ['for', 'the', 'and', 'or', 'not', 'all', 'any']
      if (falsePositives.includes(candidate.toLowerCase())) {
        continue
      }
      // Prefer matches by label strength (Sales Order > SO > Order No)
      if (!bestMatch || i < bestPriority) {
        bestMatch = candidate
        bestPriority = i
      }
    }
  }
  
  return bestMatch
}

/**
 * Extract ship/delivery date from text
 */
function extractShipDate(text: string): string | null {
  // Look for labels in order of preference
  // Note: "Confirmed Ship Date" may be on same line with other text, so we need flexible matching
  const datePatterns = [
    // Confirmed Ship Date (highest priority) - handle text before/after on same line
    /Confirmed\s+Ship\s+Date\s*[:\-]?\s*([0-9\/\-]+)/i,
    /Ship\s+Date\s*[:\-]?\s*([0-9\/\-]+)/i,
    /Promised\s+Ship\s+Date\s*[:\-]?\s*([0-9\/\-]+)/i,
    /Requested\s+Ship\s+Date\s*[:\-]?\s*([0-9\/\-]+)/i,
    /Delivery\s+Date\s*[:\-]?\s*([0-9\/\-]+)/i,
  ]
  
  for (const pattern of datePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const normalized = normalizeDate(match[1].trim())
      if (normalized) {
        return normalized
      }
    }
  }
  
  return null
}

/**
 * Extract quantity and UOM from text
 */
function extractQuantityAndUOM(text: string, poNumber?: string): { quantity: number | null; uom: string | null } {
  // Pattern 1: "Qty" or "Quantity" with optional UOM
  const qtyPattern1 = /(Qty|Quantity)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Z]{1,5})?/i
  const match1 = text.match(qtyPattern1)
  if (match1 && match1[2]) {
    const quantity = parseFloat(match1[2])
    const uom = match1[3] ? match1[3].toUpperCase() : null
    if (!isNaN(quantity)) {
      return { quantity, uom }
    }
  }
  
  // Pattern 2: Line-like patterns with UOM
  const linePattern = /([0-9]+(?:\.[0-9]+)?)\s*(EA|PCS|PC|UNIT|UN|EACH)\b/i
  const allMatches: Array<{ qty: number; uom: string | null }> = []
  let match
  const globalPattern = new RegExp(linePattern.source, 'gi')
  while ((match = globalPattern.exec(text)) !== null) {
    const qty = parseFloat(match[1])
    const uom = match[2] ? match[2].toUpperCase() : null
    if (!isNaN(qty) && qty > 0) {
      allMatches.push({ qty, uom })
    }
  }
  
  if (allMatches.length > 0) {
    // Prefer quantities with UOM
    const withUOM = allMatches.filter(m => m.uom)
    if (withUOM.length > 0) {
      // Return first one with UOM
      return { quantity: withUOM[0].qty, uom: withUOM[0].uom }
    }
    // Otherwise return largest quantity
    const largest = allMatches.reduce((max, m) => m.qty > max.qty ? m : max)
    return { quantity: largest.qty, uom: null }
  }
  
  return { quantity: null, uom: null }
}

/**
 * Parse confirmation fields from PDF text
 */
export function parseConfirmationFromText(
  text: string,
  opts?: ParseOptions
): ParsedConfirmation {
  const matched: string[] = []
  
  // Extract customer PO number
  const customer_po_number = extractCustomerPONumber(text)
  if (customer_po_number) {
    matched.push('customer_po_number')
  }
  
  // Extract supplier order number
  const supplier_order_number = extractSupplierOrderNumber(text, opts?.poNumber)
  if (supplier_order_number) {
    matched.push('supplier_order_number')
  }
  
  // Extract order date
  const order_date = extractOrderDate(text)
  if (order_date) {
    matched.push('order_date')
  }
  
  // Extract ship date
  const confirmed_ship_date = extractShipDate(text)
  if (confirmed_ship_date) {
    matched.push('confirmed_ship_date')
  }
  
  // Extract quantity and UOM
  const { quantity, uom } = extractQuantityAndUOM(text, opts?.poNumber)
  if (quantity !== null) {
    matched.push('confirmed_quantity')
  }
  if (uom) {
    matched.push('confirmed_uom')
  }
  
  // Calculate score: number of non-null fields
  const score = [
    customer_po_number,
    supplier_order_number,
    order_date,
    confirmed_ship_date,
    quantity,
  ].filter(f => f !== null).length
  
  return {
    customer_po_number,
    supplier_order_number,
    order_date,
    confirmed_ship_date,
    confirmed_quantity: quantity,
    confirmed_uom: uom,
    evidence: { matched, score },
  }
}
