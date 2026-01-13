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
    <div className="border border-neutral-200/50 rounded-xl overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-neutral-50/50 transition-colors"
      >
        <span className="text-sm font-medium text-neutral-700">{title}</span>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-neutral-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-neutral-500" />
        )}
      </button>
      {isOpen && (
        <div className="px-4 py-3 bg-neutral-50/30 border-t border-neutral-200/50">
          {children}
        </div>
      )}
    </div>
  )
}
