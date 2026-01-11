'use client'

import { ExceptionInboxItem } from '@/src/lib/exceptionInbox'

interface ExceptionInboxRowProps {
  exception: ExceptionInboxItem
  onClick: () => void
}

export function ExceptionInboxRow({ exception, onClick }: ExceptionInboxRowProps) {
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

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-5 rounded-2xl bg-white/70 hover:bg-white/85 shadow-sm hover:shadow-md transition-all group"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* PO Reference and Status */}
          <div className="flex items-center gap-3 mb-3">
            <span className="text-sm font-medium text-neutral-800">
              {exception.po_id}-{exception.line_id}
            </span>
            <div className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(exception.current_status)}`}>
              {getStatusLabel(exception.current_status)}
            </div>
          </div>

          {/* Issue Summary */}
          <p className="text-sm text-neutral-700 leading-relaxed">{exception.issue_summary}</p>
        </div>
      </div>
    </button>
  )
}
