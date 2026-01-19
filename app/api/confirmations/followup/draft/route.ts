import { NextRequest, NextResponse } from 'next/server'
import { getCase, listMessages, listAttachmentsForCase } from '@/src/lib/supplier-agent/store'
import { generateConfirmationEmail } from '@/src/lib/supplier-agent/emailDraft'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { caseId, threadId, missingFields: requestedMissingFields, poNumber, lineId, supplierName, supplierEmail } = body

    // Validate required field
    if (!caseId || typeof caseId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid caseId. Required field: caseId (string)' },
        { status: 400 }
      )
    }

    const caseData = getCase(caseId)
    if (!caseData) {
      return NextResponse.json({ error: `Case ${caseId} not found` }, { status: 404 })
    }

    // Use provided values or fall back to case data (to fix wrong-case bug)
    const resolvedPoNumber = poNumber || caseData.po_number
    const resolvedLineId = lineId || caseData.line_id
    const resolvedSupplierName = supplierName || caseData.supplier_name || null
    const resolvedSupplierEmail = supplierEmail || caseData.supplier_email || ''

    // Determine missing fields: use requested fields if provided, otherwise derive from case
    let missingFields: string[] = []
    if (Array.isArray(requestedMissingFields) && requestedMissingFields.length > 0) {
      missingFields = requestedMissingFields
    } else {
      // Derive from case.missing_fields
      missingFields = Array.isArray(caseData.missing_fields) ? caseData.missing_fields : []
      
      // If still empty, try to derive from parsed_best_fields_v1 (delivery_date, quantity)
      if (missingFields.length === 0) {
        const meta = (caseData.meta && typeof caseData.meta === 'object' ? caseData.meta : {}) as Record<string, any>
        const parsed = meta.parsed_best_fields_v1
        if (parsed) {
          if (!parsed.confirmed_delivery_date?.value) missingFields.push('confirmed_delivery_date')
          if (!parsed.supplier_order_number?.value) missingFields.push('supplier_order_number')
          if (!(parsed.confirmed_quantity?.value !== null && parsed.confirmed_quantity?.value !== undefined)) {
            missingFields.push('confirmed_quantity')
          }
        }
      }
    }

    // Dev log for missing fields used
    console.log("[FOLLOWUP_DRAFT_FIELDS]", { 
      caseId, 
      missingFields,
      poNumber: resolvedPoNumber,
      lineId: resolvedLineId,
      supplierName: resolvedSupplierName,
      supplierEmail: resolvedSupplierEmail
    })

    // If still no missing fields, return a minimal draft (no error - just no missing fields to request)
    // This allows the UI to show a draft even if all fields are found
    if (missingFields.length === 0) {
      // Generate a minimal follow-up draft anyway (acknowledgment or general follow-up)
      const emailDraft = generateConfirmationEmail({
        poNumber: caseData.po_number,
        lineId: caseData.line_id,
        supplierName: caseData.supplier_name || null,
        supplierEmail: caseData.supplier_email || '',
        missingFields: [], // Empty - will generate acknowledgment-style email
        context: {},
      })

      return NextResponse.json({
        ok: true,
        subject: emailDraft.subject,
        body: emailDraft.bodyText,
        missingFields: [],
        contextSnippet: null, // No context needed if no missing fields
      })
    }

    // Get context snippet from latest supplier reply (threadId is optional)
    let contextSnippet: string | null = null
    
    // Try to get context from messages/attachments (threadId not required)
    const messages = listMessages(caseData.case_id)
    const latestMessage = messages
      .filter(m => m.direction === 'INBOUND')
      .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]

    // Get latest attachment extract for context
    const attachments = listAttachmentsForCase(caseData.case_id)
    const latestAttachment = attachments
      .filter(a => a.text_extract && a.text_extract.length > 0)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]

    // Build context snippet from latest reply (if available)
    if (latestMessage?.body_text) {
      const bodyText = latestMessage.body_text.trim()
      // Take first 200 chars as context
      contextSnippet = bodyText.length > 200 ? bodyText.substring(0, 200) + '...' : bodyText
    } else if (latestAttachment?.text_extract) {
      const extract = latestAttachment.text_extract.trim()
      contextSnippet = extract.length > 200 ? extract.substring(0, 200) + '...' : extract
    }
    
    // If threadId was provided but we still don't have context, we could fetch from Gmail
    // For now, we'll proceed without it (contextSnippet will be null)
    
    // Determine if this is a follow-up (has supplier evidence)
    const hasSupplierEvidence = messages.some(m => m.direction === 'INBOUND') || attachments.length > 0
    
    // Get threadId from request or case.meta
    const resolvedThreadId = threadId || (caseData.meta as any)?.thread_id || (caseData.meta as any)?.gmail_threadId || null
    
    // Get original subject from latest inbound message if available (for Re: prefix)
    let originalSubject: string | null = null
    const latestInbound = messages
      .filter(m => m.direction === 'INBOUND')
      .sort((a, b) => (b.received_at || b.created_at) - (a.received_at || a.created_at))[0]
    originalSubject = latestInbound?.subject || null

    // Generate email draft using resolved values (fixes wrong-case bug)
    const emailDraft = generateConfirmationEmail({
      poNumber: resolvedPoNumber,
      lineId: resolvedLineId,
      supplierName: resolvedSupplierName,
      supplierEmail: resolvedSupplierEmail,
      missingFields, // Always include missingFields in body (generateConfirmationEmail handles this)
      context: {
        // Could be enhanced to pull from PO record
      },
    })
    
    // For follow-ups: use "Re:" prefix if hasSupplierEvidence
    // Prevent "Re: Re: Re:" accumulation by checking if already has "Re:"
    let finalSubject = emailDraft.subject
    if (hasSupplierEvidence) {
      if (originalSubject) {
        // Remove existing "Re:" prefixes and add one
        const cleanedSubject = originalSubject.replace(/^Re:\s*/i, '').trim()
        finalSubject = `Re: ${cleanedSubject}`
      } else {
        finalSubject = `Re: PO ${resolvedPoNumber} – Line ${resolvedLineId} – Confirmation`
      }
    }
    
    // Enhance body for follow-up tone if hasSupplierEvidence
    let finalBody = emailDraft.bodyText
    if (hasSupplierEvidence && missingFields.length > 0) {
      // Replace the opening with follow-up tone
      const greeting = emailDraft.bodyText.split('\n\n')[0] // "Hi [Name],"
      const afterGreeting = emailDraft.bodyText.split('\n\n').slice(1).join('\n\n')
      
      // Extract bullets section
      const bulletsMatch = afterGreeting.match(/Please confirm the following:\n\n([•][\s\S]+?)(\n\n|$)/)
      const bullets = bulletsMatch ? afterGreeting.match(/• .+/g) || [] : []
      
      if (bullets.length > 0) {
        // Simple follow-up opener
        const followUpOpening = `Thanks — quick follow-up on PO ${resolvedPoNumber}, line ${resolvedLineId}.\n\n`
        
        // Rebuild body with follow-up tone - only include missing fields bullets
        const restAfterBullets = afterGreeting.split('Please confirm the following:')[1]?.replace(/^[\s\S]*?• .+\n/gm, '').trim() || ''
        finalBody = `${greeting}\n\n${followUpOpening}Please confirm the following:\n\n${bullets.join('\n')}${restAfterBullets ? '\n\n' + restAfterBullets : ''}`
      }
    }

    return NextResponse.json({
      ok: true,
      subject: finalSubject,
      body: finalBody,
      missingFields,
      contextSnippet,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to draft follow-up'
    console.error('[FOLLOWUP_DRAFT] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
