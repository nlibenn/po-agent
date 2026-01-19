'use client'

/**
 * LoginBackdrop - Animated background for login page with subtle motion
 * Features:
 * - 3 gradient blobs that drift slowly with visible but calm motion
 * - Optional grain/noise texture overlay
 * - Respects prefers-reduced-motion
 * - Uses semantic design tokens
 */
export function LoginBackdrop() {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
      {/* Gradient Blob 1 - Top left */}
      <div
        className="absolute -top-1/4 -left-1/4 w-[600px] h-[600px] rounded-full opacity-[0.20] blur-3xl"
        style={{
          background: 'radial-gradient(circle, rgb(var(--primary)) 0%, rgb(var(--primary) / 0.4) 50%, transparent 70%)',
          animation: 'floatSlow 20s ease-in-out infinite alternate',
          willChange: 'transform',
        }}
      />

      {/* Gradient Blob 2 - Center right */}
      <div
        className="absolute top-1/3 right-1/4 w-[500px] h-[500px] rounded-full opacity-[0.16] blur-3xl"
        style={{
          background: 'radial-gradient(circle, rgb(var(--primary-strong)) 0%, rgb(var(--primary) / 0.3) 50%, transparent 70%)',
          animation: 'floatSlow2 24s ease-in-out infinite alternate-reverse',
          animationDelay: '3s',
          willChange: 'transform',
        }}
      />

      {/* Gradient Blob 3 - Bottom center */}
      <div
        className="absolute -bottom-1/4 left-1/3 w-[550px] h-[550px] rounded-full opacity-[0.14] blur-3xl"
        style={{
          background: 'radial-gradient(circle, rgb(var(--surface-tint)) 0%, rgb(var(--primary) / 0.2) 50%, transparent 70%)',
          animation: 'floatSlow3 28s ease-in-out infinite alternate',
          animationDelay: '6s',
          willChange: 'transform',
        }}
      />

      {/* Subtle grain/noise texture overlay */}
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='2' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          backgroundSize: '200px 200px',
        }}
      />

      {/* Subtle sheen effect - moves slowly across with transform for better visibility */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none overflow-hidden"
        style={{
          background: 'linear-gradient(110deg, transparent 20%, rgb(var(--primary) / 0.15) 45%, rgb(var(--primary) / 0.08) 55%, transparent 80%)',
          width: '150%',
          height: '150%',
          animation: 'sheen 16s ease-in-out infinite',
          willChange: 'transform',
        }}
      />
    </div>
  )
}
