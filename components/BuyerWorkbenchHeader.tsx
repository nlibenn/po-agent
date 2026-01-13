'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useWorkspace } from '@/components/WorkspaceProvider'
import { formatRelativeTime } from '@/src/lib/utils/relativeTime'

export function BuyerWorkbenchHeader() {
  const pathname = usePathname()
  const { filename, updatedAt, source } = useWorkspace()

  // Hide workspace indicator on Home page (Home page owns the workspace display)
  if (pathname === '/home' || pathname === '/') {
    return (
      <div className="px-6 py-3 bg-white/60 border-b border-neutral-200/30">
        {/* Minimal header on Home - no workspace indicator */}
      </div>
    )
  }

  const hasWorkspace = source === 'local' || source === 'sample'

  return (
    <div className="flex items-center justify-between px-6 py-3 bg-white/60 border-b border-neutral-200/30">
      <div className="flex items-center gap-3">
        {/* Workspace Indicator */}
        {hasWorkspace && filename && updatedAt ? (
          <>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Workspace:</span>
            <span className="text-xs text-neutral-700">{filename}</span>
            <span className="text-xs text-neutral-500">·</span>
            <span className="text-xs text-neutral-500">{formatRelativeTime(updatedAt)}</span>
            <Link
              href="/home"
              className="ml-2 text-xs font-medium text-neutral-700 hover:text-neutral-900 underline"
            >
              Change
            </Link>
          </>
        ) : (
          <>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Workspace:</span>
            <span className="text-xs text-neutral-500">No data loaded</span>
            <Link
              href="/home"
              className="ml-2 text-xs font-medium text-neutral-700 hover:text-neutral-900 underline"
            >
              Upload data
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
