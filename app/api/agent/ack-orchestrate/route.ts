import { NextRequest, NextResponse } from 'next/server'
import { runAckOrchestrator } from '@/src/lib/supplier-agent/agentAckOrchestrator'

export const runtime = 'nodejs'

/**
 * POST /api/agent/ack-orchestrate
 * 
 * Acknowledgement Orchestrator - Minimal agentic layer for supplier confirmation workflow.
 * 
 * Supports two modes:
 * 1. Regular JSON response (default)
 * 2. Server-Sent Events stream (if Accept: text/event-stream header is present)
 * 
 * SSE Events:
 * - type: "progress" - Real-time progress updates during execution
 * - type: "result" - Final orchestrator result
 * - type: "error" - Error occurred during execution
 * 
 * Manual test (JSON):
 * curl -X POST http://localhost:3000/api/agent/ack-orchestrate \
 *   -H "Content-Type: application/json" \
 *   -d '{"caseId":"<your-case-id>","mode":"dry_run"}'
 * 
 * Manual test (SSE):
 * curl -X POST http://localhost:3000/api/agent/ack-orchestrate \
 *   -H "Content-Type: application/json" \
 *   -H "Accept: text/event-stream" \
 *   -d '{"caseId":"<your-case-id>","mode":"dry_run"}'
 * 
 * Input:
 * {
 *   caseId: string (required)
 *   mode?: "dry_run" | "queue_only" | "auto_send" (default: "dry_run")
 *   lookbackDays?: number (default: 90)
 *   stream?: boolean (alternative to Accept header)
 * }
 * 
 * Output (JSON mode):
 * {
 *   caseId: string
 *   policy_version: string
 *   state_before: string
 *   evidence_summary: { ... }
 *   extracted_fields_best: { ... } | null
 *   decision: { ... }
 *   drafted_email?: { ... }
 *   queued_action?: { ... }
 *   requires_user_approval: boolean
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { caseId, mode = 'dry_run', lookbackDays = 90, debug = false, stream = false } = body

    // Validate required fields
    if (!caseId || typeof caseId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid required field: caseId (string)' },
        { status: 400 }
      )
    }

    // Validate mode
    if (mode && !['dry_run', 'queue_only', 'auto_send'].includes(mode)) {
      return NextResponse.json(
        { error: 'Invalid mode. Must be one of: dry_run, queue_only, auto_send' },
        { status: 400 }
      )
    }

    // Check if client wants SSE stream
    const acceptHeader = request.headers.get('accept') || ''
    const wantsStream = stream === true || acceptHeader.includes('text/event-stream')

    if (wantsStream) {
      // Return Server-Sent Events stream
      const encoder = new TextEncoder()
      
      const stream = new ReadableStream({
        async start(controller) {
          // Helper to send SSE event
          const sendEvent = (type: string, data: any) => {
            const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
            controller.enqueue(encoder.encode(event))
          }

          try {
            // Run orchestrator with progress callback
            const result = await runAckOrchestrator({
              caseId,
              mode: mode as 'dry_run' | 'queue_only' | 'auto_send',
              lookbackDays: typeof lookbackDays === 'number' ? lookbackDays : 90,
              debug: debug === true,
              onProgress: (message: string) => {
                sendEvent('progress', { message, timestamp: Date.now() })
              },
            })

            // Send final result
            sendEvent('result', result)
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to run orchestrator'
            console.error('[ACK_ORCHESTRATOR] SSE error:', error)
            sendEvent('error', { error: errorMessage })
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    // Regular JSON response
    const result = await runAckOrchestrator({
      caseId,
      mode: mode as 'dry_run' | 'queue_only' | 'auto_send',
      lookbackDays: typeof lookbackDays === 'number' ? lookbackDays : 90,
      debug: debug === true,
    })

    return NextResponse.json(result)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to run orchestrator'
    console.error('[ACK_ORCHESTRATOR] error:', error)
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
