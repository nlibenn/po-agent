# Chat Response Tightening Implementation

## Changes Made

### Updated System Prompts

Both `/app/api/resolve/route.ts` and `/app/api/chat/route.ts` now enforce strict response constraints:

#### 1. Length Constraints
- **≤90 words total** (strict limit)
- **Maximum 4 bullet points** total

#### 2. Required Format
Always use this exact structure:
1. **First line**: Reference PO + line_id, then one-line diagnosis
   - Example: "PO-907162 L1: Line remains open after receipt posted."
2. **Evidence bullets (2-3 max)**: Quote only fields from the currently selected PO line
   - Format: "• [field name]: [value]"
3. **Next step (single sentence)**: One actionable next step

#### 3. Strict Rules Added
- **No unrequested emails/messages**: Do NOT generate emails, templates, or messages unless the user explicitly asks "draft an email/message" or similar
- **No false claims**: Do NOT claim you checked supplier history, similar POs, or anything not present in the provided context
- **Missing data handling**: If the user asks something requiring missing data, say: "I can't confirm without [field name(s)]" and list the missing field(s)

#### 4. Grounding Requirements
- **Always start with PO reference**: First line must include "PO-[po_id] L[line_id]:"
- **Quote actual fields**: Only quote actual field values from the provided data
- **Current line focus**: Only use the currently selected line's data unless the user explicitly asks to compare against other POs

## Key Differences

### Before:
- Long responses with multiple sections
- Unrequested draft emails included
- Claims about checking supplier history even when not provided
- No strict word limit
- Flexible format

### After:
- ≤90 words, max 4 bullet points
- No emails/messages unless explicitly requested
- Only claims about data actually provided
- Strict format: diagnosis → evidence → next step
- Always references PO + line_id in first line

## Example Response Format

**Case-scoped (resolve route):**
```
PO-907162 L1: Line remains open after receipt posted.
• Receipt date: 4/17/24
• Order quantity: 500
• Line status: Open
Confirm remaining quantity with supplier and close line if complete.
```

**Global (chat route):**
```
Found 5 exceptions across 66 PO lines.
• PO-123 L1: Shipment overdue, not received
• PO-456 L2: Line remains open after receipt
Review flagged exceptions in the queue.
```

## Testing

To verify the changes:
1. Ask a case-scoped question - should be ≤90 words, start with PO reference, no unrequested emails
2. Ask a global question - should be concise, cite specific po_id/line_id
3. Ask "draft an email" - should generate email (only when explicitly requested)
4. Ask about missing data - should say "I can't confirm without [field]"
