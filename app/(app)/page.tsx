'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface GmailStatus {
  connected: boolean
  email?: string
  scopes?: string[]
}

export default function HomePage() {
  const router = useRouter()
  const [isChecking, setIsChecking] = useState(true)

  useEffect(() => {
    const checkGmailStatus = async () => {
      try {
        const response = await fetch('/api/gmail/status')
        const data: GmailStatus = await response.json()
        
        if (data.connected) {
          router.replace('/home')
        } else {
          router.replace('/login')
        }
      } catch (error) {
        console.error('Error checking Gmail status:', error)
        // On error, redirect to login
        router.replace('/login')
      } finally {
        setIsChecking(false)
      }
    }

    checkGmailStatus()
  }, [router])

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-neutral-600">Redirecting...</div>
    </div>
  )
}
