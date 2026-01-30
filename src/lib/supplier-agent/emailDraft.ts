/**
 * Email Draft Generation (Client-Safe)
 *
 * Pure functions for generating email text following EMAIL_DRAFTING_RULES.md
 * No server dependencies. Can be used in client components.
 */

export interface FieldValue {
  value: string | number | null
  source?: 'parsed' | 'manual' | 'po' | 'inferred'
}

export interface EmailDraftContext {
  poNumber: string
  lineId?: string
  supplierName?: string | null
  supplierEmail: string

  // What the supplier confirmed (or didn't)
  supplierConfirmed: {
    supplierOrderNumber?: FieldValue
    deliveryDate?: FieldValue
    shipDate?: FieldValue
    quantity?: FieldValue
  }

  // What's on our PO (or not available)
  poExpected: {
    deliveryDate?: FieldValue
    quantity?: FieldValue
    unitPrice?: FieldValue
  }
}

export interface ConfirmationEmail {
  subject: string
  bodyText: string
}

interface FieldComparison {
  field: string
  supplierValue: string | number | null
  poValue: string | number | null
  isMissing: boolean
  isMismatch: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 Email Generation — follows EMAIL_DRAFTING_RULES.md
//
// Callers MUST construct an EmailDraftContext with explicit supplierConfirmed
// and poExpected fields. These cannot be inferred automatically because the
// data comes from different sources (PDF parsing vs PO record) and the caller
// is responsible for assembling them from case data.
//
// To migrate a legacy caller:
//   1. Build supplierConfirmed from parsed confirmation_extractions
//   2. Build poExpected from case.meta.po_line
//   3. Call generateConfirmationEmailV2({ ...fields, supplierConfirmed, poExpected })
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile-time guardrail: prevents accidentally passing ConfirmationEmailParams
 * (legacy shape with `missingFields`) into generateConfirmationEmailV2.
 */
type RejectLegacyParams<T> = T extends { missingFields: unknown } ? never : T

/**
 * Generate confirmation email following EMAIL_DRAFTING_RULES.md
 *
 * Subject format: PO {po_number} – {specific issue}
 * Body: Factual opening + side-by-side comparison + single action request
 *
 * Returns null if no missing/mismatched fields (nothing to ask for)
 */
export function generateConfirmationEmailV2<T extends EmailDraftContext>(
  context: RejectLegacyParams<T>
): ConfirmationEmail | null {
  const { poNumber, lineId, supplierName, supplierConfirmed, poExpected } = context

  // Compute field comparisons
  const comparisons = computeFieldComparisons(supplierConfirmed, poExpected)

  // Filter to only missing or mismatched fields
  const issues = comparisons.filter(c => c.isMissing || c.isMismatch)

  // If no issues, don't generate an email
  if (issues.length === 0) {
    return null
  }

  // Determine primary issue for subject line (priority order)
  const primaryIssue = determinePrimaryIssue(issues)

  // Generate subject
  const subject = generateSubject(poNumber, primaryIssue)

  // Generate body
  const bodyText = generateBody({
    supplierName,
    poNumber,
    lineId,
    primaryIssue,
    issues,
  })

  return { subject, bodyText }
}

/**
 * Compute field-by-field comparisons between supplier confirmation and PO
 */
function computeFieldComparisons(
  supplierConfirmed: EmailDraftContext['supplierConfirmed'],
  poExpected: EmailDraftContext['poExpected']
): FieldComparison[] {
  const comparisons: FieldComparison[] = []

  // Supplier Order Number (always check)
  const soSupplier = supplierConfirmed.supplierOrderNumber?.value ?? null
  comparisons.push({
    field: 'Supplier Order Number',
    supplierValue: soSupplier,
    poValue: null, // PO doesn't have supplier's order number
    isMissing: soSupplier === null,
    isMismatch: false,
  })

  // Date group: delivery_date and ship_date are distinct but having either
  // is sufficient. Never ask for both. Show whichever the supplier provided.
  const deliveryVal = supplierConfirmed.deliveryDate?.value ?? null
  const shipVal = supplierConfirmed.shipDate?.value ?? null
  const datePO = poExpected.deliveryDate?.value ?? null
  const hasAnyDate = deliveryVal !== null || shipVal !== null

  if (hasAnyDate) {
    // Supplier provided at least one date — show the one they gave
    const label = deliveryVal !== null ? 'Delivery Date' : 'Ship Date'
    const supplierDate = deliveryVal ?? shipVal
    comparisons.push({
      field: label,
      supplierValue: supplierDate,
      poValue: datePO,
      isMissing: false,
      isMismatch: supplierDate !== null && datePO !== null && supplierDate !== datePO,
    })
  } else {
    // Neither date provided — mark as missing
    comparisons.push({
      field: 'Delivery/Ship Date',
      supplierValue: null,
      poValue: datePO,
      isMissing: true,
      isMismatch: false,
    })
  }

  // Quantity
  const qtySupplier = supplierConfirmed.quantity?.value ?? null
  const qtyPO = poExpected.quantity?.value ?? null
  comparisons.push({
    field: 'Quantity',
    supplierValue: qtySupplier,
    poValue: qtyPO,
    isMissing: qtySupplier === null,
    isMismatch: qtySupplier !== null && qtyPO !== null && qtySupplier !== qtyPO,
  })

  return comparisons
}

/**
 * Determine the primary issue for subject line (priority order)
 */
function determinePrimaryIssue(issues: FieldComparison[]): FieldComparison {
  // Priority order (most critical first):
  // 1. Quantity mismatch
  // 2. Date mismatch
  // 3. Missing supplier reference
  // 4. Missing delivery date
  // 5. Missing quantity

  const qtyMismatch = issues.find(i => i.field === 'Quantity' && i.isMismatch)
  if (qtyMismatch) return qtyMismatch

  const dateMismatch = issues.find(i => (i.field === 'Delivery Date' || i.field === 'Ship Date') && i.isMismatch)
  if (dateMismatch) return dateMismatch

  const missingSO = issues.find(i => i.field === 'Supplier Order Number' && i.isMissing)
  if (missingSO) return missingSO

  const missingDate = issues.find(i => (i.field === 'Delivery Date' || i.field === 'Delivery/Ship Date') && i.isMissing)
  if (missingDate) return missingDate

  const missingQty = issues.find(i => i.field === 'Quantity' && i.isMissing)
  if (missingQty) return missingQty

  // Fallback to first issue
  return issues[0]
}

/**
 * Generate subject line following format: PO {po_number} – {specific issue}
 */
function generateSubject(poNumber: string, primaryIssue: FieldComparison): string {
  if (primaryIssue.isMismatch) {
    // Mismatch: "PO 907155 – Quantity mismatch"
    return `PO ${poNumber} – ${primaryIssue.field} mismatch`
  } else {
    // Missing: "PO 907155 – Missing delivery date"
    const fieldName = primaryIssue.field.toLowerCase()
    return `PO ${poNumber} – Missing ${fieldName}`
  }
}

/**
 * Generate email body with factual opening, side-by-side comparison, and action request
 */
function generateBody(params: {
  supplierName?: string | null
  poNumber: string
  lineId?: string
  primaryIssue: FieldComparison
  issues: FieldComparison[]
}): string {
  const { supplierName, poNumber, lineId, primaryIssue, issues } = params

  // Greeting
  const greeting = supplierName ? `Hi ${supplierName},` : `Hi,`

  // Opening sentence (factual statement of why email is being sent)
  const opening = generateOpening(primaryIssue)

  // Side-by-side comparison
  const comparison = generateComparison(issues)

  // Action request
  const actionRequest = generateActionRequest(issues)

  // Assemble body
  let body = `${greeting}\n\n`
  body += `${opening}\n\n`
  body += comparison
  body += `\n`
  body += `${actionRequest}\n\n`
  body += `Thank you,\n`
  body += `Procurement Team`

  return body
}

/**
 * Generate factual opening sentence based on primary issue
 */
function generateOpening(primaryIssue: FieldComparison): string {
  if (primaryIssue.isMismatch) {
    if (primaryIssue.field === 'Quantity') {
      return 'Your confirmed quantity does not match our purchase order.'
    } else if (primaryIssue.field === 'Delivery Date') {
      return 'Your confirmed delivery date differs from our expected date.'
    } else {
      return `Your confirmed ${primaryIssue.field.toLowerCase()} does not match our purchase order.`
    }
  } else {
    // Missing field
    if (primaryIssue.field === 'Supplier Order Number') {
      return `We are missing your supplier order number for this PO.`
    } else if (primaryIssue.field === 'Delivery Date' || primaryIssue.field === 'Delivery/Ship Date') {
      return 'We received your order acknowledgement but need the delivery or ship date to complete our records.'
    } else if (primaryIssue.field === 'Quantity') {
      return 'We received your order acknowledgement but need the quantity to complete our records.'
    } else {
      return `We are missing the ${primaryIssue.field.toLowerCase()} for this PO.`
    }
  }
}

/**
 * Generate side-by-side comparison showing only missing/mismatched fields
 */
function generateComparison(issues: FieldComparison[]): string {
  let comparison = 'Confirmed by Supplier:\n'

  // Supplier side
  for (const issue of issues) {
    const value = issue.supplierValue !== null ? formatValue(issue.supplierValue) : 'Not provided'
    comparison += `- ${issue.field}: ${value}\n`
  }

  comparison += '\n'
  comparison += 'On Our PO:\n'

  // PO side
  for (const issue of issues) {
    // Special case: Supplier Order Number is never on our PO
    if (issue.field === 'Supplier Order Number') {
      continue // Skip from PO side
    }

    const value = issue.poValue !== null ? formatValue(issue.poValue) : 'Not on file'

    // Map field names to PO terminology
    let poFieldName = issue.field
    if (issue.field === 'Delivery Date' || issue.field === 'Ship Date' || issue.field === 'Delivery/Ship Date') {
      poFieldName = 'Expected Delivery Date'
    } else if (issue.field === 'Quantity') {
      poFieldName = 'Ordered Quantity'
    }

    comparison += `- ${poFieldName}: ${value}\n`
  }

  return comparison
}

/**
 * Format field value for display
 */
function formatValue(value: string | number): string {
  if (typeof value === 'number') {
    return `${value} units`
  }
  return String(value)
}

/**
 * Generate single explicit action request
 */
function generateActionRequest(issues: FieldComparison[]): string {
  // Determine what to ask for based on issues
  const missingFields = issues.filter(i => i.isMissing).map(i => i.field.toLowerCase())
  const mismatchedFields = issues.filter(i => i.isMismatch).map(i => i.field.toLowerCase())

  if (mismatchedFields.length > 0 && missingFields.length > 0) {
    // Both mismatches and missing
    const mismatchList = mismatchedFields.join(' and ')
    const missingList = missingFields.join(' and ')
    return `Please confirm the correct ${mismatchList} and provide the ${missingList}.`
  } else if (mismatchedFields.length > 0) {
    // Only mismatches
    const fieldList = mismatchedFields.join(' and ')
    return `Please confirm the correct ${fieldList}.`
  } else if (missingFields.length > 0) {
    // Only missing
    const fieldList = missingFields.join(' and ')
    return `Please provide the ${fieldList}.`
  } else {
    // Fallback (should not reach here)
    return 'Please provide the missing information.'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Email Generation — DEPRECATED
//
// Uses a flat missingFields: string[] interface. Does NOT follow
// EMAIL_DRAFTING_RULES.md. Callers should migrate to V2 when ready.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy interface for backward compatibility (DEPRECATED)
 * Use generateConfirmationEmailV2() with EmailDraftContext instead
 */
export interface ConfirmationEmailParams {
  poNumber: string
  lineId: string
  supplierName?: string | null
  supplierEmail: string
  missingFields: string[]
  context?: {
    materialDesc?: string
    qty?: string | number
    unitPrice?: string | number
    currency?: string
  }
}

/**
 * @deprecated Use generateConfirmationEmailV2() with EmailDraftContext
 *
 * This function is kept for backward compatibility but does NOT follow
 * EMAIL_DRAFTING_RULES.md. It will be removed in a future version.
 */
export function generateConfirmationEmailLegacy(params: ConfirmationEmailParams): ConfirmationEmail {
  console.warn('[emailDraft] generateConfirmationEmailLegacy is deprecated. Use generateConfirmationEmailV2() with EmailDraftContext instead.')

  // Convert legacy params to new format (best effort)
  const context: EmailDraftContext = {
    poNumber: params.poNumber,
    lineId: params.lineId,
    supplierName: params.supplierName,
    supplierEmail: params.supplierEmail,
    supplierConfirmed: {
      // Assume all fields are missing since legacy API doesn't distinguish
      supplierOrderNumber: { value: null },
      deliveryDate: { value: null },
      quantity: { value: null },
    },
    poExpected: {
      deliveryDate: { value: null },
      quantity: params.context?.qty ? { value: params.context.qty } : { value: null },
    },
  }

  const result = generateConfirmationEmailV2(context)

  // If new API returns null (nothing to ask), fall back to generic message
  if (!result) {
    return {
      subject: `PO ${params.poNumber} – Confirmation needed`,
      bodyText: `Hi,\n\nWe need confirmation for Purchase Order ${params.poNumber}.\n\nThank you,\nProcurement Team`,
    }
  }

  return result
}
