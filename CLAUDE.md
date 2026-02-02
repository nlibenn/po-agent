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
- New transition events: `INBOX_CHECK_FOUND_EVIDENCE`, `INBOX_CHECK_NO_EVIDENCE` (used by polling)

**When sending emails**, always check the current case state to determine the correct transition event:
```typescript
const isFollowup = currentState === CaseState.WAITING || currentState === CaseState.FOLLOWUP_SENT
const toState = isFollowup ? CaseState.FOLLOWUP_SENT : CaseState.OUTREACH_SENT
const event = isFollowup ? TransitionEvent.FOLLOWUP_SENT_OK : TransitionEvent.OUTREACH_SENT_OK
```

### Agent Contract System

`src/lib/supplier-agent/contract.ts` defines a formal contract for allowed actions per state:
- Actions: `INBOX_SEARCH`, `RETRIEVE_ATTACHMENTS`, `PARSE_FIELDS`, `SEND_OUTREACH`, `SEND_FOLLOWUP`
- Guardrails: 24h cooldown between follow-ups, recipient validation, auto-send limits, evidence requirements
- `EvidenceRef` type with `content_sha256` for evidence integrity tracking
- `assertCan()` function for pre-action validation

### Canonical Field Mapping

`src/lib/supplier-agent/fieldMapping.ts` normalizes field names to canonical keys:
- Canonical keys: `supplier_reference`, `delivery_date`, `ship_date`, `quantity`
- Field groups: `delivery_date` OR `ship_date` satisfies the date requirement
- `computeMissingFields()` derives missing fields from extractions

### Follow-Up Coordinator

`src/lib/followup-coordinator/` is a standalone module for managing follow-up logic:
- `agent.ts` - Pure decision function (`decide()`) with no side effects
- `store.ts` - Follow-up state persistence
- `types.ts` - Types: `FollowUpContext`, `FollowUpDecision`, `ToneLevel`
- Tone ladder: POLITE → FIRM → URGENT
- Cooldown policy (48h between follow-ups)
- Field request tracking to avoid duplicate asks
- Handoff threshold for escalation to human buyer

### Database Schema

**Core Tables:**
- `cases` - Supplier confirmation cases (one per PO line); includes `next_check_at` and `last_inbox_check_at`
- `events` - Audit log of all case events; `meta_json` stores evidence references
- `messages` - Inbound/outbound emails
- `attachments` - PDF attachments with extracted text and `content_sha256` for idempotency
- `confirmation_extractions` - Parsed confirmation fields
- `gmail_tokens` - OAuth tokens for Gmail integration

**Key Relationships:**
- Cases → Messages → Attachments (foreign keys enforced)
- `cases.meta` stores structured JSON including `po_line.ordered_quantity` for mismatch detection

### Core Modules

**`src/lib/supplier-agent/`** - Supplier confirmation automation
- `stateMachine.ts` - State transition validation and execution
- `contract.ts` - Agent contract: allowed actions per state, guardrails, evidence refs
- `store.ts` - Database CRUD operations (uses `getDb()` singleton)
- `agentAckOrchestrator.ts` - Main orchestrator for automated workflow
- `inboxSearch.ts` - Gmail search and email classification
- `parseConfirmationFields.ts` - PDF/email parsing (OpenAI-powered)
- `confirmationFieldParser.ts` - Regex-based confirmation field parser (fallback)
- `pdfConfirmationParser.ts` - PDF-specific confirmation parser
- `fieldMapping.ts` - Canonical field key mapping and normalization
- `outreach.ts` - Email sending (new email or reply in thread)
- `emailDraft.ts` - Email template generation
- `lastAction.ts` - Computes last meaningful action for PO/line from events
- `eventSummarizer.ts` - Maps raw events to buyer-friendly milestones
- `types.ts` - TypeScript interfaces for cases, messages, events
- `parseTypes.ts` - Types for parsed confirmation data

**`src/lib/followup-coordinator/`** - Follow-up decision engine (see above)

**`src/lib/`** - Additional utilities
- `po.ts` - PO data models and utilities
- `confirmedPOs.ts` - Confirmed POs data management
- `unconfirmedPOs.ts` - Unconfirmed POs data management
- `exceptionInbox.ts` - Exception inbox logic
- `driveStorage.ts` - Drive/file storage utilities
- `parseUpload.ts` - Upload parsing utilities

**`src/lib/utils/`**
- `relativeTime.ts` - Relative time formatting ("2h ago", "24m ago")
- `emailNormalization.ts` - Email text normalization (UTF-8, smart punctuation, Latin-1 artifacts)

**`src/hooks/`**
- `useBuyerWorkspace.ts` - Custom hook for buyer workspace state management

### API Routes

**Agent Routes:**
- `agent/chat/route.ts` - Chat agent for interactive PO confirmation
- `agent/ack-orchestrate/route.ts` - Run orchestrator workflow
- `agent/poll-due/route.ts` - Automated polling: checks cases with `next_check_at <= now`, runs inbox search + attachment retrieval, transitions states. Read-only (never sends emails). Supports `dryRun` mode.

**Cases Routes:**
- `cases/resolve/route.ts` - Resolve/create cases
- `cases/bulk/route.ts` - Bulk fetch case states by PO line keys

**Confirmations Routes:**
- `confirmations/send/route.ts` - Send confirmation emails
- `confirmations/followup/draft/route.ts` - Draft follow-up emails with supplier context
- `confirmations/last-action/route.ts` - Get last meaningful action for a PO/line
- `confirmations/case/upsert/route.ts` - Upsert case
- `confirmations/case/[caseId]/apply-updates/route.ts` - Apply field updates to case
- `confirmations/attachments/list/route.ts` - List attachments for a case
- `confirmations/attachments/retrieve/route.ts` - Retrieve PDF attachments from Gmail
- `confirmations/attachments/[attachmentId]/download/route.ts` - Download attachment
- `confirmations/records/route.ts` - Confirmation records CRUD
- `confirmations/records/upsert/route.ts` - Upsert confirmation record
- `confirmations/records/bulk/route.ts` - Bulk confirmation records
- `confirmations/reset/route.ts` - Reset confirmations (demo mode)

**Gmail Routes:**
- `gmail/auth/route.ts` - OAuth initiation
- `gmail/callback/route.ts` - OAuth callback
- `gmail/status/route.ts` - Token status

**Debug/Dev Routes:**
- `debug/reset/route.ts` - Reset all data (SQLite, tokens, localStorage)
- `debug/case-inspect/route.ts` - Inspect case details
- `debug/events/route.ts` - Debug event logs
- `debug/pdfjs/route.ts` - Test PDF.js extraction
- `debug/cleanup-duplicates/route.ts` - Clean up duplicate records
- `debug/rehash-pdf-attachments/route.ts` - Rehash PDF attachments
- `demo/reset/route.ts` - Demo-specific reset
- `agent/dev/stats/route.ts` - Case statistics
- `agent/dev/make-due/route.ts` - Manually trigger cases as due
- `agent/dev/reset-case/route.ts` - Reset individual case state
- `agent/dev/set-expected-qty/route.ts` - Set expected quantity for testing

### App Pages

**`app/(app)/`** - Protected app routes:
- `acknowledgements/` - Main PO confirmation UI
- `home/` - Home/dashboard
- `unconfirmed-pos/` - Unconfirmed POs listing
- `exceptions/` - Exceptions listing
- `exception/[id]/` - Individual exception detail
- `invoices/` - Invoices
- `releases/` - Releases/changelog
- `standard-work/` - Standard work procedures
- `drive/` - Drive/file management

**`app/(auth)/`** - Auth routes:
- `login/` - Login page

### UI Components

**`components/acknowledgements/`**
- `AgentWorkspace.tsx` - Main chat UI with inline email editor
- `AgentStatePanel.tsx` - Shows agent task progress and confirmation card
- `AcknowledgementWorkQueue.tsx` - Work queue for unconfirmed POs
- `AcknowledgementChatProvider.tsx` - Chat context provider
- `AgentStateContext.tsx` - Agent state context for cross-component sharing
- `exportConfirmedPOs.ts` - Export utility for confirmed POs

**`components/`** - Shared components
- `SupplierConfirmationDrawer.tsx` - Supplier confirmation drawer
- `UnconfirmedPORow.tsx` - Unconfirmed PO row component
- `ExceptionInboxRow.tsx` - Exception inbox row
- `ExceptionSidePanel.tsx` - Exception side panel
- `CompanionChat.tsx` - Companion chat UI
- `BuyerWorkbenchHeader.tsx` - Header for buyer workbench
- `BuyerWorkbenchNav.tsx` - Navigation for buyer workbench
- `WorkspaceProvider.tsx` - Workspace context provider
- `ResetEverythingButton.tsx` - Full reset (SQLite, OAuth, localStorage, sessionStorage)
- `AuthGate.tsx` - Authentication gate

**`components/chat/`**
- `ChatProvider.tsx` - Chat context provider
- `useChatScope.ts` - Chat scope hook

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
- `DEMO_RECIPIENT_EMAIL` overrides the default demo recipient
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

### Data Flow: Automated Polling

```
Cron triggers POST /api/agent/poll-due
  ↓
Query cases with next_check_at <= now
  ↓
For each due case:
  ↓
  Run inbox search (Gmail API)
  ↓
  Retrieve attachments (if found)
  ↓
  Parse confirmation fields (if PDF found)
  ↓
  Transition state with evidenceRef (content_sha256)
  ↓
  Update next_check_at for next poll cycle
```

### Quantity Mismatch Detection

The agent can detect quantity mismatches between PO and supplier confirmation:
- Expected quantity sourced from `caseData.meta.po_line.ordered_quantity`
- Confirmed quantity extracted from supplier PDF
- System prompt instructs agent to flag: "⚠️ QUANTITY MISMATCH: Supplier confirmed 1 unit (Expected: 140)"

### Event Summarization

`src/lib/supplier-agent/eventSummarizer.ts` maps raw technical events to buyer-friendly milestones:
- Collapses duplicates and groups related events
- Provides `Milestone` type with buyer-friendly labels
- Used in the buyer workbench UI

## Critical Patterns

### Database Access
Always use `getDb()` from `src/lib/supplier-agent/storage/sqlite.ts` - it's a singleton that handles initialization and schema migrations.

### State Transitions
**Never** call `updateCase()` to change `state` directly. Always use `transitionCase()` which validates transitions and logs events atomically. `transitionCase()` now supports an `evidenceRef` parameter for tracking evidence integrity.

### Email Thread Management
- First email: `sendNewEmail()` creates new thread
- Follow-ups: `sendReplyInThread()` continues existing thread
- Thread ID stored in `cases.meta.thread_id` and `messages.thread_id`

### Evidence Tracking
- Evidence tracked with `EvidenceRef` type containing `content_sha256`
- Idempotency checks based on hash prevent re-parsing the same PDF
- Evidence source tracking: `pdf`, `email_body`, `mixed`, `none`

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

### PDF Parsing
PDFs are parsed in two stages:
1. Text extraction: `pdfTextExtraction.ts` (pdfjs-dist)
2. Field extraction: `parseConfirmationFields.ts` (OpenAI GPT-4o) with `confirmationFieldParser.ts` as regex fallback

Extracted fields stored in `confirmation_extractions` table and `cases.meta.parsed_best_fields_v1`.

## Environment Variables

```bash
# Required for development
OPENAI_API_KEY=sk-...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_SENDER_EMAIL=lisa.acmebuyer@gmail.com

# Optional
DEMO_MODE=true                # Redirect emails to supplierbart@gmail.com
DEMO_RECIPIENT_EMAIL=...      # Override default demo recipient
CRON_SECRET=dev-secret-123    # For dev/cron endpoints
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

5a. **Expected quantity not returned (read path)**: Even when persisted, quantity not in fetched case data
   - **Cause**: `/api/cases/[caseId]` reconstructs meta and drops `po_line.ordered_quantity`
   - **Fix**: Include `po_line` in returned meta object

6. **Inbox search excludes pre-existing emails**: Agent can't find emails sent before case creation
   - **Cause**: Using `searchAfterEpochMs: caseData.created_at` excludes emails before user asked agent for help
   - **Fix**: Calculate search floor from lookback window: `Date.now() - (lookbackDays * 24 * 60 * 60 * 1000)`

7. **PDF attachments missed when buyer email scores higher**: Agent finds multiple emails but only checks top-scored message for PDFs
   - **Cause**: Only `topCandidates[0]` was checked for attachments; if that's a buyer email, supplier PDFs are missed
   - **Fix**: Loop through ALL top candidates (prioritizing supplier messages), stop when first PDF is found

8. **UI shows green check when quantity can't be verified**: Confirmation card shows checkmark even when `meta.po_line.ordered_quantity` is null
   - **Cause**: Validation logic only checked mismatch when expected qty exists, falling through to green check when null
   - **Fix**: Show warning "Cannot verify" when expected qty is null, green check ONLY when verified match

## File Structure

```
app/
  (app)/                # App routes (protected by auth)
    acknowledgements/   # Main PO confirmation UI
    home/               # Dashboard
    unconfirmed-pos/    # Unconfirmed POs listing
    exceptions/         # Exceptions listing
    exception/[id]/     # Exception detail
    invoices/           # Invoices
    releases/           # Releases/changelog
    standard-work/      # Standard work procedures
    drive/              # Drive/file management
  (auth)/               # Auth routes
    login/              # Login page
  api/                  # API routes
    agent/              # Agent endpoints (chat, orchestrate, poll-due, dev/)
    cases/              # Case CRUD and bulk operations
    confirmations/      # Email sending, parsing, attachments, records
    gmail/              # OAuth flow
    debug/              # Debug/inspection endpoints
    demo/               # Demo reset
components/
  acknowledgements/     # Chat UI, confirmation details, work queue
  chat/                 # Chat context providers
  auth/                 # Login UI
  ui/                   # Shared UI primitives (Radix-based)
  *.tsx                 # Shared components (drawers, nav, workspace)
src/
  lib/
    supplier-agent/     # Core business logic (state machine, contract, parsing, search)
      storage/          # Database layer
    followup-coordinator/ # Follow-up decision engine (tone ladder, cooldowns)
    gmail/              # Gmail integration
    utils/              # Shared utilities (relative time, email normalization)
  hooks/                # React hooks (useBuyerWorkspace)
  types/                # TypeScript declarations
data/                   # SQLite database (gitignored)
```
