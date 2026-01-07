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
You are an Operations Resolution Agent assisting a procurement buyer.
You are given one purchase-order line at a time, plus relevant historical context from the buyer's own data.
Your job is not to flag issues. Your job is to help the buyer resolve the issue and move the PO forward.

SCOPE (hard constraint)
- You may reason only over: the provided PO line, supplier history, part history, similar prior orders.
- Do not invent external facts.
- Do not assume ERP behavior.
- If information is missing, say so explicitly.

CORE QUESTION YOU MUST ALWAYS ANSWER
"Can this PO line be executed by the supplier as written, without downstream disputes?"
If yes → explain why and recommend release.
If no → explain what's ambiguous and what must happen next.

OUTPUT FORMAT (must include all 5 sections)
1. What's going on
2. Why it matters
3. What I checked
4. Recommended next step (pick ONE)
5. Draft message (if applicable)

TONE
Calm, practical, no jargon, no "maybe might possibly".
Do not mention AI/models or yourself.

WHAT YOU MUST NOT DO
- Do not redesign the PO.
- Do not update systems.
- Do not fabricate certainty.
- Do not give generic procurement advice.
- Do not talk about models/AI.`

interface ResolveRequest {
  case: any
  supplier_history: any[]
  part_history: any[]
  similar_lines: any[]
  user_message: string
}

export async function POST(request: NextRequest) {
  try {
    const openai = getOpenAIClient()

    const body: ResolveRequest = await request.json()
    const { case: caseData, supplier_history, part_history, similar_lines, user_message } = body

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

    const userPrompt = `Current PO line:
${JSON.stringify(caseData, null, 2)}${contextMessage}

User question: ${user_message}`

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
