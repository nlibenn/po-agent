/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    esmExternals: 'loose',
    serverComponentsExternalPackages: ['pdfjs-dist'],
  },
  // Prevent webpack chunk resolution issues in dev mode
  webpack: (config, { dev, isServer }) => {
    if (dev) {
      // Ensure consistent chunk loading in development
      config.optimization = {
        ...config.optimization,
        moduleIds: 'named',
      }
    }
    
    // Externalize pdfjs-dist for server-side to avoid bundling into RSC output
    if (isServer) {
      const existingExternals = config.externals || []
      config.externals = [
        ...(Array.isArray(existingExternals) ? existingExternals : [existingExternals]),
        ({ request }, callback) => {
          if (request && (request === 'pdfjs-dist' || request.startsWith('pdfjs-dist/'))) {
            return callback(null, `commonjs ${request}`)
          }
          callback()
        },
      ]
    }

    // Allow top-level await (used by some ESM externals/bundles)
    config.experiments = { ...(config.experiments || {}), topLevelAwait: true }
    
    return config
  },
}

module.exports = nextConfig




