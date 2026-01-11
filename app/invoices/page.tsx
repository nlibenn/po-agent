'use client'

export default function InvoicesPage() {
  return (
    <div className="h-full">
      <div className="max-w-7xl mx-auto px-8 py-10">
        {/* Informational, post-mortem framing - calm surface */}
        <div className="mb-8">
          <h1 className="text-xl font-normal text-neutral-700 mb-1">Invoices</h1>
          <p className="text-xs text-neutral-500">Historical invoice records and processing status</p>
        </div>
        
        <div className="bg-white/70 rounded-3xl shadow-sm p-16 text-center max-w-xl mx-auto">
          <p className="text-neutral-500 font-medium mb-2">No invoices available</p>
          <p className="text-xs text-neutral-400">Invoice records appear here after processing</p>
        </div>
      </div>
    </div>
  )
}
