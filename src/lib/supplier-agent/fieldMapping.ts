/**
 * Canonical Field Key Mapping
 * 
 * Maps parsed field names to canonical keys used throughout the system.
 * Canonical keys:
 * - supplier_reference (was: supplier_order_number)
 * - delivery_date (was: confirmed_delivery_date, delivery_date, ship_date)
 * - quantity (was: confirmed_quantity, quantity)
 */

export const CANONICAL_FIELD_KEYS = {
  SUPPLIER_REFERENCE: 'supplier_reference',
  DELIVERY_DATE: 'delivery_date',
  QUANTITY: 'quantity',
} as const

export type CanonicalFieldKey = typeof CANONICAL_FIELD_KEYS[keyof typeof CANONICAL_FIELD_KEYS]

/**
 * Map parser field names to canonical keys
 */
export const PARSER_TO_CANONICAL: Record<string, CanonicalFieldKey> = {
  supplier_order_number: CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE,
  supplier_reference: CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE,
  confirmed_delivery_date: CANONICAL_FIELD_KEYS.DELIVERY_DATE,
  confirmed_ship_date: CANONICAL_FIELD_KEYS.DELIVERY_DATE,
  delivery_date: CANONICAL_FIELD_KEYS.DELIVERY_DATE,
  ship_date: CANONICAL_FIELD_KEYS.DELIVERY_DATE,
  confirmed_quantity: CANONICAL_FIELD_KEYS.QUANTITY,
  quantity: CANONICAL_FIELD_KEYS.QUANTITY,
}

/**
 * Normalize a field name to its canonical key
 */
export function toCanonicalFieldKey(fieldName: string): CanonicalFieldKey | null {
  const canonical = PARSER_TO_CANONICAL[fieldName]
  if (canonical) return canonical
  
  // If already canonical, return as-is
  if (Object.values(CANONICAL_FIELD_KEYS).includes(fieldName as CanonicalFieldKey)) {
    return fieldName as CanonicalFieldKey
  }
  
  return null
}

/**
 * Normalize missing_fields array to canonical keys
 */
export function normalizeMissingFields(fields: string[]): string[] {
  const normalized = new Set<string>()
  
  for (const field of fields) {
    const canonical = toCanonicalFieldKey(field)
    if (canonical) {
      normalized.add(canonical)
    }
  }
  
  return Array.from(normalized)
}

/**
 * Compute missing_fields from extracted fields
 * Returns array of canonical field keys that are missing
 */
export function computeMissingFields(extracted: {
  supplier_order_number?: { value: string | null }
  confirmed_delivery_date?: { value: string | null }
  confirmed_quantity?: { value: number | null }
}): string[] {
  const missing: string[] = []
  
  // Check if supplier_reference exists (non-null, non-empty string)
  const hasSupplierRef = !!(
    extracted.supplier_order_number?.value &&
    extracted.supplier_order_number.value.trim().length > 0
  )
  
  // Check if delivery_date exists (non-null, non-empty string)
  const hasDeliveryDate = !!(
    extracted.confirmed_delivery_date?.value &&
    extracted.confirmed_delivery_date.value.trim().length > 0
  )
  
  // Check if quantity exists (non-null number)
  const hasQuantity = extracted.confirmed_quantity?.value !== null && 
                      extracted.confirmed_quantity?.value !== undefined &&
                      Number.isFinite(extracted.confirmed_quantity.value)
  
  if (!hasSupplierRef) {
    missing.push(CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE)
  }
  if (!hasDeliveryDate) {
    missing.push(CANONICAL_FIELD_KEYS.DELIVERY_DATE)
  }
  if (!hasQuantity) {
    missing.push(CANONICAL_FIELD_KEYS.QUANTITY)
  }
  
  return missing
}

/**
 * Map extracted fields to canonical format for apply-updates
 */
export function mapExtractedToCanonical(extracted: {
  supplier_order_number?: { value: string | null; confidence?: number }
  confirmed_delivery_date?: { value: string | null; confidence?: number }
  confirmed_quantity?: { value: number | null; confidence?: number }
}): Record<string, { value: any; confidence?: number }> {
  const canonical: Record<string, { value: any; confidence?: number }> = {}
  
  if (extracted.supplier_order_number?.value) {
    canonical[CANONICAL_FIELD_KEYS.SUPPLIER_REFERENCE] = {
      value: extracted.supplier_order_number.value,
      confidence: extracted.supplier_order_number.confidence,
    }
  }
  
  if (extracted.confirmed_delivery_date?.value) {
    canonical[CANONICAL_FIELD_KEYS.DELIVERY_DATE] = {
      value: extracted.confirmed_delivery_date.value,
      confidence: extracted.confirmed_delivery_date.confidence,
    }
  }
  
  if (extracted.confirmed_quantity?.value !== null && extracted.confirmed_quantity?.value !== undefined) {
    canonical[CANONICAL_FIELD_KEYS.QUANTITY] = {
      value: extracted.confirmed_quantity.value,
      confidence: extracted.confirmed_quantity.confidence,
    }
  }
  
  return canonical
}
