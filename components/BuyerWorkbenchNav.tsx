'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useWorkspace } from '@/components/WorkspaceProvider'
import { useEffect, useState } from 'react'
import { Home, FolderOpen, Package, AlertCircle, FileCheck, CheckSquare } from 'lucide-react'

const navItems = [
  { href: '/home', label: 'Home', priority: 'highest', dataDependent: false, icon: Home },
  { href: '/acknowledgements', label: 'Acknowledgements', priority: 'primary', dataDependent: true, icon: CheckSquare },
  { href: '/drive', label: 'Drive', priority: 'highest', dataDependent: false, icon: FolderOpen },
  // Hide these for now per scope - focus on acknowledgements only
  // { href: '/releases', label: 'Releases', priority: 'highest', dataDependent: true, icon: Package },
  // { href: '/exceptions', label: 'Exceptions', priority: 'primary', dataDependent: true, icon: AlertCircle },
  // { href: '/unconfirmed-pos', label: 'Unconfirmed POs', priority: 'muted', dataDependent: true, icon: FileCheck },
]

export function BuyerWorkbenchNav() {
  const pathname = usePathname()
  const { rows } = useWorkspace()
  const hasWorkspaceData = rows.length > 0
  const [isInspectorOpen, setIsInspectorOpen] = useState(false)
  
  // Check if inspector/workbench is open via body data attribute
  useEffect(() => {
    const checkInspector = () => {
      const isOpen = document.body.getAttribute('data-inspector-open') === 'true'
      const isAckWorkbench = document.body.getAttribute('data-ack-workbench') === 'true'
      setIsInspectorOpen(isOpen || isAckWorkbench)
    }
    
    // Check initially
    checkInspector()
    
    // Watch for changes via MutationObserver
    const observer = new MutationObserver(checkInspector)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-inspector-open', 'data-ack-workbench'] })
    
    return () => observer.disconnect()
  }, [])
  
  // Collapse on unconfirmed-pos page with inspector or on acknowledgements page (always icon-only)
  const isUnconfirmedPosPage = pathname === '/unconfirmed-pos'
  const isAcknowledgementsPage = pathname === '/acknowledgements'
  const shouldCollapse = (isUnconfirmedPosPage && isInspectorOpen) || isAcknowledgementsPage

  const getPriorityClasses = (priority: string, isActive: boolean, dataDependent: boolean, hasData: boolean) => {
    // Active state always wins - pill background takes precedence over workspace state
    if (isActive) {
      // Soft rounded pill for active state - state communicated via background and text color only
      // All nav items use consistent font-weight (default/normal)
      switch (priority) {
        case 'highest':
          return 'bg-primary-deep text-surface shadow-sm'
        case 'primary':
          return 'bg-primary-strong text-surface shadow-sm'
        case 'muted':
          return 'bg-surface-2 text-text'
        case 'informational':
          return 'bg-surface-tint text-text-muted'
        case 'lowest':
          return 'bg-surface-tint/50 text-text-subtle'
        default:
          return 'bg-primary-deep text-surface shadow-sm'
      }
    } else {
      // When no workspace data and item is data-dependent, use more muted colors from existing scale
      // All nav items use consistent font-weight (default/normal)
      if (dataDependent && !hasData) {
        switch (priority) {
          case 'highest':
            return 'text-text-subtle hover:bg-surface/40'
          case 'primary':
            return 'text-text-subtle hover:bg-surface/40'
          case 'muted':
            return 'text-text-subtle hover:bg-surface/40'
          case 'informational':
            return 'text-text-subtle hover:bg-surface/40'
          default:
            return 'text-text-subtle hover:bg-surface/40'
        }
      } else {
        switch (priority) {
          case 'highest':
            return 'text-text hover:bg-surface/40'
          case 'primary':
            return 'text-text hover:bg-surface/40'
          case 'muted':
            return 'text-text-muted hover:bg-surface/40'
          case 'informational':
            return 'text-text-subtle hover:bg-surface/40'
          case 'lowest':
            return 'text-text-subtle hover:bg-surface/40'
          default:
            return 'text-text hover:bg-surface/40'
        }
      }
    }
  }

  const renderIcon = (item: typeof navItems[0]) => {
    const IconComponent = item.icon
    return <IconComponent className={`${shouldCollapse ? 'w-5 h-5' : 'w-4 h-4 mr-2'} flex-shrink-0`} />
  }

  return (
    // Ensure sidebar stays clickable above any workbench overlays (e.g. /acknowledgements panels)
    <nav
      className={`relative z-50 pointer-events-auto flex flex-col h-full transition-all ${
        shouldCollapse ? 'w-16' : 'w-64'
      }`}
    >
      <div className={`${shouldCollapse ? 'px-3 py-4' : 'px-6 py-6'} transition-all`}>
        {!shouldCollapse && (
          <h1 className="text-base font-semibold text-text">Buyer Workbench</h1>
        )}
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
                className={`flex items-center ${shouldCollapse ? 'justify-center px-3' : 'px-4'} py-2.5 rounded-full text-sm transition-all ${classes}`}
                title={shouldCollapse ? item.label : undefined}
                aria-label={shouldCollapse ? item.label : undefined}
              >
                {renderIcon(item)}
                {!shouldCollapse && <span>{item.label}</span>}
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
