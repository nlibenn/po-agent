'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useWorkspace } from '@/components/WorkspaceProvider'

const navItems = [
  { href: '/home', label: 'Home', priority: 'highest', dataDependent: false },
  { href: '/releases', label: 'Releases', priority: 'highest', dataDependent: true },
  { href: '/exceptions', label: 'Exceptions', priority: 'primary', dataDependent: true },
  { href: '/unconfirmed-pos', label: 'Unconfirmed POs', priority: 'muted', dataDependent: true },
  { href: '/invoices', label: 'Invoices', priority: 'informational', dataDependent: true },
  { href: '/standard-work', label: 'Standard Work', priority: 'lowest', dataDependent: false },
]

export function BuyerWorkbenchNav() {
  const pathname = usePathname()
  const { rows } = useWorkspace()
  const hasWorkspaceData = rows.length > 0

  const getPriorityClasses = (priority: string, isActive: boolean, dataDependent: boolean, hasData: boolean) => {
    // Active state always wins - pill background takes precedence over workspace state
    if (isActive) {
      // Soft rounded pill for active state - state communicated via background and text color only
      // All nav items use consistent font-weight (default/normal)
      switch (priority) {
        case 'highest':
          return 'bg-neutral-800 text-white shadow-sm'
        case 'primary':
          return 'bg-neutral-700 text-white shadow-sm'
        case 'muted':
          return 'bg-neutral-100 text-neutral-700'
        case 'informational':
          return 'bg-neutral-50 text-neutral-600'
        case 'lowest':
          return 'bg-neutral-50/50 text-neutral-500'
        default:
          return 'bg-neutral-800 text-white shadow-sm'
      }
    } else {
      // When no workspace data and item is data-dependent, use more muted colors from existing scale
      // All nav items use consistent font-weight (default/normal)
      if (dataDependent && !hasData) {
        switch (priority) {
          case 'highest':
            return 'text-neutral-400 hover:bg-white/40'
          case 'primary':
            return 'text-neutral-400 hover:bg-white/40'
          case 'muted':
            return 'text-neutral-400 hover:bg-white/40'
          case 'informational':
            return 'text-neutral-400 hover:bg-white/40'
          default:
            return 'text-neutral-400 hover:bg-white/40'
        }
      } else {
        switch (priority) {
          case 'highest':
            return 'text-neutral-800 hover:bg-white/40'
          case 'primary':
            return 'text-neutral-700 hover:bg-white/40'
          case 'muted':
            return 'text-neutral-500 hover:bg-white/40'
          case 'informational':
            return 'text-neutral-400 hover:bg-white/40'
          case 'lowest':
            return 'text-neutral-400 hover:bg-white/40'
          default:
            return 'text-neutral-700 hover:bg-white/40'
        }
      }
    }
  }

  return (
    <nav className="flex flex-col h-full">
      <div className="px-6 py-6">
        <h1 className="text-base font-semibold text-neutral-800">Buyer Workbench</h1>
      </div>
      <div className="flex-1 py-2 px-3">
        <div className="space-y-1">
          {navItems.map((item) => {
            // Active state: exact match OR pathname starts with href + "/" (for nested routes)
            // Special case: /home is active on root / as well
            // Special case: /exceptions matches /exception/[id] (singular)
            let isActive = false
            if (pathname === item.href) {
              isActive = true
            } else if (pathname === '/' && item.href === '/home') {
              isActive = true
            } else if (item.href === '/exceptions' && pathname?.startsWith('/exception')) {
              isActive = true
            } else if (pathname?.startsWith(item.href + '/')) {
              isActive = true
            }
            
            // When active, always use active pill styles (ignore workspace state)
            const classes = getPriorityClasses(item.priority, isActive, item.dataDependent, hasWorkspaceData)
            
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center px-4 py-2.5 rounded-full text-sm transition-all ${classes}`}
              >
                <span>{item.label}</span>
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
