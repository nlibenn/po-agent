'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'

interface GmailStatus {
  connected: boolean
  email?: string
  scopes?: string[]
}

/**
 * Client-side auth gate component
 * Checks Gmail auth status and redirects to /login if not authenticated
 * Only renders children if authenticated
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [isChecking, setIsChecking] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/gmail/status')
        const data: GmailStatus = await response.json()
        
        if (data.connected) {
          setIsAuthenticated(true)
        } else {
          // Not authenticated - redirect to login
          router.replace('/login')
        }
      } catch (error) {
        console.error('Error checking auth:', error)
        // On error, redirect to login
        router.replace('/login')
      } finally {
        setIsChecking(false)
      }
    }

    // Only check auth for app routes (not login page)
    if (pathname !== '/login') {
      checkAuth()
    } else {
      setIsChecking(false)
    }
  }, [router, pathname])

  // Show loading state while checking
  if (isChecking) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-neutral-600">Loading...</div>
      </div>
    )
  }

  // Only render children if authenticated (or on login page)
  if (!isAuthenticated && pathname !== '/login') {
    return null // Will redirect, so return nothing
  }

  return <>{children}</>
}
