'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { formatRelativeTime } from '@/src/lib/utils/relativeTime'
import { getDriveSummary } from '@/src/lib/driveStorage'

interface GmailStatus {
  connected: boolean
  email?: string
  scopes?: string[]
}

export default function HomePage() {
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null)
  const [isCheckingGmail, setIsCheckingGmail] = useState(true)
  const [showComingSoonModal, setShowComingSoonModal] = useState(false)
  const [driveSummary, setDriveSummary] = useState<{
    totalDocuments: number
    lastUpload: number | null
  }>({ totalDocuments: 0, lastUpload: null })

  useEffect(() => {
    const checkGmailStatus = async () => {
      try {
        const response = await fetch('/api/gmail/status')
        const data: GmailStatus = await response.json()
        setGmailStatus(data)
      } catch (error) {
        console.error('Error checking Gmail status:', error)
        setGmailStatus({ connected: false })
      } finally {
        setIsCheckingGmail(false)
      }
    }

    checkGmailStatus()

    // Load Drive summary
    const loadDriveSummary = () => {
      const summary = getDriveSummary()
      setDriveSummary({
        totalDocuments: summary.totalDocuments,
        lastUpload: summary.lastUpload,
      })
    }

    loadDriveSummary()

    // Listen for storage changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'drive_documents_v1') {
        loadDriveSummary()
      }
    }
    
    // Listen for custom storage event (same-tab updates)
    const handleCustomStorageChange = () => {
      loadDriveSummary()
    }
    
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('driveStorageChanged', handleCustomStorageChange)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('driveStorageChanged', handleCustomStorageChange)
    }
  }, [])

  const handleConnectGmail = () => {
    window.location.href = '/api/gmail/auth'
  }

  return (
    <div className="h-full">
      <div className="max-w-2xl mx-auto px-8 py-12">
        {/* Gmail Connection Banner */}
        {!isCheckingGmail && gmailStatus && !gmailStatus.connected && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-surface-tint border border-primary/20 flex items-center justify-between">
            <div className="flex-1">
              <p className="text-sm text-primary-deep">
                Connect your Gmail account to enable supplier outreach and email features.
              </p>
            </div>
            <button
              onClick={handleConnectGmail}
              className="ml-4 px-4 py-2 rounded-lg text-sm font-medium text-surface bg-primary hover:bg-primary-strong transition-colors shadow-sm flex-shrink-0"
            >
              Connect Gmail
            </button>
          </div>
        )}

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-text mb-2">Overview</h1>
          <p className="text-sm text-text-muted">Your purchase order workspace</p>
        </div>

        {/* Drive Summary Card */}
        {driveSummary.totalDocuments > 0 ? (
          <div className="bg-surface rounded-2xl shadow-soft border border-border/70 p-6 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text">
                  Using {driveSummary.totalDocuments} {driveSummary.totalDocuments === 1 ? 'uploaded document' : 'uploaded documents'}
                </div>
                {driveSummary.lastUpload && (
                  <div className="text-xs text-text-subtle mt-1">
                    Last updated {formatRelativeTime(driveSummary.lastUpload)}
                  </div>
                )}
              </div>
              <Link
                href="/drive"
                className="ml-4 px-4 py-2 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 transition-colors shadow-sm flex-shrink-0"
              >
                Go to Drive
              </Link>
            </div>
          </div>
        ) : (
          <div className="bg-surface rounded-2xl shadow-soft border border-border/70 p-6 mb-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-muted">
                  No documents uploaded
                </div>
              </div>
              <Link
                href="/drive"
                className="ml-4 px-4 py-2 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 transition-colors shadow-sm flex-shrink-0"
              >
                Go to Drive
              </Link>
            </div>
          </div>
        )}

        {/* Connect your tools Section */}
        <div className="mt-8 bg-surface rounded-2xl shadow-soft border border-border/70 p-8">
          <h2 className="text-lg font-semibold text-text text-center mb-8">
            Connect your tools
          </h2>
          <div className="flex flex-wrap justify-center gap-5">
            {['SAP', 'Oracle', 'NetSuite', 'MES', 'WMS', 'SCM'].map((tool) => (
              <button
                key={tool}
                onClick={() => setShowComingSoonModal(true)}
                className="w-16 h-16 rounded-full bg-surface border border-border shadow-sm hover:shadow-md hover:border-primary/50 hover:scale-105 transition-all flex items-center justify-center active:scale-95"
                title={tool}
              >
                <span className="text-[11px] font-medium text-text hover:text-primary-deep text-center leading-tight px-1.5">
                  {tool}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Coming Soon Modal */}
      {showComingSoonModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Overlay */}
          <div
            className="fixed inset-0 bg-shadow/10 backdrop-blur-[2px]"
            onClick={() => setShowComingSoonModal(false)}
          />
          {/* Modal Content */}
          <div className="relative bg-surface rounded-2xl shadow-lift border border-border/70 p-6 max-w-sm w-full">
            <h3 className="text-lg font-semibold text-text mb-3">Coming soon</h3>
            <p className="text-sm text-text-muted mb-6 leading-relaxed">
              This integration is on our roadmap. For now, upload documents in Drive or run the Confirmation Agent from Unconfirmed POs.
            </p>
            <button
              onClick={() => setShowComingSoonModal(false)}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-medium text-surface bg-primary-deep hover:bg-primary-deep/90 transition-colors shadow-sm"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
