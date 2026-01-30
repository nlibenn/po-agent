'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

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
  const searchParams = useSearchParams()
  const [isChecking, setIsChecking] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    const checkAuth = async () => {
      // Check for success parameter from OAuth callback
      const gmailConnected = searchParams?.get('gmail_connected') === '1'
      
      if (gmailConnected) {
        // OAuth callback just redirected here — trust the server-side
        // redirect and grant immediate access. This avoids a race where
        // KV hasn't propagated the token yet and /api/gmail/status
        // returns connected: false, causing a redirect loop.
        console.log('[AUTH_GATE] Detected gmail_connected=1, granting immediate access')
        setIsAuthenticated(true)
        setIsChecking(false)
        // Clean the query param from the URL
        const newUrl = new URL(window.location.href)
        newUrl.searchParams.delete('gmail_connected')
        router.replace(newUrl.pathname + newUrl.search)
        return
      }

      try {
        const response = await fetch('/api/gmail/status')
        const data: GmailStatus = await response.json()

        if (data.connected) {
          setIsAuthenticated(true)
        } else {
          router.replace('/login')
        }
      } catch (error) {
        console.error('[AUTH_GATE] Error checking auth:', error)
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
  }, [router, pathname, searchParams])

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
