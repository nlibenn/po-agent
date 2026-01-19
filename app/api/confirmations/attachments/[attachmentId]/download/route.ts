import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/src/lib/supplier-agent/storage/sqlite'

export const runtime = 'nodejs'

/**
 * GET /api/confirmations/attachments/[attachmentId]/download
 * Download a stored PDF attachment
 * 
 * Returns the PDF file as a blob
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { attachmentId: string } }
) {
  try {
    const { attachmentId } = params
    
    if (!attachmentId) {
      return NextResponse.json(
        { error: 'Missing attachmentId' },
        { status: 400 }
      )
    }
    
    const db = getDb()
    
    // Fetch attachment from database
    const stmt = db.prepare(`
      SELECT 
        binary_data_base64,
        filename,
        mime_type
      FROM attachments
      WHERE attachment_id = ?
    `)
    
    const attachment = stmt.get(attachmentId) as {
      binary_data_base64: string | null
      filename: string | null
      mime_type: string | null
    } | undefined
    
    if (!attachment || !attachment.binary_data_base64) {
      return NextResponse.json(
        { error: 'Attachment not found or has no binary data' },
        { status: 404 }
      )
    }
    
    // Decode base64 to binary
    const binaryData = Buffer.from(attachment.binary_data_base64, 'base64')
    
    // Return PDF as blob
    return new NextResponse(binaryData, {
      headers: {
        'Content-Type': attachment.mime_type || 'application/pdf',
        'Content-Disposition': `attachment; filename="${attachment.filename || 'attachment.pdf'}"`,
        'Content-Length': binaryData.length.toString(),
      },
    })
  } catch (error) {
    console.error('Error downloading attachment:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to download attachment' },
      { status: 500 }
    )
  }
}
