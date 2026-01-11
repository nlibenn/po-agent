'use client'

import { useEffect, useState } from 'react'
import { UnconfirmedPO, getUnconfirmedPOs } from '../../src/lib/unconfirmedPOs'
import { UnconfirmedPORow } from '@/components/UnconfirmedPORow'
import { normalizeRow } from '../../src/lib/po'

export default function UnconfirmedPOsPage() {
  const [unconfirmedPOs, setUnconfirmedPOs] = useState<UnconfirmedPO[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // This section is usually empty - passive monitoring
    const storedData = sessionStorage.getItem('po_rows')

    if (!storedData) {
      setUnconfirmedPOs([])
      setLoading(false)
      return
    }

    try {
      const parsedRows = JSON.parse(storedData) as Record<string, any>[]
      
      if (!Array.isArray(parsedRows)) {
        setUnconfirmedPOs([])
        setLoading(false)
        return
      }

      // Normalize rows
      const normalizedRows = parsedRows.map(row => normalizeRow(row))
      
      // Get unconfirmed POs (usually returns empty array)
      const today = new Date()
      const unconfirmed = getUnconfirmedPOs(normalizedRows, today)
      
      setUnconfirmedPOs(unconfirmed)
      setLoading(false)
    } catch (e) {
      console.error('Error processing data:', e)
      setUnconfirmedPOs([])
      setLoading(false)
    }
  }, [])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-neutral-600">Loading...</div>
      </div>
    )
  }

  return (
    <div className="h-full">
      <div className="max-w-7xl mx-auto px-8 py-10">
        {/* Muted, low-interaction - calm surface */}
        <div className="mb-8">
          <h1 className="text-xl font-medium text-neutral-600 mb-1">Unconfirmed POs</h1>
          <p className="text-xs text-neutral-500">Passive monitoring of purchase orders awaiting confirmation</p>
        </div>

        {unconfirmedPOs.length === 0 ? (
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
          // Monitoring view when populated - muted surfaces
          <div className="space-y-4">
            {/* Summary - soft elevation */}
            <div className="bg-white/70 rounded-2xl shadow-sm px-6 py-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-neutral-400 uppercase tracking-wide mb-1">
                    Active unconfirmed POs
                  </div>
                  <div className="text-xl font-medium text-neutral-600">
                    {unconfirmedPOs.length}
                  </div>
                </div>
                <div className="text-xs text-neutral-400">
                  Passive monitoring only
                </div>
              </div>
            </div>

            {/* Monitoring List - no dividers, soft cards */}
            <div className="space-y-2">
              {unconfirmedPOs.map((po) => (
                <UnconfirmedPORow key={`${po.po_id}-${po.line_id || ''}`} po={po} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
