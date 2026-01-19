import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Middleware to gate (app) routes - redirect to /login if not authenticated
 * 
 * Note: Auth check is done client-side in app/(app)/layout.tsx for simplicity
 * This middleware just ensures /login and API routes are accessible
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow auth routes and API routes
  if (pathname.startsWith('/login') || pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // All other routes will be checked client-side in the app layout
  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
