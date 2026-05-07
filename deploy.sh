#!/usr/bin/env bash
# deploy.sh — Cometa Vault · despliegue manual a Google Cloud Run
#
# Uso:
#   ./deploy.sh                    # despliega backend + frontend (producción)
#   ./deploy.sh --only backend     # solo backend
#   ./deploy.sh --only frontend    # solo frontend
#
# Prerequisitos:
#   gcloud auth login
#   gcloud config set project cometa-mvp
#
# Estrategia de credenciales (sin cometa_key.json):
#   El backend usa GCP_SERVICE_ACCOUNT_JSON inyectado desde Secret Manager.
#   Si el secret no existe, usa Application Default Credentials (SA adjunta).
#
# NUNCA commits secretos reales en este archivo.

set -euo pipefail

# ── Configuración ─────────────────────────────────────────────────────────────

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-cometa-mvp}"
REGION="us-central1"
REPO="cometa-vault"
BACKEND_SERVICE="cometa-vault"
FRONTEND_SERVICE="cometa-vault-frontend"
SA_EMAIL="cometa-vault-sa@${PROJECT_ID}.iam.gserviceaccount.com"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

BACKEND_URL="https://cometa-vault-92572839783.us-central1.run.app"
FRONTEND_URL="https://cometa-vault-frontend-92572839783.us-central1.run.app"
GOOGLE_CLIENT_ID="92572839783-7ot0oqfemmbah7mubirkee631fl7h8lm.apps.googleusercontent.com"

ONLY="${2:-all}"   # --only backend | --only frontend | all

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Cometa Vault — Manual Cloud Run Deployment"
echo "  Project  : ${PROJECT_ID}  |  Region: ${REGION}"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Backend ───────────────────────────────────────────────────────────────────

if [[ "$ONLY" == "all" || "$ONLY" == "backend" ]]; then
  echo "── [1/4] Building backend image ──────────────────────────────────"
  gcloud builds submit \
    --project="${PROJECT_ID}" \
    --tag="${REGISTRY}/backend:latest" \
    --file=Dockerfile \
    .

  echo ""
  echo "── [2/4] Deploying backend → Cloud Run ───────────────────────────"
  gcloud run deploy "${BACKEND_SERVICE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${REGISTRY}/backend:latest" \
    --platform=managed \
    --service-account="${SA_EMAIL}" \
    --allow-unauthenticated \
    --port=8080 \
    --cpu=1 --memory=2Gi \
    --min-instances=0 --max-instances=10 \
    --concurrency=10 --timeout=300 \
    --set-env-vars="\
GOOGLE_PROJECT_ID=${PROJECT_ID},\
GCS_INPUT_BUCKET=cometa-vc-raw-prod,\
GCS_OUTPUT_BUCKET=cometa-vc-stage-prod,\
GCS_RAW_BUCKET=cometa-vc-raw-prod,\
GCS_STAGE_BUCKET=cometa-vc-stage-prod,\
BUCKET_GOLD=cometa-vc-gold-prod,\
HISTORICOFUND_BUCKET=historicofund,\
GOOGLE_BIGQUERY_DATASET=BD_Cometa,\
BIGQUERY_DATASET=BD_Cometa,\
DOCUMENT_AI_PROCESSOR_ID=c5e1adfde68e63cf,\
DOCUMENT_AI_LOCATION=us,\
VERTEX_AI_LOCATION=us-central1,\
GEMINI_MODEL=gemini-2.5-flash,\
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},\
EMAIL_FROM=onboarding@cometa.vc,\
EMAIL_FROM_NAME=Cometa Vault,\
DASHBOARD_URL=https://datastudio.google.com/reporting/99155726-349c-440c-81eb-9a199120b5f6,\
SKIP_ORIGIN_CHECK=false,\
ALLOWED_ORIGINS=${FRONTEND_URL}" \
    --set-secrets="\
GCP_SERVICE_ACCOUNT_JSON=cometa-gcp-credentials:latest,\
JWT_SECRET=cometa-jwt-secret:latest,\
RESEND_API_KEY=cometa-resend-key:latest"
fi

# ── Frontend ──────────────────────────────────────────────────────────────────

if [[ "$ONLY" == "all" || "$ONLY" == "frontend" ]]; then
  echo ""
  echo "── [3/4] Building frontend image ─────────────────────────────────"
  gcloud builds submit \
    --project="${PROJECT_ID}" \
    --tag="${REGISTRY}/frontend:latest" \
    --file=frontend/Dockerfile \
    --build-arg="NEXT_PUBLIC_API_URL=${BACKEND_URL}" \
    --build-arg="NEXT_PUBLIC_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}" \
    frontend/

  echo ""
  echo "── [4/4] Deploying frontend → Cloud Run ──────────────────────────"
  gcloud run deploy "${FRONTEND_SERVICE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${REGISTRY}/frontend:latest" \
    --platform=managed \
    --allow-unauthenticated \
    --port=3000 \
    --cpu=1 --memory=1Gi \
    --min-instances=0 --max-instances=5 \
    --concurrency=80
fi

# ── Smoke test ────────────────────────────────────────────────────────────────

echo ""
echo "── Smoke test ────────────────────────────────────────────────────"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${BACKEND_URL}/health" || echo "000")
if [[ "$HTTP" == "200" ]]; then
  echo "  ✓  Backend /health → HTTP 200"
else
  echo "  ⚠  Backend /health → HTTP ${HTTP} — ver logs:"
  echo "     gcloud run services logs read ${BACKEND_SERVICE} --region=${REGION} --limit=50"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deployment complete — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Backend  : ${BACKEND_URL}"
echo "  Frontend : ${FRONTEND_URL}"
echo "═══════════════════════════════════════════════════════════════"
echo ""
