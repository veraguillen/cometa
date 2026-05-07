/**
 * Providers — no-op wrapper.
 * NextAuth has been removed; auth is handled via localStorage session in page.tsx.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
