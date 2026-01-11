'use client'

import { X } from 'lucide-react'
import { ExceptionInboxItem } from '@/src/lib/exceptionInbox'

interface ExceptionSidePanelProps {
  exception: ExceptionInboxItem | null
  onClose: () => void
  onAction: (action: 'approve' | 'override' | 'hold', exceptionId: string) => void
}

export function ExceptionSidePanel({ exception, onClose, onAction }: ExceptionSidePanelProps) {
  if (!exception) return null

  const getStatusColor = (status: string) => {
    // Soft pill-shaped badges, no borders
    switch (status) {
      case 'awaiting_buyer':
        return 'bg-neutral-100 text-neutral-800'
      case 'blocked':
        return 'bg-neutral-200 text-neutral-800'
      case 'resolved':
        return 'bg-neutral-50 text-neutral-600'
      default:
        return 'bg-neutral-50 text-neutral-700'
    }
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'awaiting_buyer':
        return 'Awaiting buyer'
      case 'blocked':
        return 'Blocked'
      case 'resolved':
        return 'Resolved'
      default:
        return status
    }
  }

  // Removed icons - no excessive icons per requirements
  // Keeping minimal visual indicators only

  const formatTimestamp = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  return (
    <>
      {/* Backdrop - subtle */}
      <div 
        className="fixed inset-0 bg-black/10 z-30 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Side Panel - elevated floating surface */}
      <div className="fixed inset-y-0 right-0 w-[600px] bg-white/85 backdrop-blur-md shadow-2xl z-40 flex flex-col">
        {/* Header - no border, soft separation */}
        <div className="flex-shrink-0 px-8 py-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-neutral-800">Exception Details</h2>
            <button
              onClick={onClose}
              className="p-1.5 text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100/50 rounded-xl transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className={`px-3 py-1.5 rounded-full text-xs font-medium ${getStatusColor(exception.current_status)}`}>
              {getStatusLabel(exception.current_status)}
            </div>
            <div className="text-sm text-neutral-600">
              PO {exception.po_id} • Line {exception.line_id}
            </div>
          </div>
        </div>

        {/* Scrollable Content - calm surfaces */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="space-y-8">
            {/* Issue Summary */}
            <div>
              <h3 className="text-sm font-semibold text-neutral-800 mb-3">Issue Summary</h3>
              <p className="text-sm text-neutral-700 leading-relaxed">{exception.issue_summary}</p>
            </div>

            {/* Agent Action Timeline - no icons, clean typography */}
            <div>
              <h3 className="text-sm font-semibold text-neutral-800 mb-4">Agent Action Timeline</h3>
              <div className="space-y-5">
                {exception.agent_attempts.map((action) => (
                  <div key={action.id} className="flex gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-medium text-neutral-800">{action.title}</span>
                        <span className="text-xs text-neutral-500">{formatTimestamp(action.timestamp)}</span>
                      </div>
                      <p className="text-xs text-neutral-600 leading-relaxed mb-3">{action.description}</p>
                      {action.outcome && (
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2.5 py-1 rounded-full ${
                            action.outcome === 'success' ? 'bg-neutral-100 text-neutral-700' :
                            action.outcome === 'failed' ? 'bg-neutral-200 text-neutral-800' :
                            action.outcome === 'requires_buyer' ? 'bg-neutral-100 text-neutral-700' :
                            'bg-neutral-50 text-neutral-700'
                          }`}>
                            {action.outcome === 'requires_buyer' ? 'Awaiting buyer' : action.outcome}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Next Agent Step - soft elevation */}
            {exception.next_agent_step && (
              <div className="bg-neutral-100/50 rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-neutral-800 mb-2">Recommended Next Step</h3>
                <p className="text-sm text-neutral-700 mb-2">{exception.next_agent_step.action}</p>
                <p className="text-xs text-neutral-600">{exception.next_agent_step.reason}</p>
              </div>
            )}

            {/* Parsed Evidence - soft surface */}
            <div>
              <h3 className="text-sm font-semibold text-neutral-800 mb-4">Parsed Evidence</h3>
              <div className="bg-neutral-50/50 rounded-2xl shadow-sm p-5 space-y-4">
                <div>
                  <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Signals Detected</div>
                  <div className="flex flex-wrap gap-2">
                    {exception.triage.signals.length > 0 ? (
                      exception.triage.signals.map((signal, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-white/70 text-neutral-700 shadow-sm"
                        >
                          {signal}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-neutral-500">No signals detected</span>
                    )}
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-neutral-200/50">
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Supplier</div>
                    <div className="text-sm text-neutral-800">{exception.supplier_name || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Part Number</div>
                    <div className="text-sm text-neutral-800">{exception.row.part_num || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Quantity</div>
                    <div className="text-sm text-neutral-800">{exception.row.order_qty !== null ? exception.row.order_qty.toLocaleString() : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Unit Price</div>
                    <div className="text-sm text-neutral-800">
                      {exception.row.unit_price !== null ? `$${exception.row.unit_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Due Date</div>
                    <div className="text-sm text-neutral-800">
                      {exception.row.due_date ? exception.row.due_date.toLocaleDateString() : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Receipt Date</div>
                    <div className="text-sm text-neutral-800">{exception.row.receipt_date || '—'}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-1">Description</div>
                    <div className="text-sm text-neutral-800">{exception.row.description || '—'}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions - soft elevation, no border */}
        <div className="flex-shrink-0 px-8 py-6 bg-neutral-50/50 backdrop-blur-sm space-y-3">
          <div className="text-xs font-medium text-neutral-800 mb-3">Buyer Actions</div>
          <div className="flex gap-3">
            <button
              onClick={() => onAction('approve', exception.id)}
              className="flex-1 px-4 py-3 text-sm font-medium text-white bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 shadow-sm"
            >
              Approve Next Step
            </button>
            <button
              onClick={() => onAction('override', exception.id)}
              className="flex-1 px-4 py-3 text-sm font-medium text-neutral-800 bg-white/70 hover:bg-white/85 rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 shadow-sm"
            >
              Override Agent
            </button>
            <button
              onClick={() => onAction('hold', exception.id)}
              className="flex-1 px-4 py-3 text-sm font-medium text-neutral-800 bg-white/70 hover:bg-white/85 rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-800 focus:ring-offset-2 shadow-sm"
            >
              Hold
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
