import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

interface BulkFetchRequest {
  po_ids?: string[]
  keys?: Array<{ po_id: string; line_id: string }>
}

/**
 * POST /api/confirmations/records/bulk
 * Fetch confirmation records in bulk (supports large datasets)
 * 
 * Body:
 * {
 *   po_ids?: string[]  // Fetch all records for these PO IDs
 *   keys?: Array<{ po_id: string, line_id: string }>  // Fetch exact (po_id, line_id) pairs
 * }
 * 
 * Returns:
 * {
 *   records: Array<ConfirmationRecord>
 *   recordsMap?: Record<string, ConfirmationRecord>  // Keyed by "po_id-line_id" for easy merging
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body: BulkFetchRequest = await request.json()
    
    // Validate that at least one parameter is provided
    if (!body.po_ids && !body.keys) {
      return NextResponse.json(
        { error: 'Missing required field: either po_ids or keys must be provided' },
        { status: 400 }
      )
    }

    // Validate that only one parameter is provided (not both)
    if (body.po_ids && body.keys) {
      return NextResponse.json(
        { error: 'Cannot specify both po_ids and keys. Use one or the other.' },
        { status: 400 }
      )
    }

    const db = getDb()
    let records: Array<{
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
    }> = []

    let requestedCount = 0

    if (body.keys && body.keys.length > 0) {
      // Fetch exact (po_id, line_id) pairs
      requestedCount = body.keys.length
      
      // Build query with placeholders for exact matches
      // SQLite doesn't support IN with tuples, so we use OR conditions
      const conditions: string[] = []
      const params: string[] = []
      
      for (const key of body.keys) {
        conditions.push('(po_id = ? AND line_id = ?)')
        params.push(key.po_id, key.line_id)
      }
      
      const whereClause = conditions.join(' OR ')
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
        WHERE ${whereClause}
      `)
      
      records = stmt.all(...params) as typeof records
    } else if (body.po_ids && body.po_ids.length > 0) {
      // Fetch all records for given PO IDs
      requestedCount = body.po_ids.length
      
      const placeholders = body.po_ids.map(() => '?').join(',')
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
      
      records = stmt.all(...body.po_ids) as typeof records
    }

    // Build records map for easy UI merging (keyed by "po_id-line_id")
    const recordsMap: Record<string, typeof records[0]> = {}
    records.forEach(record => {
      const key = `${record.po_id}-${record.line_id}`
      recordsMap[key] = record
    })

    // Log fetch statistics
    console.log(`[CONFIRMATION_RECORDS] bulk fetch: ${requestedCount} requested, ${records.length} returned`)

    return NextResponse.json({
      records,
      recordsMap,
    })
  } catch (error) {
    console.error('Error in bulk confirmation records fetch:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch confirmation records' },
      { status: 500 }
    )
  }
}
