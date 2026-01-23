'use client'

import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { CaseState } from '@/src/lib/supplier-agent/types'

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface TaskStep {
  id: string
  label: string
  status: TaskStepStatus
}

export interface ConfirmedPO {
  po_number: string
  line_id: string
  supplier_name: string | null
  supplier_order_number: string | null
  delivery_date: string | null
  quantity: number | null
  unit_price: number | null
  confirmed_at: number
}

interface AgentStateStore {
  // Session tracking
  session: {
    totalPOs: number
    confirmedPOs: ConfirmedPO[]
    inProgressPOs: number
    pendingPOs: number
  }
  
  // Current task tracking
  currentTask: {
    poNumber: string | null
    lineId: string | null
    steps: TaskStep[]
  }
  
  // Data sources
  dataSources: {
    csvFilename: string | null
    csvPOCount: number
    gmailConnected: boolean
    pdfs: { filename: string; attachmentId: string }[]
  }
}

interface AgentStateContextType extends AgentStateStore {
  // Session actions
  setTotalPOs: (count: number) => void
  addConfirmedPO: (po: ConfirmedPO) => void
  updateSessionCounts: (counts: { total: number; confirmed: number; inProgress: number; pending: number }) => void
  
  // Task actions
  setCurrentTask: (poNumber: string | null, lineId: string | null) => void
  updateTaskStep: (stepId: string, status: TaskStepStatus, label?: string) => void
  addTaskStep: (step: TaskStep) => void
  resetTask: () => void
  
  // Data sources actions
  setCSVSource: (filename: string | null, poCount: number) => void
  setGmailStatus: (connected: boolean) => void
  setPDFs: (pdfs: { filename: string; attachmentId: string }[]) => void
}

const AgentStateContext = createContext<AgentStateContextType | undefined>(undefined)

export function AgentStateProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AgentStateStore['session']>({
    totalPOs: 0,
    confirmedPOs: [],
    inProgressPOs: 0,
    pendingPOs: 0,
  })
  
  const [currentTask, setCurrentTaskState] = useState<AgentStateStore['currentTask']>({
    poNumber: null,
    lineId: null,
    steps: [],
  })
  
  const [dataSources, setDataSources] = useState<AgentStateStore['dataSources']>({
    csvFilename: null,
    csvPOCount: 0,
    gmailConnected: false,
    pdfs: [],
  })

  const setTotalPOs = useCallback((count: number) => {
    setSession(prev => ({ ...prev, totalPOs: count }))
  }, [])

  const addConfirmedPO = useCallback((po: ConfirmedPO) => {
    setSession(prev => {
      // Check if PO already exists
      const exists = prev.confirmedPOs.some(
        p => p.po_number === po.po_number && p.line_id === po.line_id
      )
      if (exists) return prev
      
      return {
        ...prev,
        confirmedPOs: [...prev.confirmedPOs, po],
      }
    })
  }, [])

  const updateSessionCounts = useCallback((counts: {
    total: number
    confirmed: number
    inProgress: number
    pending: number
  }) => {
    setSession(prev => ({
      ...prev,
      totalPOs: counts.total,
      inProgressPOs: counts.inProgress,
      pendingPOs: counts.pending,
    }))
  }, [])

  const setCurrentTask = useCallback((poNumber: string | null, lineId: string | null) => {
    setCurrentTaskState({
      poNumber,
      lineId,
      steps: [],
    })
  }, [])

  const updateTaskStep = useCallback((stepId: string, status: TaskStepStatus, label?: string) => {
    setCurrentTaskState(prev => ({
      ...prev,
      steps: prev.steps.map(step =>
        step.id === stepId
          ? { ...step, status, ...(label ? { label } : {}) }
          : step
      ),
    }))
  }, [])

  const addTaskStep = useCallback((step: TaskStep) => {
    setCurrentTaskState(prev => ({
      ...prev,
      steps: [...prev.steps, step],
    }))
  }, [])

  const resetTask = useCallback(() => {
    setCurrentTaskState({
      poNumber: null,
      lineId: null,
      steps: [],
    })
  }, [])

  const setCSVSource = useCallback((filename: string | null, poCount: number) => {
    setDataSources(prev => ({
      ...prev,
      csvFilename: filename,
      csvPOCount: poCount,
    }))
  }, [])

  const setGmailStatus = useCallback((connected: boolean) => {
    setDataSources(prev => ({
      ...prev,
      gmailConnected: connected,
    }))
  }, [])

  const setPDFs = useCallback((pdfs: { filename: string; attachmentId: string }[]) => {
    setDataSources(prev => ({
      ...prev,
      pdfs,
    }))
  }, [])

  return (
    <AgentStateContext.Provider
      value={{
        session,
        currentTask,
        dataSources,
        setTotalPOs,
        addConfirmedPO,
        updateSessionCounts,
        setCurrentTask,
        updateTaskStep,
        addTaskStep,
        resetTask,
        setCSVSource,
        setGmailStatus,
        setPDFs,
      }}
    >
      {children}
    </AgentStateContext.Provider>
  )
}

export function useAgentState() {
  const context = useContext(AgentStateContext)
  if (!context) {
    throw new Error('useAgentState must be used within AgentStateProvider')
  }
  return context
}
