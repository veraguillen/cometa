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

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          /**
           * COOP: same-origin-allow-popups
           * Requerido por Google Identity Services (GIS) SDK.
           * El default "same-origin" de Next.js bloquea window.postMessage
           * entre la ventana principal y el popup de Google OAuth.
           */
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          /**
           * COEP: unsafe-none
           * Permite cargar recursos cross-origin sin cabecera CORP explícita
           * (ej. fotos de perfil desde lh3.googleusercontent.com).
           * "require-corp" las bloquearía silenciosamente.
           */
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "unsafe-none",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
