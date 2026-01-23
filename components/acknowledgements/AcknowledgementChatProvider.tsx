'use client'

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

export interface AckMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  metadata?: {
    command?: string
    result?: any
    error?: string
  }
}

interface AckChatContextType {
  messages: AckMessage[]
  addMessage: (message: Omit<AckMessage, 'id' | 'timestamp'>) => void
  clearMessages: () => void
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
  caseId: string | null
  setCaseId: (caseId: string | null) => void
}

const AckChatContext = createContext<AckChatContextType | undefined>(undefined)

const STORAGE_KEY_PREFIX = 'ack_chat_'

/**
 * Case-scoped chat provider for acknowledgement workflow
 * Messages are stored per-case in sessionStorage
 */
export function AcknowledgementChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<AckMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [caseId, setCaseIdInternal] = useState<string | null>(null)

  // Load messages when caseId changes
  useEffect(() => {
    if (!caseId) {
      setMessages([])
      return
    }

    try {
      const stored = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${caseId}`)
      if (stored) {
        const parsed = JSON.parse(stored) as AckMessage[]
        setMessages(parsed)
      } else {
        setMessages([])
      }
    } catch (e) {
      console.error('Error loading ack chat messages:', e)
      setMessages([])
    }
  }, [caseId])

  // Save messages to sessionStorage whenever they change
  useEffect(() => {
    if (!caseId) return
    
    try {
      sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${caseId}`, JSON.stringify(messages))
    } catch (e) {
      console.error('Error saving ack chat messages:', e)
    }
  }, [messages, caseId])

  const addMessage = useCallback((message: Omit<AckMessage, 'id' | 'timestamp'>) => {
    const newMessage: AckMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, newMessage])
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    if (caseId) {
      try {
        sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${caseId}`)
      } catch (e) {
        console.error('Error clearing ack chat messages:', e)
      }
    }
  }, [caseId])

  const setCaseId = useCallback((newCaseId: string | null) => {
    setCaseIdInternal(newCaseId)
  }, [])

  return (
    <AckChatContext.Provider
      value={{
        messages,
        addMessage,
        clearMessages,
        isLoading,
        setIsLoading,
        caseId,
        setCaseId,
      }}
    >
      {children}
    </AckChatContext.Provider>
  )
}

export function useAckChat() {
  const context = useContext(AckChatContext)
  if (context === undefined) {
    throw new Error('useAckChat must be used within an AcknowledgementChatProvider')
  }
  return context
}
