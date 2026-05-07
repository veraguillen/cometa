import { redirect } from "next/navigation";

/**
 * Root route — delegates all session/role routing to middleware + /login.
 *
 * Flow:
 *   authenticated (cookie)  → middleware redirects to /analyst/dashboard or /founder/onboarding
 *   unauthenticated         → middleware passes through → server redirect to /login
 *
 * The old SPA shell (LoginScreen / AnalistaDashboard / SocioView) is replaced by
 * dedicated routes under /login, /analyst/, and /founder/.
 */
export default function Home() {
  redirect("/login");
}
