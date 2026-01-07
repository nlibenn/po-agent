import type { Metadata } from 'next'
import './globals.css'
import { ChatProvider } from '@/components/chat/ChatProvider'
import { CompanionChat } from '@/components/CompanionChat'

export const metadata: Metadata = {
  title: 'PO Agent',
  description: 'PO Agent Application',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <ChatProvider>
          {children}
          <CompanionChat />
        </ChatProvider>
      </body>
    </html>
  )
}
