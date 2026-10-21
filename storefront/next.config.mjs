/**
 * Public storefront: a Next.js *Pages Router* static export.
 *
 * Pages Router (not App Router) on purpose: its export contains no executable
 * inline scripts (only an application/json data block), so it runs under the
 * storefront's strict `script-src 'self'` policy in web/spa.js. The App Router
 * export inlines `self.__next_f.push(...)` scripts and renders a blank page
 * under that policy (verified in Chrome).
 *
 * Built by scripts/build-storefront.mjs, which copies the result into
 * web/public (served by Express) and removes this directory's build cache.
 */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
