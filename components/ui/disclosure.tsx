'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface DisclosureProps {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}

export function Disclosure({ title, children, defaultOpen = false }: DisclosureProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="border border-border/70 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-surface-2 transition-colors"
      >
        <span className="text-sm font-medium text-text">{title}</span>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-text-subtle" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-subtle" />
        )}
      </button>
      {isOpen && (
        <div className="px-4 py-3 bg-surface-2 border-t border-border/70">
          {children}
        </div>
      )}
    </div>
  )
}
