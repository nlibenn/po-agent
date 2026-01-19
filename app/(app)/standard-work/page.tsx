'use client'

export default function StandardWorkPage() {
  return (
    <div className="h-full">
      <div className="max-w-7xl mx-auto px-8 py-10">
        {/* Lowest contrast and emphasis - very subtle, quiet surface */}
        <div className="mb-8">
          <h1 className="text-lg font-normal text-neutral-400 mb-1">Standard Work</h1>
          <p className="text-xs text-neutral-400">Standard operating procedures and workflows</p>
        </div>
        
        <div className="bg-white/65 rounded-3xl shadow-sm p-16 text-center max-w-xl mx-auto">
          <p className="text-neutral-400">No standard work available</p>
        </div>
      </div>
    </div>
  )
}
