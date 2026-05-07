import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cometa Vault",
  description: "Portal de Inversión — Cometa VC",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme="obsidian" is the SSR default — public routes (login, landing) are dark.
    // Private routes override this on mount:
    //   · /analyst/* — ThemeProvider reads localStorage (defaults to "pearl")
    //   · /founder/* and /success — <ResetTheme theme="pearl" /> forces pearl on mount.
    <html lang="es" data-theme="obsidian">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
