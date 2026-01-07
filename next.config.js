/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent webpack chunk resolution issues in dev mode
  webpack: (config, { dev, isServer }) => {
    if (dev) {
      // Ensure consistent chunk loading in development
      config.optimization = {
        ...config.optimization,
        moduleIds: 'named',
      }
    }
    return config
  },
}

module.exports = nextConfig




