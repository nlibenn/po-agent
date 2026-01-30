'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Root page inside (app) layout — just redirects to /home.
 * Auth gating is handled by AuthGate in the layout; no need
 * to duplicate the gmail status check here.
 */
export default function RootPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/home')
  }, [router])

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-neutral-600">Redirecting...</div>
    </div>
  )
}
