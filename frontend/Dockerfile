# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Instalar TODAS las dependencias (incluidas devDeps para el build)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci completo — TypeScript, Tailwind y el compilador React son devDeps
# necesarias para que `next build` funcione.
RUN npm ci


# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Build de Next.js (modo standalone)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Variables públicas de build — Next.js las incrusta en los bundles estáticos.
# Pasadas desde Cloud Build con --build-arg NEXT_PUBLIC_API_URL=<url>
ARG NEXT_PUBLIC_API_URL=https://cometa-vault-92572839783.us-central1.run.app
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Google OAuth Client ID for analyst sign-in (GIS button on /login)
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=""
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID

# next.config.ts tiene output: 'standalone' → genera .next/standalone/server.js
RUN npm run build


# ──────────────────────────────────────────────────────────────────────────────
# Stage 3: Runtime mínimo — solo el output standalone de Next.js
# El standalone bundle incluye los node_modules mínimos de runtime; no se
# necesita copiar node_modules completo.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Cloud Run inyecta PORT en runtime; 3000 es el fallback local.
ENV PORT=3000

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Usuario no-root (sintaxis Debian/slim, no Alpine)
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid 1001 nextjs
USER nextjs

EXPOSE 3000

# server.js generado por Next.js standalone; lee PORT del entorno.
CMD ["node", "server.js"]
