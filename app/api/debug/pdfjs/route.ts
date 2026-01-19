import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { extractTextFromPdfBase64 } from '@/src/lib/supplier-agent/pdfTextExtraction'

export const runtime = 'nodejs'

/**
 * GET /api/debug/pdfjs
 * Debug-only: Return pdfjs-dist diagnostics
 * 
 * Returns:
 * - node version
 * - pdfjs-dist version (from package.json)
 * - canResolveWorkerPath: boolean indicating if worker path can be resolved
 */
export async function GET(request: NextRequest) {
  try {
    // Get Node version
    const nodeVersion = process.version

    // Read pdfjs-dist version from package.json
    let pdfjsVersion = 'unknown'
    try {
      const pdfjsPackagePath = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'package.json')
      const pdfjsPackage = JSON.parse(readFileSync(pdfjsPackagePath, 'utf-8'))
      pdfjsVersion = pdfjsPackage.version || 'unknown'
    } catch (err) {
      console.error('[DEBUG_PDFJS] Failed to read pdfjs-dist package.json:', err)
    }

    // Check if worker path can be resolved
    let canResolveWorkerPath = false
    try {
      // Use the same logic as in pdfTextExtraction.ts
      const workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()
      // If we get here without error, the path can be resolved
      canResolveWorkerPath = true
    } catch (err) {
      canResolveWorkerPath = false
    }

    return NextResponse.json({
      nodeVersion,
      pdfjsVersion,
      canResolveWorkerPath,
    })
  } catch (error) {
    console.error('[DEBUG_PDFJS] error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get pdfjs diagnostics' },
      { status: 500 }
    )
  }
}
