/**
 * Adapter: SupplierChaseCase → EmailDraftContext
 *
 * Future migration anchor for converting legacy callers from
 * generateConfirmationEmailLegacy() to generateConfirmationEmailV2().
 *
 * A real implementation must:
 *   1. Query confirmation_extractions for the case to build `supplierConfirmed`
 *      (supplier_order_number, confirmed_delivery_date, confirmed_quantity)
 *   2. Read case.meta.po_line to build `poExpected`
 *      (delivery date, ordered quantity, unit price)
 *   3. Return a fully populated EmailDraftContext
 *
 * This is intentionally NOT automatic — the caller must decide which
 * extraction to use when multiple exist, and how to handle null meta fields.
 */

import type { SupplierChaseCase } from './types'
import type { EmailDraftContext } from './emailDraft'

export function buildEmailDraftContextFromCase(
  caseData: SupplierChaseCase
): EmailDraftContext {
  void caseData // suppress unused-parameter lint
  throw new Error(
    'Not implemented: buildEmailDraftContextFromCase requires explicit ' +
    'supplierConfirmed (from confirmation_extractions) and poExpected ' +
    '(from case.meta.po_line) semantics. See emailDraftContextAdapter.ts comments.'
  )
}
