'use client'

import { useEffect, useState, useCallback } from 'react'
import { useWorkspace } from '@/components/WorkspaceProvider'
import { UnconfirmedPO, getUnconfirmedPOs } from '@/src/lib/unconfirmedPOs'
import { ConfirmationRecord } from '@/src/lib/confirmedPOs'

interface AcknowledgementWorkQueueProps {
  activeCaseId: string | null
  onSelectCase: (caseId: string, po: UnconfirmedPO) => void
}

// Map canonical field keys to compact display tokens
const FIELD_TOKEN_MAP: Record<string, string> = {
  supplier_reference: 'SO#',
  delivery_date: 'Date',
  quantity: 'Qty',
  // Legacy field names (for backward compatibility)
  supplier_order_number: 'SO#',
  confirmed_ship_date: 'Date',
  confirmed_delivery_date: 'Date',
  ship_date: 'Date',
  confirmed_quantity: 'Qty',
}

// Critical fields for prioritization (SO# or Date missing = highest priority)
const CRITICAL_FIELDS = ['supplier_reference', 'delivery_date']

/**
 * Derive compact need tokens from missing_fields
 * Returns unique tokens like ["SO#", "Date", "Qty"] (max 3 with +N overflow)
 */
function deriveNeedTokens(record: ConfirmationRecord | null | undefined): string[] {
  // Default missing fields if no record (using canonical keys)
  const defaultMissing = ['supplier_reference', 'delivery_date', 'quantity']
  
  // Derive missing from record: if field is null/undefined, it's missing
  let missingFields: string[] = []
  
  if (!record) {
    missingFields = defaultMissing
  } else {
    if (!record.supplier_order_number) missingFields.push('supplier_reference')
    if (!record.confirmed_ship_date) missingFields.push('delivery_date')
    if (record.confirmed_quantity === null || record.confirmed_quantity === undefined) missingFields.push('quantity')
  }
  
  // Map to tokens, dedupe
  const tokenSet = new Set<string>()
  missingFields.forEach(field => {
    const token = FIELD_TOKEN_MAP[field]
    if (token) tokenSet.add(token)
  })
  
  return Array.from(tokenSet)
}

/**
 * Check if record has critical fields missing (SO# or Ship Date)
 */
function hasCriticalMissing(record: ConfirmationRecord | null | undefined): boolean {
  if (!record) return true // No record = all critical fields missing
  
  const hasSO = !!record.supplier_order_number
  const hasDate = !!record.confirmed_ship_date
  
  return !hasSO || !hasDate
}

/**
 * Count missing fields for a record
 */
function countMissingFields(record: ConfirmationRecord | null | undefined): number {
  if (!record) return 3 // All missing
  
  let count = 0
  if (!record.supplier_order_number) count++
  if (!record.confirmed_ship_date) count++
  if (record.confirmed_quantity === null || record.confirmed_quantity === undefined) count++
  
  return count
}

/**
 * Left-middle panel: PO Work Queue
 * Compact inbox list of unresolved acknowledgements
 * Selection + prioritization only - no actions
 * 
 * Sorting:
 * 1. Critical missing fields first (SO# or Ship Date missing)
 * 2. Missing fields count DESC
 * 3. Last action ASC (oldest first)
 */
export function AcknowledgementWorkQueue({
  activeCaseId,
  onSelectCase,
}: AcknowledgementWorkQueueProps) {
  const { normalizedRows } = useWorkspace()
  const [unconfirmedPOs, setUnconfirmedPOs] = useState<UnconfirmedPO[]>([])
  const [confirmationRecords, setConfirmationRecords] = useState<Map<string, ConfirmationRecord>>(new Map())
  const [loading, setLoading] = useState(true)

  // Fetch confirmation records from database
  const fetchConfirmationRecords = useCallback(async () => {
    if (!normalizedRows || normalizedRows.length === 0) {
      setConfirmationRecords(new Map())
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const keys = normalizedRows.map(row => ({
        po_id: row.po_id,
        line_id: row.line_id || '',
      }))

      if (keys.length === 0) {
        setConfirmationRecords(new Map())
        return
      }

      const response = await fetch('/api/confirmations/records/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      })

      if (!response.ok) {
        console.error('Failed to fetch confirmation records')
        setConfirmationRecords(new Map())
        return
      }

      const data = await response.json()
      const records: ConfirmationRecord[] = data.records || []
      
      let recordsMap: Map<string, ConfirmationRecord>
      if (data.recordsMap) {
        recordsMap = new Map(Object.entries(data.recordsMap))
      } else {
        recordsMap = new Map<string, ConfirmationRecord>()
        records.forEach(record => {
          const key = `${record.po_id}-${record.line_id}`
          recordsMap.set(key, record)
        })
      }
      
      setConfirmationRecords(recordsMap)
    } catch (error) {
      console.error('Error fetching confirmation records:', error)
      setConfirmationRecords(new Map())
    } finally {
      setLoading(false)
    }
  }, [normalizedRows])

  useEffect(() => {
    fetchConfirmationRecords()
  }, [fetchConfirmationRecords])

  // Listen for confirmation record updates (from apply action)
  useEffect(() => {
    const handleUpdate = () => {
      fetchConfirmationRecords()
    }

    window.addEventListener('confirmationRecordUpdated', handleUpdate)
    return () => {
      window.removeEventListener('confirmationRecordUpdated', handleUpdate)
    }
  }, [fetchConfirmationRecords])

  // Compute unconfirmed POs with new sorting logic
  useEffect(() => {
    if (!normalizedRows || normalizedRows.length === 0) {
      setUnconfirmedPOs([])
      return
    }

    const today = new Date()
    const unconfirmed = getUnconfirmedPOs(normalizedRows, today, confirmationRecords)
    
    // Sort by:
    // 1. Critical missing fields first (SO# or Ship Date missing)
    // 2. Missing fields count DESC (more missing = higher priority)
    // 3. Last action ASC (oldest first)
    const sorted = unconfirmed.sort((a, b) => {
      const keyA = `${a.po_id}-${a.line_id || ''}`
      const keyB = `${b.po_id}-${b.line_id || ''}`
      const recordA = confirmationRecords.get(keyA)
      const recordB = confirmationRecords.get(keyB)
      
      // 1. Critical missing fields first
      const criticalA = hasCriticalMissing(recordA) ? 0 : 1
      const criticalB = hasCriticalMissing(recordB) ? 0 : 1
      if (criticalA !== criticalB) return criticalA - criticalB
      
      // 2. Missing fields count DESC (more missing = higher priority)
      const missingCountA = countMissingFields(recordA)
      const missingCountB = countMissingFields(recordB)
      if (missingCountA !== missingCountB) return missingCountB - missingCountA
      
      // 3. Last action ASC (oldest first)
      const lastActionA = recordA?.updated_at || a.sent_date.getTime()
      const lastActionB = recordB?.updated_at || b.sent_date.getTime()
      return lastActionA - lastActionB
    })
    
    setUnconfirmedPOs(sorted)
  }, [normalizedRows, confirmationRecords])

  const needsCount = unconfirmedPOs.length

  return (
    <div className="h-full flex flex-col bg-surface border-r border-border/50">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Work Queue</h2>
          <span className="text-xs text-text-subtle bg-surface-2 px-2 py-0.5 rounded-full">
            {needsCount} need{needsCount !== 1 ? 's' : ''} ack
          </span>
        </div>
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center">
            <div className="text-xs text-text-subtle">Loading...</div>
          </div>
        ) : unconfirmedPOs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <div className="text-xs text-text-subtle">No unconfirmed POs</div>
            <p className="text-[10px] text-text-subtle/70 mt-1">
              Upload PO data in Drive to get started
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {unconfirmedPOs.map((po) => {
              const key = `${po.po_id}-${po.line_id || ''}`
              const record = confirmationRecords.get(key)
              const needTokens = deriveNeedTokens(record)
              const isSelected = activeCaseId === key
              
              // Max 3 tokens, show +N overflow
              const displayTokens = needTokens.slice(0, 3)
              const overflowCount = needTokens.length - 3

              return (
                <button
                  key={key}
                  onClick={() => {
                    onSelectCase(key, po)
                  }}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    isSelected
                      ? 'bg-primary-deep/10 border-l-2 border-l-primary-deep'
                      : 'hover:bg-surface-2/50'
                  }`}
                >
                  {/* Row 1: PO number */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text truncate">
                      {po.po_id}{po.line_id ? `-${po.line_id}` : ''}
                    </span>
                  </div>
                  
                  {/* Row 2: Supplier name */}
                  <div className="text-xs text-text-muted truncate mt-0.5">
                    {po.supplier_name || 'Unknown supplier'}
                  </div>

                  {/* Row 3: Needs tokens */}
                  {needTokens.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-1.5">
                      {displayTokens.map((token, idx) => (
                        <span
                          key={idx}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-surface-2 text-text-muted border border-border/30"
                        >
                          {token}
                        </span>
                      ))}
                      {overflowCount > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-surface-2 text-text-subtle border border-border/30">
                          +{overflowCount}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
