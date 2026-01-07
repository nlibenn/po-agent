'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
}

interface ChatContextType {
  messages: Message[]
  addMessage: (message: Message) => void
  clearMessages: () => void
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

const STORAGE_KEY = 'companion_chat_messages'

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Load messages from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Message[]
        setMessages(parsed)
      }
    } catch (e) {
      console.error('Error loading chat messages:', e)
    }
  }, [])

  // Save messages to sessionStorage whenever they change
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    } catch (e) {
      console.error('Error saving chat messages:', e)
    }
  }, [messages])

  const addMessage = useCallback((message: Message) => {
    setMessages(prev => [...prev, { ...message, timestamp: Date.now() }])
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch (e) {
      console.error('Error clearing chat messages:', e)
    }
  }, [])

  return (
    <ChatContext.Provider
      value={{
        messages,
        addMessage,
        clearMessages,
        isLoading,
        setIsLoading,
      }}
    >
      {children}
    </ChatContext.Provider>
  )
}

export function useChat() {
  const context = useContext(ChatContext)
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider')
  }
  return context
}
