import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * GET /api/confirmations/records
 * Fetch confirmation records for given PO IDs
 * 
 * Query params:
 * - poIds: comma-separated list of PO IDs (e.g., "PO-001,PO-002")
 * 
 * Returns array of confirmation records
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const poIdsParam = searchParams.get('poIds')
    
    if (!poIdsParam) {
      return NextResponse.json(
        { error: 'Missing required parameter: poIds' },
        { status: 400 }
      )
    }
    
    // Parse comma-separated PO IDs
    const poIds = poIdsParam.split(',').map(id => id.trim()).filter(Boolean)
    
    if (poIds.length === 0) {
      return NextResponse.json([])
    }
    
    const db = getDb()
    
    // Build query with placeholders
    const placeholders = poIds.map(() => '?').join(',')
    const stmt = db.prepare(`
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
      WHERE po_id IN (${placeholders})
    `)
    
    const records = stmt.all(...poIds) as Array<{
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
    }>
    
    return NextResponse.json(records)
  } catch (error) {
    console.error('Error fetching confirmation records:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch confirmation records' },
      { status: 500 }
    )
  }
}
