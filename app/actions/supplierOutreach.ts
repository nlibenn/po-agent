'use server'

/**
 * Server Actions for Supplier Outreach
 * 
 * These actions can be called from client components without
 * importing server-only dependencies.
 */

import { generateConfirmationEmail } from '@/src/lib/supplier-agent/emailDraft'
import type { ConfirmationEmailParams } from '@/src/lib/supplier-agent/emailDraft'

/**
 * Generate email draft (server action)
 */
export async function generateEmailDraft(params: ConfirmationEmailParams) {
  return generateConfirmationEmail(params)
}
