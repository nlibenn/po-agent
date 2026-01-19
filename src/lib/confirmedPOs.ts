/**
 * Confirmed POs data structures and helpers
 * Buyer-facing view of fully confirmed purchase orders ready for ERP entry
 */

import { NormalizedPORow } from './po'

export interface ConfirmedPO {
  po_id: string
  line_id: string
  supplier_name: string
  supplier_order_number: string
  confirmed_ship_date: string
  confirmed_quantity: string
  confirmation_source: string // e.g., "Email", "PDF", "Manual"
}

export interface ConfirmationRecord {
  po_id: string
  line_id: string
  supplier_order_number: string | null
  confirmed_ship_date: string | null
  confirmed_quantity: number | null
  confirmed_uom: string | null
  source_type: string
  source_message_id: string | null
  source_attachment_id: string | null
  updated_at: number
}

/**
 * Check if a confirmation record meets the v1 hard gate for "confirmed" status
 * Requires: supplier_order_number && confirmed_ship_date && confirmed_quantity
 */
export function isConfirmed(record: ConfirmationRecord | null | undefined): boolean {
  if (!record) return false
  return !!(
    record.supplier_order_number &&
    record.confirmed_ship_date &&
    record.confirmed_quantity !== null &&
    record.confirmed_quantity !== undefined
  )
}

/**
 * Get source type display name
 */
export function getSourceDisplayName(sourceType: string): string {
  const map: Record<string, string> = {
    email_body: 'Email',
    sales_order_confirmation: 'Sales Order',
    shipment_notice: 'Shipment Notice',
    invoice: 'Invoice',
    manual: 'Manual',
  }
  return map[sourceType] || sourceType
}

/**
 * Helper to get value from rawRow with flexible field name matching
 */
function getRawRowValue(row: NormalizedPORow, fieldVariants: string[]): string | null {
  const rawRow = row.rawRow || {}
  for (const variant of fieldVariants) {
    // Try exact match
    if (rawRow[variant] !== undefined && rawRow[variant] !== null && rawRow[variant] !== '') {
      return String(rawRow[variant]).trim()
    }
    // Try case-insensitive match
    const lowerVariant = variant.toLowerCase()
    for (const key of Object.keys(rawRow)) {
      if (key.toLowerCase() === lowerVariant) {
        const value = rawRow[key]
        if (value !== undefined && value !== null && value !== '') {
          return String(value).trim()
        }
      }
    }
  }
  return null
}

/**
 * Get confirmed POs from normalized rows merged with confirmation records
 * A PO is confirmed if it has (from confirmation_records table):
 * - supplier_order_number (present and non-empty)
 * - confirmed_ship_date (present and non-empty)
 * - confirmed_quantity (present and non-empty)
 * 
 * @param rows - Normalized PO rows from workspace
 * @param confirmationRecords - Confirmation records from database (keyed by po_id+line_id)
 */
export function getConfirmedPOs(
  rows: NormalizedPORow[],
  confirmationRecords: Map<string, ConfirmationRecord> = new Map()
): ConfirmedPO[] {
  return rows
    .filter(row => {
      const key = `${row.po_id}-${row.line_id}`
      const record = confirmationRecords.get(key)
      return isConfirmed(record)
    })
    .map(row => {
      const key = `${row.po_id}-${row.line_id}`
      const record = confirmationRecords.get(key)!
      
      return {
        po_id: row.po_id,
        line_id: row.line_id,
        supplier_name: row.supplier_name,
        supplier_order_number: record.supplier_order_number || '',
        confirmed_ship_date: record.confirmed_ship_date || '',
        confirmed_quantity: String(record.confirmed_quantity || ''),
        confirmation_source: getSourceDisplayName(record.source_type),
      }
    })
}
