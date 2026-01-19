/**
 * Email Draft Generation (Client-Safe)
 * 
 * Pure functions for generating email text. No server dependencies.
 * Can be used in client components.
 */

export interface ConfirmationEmailParams {
  poNumber: string
  lineId: string
  supplierName?: string | null
  supplierEmail: string
  missingFields: string[] // e.g. ["delivery_date","supplier_reference"]
  context?: {
    materialDesc?: string
    qty?: string | number
    unitPrice?: string | number
    currency?: string
  }
}

export interface ConfirmationEmail {
  subject: string
  bodyText: string
}

/**
 * Generate confirmation email text (client-safe, pure function)
 */
export function generateConfirmationEmail(params: ConfirmationEmailParams): ConfirmationEmail {
  const { poNumber, lineId, supplierName, supplierEmail, missingFields, context } = params
  
  // Subject
  const subject = `PO ${poNumber} – Line ${lineId} – Confirmation needed`
  
  // Greeting
  const greeting = supplierName ? `Hi ${supplierName},` : `Hi,`
  
  // Opening
  let bodyText = `${greeting}\n\n`
  bodyText += `We need confirmation for Purchase Order ${poNumber}, Line ${lineId}.\n\n`
  
  // Context if available
  if (context?.materialDesc) {
    bodyText += `Item: ${context.materialDesc}\n`
  }
  if (context?.qty) {
    bodyText += `Quantity: ${context.qty}\n`
  }
  if (context?.unitPrice && context?.currency) {
    bodyText += `Unit Price: ${context.currency} ${context.unitPrice}\n`
  }
  if (context?.materialDesc || context?.qty || context?.unitPrice) {
    bodyText += `\n`
  }
  
  // Missing fields - build dynamic list based on what's actually missing
  if (missingFields.length > 0) {
    bodyText += `Please confirm the following:\n\n`
    
    const bullets: string[] = []
    
    // Handle each missing field dynamically
    for (const field of missingFields) {
      if (field === 'delivery_date' || field === 'confirmed_delivery_date' || field === 'ship_date' || field === 'confirmed_ship_date') {
        bullets.push(`• Confirmed ship date`)
      } else if (field === 'supplier_reference' || field === 'supplier_order_number') {
        bullets.push(`• Supplier order number`)
      } else if (field === 'quantity' || field === 'confirmed_quantity') {
        bullets.push(`• Confirmed quantity`)
      } else if (field === 'pricing_basis' || field === 'qty_basis') {
        // Multiple choice for pricing/qty basis
        const basisType = field === 'pricing_basis' ? 'pricing' : 'quantity'
        bullets.push(`• ${basisType.charAt(0).toUpperCase() + basisType.slice(1)} basis: (A) per each (B) per foot (C) per pound (D) per bundle/case (E) other: ____`)
      } else if (field === 'acknowledgement') {
        bullets.push(`• Order acknowledgement / confirmation`)
      } else {
        // Generic field name
        bullets.push(`• ${field.replace(/_/g, ' ')}`)
      }
    }
    
    bodyText += bullets.join('\n')
    bodyText += `\n\n`
  }
  
  // Closing
  bodyText += `Please reply with the above information at your earliest convenience.\n\n`
  bodyText += `Thank you,\n`
  bodyText += `Procurement Team`
  
  return { subject, bodyText }
}
