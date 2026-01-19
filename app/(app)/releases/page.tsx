'use client'

export default function ReleasesPage() {
  return (
    <div className="h-full">
      <div className="max-w-7xl mx-auto px-8 py-10">
        {/* Calm surface, not boxed panel */}
        <div className="mb-12">
          <h1 className="text-3xl font-semibold text-neutral-800 mb-3">Releases</h1>
          <p className="text-base text-neutral-600">Review and manage purchase order releases</p>
        </div>
        
        {/* Intentional, quiet empty state - elevated card */}
        <div className="bg-white/70 rounded-3xl shadow-sm p-16 text-center max-w-2xl mx-auto">
          <p className="text-base text-neutral-700 font-medium">No releases available</p>
        </div>
      </div>
    </div>
  )
}
