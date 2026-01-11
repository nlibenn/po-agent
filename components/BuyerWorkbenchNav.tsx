'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const navItems = [
  { href: '/releases', label: 'Releases', priority: 'highest' },
  { href: '/exceptions', label: 'Exceptions', priority: 'primary' },
  { href: '/unconfirmed-pos', label: 'Unconfirmed POs', priority: 'muted' },
  { href: '/invoices', label: 'Invoices', priority: 'informational' },
  { href: '/standard-work', label: 'Standard Work', priority: 'lowest' },
]

export function BuyerWorkbenchNav() {
  const pathname = usePathname()

  const getPriorityClasses = (priority: string, isActive: boolean) => {
    if (isActive) {
      // Soft rounded pill for active state
      switch (priority) {
        case 'highest':
          return 'bg-neutral-800 text-white font-semibold shadow-sm'
        case 'primary':
          return 'bg-neutral-700 text-white font-medium shadow-sm'
        case 'muted':
          return 'bg-neutral-100 text-neutral-700 font-medium'
        case 'informational':
          return 'bg-neutral-50 text-neutral-600 font-normal'
        case 'lowest':
          return 'bg-neutral-50/50 text-neutral-500 font-normal'
        default:
          return 'bg-neutral-800 text-white font-semibold shadow-sm'
      }
    } else {
      switch (priority) {
        case 'highest':
          return 'text-neutral-800 hover:bg-white/40 font-semibold'
        case 'primary':
          return 'text-neutral-700 hover:bg-white/40 font-medium'
        case 'muted':
          return 'text-neutral-500 hover:bg-white/40 font-normal'
        case 'informational':
          return 'text-neutral-400 hover:bg-white/40 font-normal'
        case 'lowest':
          return 'text-neutral-400 hover:bg-white/40 font-normal'
        default:
          return 'text-neutral-700 hover:bg-white/40'
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
            // Active state: exact match or starts with the href path (handles /exception/[id] for Exceptions)
            const isActive = pathname === item.href || 
              (item.href === '/exceptions' && pathname?.startsWith('/exception')) ||
              (item.href !== '/exceptions' && pathname?.startsWith(item.href + '/'))
            
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center px-4 py-2.5 rounded-full text-sm transition-all ${getPriorityClasses(item.priority, isActive)}`}
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
