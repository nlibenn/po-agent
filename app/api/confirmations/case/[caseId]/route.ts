import { NextRequest, NextResponse } from 'next/server'
import { getCase, listEvents, listMessages } from '@/src/lib/supplier-agent/store'

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
    
    const events = listEvents(caseId)
    const messages = listMessages(caseId)
    
    return NextResponse.json({
      case: caseData,
      events,
      messages,
    })
  } catch (error) {
    console.error('Error fetching case details:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch case details' },
      { status: 500 }
    )
  }
}
