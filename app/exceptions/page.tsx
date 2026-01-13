'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { 
  computeTriageForAll, 
  computeTriage, 
  deriveExceptions,
  Exception
} from '../../src/lib/po'
import { 
  ExceptionInboxItem,
  exceptionToInboxItem,
  filterActiveExceptions,
  sortExceptionsByPriority
} from '../../src/lib/exceptionInbox'
import { ExceptionInboxRow } from '@/components/ExceptionInboxRow'
import { ExceptionSidePanel } from '@/components/ExceptionSidePanel'
import { useWorkspace } from '@/components/WorkspaceProvider'

export default function ExceptionsPage() {
  const { normalizedRows } = useWorkspace()
  const [inboxItems, setInboxItems] = useState<ExceptionInboxItem[]>([])
  const [selectedException, setSelectedException] = useState<ExceptionInboxItem | null>(null)

  useEffect(() => {
    if (!normalizedRows || normalizedRows.length === 0) {
      setInboxItems([])
      return
    }

    try {
      const today = new Date()
      
      // Compute triage for all rows
      computeTriageForAll(normalizedRows, today)
        
      // Derive exceptions
      const exceptions = deriveExceptions(normalizedRows, today)
      
      // Convert exceptions to inbox items
      const items: ExceptionInboxItem[] = exceptions.map(exception => {
        const matchingRow = normalizedRows.find(row => 
          row.po_id === exception.po_id && row.line_id === exception.line_id
        )
        
        if (!matchingRow) {
          // This shouldn't happen, but handle gracefully
          const triage = computeTriage(exception.rowData, today, normalizedRows)
          return exceptionToInboxItem(exception, triage, exception.rowData)
        }
        
        const triage = computeTriage(matchingRow, today, normalizedRows)
        return exceptionToInboxItem(exception, triage, matchingRow)
      })

      // Filter and sort
      const activeItems = filterActiveExceptions(items)
      const sortedItems = sortExceptionsByPriority(activeItems)
      
      setInboxItems(sortedItems)
    } catch (e) {
      console.error('Error processing data:', e)
      setInboxItems([])
    }
  }, [normalizedRows])

  const handleRowClick = (item: ExceptionInboxItem) => {
    setSelectedException(item)
  }

  const handleClosePanel = () => {
    setSelectedException(null)
  }

  const handleAction = (action: 'approve' | 'override' | 'hold', exceptionId: string) => {
    // TODO: Implement actual action handling
    console.log(`Action: ${action} for exception ${exceptionId}`)
    
    // For now, just close the panel after action
    // In a real implementation, this would update the exception status and refresh the list
    if (action === 'approve') {
      // Update exception status to indicate approval
      alert(`Approved next agent step for ${exceptionId}`)
    } else if (action === 'override') {
      // Show override interface
      alert(`Override agent for ${exceptionId}`)
    } else if (action === 'hold') {
      // Update exception status to hold
      alert(`Held ${exceptionId}`)
    }
    
    setSelectedException(null)
  }

  // Counts by status
  const statusCounts = useMemo(() => {
    return {
      awaiting_buyer: inboxItems.filter(item => item.current_status === 'awaiting_buyer').length,
      blocked: inboxItems.filter(item => item.current_status === 'blocked').length,
      resolved: inboxItems.filter(item => item.current_status === 'resolved').length,
      total: inboxItems.length
    }
  }, [inboxItems])

  if (!normalizedRows || normalizedRows.length === 0) {
    return (
      <div className="h-full">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <div className="mb-10">
            <h1 className="text-2xl font-semibold text-neutral-800 mb-2">Exceptions</h1>
            <p className="text-sm text-neutral-600">Review and resolve purchase order exceptions</p>
          </div>
          <div className="bg-white/70 rounded-3xl shadow-sm px-12 py-16 text-center max-w-lg mx-auto">
            <div className="space-y-6">
              <div className="text-neutral-700 mb-8">No workspace data found. <Link href="/home" className="text-neutral-800 underline hover:text-neutral-900">Upload a CSV or Excel file</Link> to detect purchase order exceptions.</div>
              <p className="text-xs text-neutral-400">Data processed locally in your browser</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full relative">
        <div className="max-w-7xl mx-auto px-8 py-10">
        {/* Primary interaction surface - calm surface */}
        <div className="mb-10">
            <h1 className="text-2xl font-semibold text-neutral-800 mb-2">Exception Inbox</h1>
            <p className="text-sm text-neutral-600">Review purchase order exceptions and agent actions</p>
        </div>

          {/* Status Summary - elevated card surface */}
          {inboxItems.length > 0 && (
            <div className="bg-white/70 rounded-2xl shadow-sm px-8 py-6 mb-8">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="p-5 rounded-xl bg-neutral-50/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Awaiting buyer</div>
                  <div className={`text-2xl font-semibold text-right ${statusCounts.awaiting_buyer === 0 ? 'text-neutral-400' : 'text-neutral-800'}`}>
                    {statusCounts.awaiting_buyer}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-neutral-50/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Blocked</div>
                  <div className={`text-2xl font-semibold text-right ${statusCounts.blocked === 0 ? 'text-neutral-400' : 'text-neutral-800'}`}>
                    {statusCounts.blocked}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-neutral-50/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Resolved</div>
                  <div className="text-2xl font-semibold text-right text-neutral-600">
                    {statusCounts.resolved}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-neutral-100/50 shadow-sm">
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Total active</div>
                  <div className="text-2xl font-semibold text-right text-neutral-800">
                    {statusCounts.total}
                  </div>
                </div>
              </div>
            </div>
          )}

        {/* Exception Inbox List - calm surface, no dividers */}
        {inboxItems.length > 0 ? (
          <div className="space-y-3">
            {inboxItems.map((item) => (
              <ExceptionInboxRow
                key={item.id}
                exception={item}
                onClick={() => handleRowClick(item)}
              />
            ))}
          </div>
        ) : (
          <div className="bg-white/70 rounded-3xl shadow-sm px-12 py-20 text-center max-w-xl mx-auto">
            <div className="text-neutral-700 mb-2 font-medium">No exceptions found</div>
            <div className="text-sm text-neutral-500">All purchase order lines appear normal.</div>
          </div>
        )}
        </div>
      </div>

      {/* Side Panel - Overlay */}
      <ExceptionSidePanel
        exception={selectedException}
        onClose={handleClosePanel}
        onAction={handleAction}
      />
    </>
  )
}
