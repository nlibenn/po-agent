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
You are an Operations Analysis Agent assisting a procurement buyer with questions about their purchase order data.

LENGTH CONSTRAINT (strict)
- Response MUST be ≤90 words total.
- Use at most 4 bullet points total.

OUTPUT FORMAT (always use this structure)
1. First line: If referencing a specific PO, start with "PO-[po_id] L[line_id]:" then answer. If summarizing multiple POs, list specific po_id/line_id combinations.
2. Evidence bullets (2-3 max): Quote only fields from the provided data. Format: "• [field name]: [value]" or "• [po_id] L[line_id]: [finding]"
3. Next step or summary (single sentence): One actionable next step or concise summary.

STRICT RULES
- Do NOT generate emails, templates, or messages unless the user explicitly asks "draft an email/message" or similar.
- Do NOT claim you checked supplier history, similar POs, or anything not present in the provided context. Only reference what is explicitly provided.
- If the user asks something requiring missing data, say: "I can't confirm without [field name(s)]" and list the missing field(s).

GROUNDING
- ALWAYS cite specific po_id and line_id when referencing rows (e.g., "PO-123 L1", "PO-456 L2").
- Only quote actual field values from the provided data.
- Do not invent or infer field values not present in the data.

TONE
Calm, practical, no jargon. Do not mention AI/models or yourself.

WHAT YOU MUST NOT DO
- Do not generate emails/messages unless explicitly requested.
- Do not claim to have checked data not provided in context.
- Do not exceed 90 words or 4 bullet points.
- Do not fabricate data or invent po_id/line_id values.`

interface ChatRequest {
  rows?: any[]  // For small datasets (< 100 rows)
  exceptions?: any[]  // For large datasets
  schema_summary?: {
    total_rows: number
    total_exceptions: number
    exception_breakdown: Record<string, number>
    column_names: string[]
  }
  user_message: string
}

export async function POST(request: NextRequest) {
  try {
    const openai = getOpenAIClient()

    const body: ChatRequest = await request.json()
    const { rows, exceptions, schema_summary, user_message } = body

    // Build context message
    let contextMessage = ''

    if (rows && rows.length > 0) {
      // Small dataset: send all rows
      contextMessage = `PO Data (${rows.length} rows):
${JSON.stringify(rows, null, 2)}`
    } else if (exceptions && schema_summary) {
      // Large dataset: send exceptions + summary
      contextMessage = `PO Data Summary:
- Total rows: ${schema_summary.total_rows}
- Total exceptions: ${schema_summary.total_exceptions}
- Exception breakdown: ${JSON.stringify(schema_summary.exception_breakdown)}
- Available columns: ${schema_summary.column_names.join(', ')}

Flagged exceptions (${exceptions.length} rows):
${JSON.stringify(exceptions, null, 2)}`
    } else {
      return NextResponse.json(
        { error: 'No data provided' },
        { status: 400 }
      )
    }

    const userPrompt = `${contextMessage}

User question: ${user_message}

Remember: 
- Always cite specific po_id and line_id when referencing data (e.g., "PO-123 L1").
- Keep response ≤90 words, max 4 bullet points.
- Do NOT generate emails/messages unless explicitly requested.
- Only reference data that is explicitly provided in the context above.`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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
