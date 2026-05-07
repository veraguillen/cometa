#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# deploy/setup-gcp.sh
# Script de inicialización de GCP para Cometa Vault
# Ejecutar UNA SOLA VEZ antes del primer deploy.
#
# Uso:
#   chmod +x deploy/setup-gcp.sh
#   ./deploy/setup-gcp.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuración ─────────────────────────────────────────────────────────────
PROJECT_ID="cometa-mvp"           # ← cambia si tu project ID es diferente
REGION="us-central1"
SA_NAME="cometa-vault-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
REPO_NAME="cometa-vault"
KEY_FILE="cometa_key.json"        # tu archivo local de credenciales

echo "▶ Proyecto: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

# ── 1. Habilitar APIs necesarias ──────────────────────────────────────────────
echo "▶ Habilitando APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  bigquery.googleapis.com \
  storage.googleapis.com \
  documentai.googleapis.com \
  aiplatform.googleapis.com

# ── 2. Crear Service Account para Cloud Run ───────────────────────────────────
echo "▶ Creando service account ${SA_EMAIL}..."
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="Cometa Vault Runtime SA" \
  --project="${PROJECT_ID}" || echo "  (ya existe, continuando)"

# Roles que necesita el backend en runtime
ROLES=(
  "roles/bigquery.dataEditor"
  "roles/bigquery.jobUser"
  "roles/storage.objectAdmin"
  "roles/documentai.apiUser"
  "roles/aiplatform.user"
  "roles/secretmanager.secretAccessor"
)

for ROLE in "${ROLES[@]}"; do
  echo "  → Asignando ${ROLE}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --quiet
done

# ── 3. Crear repositorio en Artifact Registry ─────────────────────────────────
echo "▶ Creando repositorio Artifact Registry ${REPO_NAME}..."
gcloud artifacts repositories create "${REPO_NAME}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Imágenes Docker de Cometa Vault" || echo "  (ya existe)"

# ── 4. Cargar secretos en Secret Manager ─────────────────────────────────────
# Los secretos se leen desde tu archivo .env local y cometa_key.json.
# El JSON de la service account se guarda como contenido del secreto,
# NO como archivo dentro de la imagen.
echo "▶ Cargando secretos en Secret Manager..."

load_secret() {
  local SECRET_NAME=$1
  local VALUE=$2
  if gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT_ID}" &>/dev/null; then
    echo "  → Actualizando ${SECRET_NAME}"
    echo -n "${VALUE}" | gcloud secrets versions add "${SECRET_NAME}" --data-file=-
  else
    echo "  → Creando ${SECRET_NAME}"
    echo -n "${VALUE}" | gcloud secrets create "${SECRET_NAME}" \
      --replication-policy="automatic" \
      --data-file=- \
      --project="${PROJECT_ID}"
  fi
}

# Credenciales GCP (contenido del JSON, no la ruta)
if [ -f "${KEY_FILE}" ]; then
  load_secret "cometa-gcp-credentials" "$(cat ${KEY_FILE})"
else
  echo "  ⚠ ${KEY_FILE} no encontrado. Sube las credenciales manualmente:"
  echo "    gcloud secrets create cometa-gcp-credentials --data-file=cometa_key.json"
fi

# Otros secretos desde .env
if [ -f ".env" ]; then
  source .env
  [ -n "${BIGQUERY_DATASET:-}"    ] && load_secret "cometa-bq-dataset"   "${BIGQUERY_DATASET}"
  [ -n "${GCS_INPUT_BUCKET:-}"    ] && load_secret "cometa-gcs-bucket"   "${GCS_INPUT_BUCKET}"
  [ -n "${NEXTAUTH_SECRET:-}"     ] && load_secret "cometa-nextauth-secret" "${NEXTAUTH_SECRET}"
else
  echo "  ⚠ .env no encontrado. Carga los secretos manualmente."
fi

# ── 5. Dar acceso al SA de Cloud Build para desplegar ─────────────────────────
echo "▶ Configurando permisos de Cloud Build..."
CB_SA="$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/run.admin" --quiet

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/iam.serviceAccountUser" --quiet

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/artifactregistry.writer" --quiet

# ── 6. Configurar autenticación de Docker hacia Artifact Registry ─────────────
echo "▶ Configurando Docker auth para Artifact Registry..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo ""
echo "✅ Setup completo."
echo ""
echo "Próximos pasos:"
echo "  1. Conecta tu repositorio en Cloud Build:"
echo "     https://console.cloud.google.com/cloud-build/triggers"
echo "  2. Crea un trigger para la rama 'main' apuntando a cloudbuild.yaml"
echo "  3. Actualiza _NEXT_PUBLIC_API_URL en las sustituciones del trigger"
echo "     con la URL del backend tras el primer deploy"
