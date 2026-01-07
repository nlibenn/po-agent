'use client'

import { usePathname } from 'next/navigation'
import { useMemo } from 'react'

export interface ChatScope {
  type: 'case' | 'global'
  id?: string
}

export function useChatScope(): ChatScope {
  const pathname = usePathname()

  return useMemo(() => {
    const caseMatch = pathname?.match(/^\/exception\/([^/]+)$/)
    if (caseMatch) {
      return { type: 'case', id: caseMatch[1] }
    }
    return { type: 'global' }
  }, [pathname])
}
