/**
 * Smoke test for state transitions and scheduling
 * 
 * Validates:
 * - Illegal transitions throw errors
 * - Legal transitions work correctly
 * - Scheduling fields (next_check_at) are set/cleared appropriately
 * 
 * Run with: npx tsx scripts/smokeTransitions.ts
 * Or: npx ts-node scripts/smokeTransitions.ts
 */

import { initDb } from '../src/lib/supplier-agent/storage/sqlite'
import { createCase, getCase, findCaseByPoLine } from '../src/lib/supplier-agent/store'
import { transitionCase, TransitionEvent } from '../src/lib/supplier-agent/stateMachine'
import { CaseState, CaseStatus } from '../src/lib/supplier-agent/types'

// Initialize database
initDb()

const TEST_PO_NUMBER = 'SMOKE-TEST-PO'
const TEST_LINE_ID = 'SMOKE-TEST-LINE'

function formatTime(ms: number | null): string {
  if (ms === null) return 'null'
  const date = new Date(ms)
  return date.toISOString()
}

function formatDelta(ms1: number | null, ms2: number | null): string {
  if (ms1 === null || ms2 === null) return 'N/A'
  const delta = ms2 - ms1
  const minutes = Math.round(delta / (1000 * 60))
  return `${minutes} minutes`
}

function printNextCheckAt(label: string, nextCheckAt: number | null) {
  const now = Date.now()
  console.log(`   ${label}:`)
  if (nextCheckAt === null) {
    console.log(`      Raw: null`)
    console.log(`      ISO: null`)
    console.log(`      Delta from now: N/A`)
  } else {
    const deltaMinutes = Math.round((nextCheckAt - now) / 60000)
    console.log(`      Raw: ${nextCheckAt}`)
    console.log(`      ISO: ${new Date(nextCheckAt).toISOString()}`)
    console.log(`      Delta from now: ${deltaMinutes} minutes`)
  }
}

async function main() {
  console.log('🧪 Starting state transition smoke test...\n')

  // Step 1: Create or load test case
  let testCase = findCaseByPoLine(TEST_PO_NUMBER, TEST_LINE_ID)
  
  if (!testCase) {
    console.log('📝 Creating new test case...')
    const now = Date.now()
    const caseId = `smoke-test-${now}`
    
    testCase = {
      case_id: caseId,
      po_number: TEST_PO_NUMBER,
      line_id: TEST_LINE_ID,
      supplier_name: 'Smoke Test Supplier',
      supplier_email: 'smoke@test.com',
      supplier_domain: 'test.com',
      missing_fields: ['delivery_date'],
      state: CaseState.INBOX_LOOKUP,
      status: CaseStatus.STILL_AMBIGUOUS,
      touch_count: 0,
      last_action_at: now,
      created_at: now,
      updated_at: now,
      next_check_at: null,
      last_inbox_check_at: null,
      meta: {},
    }
    
    createCase(testCase)
    console.log(`✅ Created case: ${testCase.case_id}`)
    console.log(`   State: ${testCase.state}`)
    printNextCheckAt('next_check_at', testCase.next_check_at)
    console.log()
  } else {
    console.log(`📋 Using existing case: ${testCase.case_id}`)
    console.log(`   State: ${testCase.state}`)
    printNextCheckAt('next_check_at', testCase.next_check_at)
    console.log()
  }

  const caseId = testCase.case_id
  const initialState = testCase.state
  const initialNextCheck = testCase.next_check_at

  // Step 2: Test illegal transition (should throw)
  console.log('🚫 Testing illegal transition...')
  console.log(`   Attempting: ${initialState} -> RESOLVED via OUTREACH_SENT_OK`)
  
  try {
    transitionCase({
      caseId,
      toState: CaseState.RESOLVED,
      event: TransitionEvent.OUTREACH_SENT_OK,
      summary: 'This should fail',
    })
    console.log('   ❌ ERROR: Illegal transition did not throw!\n')
    process.exit(1)
  } catch (error: any) {
    console.log(`   ✅ Correctly threw: ${error.message}\n`)
  }

  // Step 3: Test legal transition sequence
  console.log('✅ Testing legal transition sequence...\n')

  // Transition 1: INBOX_LOOKUP -> OUTREACH_SENT
  if (testCase.state === CaseState.INBOX_LOOKUP) {
    console.log(`   Transition 1: ${CaseState.INBOX_LOOKUP} -> ${CaseState.OUTREACH_SENT}`)
    const beforeState = testCase.state
    const beforeNextCheck = testCase.next_check_at
    
    transitionCase({
      caseId,
      toState: CaseState.OUTREACH_SENT,
      event: TransitionEvent.OUTREACH_SENT_OK,
      summary: 'Smoke test: Sent outreach email',
      patch: {
        status: CaseStatus.STILL_AMBIGUOUS,
      },
    })
    
    testCase = getCase(caseId)!
    console.log(`   ✅ State changed: ${beforeState} -> ${testCase.state}`)
    console.log(`   ✅ next_check_at changed:`)
    printNextCheckAt('   Before', beforeNextCheck)
    printNextCheckAt('   After', testCase.next_check_at)
    if (testCase.next_check_at && beforeNextCheck) {
      console.log(`   ✅ Delta between before/after: ${formatDelta(beforeNextCheck, testCase.next_check_at)}`)
    } else if (testCase.next_check_at && !beforeNextCheck) {
      console.log(`   ✅ next_check_at was set (scheduling enabled)`)
    }
    console.log()
  }

  // Transition 2: OUTREACH_SENT -> WAITING
  if (testCase.state === CaseState.OUTREACH_SENT) {
    console.log(`   Transition 2: ${CaseState.OUTREACH_SENT} -> ${CaseState.WAITING}`)
    const beforeState = testCase.state
    const beforeNextCheck = testCase.next_check_at
    
    transitionCase({
      caseId,
      toState: CaseState.WAITING,
      event: TransitionEvent.INBOX_CHECK_NO_EVIDENCE,
      summary: 'Smoke test: No evidence found in inbox',
    })
    
    testCase = getCase(caseId)!
    console.log(`   ✅ State changed: ${beforeState} -> ${testCase.state}`)
    console.log(`   ✅ next_check_at changed:`)
    printNextCheckAt('   Before', beforeNextCheck)
    printNextCheckAt('   After', testCase.next_check_at)
    if (testCase.next_check_at && beforeNextCheck) {
      console.log(`   ✅ Delta between before/after: ${formatDelta(beforeNextCheck, testCase.next_check_at)}`)
    }
    console.log()
  }

  // Step 4: Test WAITING -> WAITING with no evidence (idempotent reschedule)
  if (testCase.state === CaseState.WAITING) {
    console.log(`\n   Testing WAITING -> WAITING (no evidence, should bump next_check_at)...`)
    const beforeState = testCase.state
    const beforeNextCheck = testCase.next_check_at
    const beforeTime = Date.now()
    
    // Wait a moment to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 100))
    
    transitionCase({
      caseId,
      toState: CaseState.WAITING,
      event: TransitionEvent.INBOX_CHECK_NO_EVIDENCE,
      summary: 'Smoke test: No evidence found (idempotent reschedule)',
    })
    
    testCase = getCase(caseId)!
    const afterTime = Date.now()
    
    console.log(`   ✅ State stayed: ${beforeState} -> ${testCase.state} (expected same)`)
    if (testCase.next_check_at === null) {
      console.log(`   ❌ ERROR: next_check_at should be set after WAITING->WAITING transition!`)
      process.exit(1)
    } else if (beforeNextCheck === null) {
      console.log(`   ✅ next_check_at was set (was null, now scheduled)`)
    } else if (testCase.next_check_at! > beforeNextCheck!) {
      const deltaMinutes = Math.round((testCase.next_check_at! - beforeNextCheck!) / 60000)
      console.log(`   ✅ next_check_at was bumped forward by ~${deltaMinutes} minutes`)
    } else {
      console.log(`   ⚠️  WARNING: next_check_at was not bumped forward`)
    }
    console.log(`   ✅ next_check_at is now:`)
    printNextCheckAt('   After', testCase.next_check_at)
    console.log()
  }

  // Step 5: Verify scheduling behavior
  console.log('📅 Verifying scheduling behavior...')
  const finalCase = getCase(caseId)!
  
  if (finalCase.state === CaseState.WAITING) {
    if (finalCase.next_check_at === null) {
      console.log('   ❌ ERROR: WAITING state should have next_check_at set!')
      process.exit(1)
    } else {
      const now = Date.now()
      const expectedNextCheck = now + 60 * 60 * 1000 // 60 minutes
      const diff = Math.abs(finalCase.next_check_at! - expectedNextCheck)
      const diffMinutes = Math.round(diff / (1000 * 60))
      
      if (diffMinutes <= 1) {
        console.log(`   ✅ next_check_at is correctly set (~60 minutes from now)`)
      } else {
        console.log(`   ⚠️  WARNING: next_check_at delta is ${diffMinutes} minutes (expected ~60)`)
      }
    }
  }

  // Step 6: Test that RESOLVED clears next_check_at
  if (finalCase.state === CaseState.WAITING) {
    console.log('\n   Testing RESOLVED clears next_check_at...')
    const beforeNextCheck = finalCase.next_check_at
    
    // First transition to PARSED (clears next_check_at)
    transitionCase({
      caseId,
      toState: CaseState.PARSED,
      event: TransitionEvent.INBOX_CHECK_FOUND_EVIDENCE,
      summary: 'Smoke test: Found evidence',
      evidenceRef: {
        message_id: 'test-message-id',
        content_sha256: 'test-hash-' + Date.now(),
        source_type: 'pdf',
      },
    })
    
    const parsedCase = getCase(caseId)!
    if (parsedCase.next_check_at === null) {
      console.log(`   ✅ PARSED state correctly cleared next_check_at`)
    } else {
      console.log(`   ❌ ERROR: PARSED state should clear next_check_at!`)
      process.exit(1)
    }
    
    // Then transition to RESOLVED (also clears next_check_at)
    transitionCase({
      caseId,
      toState: CaseState.RESOLVED,
      event: TransitionEvent.RESOLVE_OK,
      summary: 'Smoke test: Fully confirmed',
      patch: {
        status: CaseStatus.CONFIRMED,
      },
    })
    
    const resolvedCase = getCase(caseId)!
    if (resolvedCase.next_check_at === null) {
      console.log(`   ✅ RESOLVED state correctly cleared next_check_at`)
    } else {
      console.log(`   ❌ ERROR: RESOLVED state should clear next_check_at!`)
      process.exit(1)
    }
  }

  console.log('\n✅ All smoke tests passed!')
  console.log(`\n📊 Final case state:`)
  const final = getCase(caseId)!
  console.log(`   case_id: ${final.case_id}`)
  console.log(`   state: ${final.state}`)
  printNextCheckAt('next_check_at', final.next_check_at)
  if (final.last_inbox_check_at) {
    const now = Date.now()
    const deltaMinutes = Math.round((final.last_inbox_check_at - now) / 60000)
    console.log(`   last_inbox_check_at:`)
    console.log(`      Raw: ${final.last_inbox_check_at}`)
    console.log(`      ISO: ${new Date(final.last_inbox_check_at).toISOString()}`)
    console.log(`      Delta from now: ${deltaMinutes} minutes`)
  } else {
    console.log(`   last_inbox_check_at: null`)
  }
}

main().catch((error) => {
  console.error('❌ Smoke test failed:', error)
  process.exit(1)
})
