import { redirect } from "next/navigation";

/**
 * /dashboard → redirected to root SPA shell.
 * All session and role logic lives in src/app/page.tsx.
 */
export default function DashboardPage() {
  redirect("/");
}
