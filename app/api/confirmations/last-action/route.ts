import { NextRequest, NextResponse } from 'next/server'
import { findCaseByPoLine, listEvents } from '@/src/lib/supplier-agent/store'
import { getLastAction, formatLastAction } from '@/src/lib/supplier-agent/lastAction'

export const runtime = 'nodejs'

/**
 * GET /api/confirmations/last-action?poNumber=...&lineId=...
 * Get the last action for a PO/line
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const poNumber = searchParams.get('poNumber')
    const lineId = searchParams.get('lineId')

    if (!poNumber || !lineId) {
      return NextResponse.json(
        { error: 'Missing required parameters: poNumber, lineId' },
        { status: 400 }
      )
    }

    // Find case by PO/line
    const caseData = findCaseByPoLine(poNumber, lineId)
    if (!caseData) {
      return NextResponse.json({
        lastAction: null,
        formatted: '—',
      })
    }

    // Get events for this case
    const events = listEvents(caseData.case_id)
    
    // Compute last action
    const lastAction = getLastAction(events, poNumber)
    const formatted = formatLastAction(lastAction)

    return NextResponse.json({
      lastAction,
      formatted,
    })
  } catch (error) {
    console.error('Error fetching last action:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch last action' },
      { status: 500 }
    )
  }
}
