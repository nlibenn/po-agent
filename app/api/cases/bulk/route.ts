import { NextRequest, NextResponse } from 'next/server'
import { getAllCases } from '@/src/lib/supplier-agent/store'
import { CaseState, CaseStatus } from '@/src/lib/supplier-agent/types'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const { poLines } = await request.json() // Array of "po_id-line_id" strings

    if (!Array.isArray(poLines)) {
      return NextResponse.json({ error: 'poLines must be an array of strings' }, { status: 400 })
    }

    const allCases = getAllCases()
    const byKey = new Map<string, { state: CaseState; status: CaseStatus }>()

    for (const c of allCases) {
      byKey.set(`${c.po_number}-${c.line_id}`, { state: c.state, status: c.status })
    }

    const result: Record<string, { state: CaseState; status: CaseStatus }> = {}

    for (const key of poLines) {
      const caseInfo = byKey.get(key)
      result[key] = caseInfo
        ? caseInfo
        : { state: CaseState.INBOX_LOOKUP, status: CaseStatus.STILL_AMBIGUOUS }
    }

    return NextResponse.json({ cases: result })
  } catch (error) {
    console.error('[BULK_CASES] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch cases' }, { status: 500 })
  }
}
