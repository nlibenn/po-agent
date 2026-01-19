'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { UnconfirmedPO, getUnconfirmedPOs, formatAgentActivityStatus } from '@/src/lib/unconfirmedPOs'
import { ConfirmedPO, getConfirmedPOs, ConfirmationRecord } from '@/src/lib/confirmedPOs'
import { UnconfirmedPORow } from '@/components/UnconfirmedPORow'
import { SupplierConfirmationDrawer } from '@/components/SupplierConfirmationDrawer'
import { useWorkspace } from '@/components/WorkspaceProvider'
import { computeWorkbenchFields, getStageLabel, getStagePriority, WorkbenchStage } from '@/src/lib/unconfirmedPOsWorkbench'

interface DemoUnconfirmedPO {
  poNumber: string
  lineId: string
  supplierName: string
  supplierEmail: string
  ageDays: number
  lastAction?: string
}

type TabView = 'unconfirmed' | 'confirmed'

export default function UnconfirmedPOsPage() {
  const { normalizedRows } = useWorkspace()
  const [activeTab, setActiveTab] = useState<TabView>('unconfirmed')
  const [unconfirmedPOs, setUnconfirmedPOs] = useState<UnconfirmedPO[]>([])
  const [confirmedPOs, setConfirmedPOs] = useState<ConfirmedPO[]>([])
  const [confirmationRecords, setConfirmationRecords] = useState<Map<string, ConfirmationRecord>>(new Map())
  const [demoPOs, setDemoPOs] = useState<DemoUnconfirmedPO[]>([])
  const [activePOId, setActivePOId] = useState<string | null>(null) // Format: "po_id-line_id" or null
  const [lastActions, setLastActions] = useState<Record<string, string>>({})
  const [selectedPO, setSelectedPO] = useState<{
    poNumber: string
    lineId: string
    supplierName?: string
    supplierEmail: string
  } | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [poToReset, setPoToReset] = useState<{ poNumber: string; lineId: string } | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetSuccess, setResetSuccess] = useState(false)
  const [showDemoData, setShowDemoData] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const mainContentRef = useRef<HTMLDivElement>(null)

  // Fetch confirmation records from database (bulk fetch)
  useEffect(() => {
    if (!normalizedRows || normalizedRows.length === 0) {
      setConfirmationRecords(new Map())
      return
    }

    const fetchConfirmationRecords = async () => {
      try {
        // Build exact (po_id, line_id) keys from normalizedRows for precise matching
        const keys = normalizedRows.map(row => ({
          po_id: row.po_id,
          line_id: row.line_id || '',
        }))

        if (keys.length === 0) {
          setConfirmationRecords(new Map())
          return
        }

        // Fetch confirmation records using bulk POST endpoint
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
        
        // Use the recordsMap from the response if available, otherwise build it
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
      }
    }

    fetchConfirmationRecords()
  }, [normalizedRows])

  // Listen for confirmation record updates (from drawer Apply action)
  useEffect(() => {
    if (!normalizedRows || normalizedRows.length === 0) return

    const handleUpdate = async () => {
      try {
        // Build exact (po_id, line_id) keys from normalizedRows for precise matching
        const keys = normalizedRows.map(row => ({
          po_id: row.po_id,
          line_id: row.line_id || '',
        }))

        if (keys.length === 0) {
          setConfirmationRecords(new Map())
          return
        }

        // Fetch confirmation records using bulk POST endpoint
        const response = await fetch('/api/confirmations/records/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys }),
        })

        if (!response.ok) {
          console.error('Failed to fetch confirmation records')
          return
        }

        const data = await response.json()
        const records: ConfirmationRecord[] = data.records || []
        
        // Use the recordsMap from the response if available, otherwise build it
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
      }
    }

    window.addEventListener('confirmationRecordUpdated', handleUpdate)
    return () => {
      window.removeEventListener('confirmationRecordUpdated', handleUpdate)
    }
  }, [normalizedRows])

  useEffect(() => {
    // Always clear demo data first
    setDemoPOs([])
    
    if (!normalizedRows || normalizedRows.length === 0) {
      // No workspace data - show empty state (not demo data)
      setUnconfirmedPOs([])
      setConfirmedPOs([])
      setShowDemoData(false)
      return
    }

    // Get unconfirmed POs from actual workspace data (excluding confirmed ones)
    const today = new Date()
    const unconfirmed = getUnconfirmedPOs(normalizedRows, today, confirmationRecords)
    console.log('[UNCONFIRMED_POS_PAGE] unconfirmed.length after getUnconfirmedPOs:', unconfirmed.length)
    
    // Sort by stage priority with special handling for "parsed with needs"
    // Ready to apply first, Parsed with needs next, Waiting on supplier next, Not started last
    // Within each group, sort by last touch oldest first (if available), else by age descending
    const sorted = unconfirmed.sort((a, b) => {
      const keyA = `${a.po_id}-${a.line_id || ''}`
      const keyB = `${b.po_id}-${b.line_id || ''}`
      const recordA = confirmationRecords.get(keyA)
      const recordB = confirmationRecords.get(keyB)
      const fieldsA = computeWorkbenchFields(recordA)
      const fieldsB = computeWorkbenchFields(recordB)
      
      // Calculate sort priority: parsed with needs gets priority 1.5 (between ready_to_apply and parsed)
      const getSortPriority = (fields: ReturnType<typeof computeWorkbenchFields>) => {
        if (fields.stage === 'ready_to_apply') return 1
        if (fields.stage === 'parsed' && fields.needs.length > 0) return 1.5
        return getStagePriority(fields.stage)
      }
      
      const priorityA = getSortPriority(fieldsA)
      const priorityB = getSortPriority(fieldsB)
      const priorityDiff = priorityA - priorityB
      if (priorityDiff !== 0) {
        return priorityDiff
      }
      
      // Within same priority group, sort by last touch (oldest first if available)
      // Use updated_at from confirmationRecord, fallback to sent_date
      const lastTouchA = recordA?.updated_at || a.sent_date.getTime()
      const lastTouchB = recordB?.updated_at || b.sent_date.getTime()
      const touchDiff = lastTouchA - lastTouchB
      if (touchDiff !== 0) {
        return touchDiff
      }
      
      // If same last touch, sort by age descending (oldest first)
      return b.days_since_sent - a.days_since_sent
    })
    
    setUnconfirmedPOs(sorted)

    // Get confirmed POs from actual workspace data merged with confirmation records
    const confirmed = getConfirmedPOs(normalizedRows, confirmationRecords)
    console.log('[UNCONFIRMED_POS_PAGE] confirmed.length after getConfirmedPOs:', confirmed.length)
    setConfirmedPOs(confirmed)
    
    // Only show demo data if explicitly requested AND no real data exists
    if (showDemoData && unconfirmed.length === 0) {
      setDemoPOs([
        {
          poNumber: '907255',
          lineId: '1',
          supplierName: 'Acme Supplier',
          supplierEmail: 'noura.liben@gmail.com',
          ageDays: 5,
        },
        {
          poNumber: '907178',
          lineId: '1',
          supplierName: 'Acme Supplier',
          supplierEmail: 'noura.liben@gmail.com',
          ageDays: 2,
        },
      ])
    }
  }, [normalizedRows, confirmationRecords, showDemoData])

  // Fetch last actions for demo POs
  useEffect(() => {
    if (demoPOs.length === 0) return

    const fetchLastActions = async () => {
      const actions: Record<string, string> = {}
      
      for (const po of demoPOs) {
        try {
          const response = await fetch(
            `/api/confirmations/last-action?poNumber=${encodeURIComponent(po.poNumber)}&lineId=${encodeURIComponent(po.lineId)}`
          )
          if (response.ok) {
            const data = await response.json()
            const key = `${po.poNumber}-${po.lineId}`
            actions[key] = data.formatted || '—'
          }
        } catch (err) {
          console.error(`Error fetching last action for ${po.poNumber}-${po.lineId}:`, err)
        }
      }
      
      setLastActions(actions)
    }

    fetchLastActions()
  }, [demoPOs])

  // Handle PO selection - sets activePOId which drives panel content
  const handlePOSelect = useCallback((poNumber: string, lineId: string, supplierName?: string, supplierEmail?: string) => {
    const poKey = `${poNumber}-${lineId}`
    setActivePOId(poKey)
    
    // Find supplier_email from normalizedRows by matching po_id and line_id
    const matchingRow = normalizedRows?.find(
      row => row.po_id === poNumber && row.line_id === lineId
    )
    
    // Try to get supplier_email from rawRow with multiple field name variations
    const rawRow = matchingRow?.rawRow || {}
    const resolvedEmail = supplierEmail || 
                          rawRow.supplier_email || 
                          rawRow.supplierEmail ||
                          rawRow['supplier email'] ||
                          rawRow['Supplier Email'] ||
                          rawRow['SUPPLIER_EMAIL'] ||
                          rawRow['supplier_email_address'] ||
                          rawRow['email'] ||
                          `${(supplierName || '').toLowerCase().replace(/\s+/g, '.')}@example.com`
    
    setSelectedPO({
      poNumber,
      lineId,
      supplierName,
      supplierEmail: resolvedEmail,
    })
  }, [normalizedRows])

  const handleReview = (po: DemoUnconfirmedPO) => {
    handlePOSelect(po.poNumber, po.lineId, po.supplierName, po.supplierEmail)
  }

  const handleReviewUnconfirmed = (po: UnconfirmedPO) => {
    handlePOSelect(po.po_id, po.line_id || '', po.supplier_name)
  }

  const handleReviewConfirmed = (po: ConfirmedPO) => {
    handlePOSelect(po.po_id, po.line_id, po.supplier_name)
  }

  // Handle closing panel (X button or Escape key)
  const handleClosePanel = useCallback(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[PANEL] close', { activePOId })
    }
    setActivePOId(null)
    setSelectedPO(null)
  }, [activePOId])

  // Escape key handler to close panel
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activePOId) {
        handleClosePanel()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [activePOId, handleClosePanel])

  // Outside click handler - close panel when clicking outside of it
  useEffect(() => {
    if (!activePOId) return

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Element
      
      // Don't close if clicking inside the panel
      if (panelRef.current?.contains(target as Node)) {
        return
      }
      
      // Don't close if clicking on a table row (row click should update content, not close)
      const clickedRow = target.closest('tr')
      if (clickedRow && clickedRow.classList.contains('cursor-pointer')) {
        // Row click - let it handle selection, don't close panel
        return
      }
      
      // Don't close if clicking on interactive elements (buttons, links, inputs, etc.)
      if (
        target.closest('button') || 
        target.closest('a') || 
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('select') ||
        target.closest('[role="button"]') ||
        target.closest('[onclick]')
      ) {
        // Interactive element clicks should work normally, not close panel
        return
      }
      
      // Close panel for clicks on whitespace/background/table container (but not rows)
      handleClosePanel()
      
      // Debug log (DEV only)
      if (process.env.NODE_ENV !== 'production') {
        console.log('[PANEL] close (outside click)', { activePOId })
      }
    }

    // Use mousedown/touchstart to catch clicks before they bubble
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [activePOId, handleClosePanel])

  // Debug log when panel opens/closes
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      if (activePOId) {
        console.log('[PANEL] open', { caseId: activePOId })
      }
    }
  }, [activePOId])

  // Set data attribute on body for nav collapse (only on this page)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      if (activePOId) {
        document.body.setAttribute('data-inspector-open', 'true')
      } else {
        document.body.removeAttribute('data-inspector-open')
      }
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.body.removeAttribute('data-inspector-open')
      }
    }
  }, [activePOId])

  /**
   * Escape CSV field value (handles commas, quotes, newlines)
   */
  const escapeCSVField = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) {
      return ''
    }
    const str = String(value)
    // If field contains comma, quote, or newline, wrap in quotes and escape quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  /**
   * Export confirmed POs to CSV
   */
  const handleExportConfirmed = () => {
    if (confirmedPOs.length === 0) return

    // Build CSV rows
    const headers = [
      'po_number',
      'line_id',
      'supplier_name',
      'supplier_order_number',
      'confirmed_ship_date',
      'confirmed_quantity',
      'confirmed_uom',
      'confirmation_source',
      'updated_at',
    ]

    const rows = confirmedPOs.map(po => {
      // Get the confirmation record to access updated_at and confirmed_uom
      const key = `${po.po_id}-${po.line_id}`
      const record = confirmationRecords.get(key)
      
      // Format updated_at as human-readable date (YYYY-MM-DD HH:MM:SS)
      const updatedAt = record?.updated_at
        ? new Date(record.updated_at).toISOString().replace('T', ' ').substring(0, 19)
        : ''

      return [
        escapeCSVField(po.po_id),
        escapeCSVField(po.line_id),
        escapeCSVField(po.supplier_name),
        escapeCSVField(po.supplier_order_number),
        escapeCSVField(po.confirmed_ship_date),
        escapeCSVField(po.confirmed_quantity),
        escapeCSVField(record?.confirmed_uom || ''),
        escapeCSVField(po.confirmation_source),
        escapeCSVField(updatedAt),
      ]
    })

    // Combine headers and rows
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(',')),
    ].join('\n')

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    
    // Generate filename: confirmed_pos_YYYY-MM-DD.csv
    const today = new Date()
    const dateStr = today.toISOString().split('T')[0]
    link.download = `confirmed_pos_${dateStr}.csv`
    
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleResetClick = (e: React.MouseEvent, po: DemoUnconfirmedPO) => {
    e.stopPropagation()
    setPoToReset({ poNumber: po.poNumber, lineId: po.lineId })
    setResetConfirmOpen(true)
  }

  const handleResetConfirm = async () => {
    if (!poToReset) return

    setResetting(true)
    setResetSuccess(false)

    try {
      const response = await fetch('/api/confirmations/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poNumber: poToReset.poNumber,
          lineId: poToReset.lineId,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to reset')
      }

      setResetSuccess(true)
      
      // Refresh last actions after reset
      if (demoPOs.length > 0) {
        const fetchLastActions = async () => {
          const actions: Record<string, string> = {}
          for (const po of demoPOs) {
            try {
              const response = await fetch(
                `/api/confirmations/last-action?poNumber=${encodeURIComponent(po.poNumber)}&lineId=${encodeURIComponent(po.lineId)}`
              )
              if (response.ok) {
                const data = await response.json()
                const key = `${po.poNumber}-${po.lineId}`
                actions[key] = data.formatted || '—'
              }
            } catch (err) {
              // Silently fail
            }
          }
          setLastActions(actions)
        }
        fetchLastActions()
      }

      // Close modal after a brief delay to show success
      setTimeout(() => {
        setResetConfirmOpen(false)
        setPoToReset(null)
        setResetSuccess(false)
      }, 1500)
    } catch (err) {
      console.error('Error resetting confirmation agent:', err)
      alert(err instanceof Error ? err.message : 'Failed to reset confirmation agent')
    } finally {
      setResetting(false)
    }
  }

  const hasUnconfirmedItems = unconfirmedPOs.length > 0 || demoPOs.length > 0
  const hasConfirmedItems = confirmedPOs.length > 0
  const isInspectorOpen = activePOId !== null

  return (
    <>
      <div className="h-full relative flex" ref={mainContentRef}>
        <div className={`flex-1 px-8 py-10 ${activePOId ? '' : 'max-w-7xl mx-auto'} transition-all overflow-x-auto`}>
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-xl font-medium text-text-muted mb-1">Purchase Orders</h1>
            <p className="text-xs text-text-subtle">Monitor confirmation status and review confirmed orders</p>
          </div>

          {/* Tab Switcher */}
          <div className="mb-6 flex gap-2 border-b border-border/70">
            <button
              onClick={() => setActiveTab('unconfirmed')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'unconfirmed'
                  ? 'border-primary-deep text-primary-deep'
                  : 'border-transparent text-text-subtle hover:text-text'
              }`}
            >
              Unconfirmed ({unconfirmedPOs.length})
            </button>
            <button
              onClick={() => setActiveTab('confirmed')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'confirmed'
                  ? 'border-primary-deep text-primary-deep'
                  : 'border-transparent text-text-subtle hover:text-text'
              }`}
            >
              Confirmed ({confirmedPOs.length})
            </button>
          </div>

          {activeTab === 'unconfirmed' ? (
            <>
              {!hasUnconfirmedItems ? (
                // Empty state for unconfirmed
                <div className="bg-surface rounded-3xl shadow-soft border border-border/70 px-12 py-20 text-center max-w-md mx-auto">
                  <div className="space-y-4">
                    {normalizedRows && normalizedRows.length > 0 ? (
                      <>
                        <p className="text-text-subtle font-medium">No unconfirmed purchase orders</p>
                        <p className="text-xs text-text-subtle leading-relaxed">
                          This section passively monitors purchase orders sent to suppliers that are awaiting confirmation. 
                          It is usually empty.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-text-subtle font-medium">No workspace data</p>
                        <p className="text-xs text-text-subtle leading-relaxed mb-4">
                          Upload a PO dataset in Drive to populate this section.
                        </p>
                        <Link
                          href="/drive"
                          className="inline-block px-5 py-2.5 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 transition-colors shadow-sm"
                        >
                          Go to Drive
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                // Unconfirmed table view
                <div className="bg-surface rounded-2xl shadow-soft border border-border/70 overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border/70">
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          PO/Line
                        </th>
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          Supplier
                        </th>
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          Needs
                        </th>
                        {!isInspectorOpen && (
                          <th className="px-6 py-4 text-left text-xs font-medium text-text-subtle uppercase tracking-wide">
                            Next action
                          </th>
                        )}
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          {isInspectorOpen ? 'Touch' : 'Last touch'}
                        </th>
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          Stage
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {unconfirmedPOs.map((po, index) => {
                        const key = `${po.po_id}-${po.line_id || ''}`
                        const record = confirmationRecords.get(key)
                        const fields = computeWorkbenchFields(record)
                        const isSelected = activePOId === key
                        
                        return (
                          <tr
                            key={`${po.po_id}-${po.line_id || ''}-${index}`}
                            onClick={() => handleReviewUnconfirmed(po)}
                            className={`cursor-pointer transition-colors ${
                              isSelected 
                                ? 'bg-surface-2 border-l-2 border-l-primary-deep' 
                                : 'hover:bg-surface-2/50'
                            }`}
                          >
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} ${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text font-medium`}>
                              {po.po_id}-{po.line_id || ''}
                            </td>
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} ${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text-muted ${isInspectorOpen ? 'truncate max-w-[120px]' : ''}`} title={po.supplier_name}>
                              {po.supplier_name}
                            </td>
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'}`}>
                              {fields.needs.length === 0 ? (
                                <span className={`${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text-subtle`}>—</span>
                              ) : (
                                <div className={`flex ${isInspectorOpen ? 'gap-1' : 'gap-1.5'} flex-wrap`}>
                                  {fields.needs.slice(0, isInspectorOpen ? 2 : 3).map((need, idx) => (
                                    <span
                                      key={idx}
                                      className={`${isInspectorOpen ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'} rounded font-medium bg-surface-2 text-text border border-border/50`}
                                    >
                                      {need}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            {!isInspectorOpen && (
                              <td className="px-6 py-4 text-sm text-text-muted">
                                {fields.nextAction}
                              </td>
                            )}
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} ${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text-subtle`}>
                              {fields.lastTouch}
                            </td>
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'}`}>
                              <span className={`${isInspectorOpen ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs'} rounded-full font-medium bg-surface-2 text-text border border-border/50`}>
                                {isInspectorOpen ? getStageLabel(fields.stage).split(' ')[0] : getStageLabel(fields.stage)}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                      {/* Also render demo POs if they exist */}
                      {demoPOs.map((po, index) => {
                        const key = `${po.poNumber}-${po.lineId}`
                        const lastAction = lastActions[key] || '—'
                        return (
                          <tr
                            key={`demo-${po.poNumber}-${po.lineId}-${index}`}
                            className="hover:bg-surface-2/50 transition-colors cursor-pointer"
                            onClick={() => handleReview(po)}
                          >
                            <td className="px-6 py-4 text-sm text-text">
                              {po.poNumber}-{po.lineId}
                            </td>
                            <td className="px-6 py-4 text-sm text-text-muted">
                              {po.supplierName}
                            </td>
                            <td className="px-6 py-4 text-sm text-text-muted">
                              {po.ageDays} {po.ageDays === 1 ? 'day' : 'days'}
                            </td>
                            <td className="px-6 py-4">
                              <span className="px-3 py-1 rounded-full text-xs font-medium bg-surface-2 text-text border border-border/50">
                                Unconfirmed
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm text-text-subtle">
                              {lastAction}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleResetClick(e, po)
                                  }}
                                  className="px-3 py-2 rounded-xl text-xs font-medium text-text-muted bg-surface-2 hover:bg-surface-2/80 border border-border/50 transition-colors"
                                  title="Reset confirmation agent"
                                >
                                  Reset agent
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleReview(po)
                                  }}
                                  className="px-4 py-2 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 transition-colors shadow-sm"
                                >
                                  Review
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
              {!hasConfirmedItems ? (
                // Empty state for confirmed
                <div className="bg-surface rounded-3xl shadow-soft border border-border/70 px-12 py-20 text-center max-w-md mx-auto">
                  <div className="space-y-4">
                    <p className="text-text-subtle font-medium">No confirmed POs yet</p>
                    <p className="text-xs text-text-subtle leading-relaxed">
                      Once confirmation data is found, lines will appear here.
                    </p>
                  </div>
                </div>
              ) : (
                // Confirmed table view
                <div className="bg-surface rounded-2xl shadow-soft border border-border/70 overflow-hidden">
                  {/* Header with Export button */}
                  <div className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} border-b border-border/70 flex items-center justify-end`}>
                    <button
                      onClick={handleExportConfirmed}
                      disabled={confirmedPOs.length === 0}
                      className={`${isInspectorOpen ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} rounded-xl font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm`}
                    >
                      Export CSV
                    </button>
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border/70">
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          PO/Line
                        </th>
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          Supplier
                        </th>
                        {!isInspectorOpen && (
                          <th className="px-6 py-4 text-left text-xs font-medium text-text-subtle uppercase tracking-wide">
                            Supplier Order #
                          </th>
                        )}
                        {!isInspectorOpen && (
                          <th className="px-6 py-4 text-left text-xs font-medium text-text-subtle uppercase tracking-wide">
                            Ship Date
                          </th>
                        )}
                        <th className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} text-left text-xs font-medium text-text-subtle uppercase tracking-wide`}>
                          {isInspectorOpen ? 'Qty' : 'Confirmed Qty'}
                        </th>
                        {!isInspectorOpen && (
                          <th className="px-6 py-4 text-left text-xs font-medium text-text-subtle uppercase tracking-wide">
                            Confirmation Source
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {confirmedPOs.map((po, index) => {
                        const key = `${po.po_id}-${po.line_id}`
                        const isSelected = activePOId === key
                        return (
                          <tr
                            key={`confirmed-${po.po_id}-${po.line_id}-${index}`}
                            onClick={() => handleReviewConfirmed(po)}
                            className={`cursor-pointer transition-colors ${
                              isSelected 
                                ? 'bg-surface-2 border-l-2 border-l-primary-deep' 
                                : 'hover:bg-surface-2/50'
                            }`}
                          >
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} ${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text font-medium`}>
                              {po.po_id}-{po.line_id}
                            </td>
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} ${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text-muted ${isInspectorOpen ? 'truncate max-w-[120px]' : ''}`} title={po.supplier_name}>
                              {po.supplier_name}
                            </td>
                            {!isInspectorOpen && (
                              <td className="px-6 py-4 text-sm text-text font-medium">
                                {po.supplier_order_number}
                              </td>
                            )}
                            {!isInspectorOpen && (
                              <td className="px-6 py-4 text-sm text-text-muted">
                                {po.confirmed_ship_date}
                              </td>
                            )}
                            <td className={`${isInspectorOpen ? 'px-4 py-2' : 'px-6 py-4'} ${isInspectorOpen ? 'text-xs' : 'text-sm'} text-text-muted`}>
                              {po.confirmed_quantity}
                            </td>
                            {!isInspectorOpen && (
                              <td className="px-6 py-4 text-sm text-text-subtle">
                                {po.confirmation_source}
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Supplier Confirmation Panel - layout panel, not overlay */}
        {activePOId && selectedPO && (
          <div ref={panelRef} className="w-[420px] flex-shrink-0 border-l border-border/70 shadow-lift h-full">
            <SupplierConfirmationDrawer
              open={true}
              onClose={handleClosePanel}
              poNumber={selectedPO.poNumber}
              lineId={selectedPO.lineId}
              supplierName={selectedPO.supplierName}
              supplierEmail={selectedPO.supplierEmail}
            />
          </div>
        )}
      </div>

      {/* Reset Confirmation Modal */}
      {resetConfirmOpen && poToReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Overlay */}
          <div
            className="fixed inset-0 bg-shadow/10 backdrop-blur-[2px]"
            onClick={() => {
              if (!resetting) {
                setResetConfirmOpen(false)
                setPoToReset(null)
              }
            }}
          />
          {/* Modal Content */}
          <div className="relative bg-surface rounded-2xl shadow-lift border border-border/70 p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-text mb-3">
              Reset confirmation agent?
            </h3>
            <p className="text-sm text-text-muted mb-6 leading-relaxed">
              This clears agent history and parsed results for PO {poToReset.poNumber} line {poToReset.lineId} so you can re-run the demo.
            </p>
            
            {resetSuccess ? (
              <div className="px-4 py-3 rounded-xl bg-success/15 border border-success/30 mb-4">
                <p className="text-sm text-success">Reset complete</p>
              </div>
            ) : (
              <div className="flex gap-3">
                <button
                  onClick={handleResetConfirm}
                  disabled={resetting}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  {resetting ? 'Resetting...' : 'Reset'}
                </button>
                <button
                  onClick={() => {
                    setResetConfirmOpen(false)
                    setPoToReset(null)
                  }}
                  disabled={resetting}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium text-text bg-surface hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-border/70"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
