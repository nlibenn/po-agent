# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PO Agent** is a Next.js application that automates supplier purchase order (PO) confirmation tracking. It searches Gmail for supplier responses, parses PDF confirmations, extracts key fields (supplier order number, delivery date, quantity), and drafts follow-up emails when information is missing.

**Tech Stack:**
- Next.js 14 (App Router)
- TypeScript
- SQLite (better-sqlite3) for data storage
- OpenAI API for parsing and email generation
- Gmail API for email integration
- Vercel KV for OAuth token storage (production)
- Tailwind CSS + Radix UI for styling

## Development Commands

```bash
# Development server
npm run dev

# Type checking (runs before build)
npm run type-check

# Production build
npm run build

# Production server
npm start

# Linting
npm run lint
```

**Database Location:** `./data/chase-agent.db` (SQLite)

## Architecture Overview

### State Machine (Critical)

The supplier confirmation workflow is governed by a strict state machine in `src/lib/supplier-agent/stateMachine.ts`. **All state transitions must go through `transitionCase()` - direct state updates are forbidden.**

**States:**
- `INBOX_LOOKUP` - Initial state, searching for supplier emails
- `OUTREACH_SENT` - Initial email sent to supplier
- `WAITING` - Waiting for supplier response
- `FOLLOWUP_SENT` - Follow-up email sent
- `PARSED` - Confirmation data extracted
- `RESOLVED` - All fields confirmed
- `ESCALATED` - Needs human intervention
- `ERROR` - Error state

**Critical Transition Rules:**
- From `INBOX_LOOKUP`: Use `OUTREACH_SENT_OK` → `OUTREACH_SENT` (initial email)
- From `WAITING`: Use `FOLLOWUP_SENT_OK` → `FOLLOWUP_SENT` (follow-up email)
- From `FOLLOWUP_SENT`: Use `FOLLOWUP_SENT_OK` → `FOLLOWUP_SENT` (another follow-up)
- **Never** use `OUTREACH_SENT_OK` from `WAITING` state - this will fail validation

**When sending emails**, always check the current case state to determine the correct transition event:
```typescript
const isFollowup = currentState === CaseState.WAITING || currentState === CaseState.FOLLOWUP_SENT
const toState = isFollowup ? CaseState.FOLLOWUP_SENT : CaseState.OUTREACH_SENT
const event = isFollowup ? TransitionEvent.FOLLOWUP_SENT_OK : TransitionEvent.OUTREACH_SENT_OK
```

### Database Schema

**Core Tables:**
- `cases` - Supplier confirmation cases (one per PO line)
- `events` - Audit log of all case events
- `messages` - Inbound/outbound emails
- `attachments` - PDF attachments with extracted text
- `confirmation_extractions` - Parsed confirmation fields
- `gmail_tokens` - OAuth tokens for Gmail integration

**Key Relationships:**
- Cases → Messages → Attachments (foreign keys enforced)
- `cases.meta` stores structured JSON including `po_line.ordered_quantity` for mismatch detection

### Core Modules

**`src/lib/supplier-agent/`** - Supplier confirmation automation
- `stateMachine.ts` - State transition validation and execution
- `store.ts` - Database CRUD operations (uses `getDb()` singleton)
- `agentAckOrchestrator.ts` - Main orchestrator for automated workflow
- `inboxSearch.ts` - Gmail search and email classification
- `parseConfirmationFields.ts` - PDF/email parsing (OpenAI-powered)
- `outreach.ts` - Email sending (new email or reply in thread)
- `emailDraft.ts` - Email template generation
- `types.ts` - TypeScript interfaces for cases, messages, events

**`app/api/`** - API Routes
- `agent/chat/route.ts` - Chat agent for interactive PO confirmation
- `confirmations/send/route.ts` - Send confirmation emails (manual or agent-triggered)
- `agent/ack-orchestrate/route.ts` - Run orchestrator workflow
- `gmail/` - Gmail OAuth flow and status endpoints

**`components/acknowledgements/`** - UI Components
- `AgentWorkspace.tsx` - Main chat UI with inline email editor
- `AgentStatePanel.tsx` - Shows agent task progress
- `ConfirmationDetailsCard.tsx` - Displays parsed confirmation fields

### Chat Agent System Prompt

The chat agent (`app/api/agent/chat/route.ts`) receives a dynamic system prompt that includes:
- PO number and line ID
- Supplier name and email
- **Expected quantity** from `caseData.meta.po_line.ordered_quantity` (for mismatch detection)
- Missing fields (delivery date, supplier order number, quantity)

**Agent capabilities:**
- `search_inbox` - Search Gmail and auto-parse PDFs
- `read_confirmation` - Re-parse PDF attachments
- `draft_email` - Generate email requesting missing fields
- `send_email` - Send email (after user approval)

**Conversation History:** The agent receives conversation history from the frontend. When the inline email editor is shown, the assistant's message is **always** added to `conversationHistory` (for OpenAI context) but **optionally** skipped from visible UI to avoid clutter.

### Gmail Integration

**OAuth Flow:**
1. User clicks "Connect Gmail" → redirects to `/api/gmail/auth`
2. Google redirects to `/api/gmail/callback` with authorization code
3. Tokens stored in `gmail_tokens` table (SQLite) or Vercel KV (production)
4. `src/lib/gmail/client.ts` provides `getGmailClient()` for API access

**Demo Mode:**
- Set `DEMO_MODE=true` in `.env.local` to redirect all outgoing emails to `supplierbart@gmail.com`
- Always adds BCC to `supplierbart@gmail.com` for audit trail

### Data Flow: Email Sending

```
User clicks "Send" in UI
  ↓
POST /api/confirmations/send
  ↓
Check current case state
  ↓
Choose transition: OUTREACH_SENT_OK or FOLLOWUP_SENT_OK
  ↓
Send via Gmail API (new email or reply in thread)
  ↓
transitionCase() - validate and update state
  ↓
addMessage() - persist to messages table
  ↓
addEvent() - log EMAIL_SENT event
  ↓
Return success with gmailMessageId + threadId
```

### Quantity Mismatch Detection

The agent can detect quantity mismatches between PO and supplier confirmation:
- Expected quantity sourced from `caseData.meta.po_line.ordered_quantity`
- Confirmed quantity extracted from supplier PDF
- System prompt instructs agent to flag: "⚠️ QUANTITY MISMATCH: Supplier confirmed 1 unit (Expected: 140)"

**To set expected quantity for testing:**
```bash
curl -X POST http://localhost:3000/api/agent/dev/set-expected-qty \
  -H "Content-Type: application/json" \
  -H "X-CRON-SECRET: dev-secret-123" \
  -d '{"caseId":"<caseId>","expectedQty":140,"uom":"EA"}'
```

## Critical Patterns

### Database Access
Always use `getDb()` from `src/lib/supplier-agent/storage/sqlite.ts` - it's a singleton that handles initialization and schema migrations.

### State Transitions
**Never** call `updateCase()` to change `state` directly. Always use `transitionCase()` which validates transitions and logs events atomically.

### Email Thread Management
- First email: `sendNewEmail()` creates new thread
- Follow-ups: `sendReplyInThread()` continues existing thread
- Thread ID stored in `cases.meta.thread_id` and `messages.thread_id`

### Email Drafting Rules (CRITICAL)

When drafting supplier confirmation emails, follow strict rules to ensure factual, actionable, non-confrontational communication:

**Subject Line**:
- Format: `PO {po_number} – {specific issue}`
- Specific issue must be one of: `Missing {field}`, `Quantity mismatch`, `Date mismatch`, `Price mismatch`
- Never use generic subjects like "Confirmation needed"

**Email Body**:
1. Start with 1-sentence factual statement of why email is being sent
2. Include structured summary with explicit labels:
   ```
   Confirmed by Supplier:
   - {field}: {value | "Not provided"}

   On Our PO:
   - {field}: {value | "Not on file"}
   ```
3. Highlight ONLY fields that are missing or mismatched
4. Do NOT ask open-ended questions or request re-confirmation of matching fields
5. End with single explicit action request

**Style**: Neutral, factual, non-accusatory. No speculation or inferred values.

**See**: [EMAIL_DRAFTING_RULES.md](EMAIL_DRAFTING_RULES.md) for complete specification and examples.

**Current Implementation**: `src/lib/supplier-agent/emailDraft.ts` does NOT follow these rules and should be updated.

### PDF Parsing
PDFs are parsed in two stages:
1. Text extraction: `pdfTextExtraction.ts` (pdfjs-dist)
2. Field extraction: `parseConfirmationFields.ts` (OpenAI GPT-4o)

Extracted fields stored in `confirmation_extractions` table and `cases.meta.parsed_best_fields_v1`.

## Environment Variables

```bash
# Required for development
OPENAI_API_KEY=sk-...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_SENDER_EMAIL=lisa.acmebuyer@gmail.com

# Optional
DEMO_MODE=true  # Redirect emails to supplierbart@gmail.com
CRON_SECRET=dev-secret-123  # For dev endpoints
```

## Common Gotchas

1. **State transition errors**: "Invalid transition from WAITING to OUTREACH_SENT via event OUTREACH_SENT_OK"
   - **Fix**: Check current state and use appropriate event (see State Machine section)

2. **Conversation history bug**: Agent repeats itself after showing inline editor
   - **Fix**: Ensure assistant messages are always added to `conversationHistory` even when skipped from UI

3. **Foreign key errors**: "FOREIGN KEY constraint failed"
   - **Fix**: Ensure case exists in database before adding messages/events

4. **Gmail token expired**: "invalid_grant" errors
   - **Fix**: Re-authenticate via `/api/gmail/auth` flow

5. **Missing expected quantity (write path)**: Agent can't detect quantity mismatches
   - **Cause**: `/api/cases/resolve` was creating cases with `meta: {}` (no quantity persisted)
   - **Fix**: Accept `orderQty` parameter and persist `meta.po_line.ordered_quantity` at case creation
   - **Fixed in**: `app/api/cases/resolve/route.ts:27,37-54` and `app/(app)/acknowledgements/page.tsx:125-137`
   - **See**: [EXPECTED_QUANTITY_BUG_ANALYSIS.md](EXPECTED_QUANTITY_BUG_ANALYSIS.md) for details

5a. **Expected quantity not returned (read path)**: Even when persisted, quantity not in fetched case data
   - **Cause**: `/api/cases/[caseId]` reconstructs meta and drops `po_line.ordered_quantity`
   - **Fix**: Include `po_line` in returned meta object
   - **Fixed in**: `app/api/cases/[caseId]/route.ts:63`
   - **See**: [READ_PATH_BUG_FIX.md](READ_PATH_BUG_FIX.md) for details

6. **Inbox search excludes pre-existing emails**: Agent can't find emails sent before case creation
   - **Cause**: Using `searchAfterEpochMs: caseData.created_at` excludes emails before user asked agent for help
   - **Fix**: Calculate search floor from lookback window: `Date.now() - (lookbackDays * 24 * 60 * 60 * 1000)`
   - **Fixed in**: `app/api/agent/chat/route.ts:275` and `src/lib/supplier-agent/agentAckOrchestrator.ts:616`
   - **See**: [FIX_APPLIED.md](FIX_APPLIED.md) for details

7. **PDF attachments missed when buyer email scores higher**: Agent finds multiple emails but only checks top-scored message for PDFs
   - **Cause**: Only `topCandidates[0]` was checked for attachments; if that's a buyer email, supplier PDFs are missed
   - **Fix**: Loop through ALL top candidates (prioritizing supplier messages), stop when first PDF is found
   - **Fixed in**: `src/lib/supplier-agent/inboxSearch.ts:548-650`
   - **See**: [THREAD_SELECTION_FIX_APPLIED.md](THREAD_SELECTION_FIX_APPLIED.md) for details

8. **UI shows green check when quantity can't be verified**: Confirmation card shows ✓ even when `meta.po_line.ordered_quantity` is null
   - **Cause**: Validation logic only checked mismatch when expected qty exists, falling through to green check when null
   - **Fix**: Show warning "Cannot verify" when expected qty is null, green check ONLY when verified match
   - **Fixed in**: `components/acknowledgements/AgentStatePanel.tsx:467-497`
   - **See**: [CONFIRMATION_CARD_VALIDATION_BUG.md](CONFIRMATION_CARD_VALIDATION_BUG.md) for details

## File Structure

```
app/
  (app)/              # App routes (protected by auth)
    acknowledgements/ # Main PO confirmation UI
  api/               # API routes
    agent/           # Agent endpoints
    confirmations/   # Email sending, parsing
    gmail/           # OAuth flow
components/          # React components
  acknowledgements/  # Chat UI, confirmation details
src/
  lib/
    supplier-agent/  # Core business logic
      storage/       # Database layer
    gmail/           # Gmail integration
data/                # SQLite database (gitignored)
```
