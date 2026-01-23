import { NextRequest, NextResponse } from 'next/server'
import { findCaseByPoLine, createCase, updateCase, getCase } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'
import { normalizeMissingFields } from '@/src/lib/supplier-agent/fieldMapping'

export const runtime = 'nodejs'

/**
 * Safely merge meta objects, preserving existing fields while updating specific paths
 */
function mergeCaseMeta(existingMeta: Record<string, any> | null | undefined, updates: Record<string, any>): Record<string, any> {
  const existing = existingMeta && typeof existingMeta === 'object' ? existingMeta : {}
  
  // Deep merge: for po_line, merge objects; otherwise copy top-level properties
  const merged = { ...existing }
  
  if (updates.po_line) {
    merged.po_line = {
      ...(existing.po_line && typeof existing.po_line === 'object' ? existing.po_line : {}),
      ...updates.po_line,
    }
  }
  
  // Merge other top-level meta fields
  Object.keys(updates).forEach(key => {
    if (key !== 'po_line') {
      merged[key] = updates[key]
    }
  })
  
  return merged
}

/**
 * Normalize orderQty from various input field names to a number
 */
function normalizeOrderQty(body: any): number | null {
  const rawQty = body.orderQty ?? body.orderedQty ?? body.qty ?? body.order_quantity ?? body.quantity ?? body.quantityOrdered ?? body.poLineQty ?? body.order_qty
  
  if (rawQty === undefined || rawQty === null) {
    return null
  }
  
  const parsed = typeof rawQty === 'number' ? rawQty : parseFloat(String(rawQty))
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  
  return null
}

/**
 * POST /api/confirmations/case/upsert
 * Find or create a case for a PO/line combination
 * Also supports updating supplier_email/supplier_domain via caseId
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Support updating by caseId (for supplier email resolution and orderQty updates)
    if (body.caseId) {
      const caseData = getCase(body.caseId)
      if (!caseData) {
        return NextResponse.json(
          { error: `Case ${body.caseId} not found` },
          { status: 404 }
        )
      }
      
      // Update supplier_email and/or supplier_domain if provided
      const updates: any = {}
      if (body.supplierEmail !== undefined) {
        updates.supplier_email = body.supplierEmail
        updates.supplier_domain = body.supplierEmail && body.supplierEmail.includes('@') 
          ? body.supplierEmail.split('@')[1] 
          : null
      }
      if (body.supplierDomain !== undefined) {
        updates.supplier_domain = body.supplierDomain
      }
      
      // Handle orderQty update (merge into meta.po_line.ordered_quantity)
      const orderQty = normalizeOrderQty(body)
      if (orderQty !== null) {
        const existingMeta = caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}
        const updatedMeta = mergeCaseMeta(existingMeta, {
          po_line: {
            ordered_quantity: orderQty,
            ...(existingMeta.po_line && typeof existingMeta.po_line === 'object' ? existingMeta.po_line : {}),
          },
        })
        updates.meta = updatedMeta
      } else {
        // Log warning if orderQty is missing (not provided)
        const hasAnyQtyField = body.orderQty !== undefined || body.orderedQty !== undefined || body.qty !== undefined || body.order_quantity !== undefined
        if (hasAnyQtyField) {
          // Warn if orderQty was provided but invalid
          console.warn('[CASE_UPDATE] Invalid orderQty value for case', { caseId: body.caseId, received: body.orderQty ?? body.orderedQty ?? body.qty ?? body.order_quantity })
        }
      }
      
      if (Object.keys(updates).length > 0) {
        updateCase(body.caseId, updates)
        const updatedCase = getCase(body.caseId)
        return NextResponse.json({
          caseId: updatedCase!.case_id,
          case: updatedCase,
        })
      }
      
      return NextResponse.json({
        caseId: caseData.case_id,
        case: caseData,
      })
    }
    
    // Validate required fields for create/upsert by PO/line
    if (!body.poNumber || !body.lineId) {
      return NextResponse.json(
        { error: 'Missing required fields: poNumber and lineId (or caseId for updates)' },
        { status: 400 }
      )
    }
    
    // For create, supplierEmail is required
    if (!body.supplierEmail) {
      return NextResponse.json(
        { error: 'Missing required field: supplierEmail (required for new cases)' },
        { status: 400 }
      )
    }
    
    const {
      poNumber,
      lineId,
      supplierName,
      supplierEmail,
      missingFields = ['supplier_reference', 'delivery_date', 'quantity'], // Use canonical keys
      uom,
    } = body
    
    // Find existing case
    let caseData = findCaseByPoLine(poNumber, lineId)
    
    // Normalize ordered quantity (works for both create and update)
    const orderedQuantity = normalizeOrderQty(body)
    
    if (!caseData) {
      const caseId = `${Date.now()}-${Math.random().toString(36).substring(7)}`
      const now = Date.now()
      
      // Build meta with po_line structure for parse-fields validation
      const meta: Record<string, any> = {
        po_line: {
          po_number: poNumber,
          line_id: lineId,
          ordered_quantity: orderedQuantity,
          uom: uom ?? null,
        },
      }
      
      // Log warning if ordered_quantity is missing
      if (orderedQuantity === null) {
        console.warn('[CASE_CREATE] Missing ordered_quantity for case', { caseId, poNumber, lineId })
      }
      
      createCase({
        case_id: caseId,
        po_number: poNumber,
        line_id: lineId,
        supplier_name: supplierName || null,
        supplier_email: supplierEmail,
        supplier_domain: supplierEmail.includes('@') ? supplierEmail.split('@')[1] : null,
        missing_fields: missingFields ? normalizeMissingFields(missingFields) : ['supplier_reference', 'delivery_date', 'quantity'],
        state: CaseState.INBOX_LOOKUP,
        status: CaseStatus.STILL_AMBIGUOUS,
        touch_count: 0,
        last_action_at: now,
        created_at: now,
        updated_at: now,
        meta,
      })
      
      caseData = findCaseByPoLine(poNumber, lineId)
    } else {
      // Update existing case if supplier_email, supplier_domain, or orderQty provided
      const updates: any = {}
      if (supplierEmail !== undefined) {
        updates.supplier_email = supplierEmail
        updates.supplier_domain = supplierEmail && supplierEmail.includes('@') 
          ? supplierEmail.split('@')[1] 
          : null
      }
      if (body.supplierDomain !== undefined) {
        updates.supplier_domain = body.supplierDomain
      }
      
      // Handle orderQty update (merge into meta.po_line.ordered_quantity)
      if (orderedQuantity !== null) {
        const existingMeta = caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}
        const updatedMeta = mergeCaseMeta(existingMeta, {
          po_line: {
            ordered_quantity: orderedQuantity,
            po_number: poNumber,
            line_id: lineId,
            ...(existingMeta.po_line && typeof existingMeta.po_line === 'object' ? existingMeta.po_line : {}),
            ...(uom !== undefined ? { uom } : {}),
          },
        })
        updates.meta = updatedMeta
      } else {
        // Log warning if orderQty is missing (not provided or invalid)
        const hasAnyQtyField = body.orderQty !== undefined || body.orderedQty !== undefined || body.qty !== undefined || body.order_quantity !== undefined
        if (!hasAnyQtyField) {
          console.warn('[CASE_UPDATE] Missing ordered_quantity for existing case', { caseId: caseData.case_id, poNumber, lineId })
        } else {
          // Warn if orderQty was provided but invalid
          console.warn('[CASE_UPDATE] Invalid orderQty value for case', { caseId: caseData.case_id, poNumber, lineId, received: body.orderQty ?? body.orderedQty ?? body.qty ?? body.order_quantity })
        }
      }
      
      if (Object.keys(updates).length > 0) {
        updateCase(caseData.case_id, updates)
        caseData = getCase(caseData.case_id)!
      }
    }
    
    if (!caseData) {
      return NextResponse.json(
        { error: 'Failed to create or retrieve case' },
        { status: 500 }
      )
    }
    
    return NextResponse.json({
      caseId: caseData.case_id,
      case: caseData,
    })
  } catch (error) {
    console.error('Error in case upsert API:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upsert case' },
      { status: 500 }
    )
  }
}
