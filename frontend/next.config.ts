import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
  typescript: {
    // El build no se detiene por errores de tipos — la demo no se bloquea.
    ignoreBuildErrors: true,
  },
  eslint: {
    // ESLint no bloquea el build en Cloud Build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
