'use client'

import { useEffect, useState } from 'react'
import { UnconfirmedPO, getUnconfirmedPOs } from '../../src/lib/unconfirmedPOs'
import { UnconfirmedPORow } from '@/components/UnconfirmedPORow'
import { SupplierConfirmationDrawer } from '@/components/SupplierConfirmationDrawer'
import { useWorkspace } from '@/components/WorkspaceProvider'

interface DemoUnconfirmedPO {
  poNumber: string
  lineId: string
  supplierName: string
  supplierEmail: string
  ageDays: number
  lastAction?: string
}

export default function UnconfirmedPOsPage() {
  const { normalizedRows } = useWorkspace()
  const [unconfirmedPOs, setUnconfirmedPOs] = useState<UnconfirmedPO[]>([])
  const [demoPOs, setDemoPOs] = useState<DemoUnconfirmedPO[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [lastActions, setLastActions] = useState<Record<string, string>>({})
  const [selectedPO, setSelectedPO] = useState<{
    poNumber: string
    lineId: string
    supplierName?: string
    supplierEmail: string
  } | null>(null)

  useEffect(() => {
    if (!normalizedRows || normalizedRows.length === 0) {
      // Fall back to demo dataset when no workspace data
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
      setUnconfirmedPOs([])
      return
    }

    // Get unconfirmed POs (usually returns empty array)
    const today = new Date()
    const unconfirmed = getUnconfirmedPOs(normalizedRows, today)
    
    setUnconfirmedPOs(unconfirmed)
    
    // If no unconfirmed POs found, use demo dataset
    if (unconfirmed.length === 0) {
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
    } else {
      setDemoPOs([])
    }
  }, [normalizedRows])

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

  const handleReview = (po: DemoUnconfirmedPO) => {
    setSelectedPO({
      poNumber: po.poNumber,
      lineId: po.lineId,
      supplierName: po.supplierName,
      supplierEmail: po.supplierEmail,
    })
    setDrawerOpen(true)
  }

  const hasItems = unconfirmedPOs.length > 0 || demoPOs.length > 0

  return (
    <>
      <div className="h-full relative">
        <div className="max-w-7xl mx-auto px-8 py-10">
          {/* Muted, low-interaction - calm surface */}
          <div className="mb-8">
            <h1 className="text-xl font-medium text-neutral-600 mb-1">Unconfirmed POs</h1>
            <p className="text-xs text-neutral-500">Passive monitoring of purchase orders awaiting confirmation</p>
          </div>

          {!hasItems ? (
            // Usually empty state - intentional and quiet
            <div className="bg-white/70 rounded-3xl shadow-sm px-12 py-20 text-center max-w-md mx-auto">
              <div className="space-y-3">
                <p className="text-neutral-500 font-medium">No unconfirmed purchase orders</p>
                <p className="text-xs text-neutral-400 leading-relaxed">
                  This section passively monitors purchase orders sent to suppliers that are awaiting confirmation. 
                  It is usually empty.
                </p>
              </div>
            </div>
          ) : (
            // Table view when populated
            <div className="bg-white/70 rounded-2xl shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-neutral-200/50">
                    <th className="px-6 py-4 text-left text-xs font-medium text-neutral-500 uppercase tracking-wide">
                      PO/Line
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-neutral-500 uppercase tracking-wide">
                      Supplier
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-neutral-500 uppercase tracking-wide">
                      Age
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-neutral-500 uppercase tracking-wide">
                      Status
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-medium text-neutral-500 uppercase tracking-wide">
                      Last action
                    </th>
                    <th className="px-6 py-4 text-right text-xs font-medium text-neutral-500 uppercase tracking-wide">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200/50">
                  {demoPOs.map((po, index) => {
                    const key = `${po.poNumber}-${po.lineId}`
                    const lastAction = lastActions[key] || '—'
                    return (
                      <tr
                        key={`${po.poNumber}-${po.lineId}-${index}`}
                        className="hover:bg-neutral-50/30 transition-colors cursor-pointer"
                        onClick={() => handleReview(po)}
                      >
                        <td className="px-6 py-4 text-sm text-neutral-700">
                          {po.poNumber}-{po.lineId}
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-600">
                          {po.supplierName}
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-600">
                          {po.ageDays} {po.ageDays === 1 ? 'day' : 'days'}
                        </td>
                        <td className="px-6 py-4">
                          <span className="px-3 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700">
                            Unconfirmed
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-500">
                          {lastAction}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleReview(po)
                            }}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-900 transition-colors shadow-sm"
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Supplier Confirmation Drawer */}
      {selectedPO && (
        <SupplierConfirmationDrawer
          open={drawerOpen}
          onClose={() => {
            setDrawerOpen(false)
            setSelectedPO(null)
            // Refresh last actions after drawer closes (in case email was sent)
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
          }}
          poNumber={selectedPO.poNumber}
          lineId={selectedPO.lineId}
          supplierName={selectedPO.supplierName}
          supplierEmail={selectedPO.supplierEmail}
        />
      )}
    </>
  )
}
