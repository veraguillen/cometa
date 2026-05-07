#!/usr/bin/env bash
# setup-gcp.sh — Setup completo desde cero: IAM + Secrets + Build
set -e
PROJECT="cometa-mvp"
REGION="us-central1"
SA="cometa-vault-sa@${PROJECT}.iam.gserviceaccount.com"

echo "======================================"
echo " COMETA VAULT — SETUP DESDE CERO"
echo "======================================"

echo ""
echo "[1/7] Artifact Registry..."
gcloud artifacts repositories create cometa-vault \
  --repository-format=docker --location="${REGION}" \
  --project="${PROJECT}" 2>/dev/null && echo "  creado" || echo "  ya existia"

echo ""
echo "[2/7] Service Account..."
gcloud iam service-accounts create cometa-vault-sa \
  --display-name="Cometa Vault SA" \
  --project="${PROJECT}" 2>/dev/null && echo "  creado" || echo "  ya existia"

echo ""
echo "[3/7] Permisos Service Account..."
for ROLE in roles/run.admin roles/run.invoker roles/bigquery.dataEditor roles/bigquery.jobUser roles/storage.objectAdmin roles/secretmanager.secretAccessor roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${SA}" --role="${ROLE}" --quiet > /dev/null 2>&1 && echo "  $ROLE ok"
done

echo ""
echo "[4/7] Permisos Cloud Build SA..."
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format="value(projectNumber)")
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/secretmanager.secretAccessor roles/artifactregistry.writer roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "${PROJECT}" --member="serviceAccount:${CB_SA}" --role="${ROLE}" --quiet > /dev/null 2>&1 && echo "  $ROLE ok"
done

echo ""
echo "[5/7] Creando Secrets..."

# JWT Secret — clave segura generada automaticamente
if ! gcloud secrets describe cometa-jwt-secret --project="${PROJECT}" > /dev/null 2>&1; then
  JWT_VAL=$(openssl rand -hex 32)
  echo -n "${JWT_VAL}" | gcloud secrets create cometa-jwt-secret --data-file=- --project="${PROJECT}"
  echo "  cometa-jwt-secret creado (valor: ${JWT_VAL})"
else
  echo "  cometa-jwt-secret ya existe"
fi

# GCP Credentials — placeholder (el backend usa ADC en Cloud Run)
if ! gcloud secrets describe cometa-gcp-credentials --project="${PROJECT}" > /dev/null 2>&1; then
  echo -n "{}" | gcloud secrets create cometa-gcp-credentials --data-file=- --project="${PROJECT}"
  echo "  cometa-gcp-credentials creado (placeholder - ADC activo)"
else
  echo "  cometa-gcp-credentials ya existe"
fi

# Resend API Key — placeholder (emails opcionales para demo)
if ! gcloud secrets describe cometa-resend-key --project="${PROJECT}" > /dev/null 2>&1; then
  echo -n "re_placeholder_update_after_demo" | gcloud secrets create cometa-resend-key --data-file=- --project="${PROJECT}"
  echo "  cometa-resend-key creado (placeholder)"
else
  echo "  cometa-resend-key ya existe"
fi

echo ""
echo "[6/7] Docker auth..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo ""
echo "[7/7] Lanzando build (backend + frontend)..."
echo "      ~10-15 minutos..."
echo ""
gcloud builds submit . --config=cloudbuild.yaml --project="${PROJECT}"

echo ""
echo "======================================"
echo " DEPLOY COMPLETADO"
echo "======================================"
gcloud run services list --region="${REGION}" --project="${PROJECT}"
