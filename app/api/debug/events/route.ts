import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'
import type { SupplierChaseEvent } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

/**
 * GET /api/debug/events
 * Returns recent events from the events table (dev-only)
 * 
 * Query params:
 * - caseId (optional): Filter by case ID
 * - limit (optional): Number of events to return (default: 50)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const caseId = searchParams.get('caseId')
    const limit = parseInt(searchParams.get('limit') || '50', 10)
    
    const db = getDb()
    
    let query = 'SELECT * FROM events'
    const params: any[] = []
    
    if (caseId) {
      query += ' WHERE case_id = ?'
      params.push(caseId)
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(limit)
    
    const stmt = db.prepare(query)
    const rows = stmt.all(...params) as any[]
    
    const events: SupplierChaseEvent[] = rows.map((row) => ({
      event_id: row.event_id,
      case_id: row.case_id,
      timestamp: row.timestamp,
      event_type: row.event_type as any,
      summary: row.summary,
      evidence_refs_json: row.evidence_refs_json ? JSON.parse(row.evidence_refs_json) : null,
      meta_json: row.meta_json ? JSON.parse(row.meta_json) : null,
    }))
    
    return NextResponse.json({
      events,
      count: events.length,
    })
  } catch (error) {
    console.error('Error fetching events:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch events' },
      { status: 500 }
    )
  }
}
