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
      // #region agent log
      debugLog({location:'AuthGate.tsx:25',message:'checkAuth entry',data:{pathname},hypothesisId:'C'});
      // #endregion
      // Check for success parameter from OAuth callback
      const gmailConnected = searchParams?.get('gmail_connected') === '1'
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AuthGate.tsx:28',message:'Success param check',data:{gmailConnected},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      
      if (gmailConnected) {
        // OAuth just succeeded - wait a moment for KV write to complete, then check status
        console.log('[AUTH_GATE] Detected gmail_connected=1, waiting for token storage...')
        await new Promise(resolve => setTimeout(resolve, 500)) // Wait 500ms for KV write
      }

      try {
        // #region agent log
        debugLog({location:'AuthGate.tsx:36',message:'Before status fetch',data:{},hypothesisId:'C'});
        // #endregion
        const response = await fetch('/api/gmail/status')
        const data: GmailStatus = await response.json()
        // #region agent log
        debugLog({location:'AuthGate.tsx:38',message:'Status response received',data:{connected:data.connected},hypothesisId:'C'});
        // #endregion
        
        if (data.connected) {
          setIsAuthenticated(true)
          // Remove success parameter from URL if present
          if (gmailConnected) {
            const newUrl = new URL(window.location.href)
            newUrl.searchParams.delete('gmail_connected')
            router.replace(newUrl.pathname + newUrl.search)
          }
        } else {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/e9196934-1c8b-40c5-8b00-c00b336a7d56',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AuthGate.tsx:49',message:'Not connected, redirecting to login',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          // Not authenticated - redirect to login
          router.replace('/login')
        }
      } catch (error) {
        // #region agent log
        debugLog({location:'AuthGate.tsx:52',message:'Status fetch error',data:{errorMessage:error instanceof Error ? error.message : String(error),gmailConnected},hypothesisId:'C'});
        // #endregion
        console.error('Error checking auth:', error)
        // On error, redirect to login (unless we just got success param)
        if (!gmailConnected) {
          router.replace('/login')
        } else {
          // If we have success param but status check failed, wait a bit more and retry once
          console.log('[AUTH_GATE] Retrying status check after OAuth success...')
          await new Promise(resolve => setTimeout(resolve, 1000))
          try {
            const retryResponse = await fetch('/api/gmail/status')
            const retryData: GmailStatus = await retryResponse.json()
            if (retryData.connected) {
              setIsAuthenticated(true)
              const newUrl = new URL(window.location.href)
              newUrl.searchParams.delete('gmail_connected')
              router.replace(newUrl.pathname + newUrl.search)
            } else {
              router.replace('/login')
            }
          } catch (retryError) {
            console.error('Error on retry:', retryError)
            router.replace('/login')
          }
        }
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
