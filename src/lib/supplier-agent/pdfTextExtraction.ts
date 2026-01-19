/**
 * PDF Text Extraction
 * 
 * Extracts text from PDF files stored as base64-encoded binary data.
 * 
 * SERVER-ONLY: This module uses Node.js APIs (Buffer, pdfjs-dist).
 * Do not import this in client components.
 */

import 'server-only'

/**
 * Try to import pdfjs-dist from multiple possible paths
 * Returns the loaded module, the resolved specifier, and the import mode used
 */
async function importPdfJs(): Promise<{ mod: any; resolved: string; mode: 'specifier' }> {
  const errors: string[] = []

  // NOTE: Use literal specifiers + webpackIgnore to bypass bundling into (rsc)
  try {
    const mod = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs')
    return { mod, resolved: 'pdfjs-dist/legacy/build/pdf.mjs', mode: 'specifier' }
  } catch (err) {
    errors.push(
      `pdfjs-dist/legacy/build/pdf.mjs: ${err instanceof Error ? err.message : 'Unknown error'}`
    )
  }

  try {
    const mod = await import(/* webpackIgnore: true */ 'pdfjs-dist/build/pdf.mjs')
    return { mod, resolved: 'pdfjs-dist/build/pdf.mjs', mode: 'specifier' }
  } catch (err) {
    errors.push(`pdfjs-dist/build/pdf.mjs: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }

  try {
    const mod = await import(/* webpackIgnore: true */ 'pdfjs-dist/build/pdf.min.mjs')
    return { mod, resolved: 'pdfjs-dist/build/pdf.min.mjs', mode: 'specifier' }
  } catch (err) {
    errors.push(
      `pdfjs-dist/build/pdf.min.mjs: ${err instanceof Error ? err.message : 'Unknown error'}`
    )
  }

  throw new Error(
    `Failed to import pdfjs-dist from any known entrypoint:\n${errors.map(e => `  - ${e}`).join('\n')}`
  )
}

async function resolveWorkerSrc(): Promise<string> {
  // Prefer legacy worker module if present, fallback to modern.
  // In pdfjs-dist, the runtime expects a *module specifier string* for import(),
  // and in Node it defaults to "./pdf.worker.mjs" relative to the loaded pdf.mjs.
  try {
    const worker: any = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.worker.mjs')
    // Provide WorkerMessageHandler directly to avoid workerSrc resolution issues in bundlers.
    ;(globalThis as any).pdfjsWorker = worker
    return './pdf.worker.mjs'
  } catch {
    // ignore
  }

  try {
    const worker: any = await import(/* webpackIgnore: true */ 'pdfjs-dist/build/pdf.worker.mjs')
    ;(globalThis as any).pdfjsWorker = worker
    return './pdf.worker.mjs'
  } catch {
    // ignore
  }

  // Defensive fallback: valid (non-empty) URL string.
  return 'data:application/javascript;base64,'
}

/**
 * Extract text from a base64-encoded PDF
 * 
 * @param base64 - Base64-encoded PDF binary data
 * @returns Extracted text with normalized whitespace
 */
export async function extractTextFromPdfBase64(base64: string): Promise<string> {
  try {
    // Dynamically import pdfjs-dist from multiple possible paths
    const { mod, resolved, mode } = await importPdfJs()
    
    // Handle both module shapes (some builds nest exports under default)
    const pdfjs: any = (mod as any).default ?? mod
    
    // Log successful import
    console.log('[PDF_TEXT_IMPORT]', { mode, resolved })

    const workerSrc = await resolveWorkerSrc()
    if (pdfjs?.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
    }
    // Some pdfjs builds support disableWorker at module level
    try {
      pdfjs.disableWorker = true
    } catch (err) {
      // Ignore if not supported
    }
    
    // Decode base64 into Uint8Array
    const buffer = Buffer.from(base64, 'base64')
    const data = new Uint8Array(buffer)
    
    // Load PDF document
    let pdf
    try {
      const getDocumentParams = { data, disableWorker: true, useSystemFonts: true, verbosity: 0 }
      console.log('[PDF_TEXT_WORKER]', {
        workerSrc: pdfjs?.GlobalWorkerOptions?.workerSrc,
        disableWorker: true,
      })
      const loadingTask = pdfjs.getDocument(getDocumentParams)
      pdf = await loadingTask.promise
    } catch (err) {
      throw new Error(`Failed to load PDF document: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
    
    // Extract text from all pages
    let text = ''
    const numPages = pdf.numPages
    
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      let page
      let content
      try {
        page = await pdf.getPage(pageNum)
        content = await page.getTextContent()
      } catch (err) {
        throw new Error(`Failed to extract text from page ${pageNum}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
      
      // Accumulate text from all text items
      for (const item of content.items) {
        if ('str' in item && typeof item.str === 'string') {
          text += item.str + ' '
        }
      }
      
      // Add newline between pages (before normalization)
      if (pageNum < numPages) {
        text += '\n'
      }
    }
    
    // Normalize whitespace:
    // - Trim leading/trailing whitespace
    // - Collapse repeated whitespace (spaces, tabs, newlines) into single spaces
    text = text.trim()
    text = text.replace(/\s+/g, ' ')
    
    return text
  } catch (error) {
    console.error('[PDF_TEXT] extraction error:', error)
    throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}
