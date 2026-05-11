/**
 * /dashboard — Looker Studio embed.
 *
 * La URL se inyecta en build-time desde la variable NEXT_PUBLIC_LOOKER_URL
 * (pasada como --build-arg en el Dockerfile y configurada en el Trigger de Cloud Build).
 * Si la variable no está definida, el iframe usa la URL de fallback del cliente.
 */

const DASHBOARD_SRC =
  process.env.NEXT_PUBLIC_LOOKER_URL ||
  "https://datastudio.google.com/embed/reporting/99155726-349c-440c-81eb-9a199120b5f6/page/p_43dd3zz42d";

export default function DashboardPage() {
  return (
    <iframe
      src={DASHBOARD_SRC}
      title="Cometa Dashboard — Looker Studio"
      style={{ width: "100%", height: "100vh", border: "none", display: "block" }}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
      allowFullScreen
    />
  );
}
