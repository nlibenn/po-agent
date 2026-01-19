import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sign in - PO Agent',
  description: 'Sign in to Buyer Workbench',
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
