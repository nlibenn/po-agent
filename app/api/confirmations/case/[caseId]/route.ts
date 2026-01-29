import { NextRequest, NextResponse } from 'next/server'
import { getCase, listAttachmentsForCase, listEvents, listMessages } from '@/src/lib/supplier-agent/store'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * GET /api/confirmations/case/[caseId]
 * Get case details including events and messages
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const { caseId } = params
    
    if (!caseId) {
      return NextResponse.json(
        { error: 'Missing caseId parameter' },
        { status: 400 }
      )
    }
    
    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json(
        { error: `Case ${caseId} not found` },
        { status: 404 }
      )
    }

    const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
    const parsed_best_fields_v1 = meta.parsed_best_fields_v1 ?? null

    // Debug log: Check if ordered_quantity exists in meta
    console.log('[CONFIRMATION_CASE_READ] ordered_quantity:', meta?.po_line?.ordered_quantity, 'caseId:', caseId, 'has_po_line:', !!meta?.po_line)

    const events = listEvents(caseId)
    // Get recent events (last 20, ordered by timestamp DESC)
    const allEvents = events.slice().sort((a, b) => b.timestamp - a.timestamp)
    const recent_events = allEvents.slice(0, 20)
    const messages = listMessages(caseId)
    const attachments = listAttachmentsForCase(caseId)

    const db = getDb()
    const parsed_best_fields =
      (db
        .prepare(
          `
          SELECT
            case_id,
            supplier_order_number,
            confirmed_delivery_date,
            confirmed_quantity,
            evidence_source,
            evidence_attachment_id,
            evidence_message_id,
            raw_excerpt,
            created_at,
            updated_at
          FROM confirmation_extractions
          WHERE case_id = ?
          LIMIT 1
        `
        )
        .get(caseId) as any) ?? null

    const confirmation_record =
      (db
        .prepare(
          `
          SELECT
            supplier_order_number,
            confirmed_ship_date,
            confirmed_quantity
          FROM confirmation_records
          WHERE po_id = ? AND line_id = ?
          LIMIT 1
        `
        )
        .get(caseData.po_number, caseData.line_id || '1') as
        | { supplier_order_number: string | null; confirmed_ship_date: string | null; confirmed_quantity: number | null }
        | undefined) ?? null
    
    return NextResponse.json({
      case: caseData,
      events,
      recent_events,
      messages,
      attachments,
      parsed_best_fields,
      parsed_best_fields_v1,
      confirmation_record,
    })
  } catch (error) {
    console.error('Error fetching case details:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch case details' },
      { status: 500 }
    )
  }
}
