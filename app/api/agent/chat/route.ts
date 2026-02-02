import { NextRequest, NextResponse } from 'next/server'
import { appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
import OpenAI from 'openai'

const DEBUG_LOG_PATH = '/Users/nouraliben/Projects/PO Agent/.cursor/debug.log'
function debugLog(payload: object) {
  try { appendFileSync(DEBUG_LOG_PATH, JSON.stringify({ ...payload, sessionId: 'debug-session', runId: 'post-fix', hypothesisId: 'H6', timestamp: Date.now() }) + '\n') } catch (_) {}
}
import { getCase, listMessages, listAttachmentsForCase, addEvent, updateCase } from '@/src/lib/supplier-agent/store'
import { searchInboxForConfirmation } from '@/src/lib/supplier-agent/inboxSearch'
import { retrievePdfAttachmentsFromThread } from '@/src/lib/supplier-agent/emailAttachments'
import { parseConfirmationFieldsSmart, deriveConfirmationStatus, parsePerPdfResults, detectRevisionKeywords } from '@/src/lib/supplier-agent/parseConfirmationFields'
import type { ConfirmationHistoryEntry, MultiConfirmationStatus } from '@/src/lib/supplier-agent/types'
import { extractTextFromPdfBase64 } from '@/src/lib/supplier-agent/pdfTextExtraction'
import { generateConfirmationEmailV2, type EmailDraftContext } from '@/src/lib/supplier-agent/emailDraft'
import { sendNewEmail, sendReplyInThread } from '@/src/lib/supplier-agent/outreach'
import { getDb, getDbPath } from '@/src/lib/supplier-agent/storage/sqlite'
import { decide as coordinatorDecide, followUpStateStore, fieldRequestCounts } from '@/src/lib/followup-coordinator'
import type { FollowUpContext, SupplierFollowUpState } from '@/src/lib/followup-coordinator'

export const runtime = 'nodejs'

// Demo mode email override
const DEMO_SUPPLIER_EMAIL = 'supplierbart@gmail.com'

// OpenAI client
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured')
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })
}

/**
 * Build system prompt with case context
 */
function buildSystemPrompt(caseData: any, followUpState?: SupplierFollowUpState): string {
  const friendlyNames: Record<string, string> = {
    'supplier_reference': 'Supplier Order Number',
    'delivery_date': 'Delivery Date',
    'ship_date': 'Ship Date',
    'quantity': 'Quantity',
  }

  const missingFields = Array.isArray(caseData.missing_fields) ? caseData.missing_fields : []
  const missingFieldsList = missingFields.length > 0
    ? missingFields.map((f: string) => friendlyNames[f] || f).join(', ')
    : 'None - all fields confirmed'

  // Extract expected quantity from meta for mismatch detection
  let expectedQty: number | null = null
  if (caseData.meta) {
    try {
      const meta = typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta
      if (meta.po_line?.ordered_quantity) {
        const qty = typeof meta.po_line.ordered_quantity === 'number'
          ? meta.po_line.ordered_quantity
          : parseFloat(String(meta.po_line.ordered_quantity))
        if (Number.isFinite(qty) && qty > 0) {
          expectedQty = qty
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  console.log('[AGENT_CHAT] buildSystemPrompt - Expected Quantity:', {
    caseId: caseData.case_id,
    poNumber: caseData.po_number,
    lineId: caseData.line_id,
    expectedQty,
    hasMeta: !!caseData.meta,
    hasPoLine: !!(typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta)?.po_line,
    metaKeys: caseData.meta ? Object.keys(typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta) : [],
  })

  return `You are a procurement assistant helping a buyer with purchase order confirmations.

CURRENT CONTEXT:
- PO Number: ${caseData.po_number}-${caseData.line_id}
- Supplier: ${caseData.supplier_name || 'Unknown'}${caseData.supplier_email ? ` (${caseData.supplier_email})` : ''}
- Expected Quantity: ${expectedQty !== null ? expectedQty : 'Unknown'}
- Missing Information: ${missingFieldsList}

The user has already selected this PO. When they ask questions, they're asking about THIS specific PO. You don't need to ask which PO they mean.

IMPORTANT: When referencing the PO number in your responses to users, ALWAYS use the PO number (e.g., "907155") from the context or tool results, NEVER use the caseId (e.g., "1769129399589-gh5dr"). The caseId is an internal identifier - users don't know what it means. Always say "PO ${caseData.po_number}" or "PO ${caseData.po_number}-${caseData.line_id}" when talking to users.

Your capabilities:
- search_inbox: Search Gmail for supplier emails about this PO. This tool AUTOMATICALLY parses PDF attachments when found, so you'll get complete data in one call. Check the parsed_data field in the response.
- read_confirmation: Extract data from PDFs and emails (use this if you need to re-parse or if search_inbox didn't find PDFs)
- draft_email: Generate a professional email requesting missing info
- send_email: Send the drafted email (only after user approval)
NOTE: Confirmation status (CONFIRMED_CLEAN, CONFIRMED_WITH_ISSUES, UNCONFIRMED) is automatically derived after parsing — no manual tool call needed.

IMPORTANT: search_inbox now automatically parses PDFs when found. If the response includes parsed_data with supplier_order_number, delivery_date, or quantity, you already have the confirmation data - no need to call read_confirmation separately.

MULTIPLE CONFIRMATIONS: When read_confirmation returns multi_confirmation_status:
- "revision_detected": Supplier sent a corrected confirmation. Use the latest values and inform the buyer: "The supplier sent a revised confirmation — I'm using the most recent values."
- "conflict": Multiple PDFs show different values with no revision indicator. Show the differences and ask the buyer which to use: "I found N confirmations with different values. [show table]. Which should I use?"
- "consistent": All confirmations agree. Proceed normally — no need to mention multiple PDFs.

Always:
- Explain what you're doing
- Show what you found using ✓ for confirmed and ✗ for missing
- Ask before sending emails
- Be conversational and helpful

IMPORTANT: When you extract confirmation data, proactively flag:
- ⚠️ Quantity mismatches (confirmed qty ≠ expected qty from PO)
- ⚠️ Price changes (unit price or extended price differs from PO)
- ⚠️ Payment terms changes
- ⚠️ Unexpected freight costs
- ⚠️ Backorders or inventory issues
- ⚠️ Any notes indicating problems

Format warnings clearly with ⚠️ symbol and explain the impact.

QUANTITY MISMATCH DETECTION:
When comparing confirmation data against the PO:
- If confirmed quantity ≠ expected quantity: FLAG with "⚠️ QUANTITY MISMATCH"
- Example: "⚠️ QUANTITY MISMATCH: Supplier confirmed 1 unit (Expected: 140)"
- Always show both the confirmed and expected quantities when there's a mismatch
- This is a critical issue that requires buyer attention
- IMPORTANT: The expected quantity is available in the "expected_quantity" field of search_inbox and read_confirmation tool results. Always use that value when displaying expected quantity. Never display "Expected: Unknown" if expected_quantity is present in the tool result.
- CRITICAL: When a quantity mismatch is detected, after flagging it, IMMEDIATELY call the draft_email tool with missing_fields: ["quantity"]. Do NOT write the email text in the chat — always use the draft_email tool so the inline email editor appears.

BE PROACTIVE:
When you search for confirmation and find NOTHING (no emails, no PDFs):
- State what you found (nothing)
- IMMEDIATELY offer to draft an email to the supplier
- Ask: "Would you like me to draft an email requesting this information?"

When you search and find PARTIAL data (some fields missing):
- Show what you found with ✓/✗
- IMMEDIATELY offer to draft an email requesting the missing fields
- Ask: "Would you like me to email the supplier to request [missing fields]?"

INBOX FAILURE HANDLING:
When search_inbox returns status "inbox_unavailable" or "error":
- Do NOT say "no supplier responses found" or claim no confirmations exist
- Tell the user: "I was unable to search the inbox due to a connectivity or authentication issue."
- Suggest: "Please check that Gmail is connected and try again."
- NEVER assert absence of confirmations when the search itself failed.

Be proactive and helpful. Don't just report findings - suggest the next action.

IMPORTANT WORKFLOW RULES:
1. When you offer to draft an email and the user agrees (says 'yes', 'please', 'go ahead', 'sure'), immediately call the draft_email tool. Do NOT search the inbox again.

2. When you've already searched the inbox in this conversation and found nothing, do NOT search again unless the user explicitly asks you to re-check.

3. Once you draft an email, do NOT draft it again unless the user asks for changes.

4. NEVER write email text directly in the chat. ALL email drafting MUST go through the draft_email tool — this is what triggers the inline email editor UI. If you write email text in the chat instead of calling draft_email, the user cannot edit or send it. This applies to ALL scenarios: missing fields, quantity mismatches, price discrepancies, follow-ups, or any other reason to contact the supplier.

Remember what you've already done in this conversation to avoid repeating yourself.
${followUpState ? buildFollowUpStateSection(followUpState, friendlyNames) : ''}`
}

function buildFollowUpStateSection(
  state: SupplierFollowUpState,
  friendlyNames: Record<string, string>,
): string {
  const resolvedEntries = Object.entries(state.resolvedFields)
  const counts = fieldRequestCounts(state)

  const resolvedLines = resolvedEntries.length > 0
    ? resolvedEntries.map(([key, rf]) => {
        const name = friendlyNames[key] || key
        const date = new Date(rf.resolvedAt).toISOString().slice(0, 10)
        return `  - ${name}: ${rf.value} (confirmed ${date})`
      }).join('\n')
    : '  (none yet)'

  // Unresolved = fields still in missing_fields that are NOT in resolvedFields
  const unresolvedKeys = (state.unresolvedIssues || []).map(i => i.field)
  const unresolvedLines = unresolvedKeys.length > 0
    ? unresolvedKeys.map(key => {
        const name = friendlyNames[key] || key
        const timesAsked = counts[key] || 0
        return `  - ${name} (requested ${timesAsked} time${timesAsked !== 1 ? 's' : ''})`
      }).join('\n')
    : '  (none)'

  return `

FOLLOW-UP STATE:
Resolved fields:
${resolvedLines}
Unresolved fields:
${unresolvedLines}
RULES:
- NEVER re-request a resolved field unless the user explicitly asks to invalidate it.
- ship_date and delivery_date are different dates, but having either one is sufficient for the buyer. NEVER ask for both.`
}

// Tool definitions for OpenAI function calling
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_inbox',
      description: 'Search the Gmail inbox for emails related to this purchase order. Use this to find supplier responses, confirmations, or any communication about the PO.',
      parameters: {
        type: 'object',
        properties: {
          lookback_days: {
            type: 'number',
            description: 'How many days back to search (default: 30)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_confirmation',
      description: 'Extract confirmation data from PDF attachments found in emails. This will parse supplier order numbers, ship/delivery dates, and quantities from confirmation documents.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
    {
      type: 'function',
      function: {
        name: 'draft_email',
        description: 'Draft an email to the supplier about this PO. Use this for ANY email drafting: requesting missing fields, flagging quantity mismatches, or any other supplier communication. ALWAYS call this tool instead of writing email text in the chat — the tool triggers the inline email editor UI.',
        parameters: {
          type: 'object',
          properties: {
            missing_fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of fields to request (e.g., ["delivery_date", "supplier_reference", "quantity"])',
            },
          },
          required: ['missing_fields'],
        },
      },
    },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send the drafted email to the supplier. ONLY use this after the user has explicitly confirmed they want to send the email.',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Email subject line',
          },
          body: {
            type: 'string',
            description: 'Email body text',
          },
          thread_id: {
            type: 'string',
            description: 'Gmail thread ID to reply to (optional - if not provided, sends new email)',
          },
        },
        required: ['subject', 'body'],
      },
    },
  },
]

// Tool execution context
interface ToolContext {
  caseId: string
  caseData: any
}

// Execute search_inbox tool
async function executeSearchInbox(
  context: ToolContext,
  args: { lookback_days?: number }
): Promise<string> {
  const { caseData } = context
  const lookbackDays = args.lookback_days || 30

  console.log('[AGENT_CHAT] ===== executeSearchInbox CALLED =====')
  console.log('[AGENT_CHAT] DEBUG: caseId:', context.caseId)
  console.log('[AGENT_CHAT] DEBUG: caseData:', {
    case_id: caseData?.case_id,
    po_number: caseData?.po_number,
    line_id: caseData?.line_id,
    supplier_email: caseData?.supplier_email,
  })
  console.log('[AGENT_CHAT] DEBUG: About to call searchInboxForConfirmation with:', {
    caseId: context.caseId,
    poNumber: caseData?.po_number,
    lineId: caseData?.line_id,
  })

  // Validate po_number exists and is not the caseId
  if (!caseData?.po_number) {
    console.error('[AGENT_CHAT] ERROR: caseData.po_number is missing!')
    return JSON.stringify({
      status: 'error',
      error: 'PO number not found in case data',
    })
  }

  if (caseData.po_number === context.caseId) {
    console.error('[AGENT_CHAT] ERROR: po_number equals caseId! This is wrong!', {
      po_number: caseData.po_number,
      caseId: context.caseId,
    })
    return JSON.stringify({
      status: 'error',
      error: 'PO number incorrectly set to case ID',
    })
  }

  try {
    // Calculate search floor based on lookback window, NOT case creation time
    // This ensures we find confirmation emails that arrived before the user created the case
    const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000
    const searchFloor = Date.now() - lookbackMs

    const searchResult = await searchInboxForConfirmation({
      caseId: context.caseId,
      poNumber: caseData.po_number,
      lineId: caseData.line_id,
      supplierEmail: caseData.supplier_email || null,
      supplierDomain: caseData.supplier_domain || null,
      optionalKeywords: [],
      lookbackDays,
      searchAfterEpochMs: searchFloor, // ✅ FIX: Use lookback window instead of case creation time
    })

    // If we found a thread, fetch attachments
    if (searchResult.matchedThreadId) {
      await retrievePdfAttachmentsFromThread({
        caseId: context.caseId,
        threadId: searchResult.matchedThreadId,
      })
    }

    const messages = listMessages(context.caseId)
    const inboundMessages = messages.filter(m => m.direction === 'INBOUND')
    const attachments = listAttachmentsForCase(context.caseId)
    const pdfCount = attachments.filter(a => a.mime_type === 'application/pdf').length

    // Use PDF count from searchResult if available, otherwise count from attachments
    const finalPdfCount = searchResult.pdfCount ?? pdfCount
    const finalHasPdfs = searchResult.hasPdfs ?? (pdfCount > 0)
    
    // Include parsed data from PDFs if available
    const parsedData = searchResult.parsedData
    const hasParsedData = searchResult.hasParsedData

    // Persist when search_inbox parsed PDFs so Confirmation Details card can show them (agent often skips read_confirmation)
    if (hasParsedData && parsedData) {
      const caseId = context.caseId
      debugLog({ location: 'chat/route.ts:executeSearchInbox', message: 'search_inbox persist start', data: { caseId, hasSO: !!parsedData.supplier_order_number, hasDate: !!parsedData.delivery_date, hasQty: parsedData.quantity != null } })
      const pdfs = attachments.filter((a) => a.mime_type === 'application/pdf')
      const evidence_attachment_id = pdfs.length > 0 ? (pdfs[0] as { attachment_id: string }).attachment_id : null
      try {
        const db = getDb()
        const now = Date.now()
        const lineNumber = Number.isFinite(parseInt(caseData.line_id, 10)) ? parseInt(caseData.line_id, 10) : null
        const supplier_order_number = parsedData.supplier_order_number ?? null
        const confirmed_delivery_date = parsedData.delivery_date ?? null
        const confirmed_quantity = parsedData.quantity != null ? String(parsedData.quantity) : null
        const existing = db.prepare(`SELECT id FROM confirmation_extractions WHERE case_id = ?`).get(caseId) as { id: string } | undefined
        if (existing?.id) {
          db.prepare(
            `UPDATE confirmation_extractions SET
              po_number = ?, line_number = ?, supplier_order_number = ?, confirmed_delivery_date = ?,
              confirmed_quantity = ?, evidence_source = ?, evidence_attachment_id = ?, evidence_message_id = ?,
              confidence = ?, raw_excerpt = ?, updated_at = ?
            WHERE case_id = ?`
          ).run(caseData.po_number, lineNumber, supplier_order_number, confirmed_delivery_date, confirmed_quantity, 'pdf', evidence_attachment_id, null, 90, null, now, caseId)
        } else {
          db.prepare(
            `INSERT INTO confirmation_extractions (
              id, case_id, po_number, line_number, supplier_order_number, confirmed_delivery_date,
              confirmed_quantity, evidence_source, evidence_attachment_id, evidence_message_id,
              confidence, raw_excerpt, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            randomUUID(),
            caseId,
            caseData.po_number,
            lineNumber,
            supplier_order_number,
            confirmed_delivery_date,
            confirmed_quantity,
            'pdf',
            evidence_attachment_id,
            null,
            90,
            null,
            now,
            now
          )
        }
        const c = getCase(caseId)
        const meta = (c?.meta && typeof c.meta === 'object' ? { ...c.meta } : {}) as Record<string, unknown>
        meta.parsed_best_fields_v1 = {
          version: 'v1',
          parsed_at: now,
          evidence_source: 'pdf',
          evidence_attachment_id,
          evidence_message_id: null,
          fields: {
            supplier_order_number: { value: parsedData.supplier_order_number, confidence: 0.9, evidence_snippet: null, source: 'pdf' as const, attachment_id: evidence_attachment_id, message_id: null },
            confirmed_delivery_date: { value: parsedData.delivery_date, confidence: 0.9, evidence_snippet: null, source: 'pdf' as const, attachment_id: evidence_attachment_id, message_id: null },
            confirmed_quantity: { value: parsedData.quantity, confidence: 0.9, evidence_snippet: null, source: 'pdf' as const, attachment_id: evidence_attachment_id, message_id: null },
          },
          raw_excerpt: null,
        }
        // Derive confirmation_status from search_inbox parsed data
        const hasOrderNumber = !!parsedData.supplier_order_number
        const hasDeliveryDate = !!parsedData.delivery_date
        // Check quantity mismatch against expected qty from case meta
        let hasQtyMismatch = false
        if (parsedData.quantity != null) {
          try {
            const caseMeta = typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta
            const expectedQtyRaw = caseMeta?.po_line?.ordered_quantity
            if (expectedQtyRaw != null) {
              const expected = typeof expectedQtyRaw === 'number' ? expectedQtyRaw : parseFloat(String(expectedQtyRaw))
              if (Number.isFinite(expected) && expected > 0 && parsedData.quantity !== expected) {
                hasQtyMismatch = true
              }
            }
          } catch (_e) { /* ignore */ }
        }
        let searchInboxConfStatus: import('@/src/lib/supplier-agent/types').ConfirmationStatus = 'UNCONFIRMED'
        if (hasOrderNumber && hasDeliveryDate) {
          searchInboxConfStatus = hasQtyMismatch ? 'CONFIRMED_WITH_ISSUES' : 'CONFIRMED_CLEAN'
        }
        console.log('[AGENT_CHAT] executeSearchInbox: derived confirmation_status:', { searchInboxConfStatus, hasOrderNumber, hasDeliveryDate, hasQtyMismatch })
        updateCase(caseId, { meta, confirmation_status: searchInboxConfStatus })
        console.log('[AGENT_CHAT] executeSearchInbox: updated case confirmation_status to:', searchInboxConfStatus)
        addEvent(caseId, {
          case_id: caseId,
          timestamp: now,
          event_type: 'PARSE_RESULT',
          summary: 'Parsed confirmation fields (v1)',
          evidence_refs_json: evidence_attachment_id ? { attachment_ids: [evidence_attachment_id] } : null,
          meta_json: { version: 'v1', source: 'search_inbox', evidence_attachment_id, confirmation_status: searchInboxConfStatus },
        })
        debugLog({ location: 'chat/route.ts:executeSearchInbox', message: 'search_inbox persist done', data: { caseId, hasSO: !!supplier_order_number, hasDate: !!confirmed_delivery_date, hasQty: confirmed_quantity != null } })
      } catch (persistErr) {
        console.error('[AGENT_CHAT] executeSearchInbox persist failed:', persistErr)
        debugLog({ location: 'chat/route.ts:executeSearchInbox', message: 'search_inbox persist error', data: { caseId: context.caseId, error: persistErr instanceof Error ? persistErr.message : String(persistErr) } })
      }
    }

    // Extract expected quantity so the LLM can always display it accurately
    let expectedQty: number | null = null
    if (caseData.meta) {
      try {
        const meta = typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta
        if (meta.po_line?.ordered_quantity) {
          const qty = typeof meta.po_line.ordered_quantity === 'number'
            ? meta.po_line.ordered_quantity
            : parseFloat(String(meta.po_line.ordered_quantity))
          if (Number.isFinite(qty) && qty > 0) {
            expectedQty = qty
          }
        }
      } catch (_e) { /* ignore */ }
    }

    if (searchResult.classification === 'FOUND_CONFIRMED') {
      return JSON.stringify({
        status: 'found_confirmed',
        summary: `Found supplier response with confirmation. ${inboundMessages.length} inbound email(s), ${finalPdfCount} PDF attachment(s).${hasParsedData ? ' PDF data parsed successfully.' : ''}`,
        po_number: caseData.po_number,
        line_id: caseData.line_id,
        thread_id: searchResult.matchedThreadId,
        messages_count: inboundMessages.length,
        pdf_count: finalPdfCount,
        has_pdfs: finalHasPdfs,
        parsed_data: parsedData,
        has_parsed_data: hasParsedData,
        expected_quantity: expectedQty,
      })
    } else if (searchResult.classification === 'FOUND_INCOMPLETE') {
      return JSON.stringify({
        status: 'found_incomplete',
        summary: `Found supplier response but some fields are missing. ${inboundMessages.length} inbound email(s), ${finalPdfCount} PDF attachment(s).${hasParsedData ? ' PDF data parsed successfully.' : ''}`,
        po_number: caseData.po_number,
        line_id: caseData.line_id,
        thread_id: searchResult.matchedThreadId,
        missing_fields: searchResult.missingFields,
        messages_count: inboundMessages.length,
        pdf_count: finalPdfCount,
        has_pdfs: finalHasPdfs,
        parsed_data: parsedData,
        has_parsed_data: hasParsedData,
        expected_quantity: expectedQty,
      })
    } else {
      return JSON.stringify({
        status: 'not_found',
        summary: `No supplier response found for this PO in the last ${lookbackDays} days. ${finalPdfCount > 0 ? `However, ${finalPdfCount} PDF attachment(s) were found${hasParsedData ? ' and parsed successfully' : ' - you should call read_confirmation to parse them'}.` : ''}`,
        po_number: caseData.po_number,
        line_id: caseData.line_id,
        messages_count: 0,
        pdf_count: finalPdfCount,
        has_pdfs: finalHasPdfs,
        parsed_data: parsedData,
        has_parsed_data: hasParsedData,
        expected_quantity: expectedQty,
      })
    }
  } catch (error) {
    console.error('[AGENT_CHAT] ❌ Inbox search FAILED:', error)
    return JSON.stringify({
      status: 'inbox_unavailable',
      error: error instanceof Error ? error.message : 'Search failed',
      summary: 'Inbox search failed due to a connection or authentication error. Do NOT conclude that no confirmations exist.',
    })
  }
}

// Execute read_confirmation tool
async function executeReadConfirmation(context: ToolContext): Promise<string> {
  console.log('[AGENT_CHAT] ===== executeReadConfirmation CALLED =====')
  console.log('[AGENT_CHAT] DEBUG: caseId:', context.caseId)
  console.log('[AGENT_CHAT] DEBUG: caseData.po_number:', context.caseData?.po_number)
  
  const { caseData } = context

  try {
    const db = getDb()
    console.log('[AGENT_CHAT] DEBUG: Database connection obtained')
    
    // Get PDF attachments with binary data and message info
    const rawAttachments = db
      .prepare(`
        SELECT a.attachment_id, a.filename, a.text_extract, a.binary_data_base64,
               a.message_id, m.body_text AS message_body, m.received_at AS message_received_at
        FROM attachments a
        INNER JOIN messages m ON m.message_id = a.message_id
        WHERE m.case_id = ?
          AND a.mime_type = 'application/pdf'
        ORDER BY m.received_at DESC
      `)
      .all(context.caseId) as Array<{
        attachment_id: string
        filename: string | null
        text_extract: string | null
        binary_data_base64: string | null
        message_id: string | null
        message_body: string | null
        message_received_at: number | null
      }>

    console.log('[MULTI_PDF] PDF attachments found for case:', rawAttachments.length)
    for (const att of rawAttachments) {
      console.log('[MULTI_PDF] PDF:', {
        attachment_id: att.attachment_id,
        filename: att.filename,
        message_received_at: att.message_received_at ? new Date(att.message_received_at).toISOString() : null,
        message_id: att.message_id,
      })
    }

    if (rawAttachments.length === 0) {
      return JSON.stringify({
        status: 'no_pdfs',
        summary: 'No PDF attachments found. Run search_inbox first to find supplier emails.',
      })
    }

    // Extract text from PDFs
    const pdfTexts: Array<{ attachment_id: string; text: string | null }> = []
    
    console.log('[AGENT_CHAT] DEBUG: Found', rawAttachments.length, 'PDF attachments')
    
    for (const att of rawAttachments) {
      let text = att.text_extract
      
      console.log('[AGENT_CHAT] DEBUG: Processing attachment', att.attachment_id, {
        hasTextExtract: !!text,
        textExtractLength: text?.length || 0,
        hasBinaryData: !!att.binary_data_base64,
        binaryDataLength: att.binary_data_base64?.length || 0,
      })
      
      if ((!text || text.trim().length === 0) && att.binary_data_base64) {
        try {
          console.log('[AGENT_CHAT] DEBUG: Extracting text from binary PDF...')
          text = await extractTextFromPdfBase64(att.binary_data_base64)
          console.log('[AGENT_CHAT] DEBUG: Extracted text length:', text?.length || 0)
          if (text && text.trim().length > 0) {
            db.prepare('UPDATE attachments SET text_extract = ? WHERE attachment_id = ?')
              .run(text, att.attachment_id)
            console.log('[AGENT_CHAT] DEBUG: Saved extracted text to database')
          }
        } catch (e) {
          console.error('[AGENT_CHAT] PDF extraction failed for', att.attachment_id, e)
        }
      }
      
      if (text && text.trim().length > 0) {
        pdfTexts.push({ attachment_id: att.attachment_id, text })
        console.log('[AGENT_CHAT] DEBUG: Added PDF text to array, length:', text.length)
      } else {
        console.log('[AGENT_CHAT] DEBUG: Skipping attachment (no text extracted)')
      }
    }
    
    console.log('[AGENT_CHAT] DEBUG: Total PDF texts prepared:', pdfTexts.length)

    if (pdfTexts.length === 0) {
      return JSON.stringify({
        status: 'no_text',
        summary: 'Found PDFs but could not extract text from them.',
      })
    }

    // Extract expected quantity, unit price, and due date from case meta if available
    let expectedQty: number | null = null
    let expectedUnitPrice: number | null = null
    let expectedDueDate: string | null = null
    if (caseData.meta) {
      try {
        const meta = typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta
        if (meta.po_line?.ordered_quantity) {
          const qty = typeof meta.po_line.ordered_quantity === 'number'
            ? meta.po_line.ordered_quantity
            : parseFloat(String(meta.po_line.ordered_quantity))
          if (Number.isFinite(qty) && qty > 0) {
            expectedQty = qty
          }
        }
        // Extract expected unit price for price change detection
        if (meta.po_line?.unit_price) {
          const price = typeof meta.po_line.unit_price === 'number'
            ? meta.po_line.unit_price
            : parseFloat(String(meta.po_line.unit_price).replace(/[$,\s]/g, ''))
          if (Number.isFinite(price) && price > 0) {
            expectedUnitPrice = price
          }
        }
        // Extract expected due date for late delivery detection
        if (meta.po_line?.due_date) {
          const dd = String(meta.po_line.due_date).trim()
          if (dd && dd !== 'null' && dd !== 'undefined') {
            // Normalize to YYYY-MM-DD
            const d = new Date(dd)
            if (!isNaN(d.getTime())) {
              expectedDueDate = d.toISOString().split('T')[0]
            }
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Parse confirmation fields using smart parser (regex + LLM fallback)
    console.log('[AGENT_CHAT] ===== ABOUT TO CALL parseConfirmationFieldsSmart =====')
    console.log('[AGENT_CHAT] DEBUG: Input to parser:', {
      poNumber: caseData.po_number,
      lineId: caseData.line_id,
      pdfTextsCount: pdfTexts.length,
      pdfTextsLengths: pdfTexts.map(p => p.text?.length || 0),
      expectedQty,
      expectedUnitPrice,
    })
    
    const parsed = await parseConfirmationFieldsSmart({
      poNumber: caseData.po_number,
      lineId: caseData.line_id,
      pdfTexts,
      expectedQty: expectedQty ?? undefined,
      expectedUnitPrice: expectedUnitPrice ?? undefined,
      debug: false,
    })
    
    console.log('[AGENT_CHAT] ===== parseConfirmationFieldsSmart RETURNED =====')
    console.log('[AGENT_CHAT] DEBUG: Parsed result:', {
      hasSupplierOrderNumber: !!parsed.supplier_order_number.value,
      hasDeliveryDate: !!parsed.confirmed_delivery_date.value,
      hasQuantity: parsed.supplier_confirmed_quantity.value !== null,
      hasUnitPrice: !!parsed.unit_price?.value,
    })

    // Auto-derive confirmation_status immediately after parsing (no agent tool dependency)
    const autoConfirmationStatus = deriveConfirmationStatus(parsed, { expectedDueDate })
    console.log('[AGENT_CHAT] Auto-derived confirmation_status:', autoConfirmationStatus)

    // --- Multi-confirmation handling ---
    // Build attachment → message metadata map for revision detection
    const attachmentMessageMap = new Map<string, { message_id: string | null; body: string | null; received_at: number | null; filename: string | null }>()
    for (const att of rawAttachments) {
      attachmentMessageMap.set(att.attachment_id, {
        message_id: att.message_id,
        body: att.message_body,
        received_at: att.message_received_at,
        filename: att.filename,
      })
    }

    let multiConfirmationStatus: MultiConfirmationStatus = 'single'
    let confirmationHistory: ConfirmationHistoryEntry[] = []

    console.log('[MULTI_PDF] pdfTexts with extractable text:', pdfTexts.length)

    if (pdfTexts.length > 1) {
      // Parse each PDF individually (regex-only, no LLM cost)
      const parseInput = {
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
        expectedQty: expectedQty ?? undefined,
        expectedUnitPrice: expectedUnitPrice ?? undefined,
        pdfTexts,
      }
      const { perPdf } = parsePerPdfResults(parseInput)

      const now = Date.now()
      let anyRevision = false

      for (const { attachment_id, result } of perPdf) {
        const msgInfo = attachmentMessageMap.get(attachment_id)
        const revisionDetected = detectRevisionKeywords(msgInfo?.body)
        if (revisionDetected) anyRevision = true

        confirmationHistory.push({
          attachment_id,
          filename: msgInfo?.filename ?? undefined,
          parsed_at: now,
          fields: {
            supplier_order_number: { value: result.supplier_order_number.value, confidence: result.supplier_order_number.confidence },
            confirmed_delivery_date: { value: result.confirmed_delivery_date.value, confidence: result.confirmed_delivery_date.confidence },
            confirmed_quantity: { value: result.supplier_confirmed_quantity.value, confidence: result.supplier_confirmed_quantity.confidence },
          },
          evidence_source: result.evidence_source,
          revision_detected: revisionDetected,
          message_id: msgInfo?.message_id,
        })
      }

      // Determine multi_confirmation_status
      if (anyRevision) {
        multiConfirmationStatus = 'revision_detected'
      } else {
        // Check if all PDFs agree on core fields
        const soValues = confirmationHistory.map(h => h.fields.supplier_order_number.value).filter(Boolean)
        const dateValues = confirmationHistory.map(h => h.fields.confirmed_delivery_date.value).filter(Boolean)
        const qtyValues = confirmationHistory.map(h => h.fields.confirmed_quantity.value).filter(v => v !== null)
        const soAgree = new Set(soValues).size <= 1
        const dateAgree = new Set(dateValues).size <= 1
        const qtyAgree = new Set(qtyValues).size <= 1
        multiConfirmationStatus = (soAgree && dateAgree && qtyAgree) ? 'consistent' : 'conflict'
      }

      console.log('[MULTI_PDF] parsePerPdfResults output:', confirmationHistory.map(h => ({
        attachment_id: h.attachment_id,
        filename: h.filename,
        so: h.fields.supplier_order_number.value,
        date: h.fields.confirmed_delivery_date.value,
        qty: h.fields.confirmed_quantity.value,
        revision: h.revision_detected,
      })))
      console.log('[MULTI_PDF] multi_confirmation_status:', multiConfirmationStatus, '| anyRevision:', anyRevision)
      console.log('[MULTI_PDF] "best" result selected from combined parse:', {
        so: parsed.supplier_order_number.value,
        date: parsed.confirmed_delivery_date.value,
        qty: parsed.supplier_confirmed_quantity.value,
        evidence_source: parsed.evidence_source,
      })
    }

    const extractedFields: Record<string, any> = {}
    const missingFields: string[] = []
    const warnings: string[] = []

    // Core fields
    if (parsed.supplier_order_number.value) {
      extractedFields.supplier_order_number = parsed.supplier_order_number.value
    } else {
      missingFields.push('supplier_order_number')
    }

    if (parsed.confirmed_delivery_date.value) {
      extractedFields.delivery_date = parsed.confirmed_delivery_date.value
    } else {
      missingFields.push('delivery_date')
    }

    if (parsed.supplier_confirmed_quantity.value !== null) {
      extractedFields.quantity = parsed.supplier_confirmed_quantity.value
    } else {
      missingFields.push('quantity')
    }

    // Extended fields
    if (parsed.unit_price?.value !== null && parsed.unit_price?.value !== undefined) {
      extractedFields.unit_price = parsed.unit_price.value
    }
    if (parsed.extended_price?.value !== null && parsed.extended_price?.value !== undefined) {
      extractedFields.extended_price = parsed.extended_price.value
    }
    if (parsed.currency?.value) {
      extractedFields.currency = parsed.currency.value
    }
    if (parsed.payment_terms?.value) {
      extractedFields.payment_terms = parsed.payment_terms.value
    }
    if (parsed.freight_terms?.value) {
      extractedFields.freight_terms = parsed.freight_terms.value
    }
    if (parsed.freight_cost?.value !== null && parsed.freight_cost?.value !== undefined) {
      extractedFields.freight_cost = parsed.freight_cost.value
    }
    if (parsed.subtotal?.value !== null && parsed.subtotal?.value !== undefined) {
      extractedFields.subtotal = parsed.subtotal.value
    }
    if (parsed.tax_amount?.value !== null && parsed.tax_amount?.value !== undefined) {
      extractedFields.tax_amount = parsed.tax_amount.value
    }
    if (parsed.order_total?.value !== null && parsed.order_total?.value !== undefined) {
      extractedFields.order_total = parsed.order_total.value
    }
    if (parsed.notes?.value) {
      extractedFields.notes = parsed.notes.value
    }
    if (parsed.backorder_status?.value) {
      extractedFields.backorder_status = parsed.backorder_status.value
    }

    // Check for price changes
    if (parsed.price_changed?.value) {
      const deltaPercent = parsed.price_changed.price_delta_percent
      const sign = deltaPercent && deltaPercent > 0 ? '+' : ''
      warnings.push(`⚠️ Price change detected: Unit price changed by ${sign}${deltaPercent?.toFixed(2)}%`)
    }

    // Check for payment terms changes
    if (parsed.payment_terms?.value) {
      // Could compare with expected terms if available
      extractedFields.payment_terms = parsed.payment_terms.value
    }

    // Check for unexpected freight costs
    if (parsed.freight_cost?.value && parsed.freight_cost.value > 0) {
      warnings.push(`⚠️ Freight cost: $${parsed.freight_cost.value.toFixed(2)}`)
    }

    // Check for backorders
    if (parsed.backorder_status?.value && 
        parsed.backorder_status.value.toLowerCase().includes('backorder')) {
      warnings.push(`⚠️ Backorder status: ${parsed.backorder_status.value}`)
    }

    // Check for notes indicating problems
    if (parsed.notes?.value) {
      const notesLower = parsed.notes.value.toLowerCase()
      if (notesLower.includes('delay') || notesLower.includes('issue') || 
          notesLower.includes('problem') || notesLower.includes('concern')) {
        warnings.push(`⚠️ Notes indicate potential issues: ${parsed.notes.value}`)
      }
    }

    const summaryParts: string[] = []
    if (Object.keys(extractedFields).length > 0) {
      summaryParts.push(`Extracted: ${Object.entries(extractedFields)
        .filter(([k]) => ['supplier_order_number', 'delivery_date', 'quantity'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`)
    }
    if (warnings.length > 0) {
      summaryParts.push(warnings.join(' '))
    }

    // Persist parsed fields so Confirmation Details card can show them (fix: chat displayed data but card stayed missing)
    const caseId = context.caseId
    console.log('[AGENT_CHAT] About to updateCase with confirmation_status:', { caseId, autoConfirmationStatus, previousStatus: caseData.confirmation_status })
    updateCase(caseId, { confirmation_status: autoConfirmationStatus })
    const caseAfterUpdate = getCase(caseId)
    console.log('[AGENT_CHAT] After updateCase, case confirmation_status is now:', caseAfterUpdate?.confirmation_status, 'for caseId:', caseId)
    const evidence_attachment_id =
      parsed.supplier_order_number.attachment_id ||
      parsed.confirmed_delivery_date.attachment_id ||
      parsed.supplier_confirmed_quantity.attachment_id ||
      (pdfTexts.length > 0 ? pdfTexts[0].attachment_id : null)
    // #region agent log
    debugLog({ location: 'chat/route.ts:executeReadConfirmation', message: 'read_confirmation persist start', data: { caseId, hasSO: !!parsed.supplier_order_number.value, hasDate: !!parsed.confirmed_delivery_date.value, hasQty: parsed.supplier_confirmed_quantity.value != null } })
    // #endregion
    try {
      const now = Date.now()
      const lineNumber = Number.isFinite(parseInt(caseData.line_id, 10)) ? parseInt(caseData.line_id, 10) : null
      const confidencePct = Math.round(
        Math.max(
          parsed.supplier_order_number.confidence,
          parsed.confirmed_delivery_date.confidence,
          parsed.supplier_confirmed_quantity.confidence
        ) * 100
      )
      const supplier_order_number = parsed.supplier_order_number.value
      const confirmed_delivery_date = parsed.confirmed_delivery_date.value
      const confirmed_quantity = parsed.supplier_confirmed_quantity.value !== null ? String(parsed.supplier_confirmed_quantity.value) : null
      const raw_excerpt = parsed.raw_excerpt ?? null

      const existing = db.prepare(`SELECT id FROM confirmation_extractions WHERE case_id = ?`).get(caseId) as { id: string } | undefined
      if (existing?.id) {
        db.prepare(
          `UPDATE confirmation_extractions SET
            po_number = ?, line_number = ?, supplier_order_number = ?, confirmed_delivery_date = ?,
            confirmed_quantity = ?, evidence_source = ?, evidence_attachment_id = ?, evidence_message_id = ?,
            confidence = ?, raw_excerpt = ?, updated_at = ?
          WHERE case_id = ?`
        ).run(
          caseData.po_number,
          lineNumber,
          supplier_order_number,
          confirmed_delivery_date,
          confirmed_quantity,
          parsed.evidence_source,
          evidence_attachment_id,
          null,
          confidencePct,
          raw_excerpt,
          now,
          caseId
        )
      } else {
        db.prepare(
          `INSERT INTO confirmation_extractions (
            id, case_id, po_number, line_number, supplier_order_number, confirmed_delivery_date,
            confirmed_quantity, evidence_source, evidence_attachment_id, evidence_message_id,
            confidence, raw_excerpt, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          caseId,
          caseData.po_number,
          lineNumber,
          supplier_order_number,
          confirmed_delivery_date,
          confirmed_quantity,
          parsed.evidence_source,
          evidence_attachment_id,
          null,
          confidencePct,
          raw_excerpt,
          now,
          now
        )
      }

      const c = getCase(caseId)
      const meta = (c?.meta && typeof c.meta === 'object' ? { ...c.meta } : {}) as Record<string, unknown>
      meta.parsed_best_fields_v1 = {
        version: 'v1',
        parsed_at: now,
        evidence_source: parsed.evidence_source,
        evidence_attachment_id,
        evidence_message_id: null,
        fields: {
          supplier_order_number: parsed.supplier_order_number,
          confirmed_delivery_date: parsed.confirmed_delivery_date,
          confirmed_quantity: parsed.supplier_confirmed_quantity,
        },
        raw_excerpt: parsed.raw_excerpt,
      }
      // Persist multi-confirmation data
      if (confirmationHistory.length > 1) {
        meta.confirmation_history = confirmationHistory.slice(0, 10) // cap at 10
        meta.multi_confirmation_status = multiConfirmationStatus
      }
      updateCase(caseId, { meta, confirmation_status: autoConfirmationStatus })
      addEvent(caseId, {
        case_id: caseId,
        timestamp: now,
        event_type: 'PARSE_RESULT',
        summary: 'Parsed confirmation fields (v1)',
        evidence_refs_json: evidence_attachment_id ? { attachment_ids: [evidence_attachment_id] } : null,
        meta_json: { version: 'v1', evidence_attachment_id },
      })
      // #region agent log
      debugLog({ location: 'chat/route.ts:executeReadConfirmation', message: 'read_confirmation persist done', data: { caseId } })
      // #endregion
    } catch (persistErr) {
      console.error('[AGENT_CHAT] executeReadConfirmation persist failed:', persistErr)
      // #region agent log
      debugLog({ location: 'chat/route.ts:executeReadConfirmation', message: 'read_confirmation persist error', data: { caseId, error: persistErr instanceof Error ? persistErr.message : String(persistErr) } })
      // #endregion
    }

    return JSON.stringify({
      status: 'success',
      po_number: caseData.po_number,
      line_id: caseData.line_id,
      extracted_fields: extractedFields,
      missing_fields: missingFields,
      warnings: warnings.length > 0 ? warnings : undefined,
      price_changed: parsed.price_changed || undefined,
      evidence_source: parsed.evidence_source,
      expected_quantity: expectedQty,
      expected_unit_price: expectedUnitPrice,
      multi_confirmation_status: multiConfirmationStatus !== 'single' ? multiConfirmationStatus : undefined,
      confirmation_count: confirmationHistory.length > 1 ? confirmationHistory.length : undefined,
      confirmation_history: confirmationHistory.length > 1
        ? confirmationHistory.map(h => ({
            attachment_id: h.attachment_id,
            filename: h.filename,
            revision_detected: h.revision_detected,
            supplier_order_number: h.fields.supplier_order_number.value,
            delivery_date: h.fields.confirmed_delivery_date.value,
            quantity: h.fields.confirmed_quantity.value,
          }))
        : undefined,
      summary: summaryParts.length > 0
        ? summaryParts.join('. ')
        : 'Could not extract confirmation fields from the PDF.',
    })
  } catch (error) {
    console.error('[AGENT_CHAT] ===== ERROR in executeReadConfirmation =====')
    console.error('[AGENT_CHAT] ERROR:', error)
    console.error('[AGENT_CHAT] ERROR stack:', error instanceof Error ? error.stack : 'No stack')
    return JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : 'Read failed',
    })
  }
}

// Execute draft_email tool
async function executeDraftEmail(
  context: ToolContext,
  _args: { missing_fields: string[] }
): Promise<string> {
  const { caseId, caseData } = context

  // --- Follow-up coordinator gate (purely additive) ---
  // Consults the coordinator before drafting. If it vetoes, we return
  // an advisory message to the LLM instead of generating a draft.
  try {
    const fuState = followUpStateStore.getOrCreateState(
      caseData.po_number,
      caseData.line_id,
      caseData.supplier_email || caseData.supplier_domain || 'unknown',
    )

    const fuContext: FollowUpContext = {
      caseData,
      messages: listMessages(caseId),
      followUpState: fuState,
      now: Date.now(),
    }

    const fuDecision = coordinatorDecide(fuContext)

    console.log('[AGENT_CHAT] Follow-up coordinator decision:', {
      action: fuDecision.action,
      reason: fuDecision.reason,
    })

    addEvent(caseId, {
      case_id: caseId,
      timestamp: Date.now(),
      event_type: 'AGENT_DECISION',
      summary: `Follow-up coordinator (chat): ${fuDecision.action} — ${fuDecision.reason}`,
      evidence_refs_json: null,
      meta_json: {
        coordinator_action: fuDecision.action,
        coordinator_reason: fuDecision.reason,
        coordinator_draft: fuDecision.draft ?? null,
        source: 'chat_draft_email',
      },
    })

    if (fuDecision.action === 'WAIT') {
      return JSON.stringify({
        status: 'coordinator_wait',
        reason: fuDecision.reason,
        wait_until_ms: fuDecision.waitUntilMs ?? null,
        summary: `Follow-up coordinator advises waiting: ${fuDecision.reason}. The email draft was not generated.`,
      })
    }

    if (fuDecision.action === 'HANDOFF' || fuDecision.action === 'ESCALATE') {
      return JSON.stringify({
        status: 'coordinator_blocked',
        reason: fuDecision.reason,
        summary: `Follow-up coordinator recommends human review: ${fuDecision.reason}. The email draft was not generated.`,
      })
    }

    // SEND_FOLLOWUP or NO_OP with missing fields → proceed to draft
  } catch (coordinatorErr) {
    // Non-fatal — coordinator failure must never block drafting
    console.warn('[AGENT_CHAT] Follow-up coordinator error (non-fatal):', coordinatorErr)
  }

  try {
    const meta = (caseData.meta && typeof caseData.meta === 'object'
      ? caseData.meta
      : typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : {}
    ) as Record<string, any>

    // ── 1. Gather ALL confirmed values from every available source ──
    // Source A: meta.parsed_best_fields_v1 (set by search_inbox / read_confirmation)
    const parsed = meta.parsed_best_fields_v1 ?? {}

    // Source B: confirmation_extractions table (most authoritative)
    let dbExtraction: {
      supplier_order_number: string | null
      confirmed_delivery_date: string | null
      confirmed_quantity: string | null
    } | undefined
    try {
      const db = getDb()
      dbExtraction = db.prepare(
        `SELECT supplier_order_number, confirmed_delivery_date, confirmed_quantity
         FROM confirmation_extractions WHERE case_id = ? LIMIT 1`
      ).get(caseId) as typeof dbExtraction
    } catch { /* non-fatal */ }

    // Merge: DB wins over meta (DB is written later and may be more complete)
    const confirmedSO = dbExtraction?.supplier_order_number ?? parsed.supplier_order_number ?? null
    const confirmedDate = dbExtraction?.confirmed_delivery_date ?? parsed.confirmed_delivery_date ?? null
    const confirmedQty = dbExtraction?.confirmed_quantity != null
      ? Number(dbExtraction.confirmed_quantity)
      : (parsed.confirmed_quantity != null ? Number(parsed.confirmed_quantity) : null)

    // ── 2. Gather PO expected values ──
    const poLine = meta.po_line ?? {}
    const expectedQty = poLine.ordered_quantity != null ? Number(poLine.ordered_quantity) : null

    // ── 3. Build supplierConfirmed — always populate with real data ──
    // The email template in emailDraft.ts decides what's "missing" or "mismatched"
    // by comparing these values. We must NOT null-out confirmed values just because
    // the LLM listed a field in missing_fields — that would make the template think
    // a confirmed field is missing and ask the supplier for it again.
    //
    // Additionally, overlay resolvedFields from the follow-up coordinator so that
    // fields resolved in prior rounds are never re-requested.
    let resolvedSO: string | null = null
    let resolvedDeliveryDate: string | null = null
    let resolvedShipDate: string | null = null
    let resolvedQty: number | null = null
    try {
      const fuState = followUpStateStore.getOrCreateState(
        caseData.po_number,
        caseData.line_id,
        caseData.supplier_email || caseData.supplier_domain || 'unknown',
      )
      if (fuState.resolvedFields.supplier_reference) {
        resolvedSO = String(fuState.resolvedFields.supplier_reference.value)
      }
      if (fuState.resolvedFields.delivery_date) {
        resolvedDeliveryDate = String(fuState.resolvedFields.delivery_date.value)
      }
      if (fuState.resolvedFields.ship_date) {
        resolvedShipDate = String(fuState.resolvedFields.ship_date.value)
      }
      if (fuState.resolvedFields.quantity) {
        resolvedQty = Number(fuState.resolvedFields.quantity.value)
      }
    } catch { /* non-fatal */ }

    const supplierConfirmed: EmailDraftContext['supplierConfirmed'] = {
      supplierOrderNumber: { value: confirmedSO || confirmedDate ? confirmedSO : null },
      deliveryDate: { value: resolvedDeliveryDate || confirmedDate },
      shipDate: { value: resolvedShipDate },
      quantity: { value: resolvedQty ?? confirmedQty },
    }
    // Ensure supplier order number uses best available value
    supplierConfirmed.supplierOrderNumber = { value: resolvedSO || confirmedSO }

    const poExpected: EmailDraftContext['poExpected'] = {
      deliveryDate: { value: null }, // PO expected delivery date not tracked yet
      quantity: { value: expectedQty },
    }

    // ── 4. Generate email — template only includes missing/mismatched fields ──
    const draftContext: EmailDraftContext = {
      poNumber: caseData.po_number,
      lineId: caseData.line_id,
      supplierName: caseData.supplier_name || null,
      supplierEmail: caseData.supplier_email || '',
      supplierConfirmed,
      poExpected,
    }

    const draft = generateConfirmationEmailV2(draftContext)

    // Check for existing thread
    const threadId = meta.thread_id || null
    const isDemoMode = process.env.DEMO_MODE === 'true'

    // If generateConfirmationEmailV2 returned null (everything matches), produce a generic draft
    const subject = draft?.subject ?? `PO ${caseData.po_number} – Confirmation needed`
    const body = draft?.bodyText ?? `Hi,\n\nWe need confirmation for Purchase Order ${caseData.po_number}.\n\nThank you,\nProcurement Team`

    return JSON.stringify({
      status: 'draft_ready',
      po_number: caseData.po_number,
      line_id: caseData.line_id,
      subject,
      body,
      to: caseData.supplier_email || '',
      thread_id: threadId,
      demo_mode: isDemoMode,
      demo_warning: isDemoMode ? 'Demo Mode: Email will be sent to test account instead of real supplier.' : null,
      summary: `Draft ready to send to ${caseData.supplier_email || 'supplier'}. Subject: "${subject}"`,
    })
  } catch (error) {
    return JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : 'Draft failed',
    })
  }
}

// Execute send_email tool
async function executeSendEmail(
  context: ToolContext,
  args: { subject: string; body: string; thread_id?: string },
  conversationHistory: Array<{ role: string; content: string }> = []
): Promise<string> {
  const { caseData } = context

  console.log('[AGENT_CHAT] executeSendEmail called with:', {
    caseId: context.caseId,
    caseIdType: typeof context.caseId,
    caseIdLength: context.caseId?.length,
    caseDataExists: !!caseData,
    caseDataCaseId: caseData?.case_id,
    supplierEmail: caseData?.supplier_email,
    conversationHistoryLength: conversationHistory.length,
  })

  // Demo mode email override - check at the top for safety
  const isDemoMode = process.env.DEMO_MODE === 'true'
  let originalSupplierEmail = caseData.supplier_email || null
  let actualRecipientEmail: string | null = null
  let supplierEmail = caseData.supplier_email
  
  if (isDemoMode) {
    const demoEmail = process.env.DEMO_RECIPIENT_EMAIL || DEMO_SUPPLIER_EMAIL
    actualRecipientEmail = demoEmail
    console.log('[AGENT_CHAT] DEMO MODE: Using demo email, skipping supplier_email validation')
    console.log(`[AGENT_CHAT] DEMO MODE: Overriding recipient to ${demoEmail}`)
    console.log(`[AGENT_CHAT] Original supplier email (for logs/UI): ${originalSupplierEmail || 'not set'}`)
  } else if (!supplierEmail) {
    // Only check for missing supplier_email if NOT in demo mode
    console.log('[AGENT_CHAT] Supplier email missing, searching conversation history...')
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g
    const foundEmails = new Set<string>()
    
    // Search all messages in conversation history
    for (const msg of conversationHistory) {
      const matches = msg.content.match(emailRegex)
      if (matches) {
        matches.forEach(email => foundEmails.add(email.toLowerCase()))
      }
    }
    
    // Filter out common non-supplier emails
    const excludedDomains = ['gmail.com', 'example.com', 'test.com', 'buyer@']
    const candidateEmails = Array.from(foundEmails).filter(email => {
      const domain = email.split('@')[1]?.toLowerCase()
      return domain && !excludedDomains.some(excluded => email.includes(excluded))
    })
    
    if (candidateEmails.length > 0) {
      supplierEmail = candidateEmails[0] // Use first found email
      console.log('[AGENT_CHAT] Found email in conversation history:', supplierEmail)
      
      // Update the case with the found email
      try {
        const db = getDb()
        const supplierDomain = supplierEmail.includes('@') ? supplierEmail.split('@')[1] : null
        updateCase(context.caseId, {
          supplier_email: supplierEmail,
          supplier_domain: supplierDomain,
        })
        
        // Update caseData for this function
        caseData.supplier_email = supplierEmail
        caseData.supplier_domain = supplierDomain
        
        console.log('[AGENT_CHAT] Updated case with email from conversation:', {
          caseId: context.caseId,
          supplierEmail,
          supplierDomain,
        })
      } catch (updateError) {
        console.error('[AGENT_CHAT] Failed to update case with email:', updateError)
        // Continue anyway - we'll use the email for sending
      }
    } else {
      console.log('[AGENT_CHAT] No supplier email found in conversation history')
      return JSON.stringify({
        status: 'error',
        error: 'No supplier email address on file. Please provide a supplier email address in the conversation or update the case.',
      })
    }
  }

  try {
    // Verify case exists in database before proceeding
    const db = getDb()
    const caseCheck = db.prepare('SELECT case_id FROM cases WHERE case_id = ?').get(context.caseId) as { case_id: string } | undefined
    
    if (!caseCheck) {
      console.error('[AGENT_CHAT] FOREIGN KEY ERROR: Case not found in database:', {
        caseId: context.caseId,
        caseIdFromContext: context.caseId,
        caseIdFromCaseData: caseData.case_id,
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
      })
      
      // Try to find case by PO number
      const caseByPo = db.prepare('SELECT case_id FROM cases WHERE po_number = ? AND line_id = ?').get(
        caseData.po_number,
        caseData.line_id
      ) as { case_id: string } | undefined
      
      if (caseByPo) {
        console.log('[AGENT_CHAT] Found case by PO number, using correct caseId:', caseByPo.case_id)
        // Update context with correct caseId
        context.caseId = caseByPo.case_id
      } else {
        return JSON.stringify({
          status: 'error',
          error: `Case ${context.caseId} not found in database. Cannot log email event.`,
        })
      }
    } else {
      console.log('[AGENT_CHAT] Case verified in database:', {
        caseId: context.caseId,
        foundCaseId: caseCheck.case_id,
        match: context.caseId === caseCheck.case_id,
      })
    }

    // 2. Check for existing email thread
    let threadId = args.thread_id || null
    
    if (!threadId) {
      console.log('[AGENT_CHAT] No thread_id provided, checking for existing thread...')
      
      // Check case events for EMAIL_SENT events with thread_id
      const db = getDb()
      const emailEvents = db.prepare(`
        SELECT meta_json FROM events 
        WHERE case_id = ? AND event_type = 'EMAIL_SENT'
        ORDER BY timestamp DESC
        LIMIT 5
      `).all(context.caseId) as Array<{ meta_json: string }>
      
      for (const event of emailEvents) {
        try {
          const meta = JSON.parse(event.meta_json || '{}')
          if (meta.thread_id) {
            threadId = meta.thread_id
            console.log('[AGENT_CHAT] Found existing thread from events:', threadId)
            break
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
      
      // Also check case meta for evidence_summary.thread_id
      if (!threadId && caseData.meta) {
        try {
          const meta = typeof caseData.meta === 'string' ? JSON.parse(caseData.meta) : caseData.meta
          if (meta.evidence_summary?.thread_id) {
            threadId = meta.evidence_summary.thread_id
            console.log('[AGENT_CHAT] Found existing thread from case meta:', threadId)
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
      
      // Check messages table for existing thread
      if (!threadId) {
        const existingMessage = db.prepare(`
          SELECT thread_id FROM messages 
          WHERE case_id = ? AND direction = 'OUTBOUND'
          ORDER BY created_at DESC
          LIMIT 1
        `).get(context.caseId) as { thread_id: string } | undefined
        
        if (existingMessage?.thread_id) {
          threadId = existingMessage.thread_id
          console.log('[AGENT_CHAT] Found existing thread from messages table:', threadId)
        }
      }
    }

    // Use demo email if in demo mode (already set at top), otherwise use supplier email
    const actualTo = actualRecipientEmail || supplierEmail
    const bcc = DEMO_SUPPLIER_EMAIL

    // 3. Choose the right send method and log decision
    console.log('[AGENT_CHAT] Email send decision:', {
      to: actualTo,
      subject: args.subject,
      hasThreadId: !!threadId,
      threadId: threadId,
      demoMode: isDemoMode,
    })

    let result
    if (threadId) {
      console.log('[AGENT_CHAT] Found existing thread:', { threadId }, 'replying in thread')
      result = await sendReplyInThread({
        threadId: threadId,
        to: actualTo,
        subject: args.subject,
        bodyText: args.body,
        bcc,
      })
    } else {
      console.log('[AGENT_CHAT] No existing thread, sending new email')
      result = await sendNewEmail({
        to: actualTo,
        subject: args.subject,
        bodyText: args.body,
        bcc,
      })
    }

    console.log('[AGENT_CHAT] Email sent successfully:', {
      gmailMessageId: result.gmailMessageId,
      threadId: result.threadId,
    })

    // Log event - use verified caseId
    try {
      console.log('[AGENT_CHAT] Attempting to add event with caseId:', context.caseId)
      addEvent(context.caseId, {
        case_id: context.caseId,
        timestamp: Date.now(),
        event_type: 'EMAIL_SENT',
        summary: `Chat agent sent email: ${args.subject}`,
        evidence_refs_json: { message_ids: [result.gmailMessageId] },
        meta_json: {
          subject: args.subject,
          to: actualTo,
          thread_id: result.threadId,
          demo_mode: isDemoMode,
        },
      })
      console.log('[AGENT_CHAT] Event added successfully')
    } catch (eventError) {
      console.error('[AGENT_CHAT] Failed to add event:', {
        error: eventError instanceof Error ? eventError.message : 'Unknown error',
        stack: eventError instanceof Error ? eventError.stack : undefined,
        caseId: context.caseId,
        caseIdType: typeof context.caseId,
        caseIdValue: context.caseId,
      })
      
      // Verify case still exists
      const caseStillExists = db.prepare('SELECT case_id FROM cases WHERE case_id = ?').get(context.caseId)
      console.log('[AGENT_CHAT] Case still exists after error:', !!caseStillExists)
      
      // Don't fail the whole operation if event logging fails
      // The email was sent successfully, so we'll continue
    }

    return JSON.stringify({
      status: 'sent',
      po_number: caseData.po_number,
      line_id: caseData.line_id,
      message_id: result.gmailMessageId,
      thread_id: result.threadId,
      sent_to: actualTo,
      demo_mode: isDemoMode,
      summary: isDemoMode
        ? `Email sent to test account (${actualTo}) in demo mode.`
        : `Email sent to ${actualTo}.`,
    })
  } catch (error) {
    return JSON.stringify({
      status: 'error',
      error: error instanceof Error ? error.message : 'Send failed',
    })
  }
}

/**
 * Extract PO numbers from a message using common patterns
 * Returns array of potential PO numbers found
 */
function extractPoNumbersFromMessage(message: string): string[] {
  const poNumbers: string[] = []
  
  // Pattern 1: "PO 123456" or "PO# 123456" or "PO-123456"
  const poPattern = /\bPO[#\-\s]*(\d{5,10})\b/gi
  let match
  while ((match = poPattern.exec(message)) !== null) {
    poNumbers.push(match[1])
  }
  
  // Pattern 2: "purchase order 123456"
  const purchaseOrderPattern = /\bpurchase\s+order[#\-\s]*(\d{5,10})\b/gi
  while ((match = purchaseOrderPattern.exec(message)) !== null) {
    if (!poNumbers.includes(match[1])) {
      poNumbers.push(match[1])
    }
  }
  
  // Pattern 3: Just a 6-7 digit number that looks like a PO (standalone)
  const standalonePattern = /\b(\d{6,7})\b/g
  while ((match = standalonePattern.exec(message)) !== null) {
    if (!poNumbers.includes(match[1])) {
      poNumbers.push(match[1])
    }
  }
  
  return poNumbers
}

/**
 * Construct SupplierChaseCase from database row
 */
function caseDataFromRow(row: any): any {
  return {
    case_id: row.case_id,
    po_number: row.po_number,
    line_id: row.line_id,
    supplier_name: row.supplier_name,
    supplier_email: row.supplier_email,
    supplier_domain: row.supplier_domain,
    missing_fields: JSON.parse(row.missing_fields || '[]'),
    state: row.state,
    status: row.status,
    touch_count: row.touch_count,
    last_action_at: row.last_action_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    meta: JSON.parse(row.meta || '{}'),
  }
}

/**
 * Find a case by PO number from the database
 */
function findCaseByPoNumber(poNumber: string): { case_id: string; po_number: string; line_id: string } | null {
  const db = getDb()
  
  // Try exact match first
  let result = db
    .prepare('SELECT case_id, po_number, line_id FROM cases WHERE po_number = ? LIMIT 1')
    .get(poNumber) as { case_id: string; po_number: string; line_id: string } | undefined
  
  if (result) return result
  
  // Try with leading zeros stripped or added
  const trimmed = poNumber.replace(/^0+/, '')
  result = db
    .prepare('SELECT case_id, po_number, line_id FROM cases WHERE po_number = ? OR po_number = ? LIMIT 1')
    .get(trimmed, '0' + trimmed) as { case_id: string; po_number: string; line_id: string } | undefined
  
  if (result) return result
  
  // Try LIKE search as fallback
  result = db
    .prepare('SELECT case_id, po_number, line_id FROM cases WHERE po_number LIKE ? LIMIT 1')
    .get(`%${poNumber}%`) as { case_id: string; po_number: string; line_id: string } | undefined
  
  return result || null
}

// Main chat handler
export async function POST(request: NextRequest) {
  console.log('[AGENT_CHAT] ===== Request received =====')
  console.log('[AGENT_CHAT] OPENAI_API_KEY configured:', !!process.env.OPENAI_API_KEY)
  console.log('[AGENT_CHAT] OPENAI_API_KEY length:', process.env.OPENAI_API_KEY?.length || 0)
  
  try {
    const body = await request.json()
    console.log('[AGENT_CHAT] Request body:', {
      message: body.message?.substring(0, 100),
      caseId: body.caseId,
      conversationHistoryLength: body.conversationHistory?.length || 0,
    })
    
    const { message, caseId: providedCaseId, poNumber: clientPoNumber, lineId: clientLineId, supplierName: clientSupplierName, supplierEmail: clientSupplierEmail, conversationHistory = [] } = body

    // Validate message
    if (!message || typeof message !== 'string') {
      console.log('[AGENT_CHAT] Validation failed: missing message')
      return NextResponse.json(
        { error: 'Missing required field: message', response: 'Missing required field: message' },
        { status: 400 }
      )
    }

    // Use getDb() to get the shared database connection (consistent with all other endpoints)
    const db = getDb()
    console.log('[AGENT_CHAT] Using shared database connection, path:', getDbPath())

    let caseData: any = null
    let resolvedCaseId: string | null = null
    
    // Try provided caseId first
    if (providedCaseId && typeof providedCaseId === 'string' && providedCaseId !== 'abc-123') {
      console.log('[AGENT_CHAT] Direct lookup for caseId:', providedCaseId)
      const row = db.prepare('SELECT * FROM cases WHERE case_id = ?').get(providedCaseId) as any
      
      if (row) {
        caseData = {
          case_id: row.case_id,
          po_number: row.po_number,
          line_id: row.line_id,
          supplier_name: row.supplier_name,
          supplier_email: row.supplier_email,
          supplier_domain: row.supplier_domain,
          missing_fields: JSON.parse(row.missing_fields || '[]'),
          state: row.state,
          status: row.status,
          touch_count: row.touch_count,
          last_action_at: row.last_action_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
          next_check_at: row.next_check_at || null,
          last_inbox_check_at: row.last_inbox_check_at || null,
          meta: JSON.parse(row.meta || '{}')
        }
        resolvedCaseId = providedCaseId
        console.log('[AGENT_CHAT] DIRECT lookup success:', caseData.po_number)
      } else {
        // Retry once after 200ms to handle race condition with /api/cases/resolve
        console.log('[AGENT_CHAT] Direct lookup failed for caseId, retrying in 200ms:', providedCaseId)
        await new Promise(r => setTimeout(r, 200))
        const retryRow = db.prepare('SELECT * FROM cases WHERE case_id = ?').get(providedCaseId) as any
        if (retryRow) {
          caseData = caseDataFromRow(retryRow)
          resolvedCaseId = providedCaseId
          console.log('[AGENT_CHAT] Retry lookup SUCCESS:', caseData.po_number)
        } else {
          console.warn('[AGENT_CHAT] Retry lookup also failed for caseId:', providedCaseId)
        }
      }
    }

    // Fallback: use client-provided PO context ONLY when DB is truly unavailable (Vercel ephemeral /tmp).
    // Log a critical warning since meta will be incomplete (no po_line.ordered_quantity).
    if (!caseData && clientPoNumber) {
      console.warn('[AGENT_CHAT] DEGRADED: Using client-provided PO context as fallback (meta will be empty):', { clientPoNumber, clientLineId, providedCaseId })
      const now = Date.now()
      caseData = {
        case_id: providedCaseId || `fallback-${now}`,
        po_number: clientPoNumber,
        line_id: clientLineId || '',
        supplier_name: clientSupplierName || null,
        supplier_email: clientSupplierEmail || null,
        supplier_domain: clientSupplierEmail ? clientSupplierEmail.split('@')[1] : null,
        missing_fields: ['supplier_reference', 'delivery_date', 'quantity'],
        state: 'INBOX_LOOKUP',
        status: 'STILL_AMBIGUOUS',
        touch_count: 0,
        last_action_at: now,
        created_at: now,
        updated_at: now,
        next_check_at: null,
        last_inbox_check_at: null,
        meta: {},
      }
      resolvedCaseId = caseData.case_id
    }

    // If no case found and no caseId provided, try extracting PO from message
    if (!caseData) {
      const poNumbers = extractPoNumbersFromMessage(message)
      console.log('[AGENT_CHAT] Extracted PO numbers from message:', poNumbers)
      
      for (const poNumber of poNumbers) {
        // Try exact match
        let row = db.prepare('SELECT * FROM cases WHERE po_number = ? LIMIT 1').get(poNumber) as any
        
        // Try with leading zeros variations
        if (!row) {
          const trimmed = poNumber.replace(/^0+/, '')
          row = db.prepare('SELECT * FROM cases WHERE po_number = ? OR po_number = ? LIMIT 1')
            .get(trimmed, '0' + trimmed) as any
        }
        
        if (row) {
          caseData = {
            case_id: row.case_id,
            po_number: row.po_number,
            line_id: row.line_id,
            supplier_name: row.supplier_name,
            supplier_email: row.supplier_email,
            supplier_domain: row.supplier_domain,
            missing_fields: JSON.parse(row.missing_fields || '[]'),
            state: row.state,
            status: row.status,
            touch_count: row.touch_count,
            last_action_at: row.last_action_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            next_check_at: row.next_check_at || null,
            last_inbox_check_at: row.last_inbox_check_at || null,
            meta: JSON.parse(row.meta || '{}')
          }
          resolvedCaseId = row.case_id
          console.log(`[AGENT_CHAT] DIRECT lookup by PO success: PO ${poNumber} -> case ${resolvedCaseId}`)
          break
        }
      }
    }
    
    // Note: Don't close the database connection - it's a singleton shared across the app
    
    // If still no case, return helpful error
    if (!caseData || !resolvedCaseId) {
      console.log('[AGENT_CHAT] No case found, returning error response')
      const poNumbers = extractPoNumbersFromMessage(message)
      if (poNumbers.length > 0) {
        return NextResponse.json({
          response: `I couldn't find a case for PO ${poNumbers[0]} in the database. Please make sure the PO has been imported and try again, or select the PO from the work queue.`,
          message: `I couldn't find a case for PO ${poNumbers[0]} in the database. Please make sure the PO has been imported and try again, or select the PO from the work queue.`,
          tool_calls: [],
          case_state: null,
        })
      }
      
      return NextResponse.json({
        response: `I need to know which PO you're asking about. Please mention a PO number (like "PO 907126") or select a PO from the work queue first.`,
        message: `I need to know which PO you're asking about. Please mention a PO number (like "PO 907126") or select a PO from the work queue first.`,
        tool_calls: [],
        case_state: null,
      })
    }
    
    const caseId = resolvedCaseId
    
    // Verify caseId matches caseData.case_id (sanity check)
    if (caseId !== caseData.case_id) {
      console.warn('[AGENT_CHAT] CaseId mismatch detected:', {
        resolvedCaseId: caseId,
        caseDataCaseId: caseData.case_id,
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
      })
      // Use caseData.case_id as the source of truth
      const correctedCaseId = caseData.case_id
      console.log('[AGENT_CHAT] Correcting caseId to:', correctedCaseId)
      // Update resolvedCaseId for consistency
      resolvedCaseId = correctedCaseId
    }
    
    // Final verification: ensure case exists in database (with one retry)
    const dbForVerification = getDb()
    let finalCaseCheck = dbForVerification.prepare('SELECT case_id FROM cases WHERE case_id = ?').get(caseId) as { case_id: string } | undefined
    if (!finalCaseCheck) {
      console.warn('[AGENT_CHAT] Final verification failed, retrying in 200ms:', { caseId })
      await new Promise(r => setTimeout(r, 200))
      finalCaseCheck = dbForVerification.prepare('SELECT case_id FROM cases WHERE case_id = ?').get(caseId) as { case_id: string } | undefined
    }
    if (!finalCaseCheck) {
      console.error('[AGENT_CHAT] CRITICAL: CaseId does not exist in database after retry:', {
        caseId,
        caseDataCaseId: caseData.case_id,
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
      })
      return NextResponse.json({
        error: 'CASE_NOT_FOUND',
        response: `Case not found. Please re-select the PO from the work queue.`,
        message: `Case not found. Please re-select the PO from the work queue.`,
        tool_calls: [],
        case_state: null,
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
      }, { status: 404 })
    }
    
    console.log('[AGENT_CHAT] Using case (verified in DB):', { 
      caseId, 
      verifiedCaseId: finalCaseCheck.case_id,
      poNumber: caseData.po_number, 
      lineId: caseData.line_id 
    })

    // Check OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      console.error('[AGENT_CHAT] OPENAI_API_KEY not configured')
      return NextResponse.json({
        response: 'OpenAI API key is not configured. Please set OPENAI_API_KEY in your environment variables.',
        message: 'OpenAI API key is not configured. Please set OPENAI_API_KEY in your environment variables.',
        tool_calls: [],
        case_state: null,
      }, { status: 500 })
    }
    
    console.log('[AGENT_CHAT] Initializing OpenAI client...')
    const openai = getOpenAIClient()

    // Load follow-up state for system prompt context
    let fuState: SupplierFollowUpState | undefined
    try {
      fuState = followUpStateStore.getOrCreateState(
        caseData.po_number,
        caseData.line_id,
        caseData.supplier_email || caseData.supplier_domain || 'unknown',
      )
    } catch (e) {
      console.warn('[AGENT_CHAT] Failed to load follow-up state for prompt (non-fatal):', e)
    }

    // Build system prompt with case context (AFTER loading case data)
    const systemPrompt = buildSystemPrompt(caseData, fuState)
    console.log('[AGENT_CHAT] System prompt built, length:', systemPrompt.length)

    // Build messages array - system prompt MUST be first
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((msg: { role: string; content: string }) => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      })),
      { role: 'user', content: message },
    ]

    console.log('[AGENT_CHAT] Built messages array:', {
      totalMessages: messages.length,
      systemMessages: messages.filter(m => m.role === 'system').length,
      firstMessageRole: messages[0]?.role,
      firstMessageContentLength: messages[0]?.role === 'system' ? (messages[0] as any).content?.length : 0,
      conversationHistoryLength: conversationHistory.length,
    })
    
    // Verify system prompt is first
    if (messages[0]?.role !== 'system') {
      console.error('[AGENT_CHAT] ERROR: First message is not a system message!', {
        firstMessageRole: messages[0]?.role,
      })
    }

    // Track tool calls made
    const toolCallsExecuted: Array<{ tool: string; args: any; result: any }> = []

    // Run conversation with tool calling loop
    console.log('[AGENT_CHAT] Calling OpenAI API...')
    let response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.3,
    })
    
    console.log('[AGENT_CHAT] OpenAI API response received:', {
      hasChoices: !!response.choices && response.choices.length > 0,
      hasContent: !!response.choices?.[0]?.message?.content,
      contentLength: response.choices?.[0]?.message?.content?.length || 0,
      hasToolCalls: !!response.choices?.[0]?.message?.tool_calls,
      toolCallsCount: response.choices?.[0]?.message?.tool_calls?.length || 0,
      finishReason: response.choices?.[0]?.finish_reason,
    })
    
    if (!response.choices || response.choices.length === 0) {
      throw new Error('OpenAI API returned no choices in response')
    }

    // Tool calling loop
    let iterationCount = 0
    const maxIterations = 10 // Safety limit
    
    while (response.choices[0].message.tool_calls && iterationCount < maxIterations) {
      iterationCount++
      const toolCalls = response.choices[0].message.tool_calls
      
      console.log(`[AGENT_CHAT] Tool calling iteration ${iterationCount}, executing ${toolCalls.length} tool(s)`)
      
      // Add assistant message with tool calls
      messages.push(response.choices[0].message)

      // Execute each tool call
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}')
        
        console.log(`[AGENT_CHAT] Executing tool: ${toolName}`, { args: toolArgs })
        
        let toolResult: string
        const toolContext: ToolContext = { caseId, caseData }

        try {
          switch (toolName) {
            case 'search_inbox':
              toolResult = await executeSearchInbox(toolContext, toolArgs)
              break
            case 'read_confirmation':
              toolResult = await executeReadConfirmation(toolContext)
              break
            case 'draft_email':
              toolResult = await executeDraftEmail(toolContext, toolArgs)
              break
            case 'send_email':
              toolResult = await executeSendEmail(toolContext, toolArgs, conversationHistory)
              break
            default:
              toolResult = JSON.stringify({ error: `Unknown tool: ${toolName}` })
          }
          
          console.log(`[AGENT_CHAT] Tool ${toolName} completed, result length:`, toolResult.length)
        } catch (toolError) {
          console.error(`[AGENT_CHAT] Tool ${toolName} failed:`, toolError)
          toolResult = JSON.stringify({
            status: 'error',
            error: toolError instanceof Error ? toolError.message : 'Tool execution failed',
          })
        }

        toolCallsExecuted.push({
          tool: toolName,
          args: toolArgs,
          result: JSON.parse(toolResult),
        })

        // Add tool result message
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        })
      }

      // Continue conversation
      console.log('[AGENT_CHAT] Calling OpenAI API again after tool execution...')
      response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
      })
      
      console.log('[AGENT_CHAT] OpenAI API response after tools:', {
        hasChoices: !!response.choices && response.choices.length > 0,
        hasContent: !!response.choices?.[0]?.message?.content,
        contentLength: response.choices?.[0]?.message?.content?.length || 0,
        hasToolCalls: !!response.choices?.[0]?.message?.tool_calls,
        toolCallsCount: response.choices?.[0]?.message?.tool_calls?.length || 0,
        finishReason: response.choices?.[0]?.finish_reason,
      })
      
      if (!response.choices || response.choices.length === 0) {
        throw new Error('OpenAI API returned no choices in response after tool execution')
      }
    }
    
    if (iterationCount >= maxIterations) {
      console.warn('[AGENT_CHAT] Reached max tool calling iterations')
    }

    // Get final response
    if (!response.choices || response.choices.length === 0) {
      throw new Error('OpenAI API returned no choices in final response')
    }
    
    const assistantMessage = response.choices[0]?.message?.content || 'I was unable to generate a response.'
    
    if (!assistantMessage || assistantMessage.trim().length === 0) {
      console.warn('[AGENT_CHAT] Empty assistant message, using fallback')
      const fallbackMessage = toolCallsExecuted.length > 0
        ? 'I completed the requested actions but was unable to generate a response. Please check the tool results.'
        : 'I was unable to generate a response. Please try rephrasing your question.'
      
      const finalResponse = {
        response: fallbackMessage,
        message: fallbackMessage,
        tool_calls: toolCallsExecuted,
        case_state: getCase(caseId) ? {
          state: getCase(caseId)!.state,
          missing_fields: getCase(caseId)!.missing_fields,
          supplier_email: getCase(caseId)!.supplier_email,
        } : null,
      }
      
      console.log('[AGENT_CHAT] Returning fallback response')
      return NextResponse.json(finalResponse)
    }
    
    console.log('[AGENT_CHAT] Final assistant message:', {
      length: assistantMessage.length,
      preview: assistantMessage.substring(0, 100),
      toolCallsExecuted: toolCallsExecuted.length,
    })

    // Reload case to get any updates
    const updatedCase = getCase(caseId)

    const finalResponse = {
      response: assistantMessage,
      message: assistantMessage, // Also include as "message" for compatibility
      tool_calls: toolCallsExecuted,
      case_state: updatedCase ? {
        state: updatedCase.state,
        missing_fields: updatedCase.missing_fields,
        supplier_email: updatedCase.supplier_email,
      } : null,
    }
    
    console.log('[AGENT_CHAT] Returning response:', {
      hasResponse: !!finalResponse.response,
      responseLength: finalResponse.response?.length || 0,
      toolCallsCount: finalResponse.tool_calls.length,
    })
    console.log('[AGENT_CHAT] ===== Request completed =====')

    return NextResponse.json(finalResponse)
  } catch (error) {
    console.error('[AGENT_CHAT] ===== ERROR =====')
    console.error('[AGENT_CHAT] Error type:', error instanceof Error ? error.constructor.name : typeof error)
    console.error('[AGENT_CHAT] Error message:', error instanceof Error ? error.message : String(error))
    console.error('[AGENT_CHAT] Error stack:', error instanceof Error ? error.stack : 'No stack trace')
    console.error('[AGENT_CHAT] ===== ERROR END =====')
    
    const errorMessage = error instanceof Error ? error.message : 'Chat failed'
    const errorResponse = {
      error: errorMessage,
      response: `I encountered an error: ${errorMessage}. Please try again or check the server logs.`,
      message: `I encountered an error: ${errorMessage}. Please try again or check the server logs.`,
      tool_calls: [],
      case_state: null,
    }
    
    return NextResponse.json(errorResponse, { status: 500 })
  }
}
