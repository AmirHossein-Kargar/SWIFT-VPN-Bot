/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/next-panel",
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
