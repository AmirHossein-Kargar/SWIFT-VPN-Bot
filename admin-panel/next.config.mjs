/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/panel-next",
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
