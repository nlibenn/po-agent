'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

interface GmailStatus {
  connected: boolean
  email?: string
  scopes?: string[]
}

/**
 * Client-side auth gate component.
 * Auth state is tri-state: loading | authenticated | unauthenticated.
 * No redirects happen while state is 'loading'.
 * Once resolved to 'authenticated', the state is sticky — subsequent
 * effect re-runs (e.g. searchParams change) won't downgrade it.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [authState, setAuthState] = useState<AuthState>('loading')
  const resolvedRef = useRef(false)

  useEffect(() => {
    // Once auth has been resolved, never re-check. This prevents
    // the searchParams dependency from re-triggering after we
    // strip gmail_connected from the URL.
    if (resolvedRef.current) return

    const checkAuth = async () => {
      const gmailConnected = searchParams?.get('gmail_connected') === '1'

      if (gmailConnected) {
        console.log('[AUTH_GATE] Detected gmail_connected=1, granting immediate access')
        resolvedRef.current = true
        setAuthState('authenticated')
        // Strip the param from URL
        const newUrl = new URL(window.location.href)
        newUrl.searchParams.delete('gmail_connected')
        router.replace(newUrl.pathname + newUrl.search)
        return
      }

      try {
        const response = await fetch('/api/gmail/status')
        const data: GmailStatus = await response.json()
        resolvedRef.current = true

        if (data.connected) {
          setAuthState('authenticated')
        } else {
          setAuthState('unauthenticated')
          router.replace('/login')
        }
      } catch (error) {
        console.error('[AUTH_GATE] Error checking auth:', error)
        resolvedRef.current = true
        setAuthState('unauthenticated')
        router.replace('/login')
      }
    }

    if (pathname !== '/login') {
      checkAuth()
    } else {
      resolvedRef.current = true
      setAuthState('authenticated') // login page doesn't need gating
    }
  }, [router, pathname, searchParams])

  if (authState === 'loading') {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-neutral-600">Loading...</div>
      </div>
    )
  }

  if (authState === 'unauthenticated' && pathname !== '/login') {
    return null
  }

  return <>{children}</>
}
