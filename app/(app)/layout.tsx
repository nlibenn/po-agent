import type { Metadata } from 'next'
import { ChatProvider } from '@/components/chat/ChatProvider'
import { CompanionChat } from '@/components/CompanionChat'
import { BuyerWorkbenchNav } from '@/components/BuyerWorkbenchNav'
import { BuyerWorkbenchHeader } from '@/components/BuyerWorkbenchHeader'
import { WorkspaceProvider } from '@/components/WorkspaceProvider'
import { AuthGate } from '@/components/AuthGate'

export const metadata: Metadata = {
  title: 'PO Agent',
  description: 'PO Agent Application',
}

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthGate>
      <ChatProvider>
        <WorkspaceProvider>
          <div className="flex h-full">
            {/* Sidebar - Frame/Shell with subtle tinted background */}
            <div className="flex-shrink-0 bg-neutral-100/50">
              <BuyerWorkbenchNav />
            </div>
            {/* Main workbench - Cleaner, lighter workspace surface */}
            <main className="flex-1 flex flex-col overflow-hidden bg-white/40">
              <BuyerWorkbenchHeader />
              <div className="flex-1 overflow-auto">
                {children}
              </div>
            </main>
          </div>
          <CompanionChat />
        </WorkspaceProvider>
      </ChatProvider>
    </AuthGate>
  )
}
