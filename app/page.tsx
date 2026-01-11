'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    // Redirect to releases as default section
    router.replace('/releases')
  }, [router])

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-neutral-600">Redirecting...</div>
    </div>
  )
}
