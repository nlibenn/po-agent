import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * POST /api/confirmations/records/upsert
 * Create or update a confirmation record
 * 
 * Body:
 * {
 *   po_id: string
 *   line_id: string
 *   supplier_order_number?: string
 *   confirmed_ship_date?: string (ISO string)
 *   confirmed_quantity?: number
 *   confirmed_uom?: string
 *   source_type: 'email_body' | 'sales_order_confirmation' | 'shipment_notice' | 'invoice' | 'manual'
 *   source_message_id?: string
 *   source_attachment_id?: string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.po_id || !body.line_id || !body.source_type) {
      return NextResponse.json(
        { error: 'Missing required fields: po_id, line_id, source_type' },
        { status: 400 }
      )
    }
    
    // Validate source_type
    const validSourceTypes = ['email_body', 'sales_order_confirmation', 'shipment_notice', 'invoice', 'manual']
    if (!validSourceTypes.includes(body.source_type)) {
      return NextResponse.json(
        { error: `Invalid source_type. Must be one of: ${validSourceTypes.join(', ')}` },
        { status: 400 }
      )
    }
    
    const {
      po_id,
      line_id,
      supplier_order_number = null,
      confirmed_ship_date = null,
      confirmed_quantity = null,
      confirmed_uom = null,
      source_type,
      source_message_id = null,
      source_attachment_id = null,
    } = body
    
    const db = getDb()
    const now = Date.now()
    
    // Upsert using INSERT OR REPLACE
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO confirmation_records (
        po_id,
        line_id,
        supplier_order_number,
        confirmed_ship_date,
        confirmed_quantity,
        confirmed_uom,
        source_type,
        source_message_id,
        source_attachment_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    stmt.run(
      po_id,
      line_id,
      supplier_order_number,
      confirmed_ship_date,
      confirmed_quantity,
      confirmed_uom,
      source_type,
      source_message_id,
      source_attachment_id,
      now
    )
    
    // Fetch and return the updated record
    const fetchStmt = db.prepare(`
      SELECT 
        po_id,
        line_id,
        supplier_order_number,
        confirmed_ship_date,
        confirmed_quantity,
        confirmed_uom,
        source_type,
        source_message_id,
        source_attachment_id,
        updated_at
      FROM confirmation_records
      WHERE po_id = ? AND line_id = ?
    `)
    
    const record = fetchStmt.get(po_id, line_id) as {
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
    
    return NextResponse.json({ ok: true, record })
  } catch (error) {
    console.error('Error upserting confirmation record:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upsert confirmation record' },
      { status: 500 }
    )
  }
}
