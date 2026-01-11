'use client'

import { UnconfirmedPO } from '@/src/lib/unconfirmedPOs'
import { formatAgentActivityStatus } from '@/src/lib/unconfirmedPOs'

interface UnconfirmedPORowProps {
  po: UnconfirmedPO
}

export function UnconfirmedPORow({ po }: UnconfirmedPORowProps) {
  const formatDate = (date?: Date) => {
    if (!date) return '—'
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(date)
  }

  // Removed icons - no excessive icons per requirements
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'waiting':
        return 'text-neutral-500'
      case 'chasing':
        return 'text-neutral-600'
      case 'escalated':
        return 'text-neutral-700'
      default:
        return 'text-neutral-500'
    }
  }

  return (
    <div className="p-5 rounded-2xl bg-white/70 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* PO Reference and Supplier - muted */}
          <div className="flex items-center gap-3 mb-4">
            <span className="text-sm font-normal text-neutral-600">
              {po.po_id}{po.line_id ? `-${po.line_id}` : ''}
            </span>
            <span className="text-sm text-neutral-500">{po.supplier_name}</span>
          </div>

          {/* Days Since Sent */}
          <div className="flex items-center gap-6 mb-3">
            <div>
              <div className="text-xs font-normal text-neutral-400 uppercase tracking-wide mb-1">
                Days since sent
              </div>
              <div className="text-sm font-medium text-neutral-600">
                {po.days_since_sent} {po.days_since_sent === 1 ? 'day' : 'days'}
              </div>
            </div>

            {/* Agent Activity Status - muted, no icon */}
            <div>
              <div className="text-xs font-normal text-neutral-400 uppercase tracking-wide mb-1">
                Agent activity
              </div>
              <div className={`text-sm font-normal ${getStatusColor(po.agent_activity_status)}`}>
                {formatAgentActivityStatus(po.agent_activity_status, po.agent_activity_days)}
              </div>
            </div>
          </div>

          {/* Next Queued Escalation - muted, no divider */}
          {po.next_escalation_action && (
            <div className="mt-4 pt-4 border-t border-neutral-200/50">
              <div className="text-xs font-normal text-neutral-400 uppercase tracking-wide mb-1">
                Next queued escalation
              </div>
              <div className="flex items-center gap-2">
                <div className="text-sm text-neutral-500">
                  {po.next_escalation_action}
                </div>
                {po.next_escalation_date && (
                  <span className="text-xs text-neutral-400">
                    ({formatDate(po.next_escalation_date)})
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
