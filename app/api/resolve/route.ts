import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

// Ensure this route runs on Node.js runtime (required for OpenAI SDK)
export const runtime = 'nodejs'

// Initialize OpenAI client lazily to avoid issues if API key is missing
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured')
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })
}

const SYSTEM_PROMPT = `ROLE
You are an Operations Resolution Agent assisting a procurement buyer with a specific purchase order line.

LENGTH CONSTRAINT (strict)
- Response MUST be ≤90 words total.
- Use at most 4 bullet points total.

OUTPUT FORMAT (always use this exact structure)
1. First line: Reference PO + line_id, then one-line diagnosis (e.g., "PO-907162 L1: Line remains open after receipt posted.")
2. Evidence bullets (2-3 max): Quote only fields from the currently selected PO line. Format: "• [field name]: [value]"
3. Next step (single sentence): One actionable next step.

STRICT RULES
- Do NOT generate emails, templates, or messages unless the user explicitly asks "draft an email/message" or similar.
- Do NOT claim you checked supplier history, similar POs, or anything not present in the provided context. Only reference what is explicitly provided.
- If the user asks something requiring missing data, say: "I can't confirm without [field name(s)]" and list the missing field(s).
- Only use the currently selected line's data unless the user explicitly asks to compare against other POs.

GROUNDING
- ALWAYS start with "PO-[po_id] L[line_id]:" in the first line.
- Only quote actual field values from the provided PO line data.
- Do not invent or infer field values not present in the data.

TONE
Calm, practical, no jargon. Do not mention AI/models or yourself.

WHAT YOU MUST NOT DO
- Do not generate emails/messages unless explicitly requested.
- Do not claim to have checked data not provided in context.
- Do not exceed 90 words or 4 bullet points.
- Do not reference data without citing specific po_id/line_id.`

interface ResolveRequest {
  case: any
  supplier_history: any[]
  part_history: any[]
  similar_lines: any[]
  user_message: string
}

type QuestionIntent = 'INTERPRETATION_RISK' | 'OPERATIONAL_EXCEPTION'

// Detect question intent from user message
function detectIntent(userMessage: string): QuestionIntent {
  const lowerMessage = userMessage.toLowerCase()
  
  // Interpretation risk keywords
  const interpretationKeywords = [
    'uom', 'unit of measure', 'unit', 'measurement', 'dimension', 'dimensions',
    'spec', 'description', 'x', 'inch', 'in', 'ft', 'feet', '"'
  ]
  
  // Operational exception keywords
  const operationalKeywords = [
    'open', 'close', 'receipt', 'received', 'overdue', 'late', 'due'
  ]
  
  // Check for interpretation risk keywords first
  const hasInterpretationKeyword = interpretationKeywords.some(keyword => 
    lowerMessage.includes(keyword)
  )
  
  // Check for operational keywords
  const hasOperationalKeyword = operationalKeywords.some(keyword => 
    lowerMessage.includes(keyword)
  )
  
  // If both present, prioritize interpretation risk
  if (hasInterpretationKeyword) {
    return 'INTERPRETATION_RISK'
  }
  
  if (hasOperationalKeyword) {
    return 'OPERATIONAL_EXCEPTION'
  }
  
  // Default to operational exception if no clear intent
  return 'OPERATIONAL_EXCEPTION'
}

export async function POST(request: NextRequest) {
  try {
    const openai = getOpenAIClient()

    const body: ResolveRequest = await request.json()
    const { case: caseData, supplier_history, part_history, similar_lines, user_message } = body

    // Detect question intent
    const intent = detectIntent(user_message)

    // Build context message
    const contextParts = []
    
    if (supplier_history.length > 0) {
      contextParts.push(`Supplier history (${supplier_history.length} prior orders):\n${JSON.stringify(supplier_history, null, 2)}`)
    }
    
    if (part_history.length > 0) {
      contextParts.push(`Part history (${part_history.length} prior orders):\n${JSON.stringify(part_history, null, 2)}`)
    }
    
    if (similar_lines.length > 0) {
      contextParts.push(`Similar lines (${similar_lines.length} similar orders):\n${JSON.stringify(similar_lines, null, 2)}`)
    }

    const contextMessage = contextParts.length > 0
      ? `\n\nContext:\n${contextParts.join('\n\n')}`
      : ''

    // Build intent-specific instructions
    let intentInstructions = ''
    let systemPromptOverride = SYSTEM_PROMPT

    if (intent === 'INTERPRETATION_RISK') {
      // Override system prompt for interpretation risk
      systemPromptOverride = `ROLE
You are an Operations Resolution Agent assisting a procurement buyer with a specific purchase order line.

LENGTH CONSTRAINT (strict)
- Response MUST be ≤90 words total.
- Use at most 4 bullet points total.

OUTPUT FORMAT (always use this exact structure)
1. First line (always use this exact text): "PO-[po_id] L[line_id]: Possible interpretation risk from description measurements."
2. Explanation sentence: Explain that dimensional notation (inches/quotes/dimensions) in the description could be interpreted as per-piece vs per-length vs per-weight, while order_qty isn't explicitly tied to a unit (piece vs length vs weight). Use "could" or "may" - do not claim certainty. Avoid vague terms like "intended application".
3. Evidence bullets (2-3 max): MUST include description field (truncate to ~80 chars), and optionally order_qty, unit_price, or any explicit uom field if present. Format: "• [field name]: [value]"
4. Next step (single sentence): Ask to confirm which unit the unit_price applies to (per piece vs per length/weight) and how the supplier interprets the quantity.

STRICT RULES
- Focus ONLY on description measurements and unit of measure ambiguity.
- Do NOT mention "line remains open after receipt" or operational status unless the user explicitly asked about open/receipt/closure.
- Do NOT generate emails, templates, or messages unless the user explicitly asks "draft an email/message" or similar.
- Do NOT claim you checked supplier history, similar POs, or anything not present in the provided context. Only reference what is explicitly provided.
- If the user asks something requiring missing data, say: "I can't confirm without [field name(s)]" and list the missing field(s).

GROUNDING
- ALWAYS start with "PO-[po_id] L[line_id]: Possible interpretation risk from description measurements." (use this exact text).
- Follow with explanation sentence that mentions dimensional notation could be interpreted as per-piece vs per-length vs per-weight, while order_qty isn't explicitly tied to a unit (piece vs length vs weight).
- Only quote actual field values from the provided PO line data.
- Do not invent or infer field values not present in the data.

TONE
Calm, practical, procurement-focused. Do not mention AI/models or yourself. Avoid vague language.

WHAT YOU MUST NOT DO
- Do not generate emails/messages unless explicitly requested.
- Do not claim to have checked data not provided in context.
- Do not exceed 90 words or 4 bullet points.
- Do not mention operational exceptions unless explicitly asked.
- Do not use vague terms like "intended application" or "use case".`

      intentInstructions = `
INTENT: INTERPRETATION_RISK
- Focus on description measurements and unit of measure ambiguity.
- First line MUST be exactly: "PO-${caseData.po_id} L${caseData.line_id}: Possible interpretation risk from description measurements."
- Follow with explanation sentence: Dimensional notation (inches/quotes/dimensions) could be interpreted as per-piece vs per-length vs per-weight, while order_qty isn't explicitly tied to a unit (piece vs length vs weight). Use "could" or "may" - do not claim certainty.
- Evidence MUST include description field (truncate to ~80 chars).
- Next step: Confirm which unit unit_price applies to (per piece vs per length/weight) and how supplier interprets quantity.
- Do NOT mention operational status (open/close/receipt) unless user explicitly asked about it.`
    } else {
      // OPERATIONAL_EXCEPTION - keep current behavior
      intentInstructions = `
INTENT: OPERATIONAL_EXCEPTION
- Focus on operational issues (line open, late delivery, receipt status).
- First line: "PO-${caseData.po_id} L${caseData.line_id}:" followed by operational diagnosis.
- Evidence should include dates, quantities, and status fields.`
    }

    const userPrompt = `Current PO line (focus on this line only):
${JSON.stringify(caseData, null, 2)}${contextMessage}

User question: ${user_message}
${intentInstructions}

Remember: 
- Only quote fields from the current PO line unless user explicitly asks to compare.
- Do NOT generate emails/messages unless explicitly requested.
- Keep response ≤90 words, max 4 bullet points.`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPromptOverride },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    })

    const answer = completion.choices[0]?.message?.content || 'No response generated'

    return NextResponse.json({ answer })
  } catch (error) {
    console.error('Error calling OpenAI:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
