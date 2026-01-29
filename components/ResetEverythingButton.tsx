'use client'

import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { clearDriveDocuments } from '@/src/lib/driveStorage'

interface ResetEverythingButtonProps {
  className?: string
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
}

/**
 * ResetEverythingButton
 *
 * Provides a "Reset Everything" button that clears:
 * - All SQLite tables (cases, events, messages, attachments, confirmations)
 * - Gmail OAuth tokens
 * - localStorage (Drive documents, workspace data, chat messages)
 * - sessionStorage (all keys)
 *
 * Requires typing "RESET EVERYTHING" to confirm.
 * Only available in demo/dev mode (enforced by API).
 */
export function ResetEverythingButton({
  className,
  variant = 'outline',
  size = 'default'
}: ResetEverythingButtonProps) {
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isResetting, setIsResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isConfirmValid = confirmText === 'RESET EVERYTHING'

  const handleReset = async () => {
    if (!isConfirmValid) return

    setIsResetting(true)
    setError(null)

    try {
      // Call server-side reset endpoint
      const response = await fetch('/api/debug/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Reset failed')
      }

      // Clear client-side storage
      clearClientStorage()

      // Show success briefly, then reload
      console.log('[RESET] Success:', data)
      setTimeout(() => {
        window.location.reload()
      }, 500)
    } catch (err) {
      console.error('[RESET] Error:', err)
      setError(err instanceof Error ? err.message : 'Failed to reset workspace')
      setIsResetting(false)
    }
  }

  const clearClientStorage = () => {
    try {
      // Clear localStorage
      clearDriveDocuments() // drive_documents_v1
      localStorage.removeItem('buyer_workspace_v1')
      localStorage.removeItem('companion_chat_messages')

      // Clear all sessionStorage
      sessionStorage.clear()

      console.log('[RESET] Client storage cleared')
    } catch (err) {
      console.error('[RESET] Error clearing client storage:', err)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!isResetting) {
      setOpen(newOpen)
      if (!newOpen) {
        // Reset form when closing
        setConfirmText('')
        setError(null)
      }
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Trigger asChild>
        <Button
          variant={variant}
          size={size}
          className={cn(
            'text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200',
            className
          )}
        >
          <AlertTriangle className="h-4 w-4 mr-2" />
          Reset Everything
        </Button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        {/* Overlay */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* Dialog Content */}
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-50 w-full max-w-lg translate-x-[-50%] translate-y-[-50%] bg-white rounded-lg shadow-xl border border-border/70 p-6 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
        >
          {/* Close button */}
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-white transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:pointer-events-none"
            disabled={isResetting}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>

          {/* Header */}
          <div className="flex items-start gap-4 mb-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
            <div className="flex-1">
              <DialogPrimitive.Title className="text-lg font-semibold text-gray-900 mb-1">
                Reset Everything?
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-sm text-gray-600">
                This action cannot be undone.
              </DialogPrimitive.Description>
            </div>
          </div>

          {/* Warning content */}
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
            <p className="text-sm text-red-800 font-medium mb-2">
              This will permanently delete:
            </p>
            <ul className="text-sm text-red-700 space-y-1 ml-4 list-disc">
              <li>All supplier cases and confirmation data</li>
              <li>All email messages and attachments</li>
              <li>All uploaded files and PO documents</li>
              <li>All chat history</li>
              <li>Gmail OAuth connection</li>
            </ul>
          </div>

          {/* Confirmation input */}
          <div className="mb-4">
            <label htmlFor="confirm-text" className="block text-sm font-medium text-gray-700 mb-2">
              Type <span className="font-mono bg-gray-100 px-1 py-0.5 rounded">RESET EVERYTHING</span> to confirm:
            </label>
            <input
              id="confirm-text"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={isResetting}
              placeholder="RESET EVERYTHING"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
              autoComplete="off"
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <DialogPrimitive.Close asChild>
              <Button
                variant="outline"
                disabled={isResetting}
              >
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button
              onClick={handleReset}
              disabled={!isConfirmValid || isResetting}
              className={cn(
                'bg-red-600 text-white hover:bg-red-700',
                'disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed'
              )}
            >
              {isResetting ? 'Resetting...' : 'Reset Everything'}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
