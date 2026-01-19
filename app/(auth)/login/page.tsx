'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LoginBackdrop } from '@/components/auth/LoginBackdrop'

function LoginContent() {
  const searchParams = useSearchParams()
  const hasError = searchParams.get('error') === '1'
  const [isLoading, setIsLoading] = useState(false)

  const handleGoogleSignIn = () => {
    setIsLoading(true)
    window.location.href = '/api/gmail/auth'
  }

  return (
    <div className="min-h-screen w-full grid grid-cols-1 md:grid-cols-2">
      {/* Left Panel - Visual with animated backdrop */}
      <div 
        className="hidden md:block relative overflow-hidden"
        style={{
          background: `
            radial-gradient(ellipse at top left, rgb(var(--primary) / 0.14) 0%, transparent 55%),
            radial-gradient(ellipse at bottom left, rgb(var(--primary) / 0.10) 0%, transparent 60%),
            radial-gradient(ellipse at bottom center, rgb(var(--warning) / 0.06) 0%, transparent 55%),
            rgb(var(--surface-tint))
          `
        }}
      >
        <LoginBackdrop />
        {/* Content */}
        <div className="relative z-10 flex flex-col p-12 h-full">
          {/* Wordmark - Top left */}
          <div className="mb-auto">
            <h1 className="text-xl font-semibold text-text">Buyer Workbench</h1>
          </div>
          
          {/* Center content */}
          <div className="max-w-md space-y-6">
            <div className="space-y-4">
              <h2 className="text-3xl font-semibold text-text">Welcome back</h2>
              <p className="text-sm text-text-muted leading-relaxed">
                Manage purchase orders, track exceptions, and coordinate with suppliers—all in one place.
              </p>
            </div>
          </div>
          
          {/* Bottom spacing */}
          <div className="mt-auto" />
        </div>
      </div>

      {/* Right Panel - Sign-in Card */}
      <div className="relative flex items-center justify-center bg-bg px-6">
        {/* Soft gradient divider overlay at boundary */}
        <div 
          className="absolute left-0 top-0 bottom-0 w-8 pointer-events-none z-0"
          style={{
            background: 'linear-gradient(to right, rgb(var(--primary) / 0.04) 0%, transparent 100%)',
          }}
        />
        <div className="w-full max-w-md py-12 relative z-10">
          {/* Wordmark for mobile */}
          <div className="md:hidden mb-8">
            <h1 className="text-xl font-semibold text-text">Buyer Workbench</h1>
          </div>

          {/* Login Card */}
          <div className="bg-surface border border-border/70 rounded-lg shadow-soft p-8 space-y-6">
            {/* Title */}
            <div>
              <h1 className="text-3xl font-semibold text-text mb-2">Sign in</h1>
            </div>

            {/* Error Message */}
            {hasError && (
              <div className="px-4 py-3 rounded-xl bg-danger/12 border border-danger/25">
                <p className="text-sm text-danger">
                  There was an issue connecting your Gmail account. Please try again.
                </p>
              </div>
            )}

            {/* Sign-in Button */}
            <button
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="w-full px-6 py-3.5 rounded-xl bg-surface border border-border/70 hover:border-primary/50 hover:bg-surface-2 transition-colors shadow-sm flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              <span className="text-sm font-medium text-text">
                {isLoading ? 'Connecting...' : 'Continue with Google'}
              </span>
            </button>

            {/* Footnote */}
            <div className="pt-2">
              <p className="text-xs text-text-subtle text-center">
                Demo enabled for lisa.acembuyer@gmail.com
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="h-screen flex items-center justify-center bg-bg">
        <div className="text-text-muted">Loading...</div>
      </div>
    }>
      <LoginContent />
    </Suspense>
  )
}
