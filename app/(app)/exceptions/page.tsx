'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { 
  computeTriageForAll, 
  computeTriage, 
  deriveExceptions,
  Exception
} from '@/src/lib/po'
import { 
  ExceptionInboxItem,
  exceptionToInboxItem,
  filterActiveExceptions,
  sortExceptionsByPriority
} from '@/src/lib/exceptionInbox'
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
            <h1 className="text-2xl font-semibold text-text mb-2">Exceptions</h1>
            <p className="text-sm text-text-muted">Review and resolve purchase order exceptions</p>
          </div>
          <div className="bg-surface rounded-3xl shadow-soft border border-border/70 px-12 py-16 text-center max-w-lg mx-auto">
            <div className="space-y-6">
              <div className="text-text font-medium text-lg mb-2">No data loaded</div>
              <div className="text-sm text-text-muted mb-8">
                Upload a PO dataset in Drive to populate Exceptions.
              </div>
              <Link
                href="/drive"
                className="inline-block px-5 py-2.5 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 transition-colors shadow-sm"
              >
                Go to Drive
              </Link>
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
            <h1 className="text-2xl font-semibold text-text mb-2">Exception Inbox</h1>
            <p className="text-sm text-text-muted">Review purchase order exceptions and agent actions</p>
        </div>

          {/* Status Summary - elevated card surface */}
          {inboxItems.length > 0 && (
            <div className="bg-surface rounded-2xl shadow-soft border border-border/70 px-8 py-6 mb-8">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="p-5 rounded-xl bg-surface-2 shadow-sm border border-border/50">
                  <div className="text-xs font-medium text-text-subtle uppercase tracking-wide mb-2">Awaiting buyer</div>
                  <div className={`text-2xl font-semibold text-right ${statusCounts.awaiting_buyer === 0 ? 'text-text-subtle' : 'text-text'}`}>
                    {statusCounts.awaiting_buyer}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-surface-2 shadow-sm border border-border/50">
                  <div className="text-xs font-medium text-text-subtle uppercase tracking-wide mb-2">Blocked</div>
                  <div className={`text-2xl font-semibold text-right ${statusCounts.blocked === 0 ? 'text-text-subtle' : 'text-text'}`}>
                    {statusCounts.blocked}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-surface-2 shadow-sm border border-border/50">
                  <div className="text-xs font-medium text-text-subtle uppercase tracking-wide mb-2">Resolved</div>
                  <div className="text-2xl font-semibold text-right text-text-muted">
                    {statusCounts.resolved}
                  </div>
                </div>
                <div className="p-5 rounded-xl bg-surface-tint shadow-sm border border-border/50">
                  <div className="text-xs font-medium text-text-subtle uppercase tracking-wide mb-2">Total active</div>
                  <div className="text-2xl font-semibold text-right text-text">
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
          <div className="bg-surface rounded-3xl shadow-soft border border-border/70 px-12 py-20 text-center max-w-xl mx-auto">
            <div className="text-text mb-2 font-medium">No exceptions found</div>
            <div className="text-sm text-text-subtle">All purchase order lines appear normal.</div>
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
