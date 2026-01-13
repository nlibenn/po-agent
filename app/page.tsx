'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    // Redirect to home as default section
    router.replace('/home')
  }, [router])

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-neutral-600">Redirecting...</div>
    </div>
  )
}
