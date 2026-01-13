'use client'

import { createContext, useContext, ReactNode } from 'react'
import { useBuyerWorkspace, UseBuyerWorkspaceReturn } from '@/src/hooks/useBuyerWorkspace'

const WorkspaceContext = createContext<UseBuyerWorkspaceReturn | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useBuyerWorkspace()
  
  return (
    <WorkspaceContext.Provider value={workspace}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error('useWorkspace must be used within WorkspaceProvider')
  }
  return context
}
