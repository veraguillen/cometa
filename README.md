# Cometa Vault

**Plataforma de Inteligencia Financiera para Portafolio de Venture Capital**

Cometa Vault automatiza la extracción, validación y análisis de KPIs financieros de las startups del portafolio de Cometa VC. Los founders suben sus reportes (PDF, Excel, CSV); la IA los procesa, verifica y presenta al equipo analista en un dashboard en tiempo real.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND · Next.js 16 · React 19 · TypeScript · Tailwind CSS 4    │
│  /login    → Obsidian & Steel (tema oscuro, entrada premium)        │
│  /analyst  → Pearl & Emerald   (claridad institucional)             │
│  /founder  → Pearl & Emerald   (portal de carga)                   │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ HTTPS · JWT HS256 · 24h
┌──────────────────────▼──────────────────────────────────────────────┐
│  BACKEND · FastAPI + Python 3.11 · Uvicorn · Cloud Run              │
│  POST /upload              → Extracción con Gemini 2.5 Flash        │
│  GET  /api/results         → KPIs por empresa                       │
│  PUT  /api/kpi-update      → Corrección analista (→ "verified")     │
│  GET  /api/analyst/coverage → Heatmap de cobertura del portafolio  │
│  POST /api/chat[/stream]   → RAG conversacional + SSE               │
│  POST /api/admin/invite    → Invitación a founders (Resend)         │
└──────┬───────────────────────────────────────────┬──────────────────┘
       │                                           │
┌──────▼──────────────────┐        ┌──────────────▼──────────────────┐
│  Google BigQuery        │        │  Google Cloud Storage            │
│  cometa-mvp             │        │  vault/{company}/                │
│  ├─ submissions         │        │    {hash}_result.json            │
│  ├─ fact_kpi_values     │        │    raw/{hash}.pdf                │
│  ├─ dim_company         │        └─────────────────────────────────┘
│  ├─ dim_kpi_metadata    │
│  └─ v_data_coverage     │        ┌─────────────────────────────────┐
└─────────────────────────┘        │  Vertex AI · Gemini 2.5 Flash   │
                                   │  us-central1                    │
                                   └─────────────────────────────────┘
```

---

## Funcionalidades clave

### Extracción automática de KPIs con IA
- Gemini 2.5 Flash extrae 16+ KPIs financieros con score de confianza (0.0–1.0) por métrica
- PDF chunking automático para documentos >90 páginas (`split_pdf_to_chunks`)
- Fusión multi-bloque con regla *highest-confidence-wins* (`merge_consolidated_results`)
- Motor de derivación matemática (`gross_profit_margin`, `ebitda_margin` calculados desde bases)
- Normalización de moneda a USD via tasas FMI anuales (`src/core/fx_service.py`)
- Deduplicación por SHA-256 — mismo archivo nunca se reprocesa

### Sistema de Fidelidad de Datos

Cada KPI en BigQuery tiene un estado de fidelidad que evoluciona a lo largo del tiempo:

| Estado | `is_manually_edited` | Descripción |
|--------|----------------------|-------------|
| **Legacy** | `FALSE` | Extraído por IA, sin revisión analista |
| **Verified** | `TRUE` | Confirmado o corregido por analista Cometa |

El campo `submission_id` (UUID v4) actúa como clave de trazabilidad — une el documento original, sus KPIs en `fact_kpi_values`, la entrada manual, y el log de auditoría en una cadena inquebrantable.

### RAG Conversacional (Analista)
- Chat sobre los datos del portafolio con contexto BigQuery en tiempo real
- Diccionario dinámico de KPIs inyectado como `<kpi_dict>` desde `dim_kpi_metadata`
- Streaming SSE en tiempo real — el analista ve la respuesta letra a letra
- El motor conoce KPIs no existentes aún en los datos y puede responder sobre brechas

### Portfolio Coverage Heatmap
- Mapa visual empresa × período para detectar brechas de datos a golpe de vista
- Semáforo de tres estados: Verified (acento del tema) · Legacy (ámbar) · Missing (rojo pulsante)
- Tooltip con conteo exacto de KPIs verificados/legacy/total al pasar el cursor
- Navegación directa al dashboard de la empresa con un clic en cualquier celda
- Disponible como tercera pestaña "Cobertura" en el analyst dashboard

### Sistema de Invitaciones
- `POST /api/admin/invite` — envía email de bienvenida con link de activación (Resend)
- `POST /api/auth/setup-password` — el founder establece contraseña (bcrypt `$2b$12$`)
- IDs híbridos: `ANA-XXXXXX` para analistas Cometa · `FND-XXXXXX` para founders externos

---

## Sistema de Temas (4 modos)

Todos los colores pasan por CSS custom properties en `globals.css`. El cambio de tema es un cambio del atributo `data-theme` en `<html>` — cero re-renders de React.

| Tema | Fondo | Acento | Contexto |
|------|-------|--------|----------|
| **Pearl & Emerald** | `#FFFFFF` | `#00A86B` | Dashboard analista · Portal founder |
| **Obsidiana & Steel** | `#000000` | `#64CAE4` | Login · Landing · Entrada premium |
| **Ivory & Slate** | `#F4F1EB` | `#ECE5BC` | Alternativa banca privada |
| **Deep Umber & Gold** | `#1A0F07` | `#ECE5BC` | Alternativa premium oscuro |

**Routing automático de temas:**
```
/login         → ResetTheme()           → data-theme="obsidian"
/analyst/*     → ThemeProvider          → localStorage ?? "pearl"
/founder/*     → ResetTheme theme="pearl" → data-theme="pearl"
/success       → ResetTheme theme="pearl" → data-theme="pearl"
```

El analista puede cambiar de tema manualmente con `ThemeSwitcher`. La preferencia persiste en `localStorage`.

---

## Roles y permisos

| Rol | ID Prefix | Acceso |
|-----|-----------|--------|
| `ANALISTA` | `ANA-XXXXXX` | Dashboard global · Corrección KPIs · Heatmap · Chat RAG · Auditoría |
| `FOUNDER` | `FND-XXXXXX` | Portal de carga (solo sus documentos) · Página de éxito |
| `SOCIO` | — | Vista de portafolio (read-only) |

**Zero Trust**: Pydantic v2 valida cada request/response en el backend. Zod valida cada respuesta de API en el frontend. Ninguna capa confía en la otra sin validación explícita en runtime.

---

## Inicio rápido

### Requisitos

- Python 3.11+
- Node.js 18+
- Service Account JSON con roles: `bigquery.dataEditor`, `bigquery.jobUser`, `storage.objectAdmin`, `aiplatform.user`, `documentai.apiUser`

### 1. Clonar y configurar

```bash
git clone https://github.com/cometa-vc/cometa-pipeline.git
cd cometa-pipeline

# Entorno virtual Python
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS/Linux
pip install -r requirements.txt

# Dependencias frontend
cd frontend && npm install && cd ..
```

### 2. Variables de entorno

```bash
cp env.template .env
# Editar .env con tus credenciales
```

Variables mínimas para desarrollo local:

```env
GOOGLE_APPLICATION_CREDENTIALS=./cometa_key.json
GOOGLE_PROJECT_ID=cometa-mvp
BIGQUERY_DATASET=cometa_vault
VERTEX_AI_LOCATION=us-central1
GCS_INPUT_BUCKET=ingesta-financiera-raw-cometa-mvp
GCS_OUTPUT_BUCKET=cometa-vault-results
JWT_SECRET=<mínimo-32-caracteres-aleatorios>
SKIP_ORIGIN_CHECK=true
RESEND_API_KEY=re_...
NEXT_PUBLIC_API_URL=http://localhost:8000
CORS_ORIGINS=["http://localhost:3000"]
```

### 3. Backend

```bash
.\venv\Scripts\python.exe -m uvicorn src.api:app --reload --port 8000
```

Al arrancar, el backend inicializa automáticamente el schema BigQuery (`ensure_schema()`), sincroniza `dim_company` y `dim_kpi_metadata`, y crea `v_data_coverage`. BigQuery es no-fatal — el servidor arranca aunque no haya conexión.

### 4. Frontend

```bash
cd frontend && npm run dev
# → http://localhost:3000
```

### 5. Tests

```bash
pytest src/tests/ -v
```

---

## Stack tecnológico

| Capa | Tecnología | Versión |
|------|-----------|---------|
| Frontend framework | Next.js (App Router) | 16 |
| UI runtime | React | 19 |
| Tipado | TypeScript | 5 |
| Estilos | Tailwind CSS | 4 |
| Animaciones | Framer Motion | — |
| Validación frontend | Zod | 3 |
| HTTP client | Axios | — |
| Backend framework | FastAPI | 0.115 |
| ASGI server | Uvicorn | — |
| Validación backend | Pydantic | v2 |
| IA | Vertex AI · Gemini 2.5 Flash | — |
| Base de datos | Google BigQuery | — |
| Almacenamiento | Google Cloud Storage | — |
| Email transaccional | Resend | — |
| Auth | JWT HS256 + bcrypt | — |
| Contenedores | Docker · Cloud Run | — |

---

## Estructura del proyecto

```
cometa-pipeline/
├── src/
│   ├── api.py                  # FastAPI — rutas, middleware, auth, endpoints
│   ├── ai_engine.py            # Prompt builder, RAG, streaming, kpi_dict
│   ├── auth_utils.py           # JWT helpers, IDs híbridos ANA-/FND-
│   ├── schemas.py              # Pydantic models — fuente de verdad backend
│   ├── users.json              # Usuarios (no commitear contraseñas reales)
│   ├── adapters/
│   │   ├── google_cloud.py     # GeminiAuditor — Vertex AI wrapper
│   │   └── document_ai.py      # Document AI OCR adapter
│   ├── core/
│   │   ├── data_contract.py    # Parser KPIs, build_contract(), derivación matemática
│   │   ├── db_writer.py        # BigQuery schema, insert, query_coverage(), audit
│   │   ├── kpi_transformer.py  # Normalización de períodos (R5 — PYYYYQxMyy)
│   │   ├── metric_catalog.py   # Catálogo de métricas
│   │   └── fx_bq_loader.py     # Tasas de cambio FMI
│   ├── scripts/
│   │   ├── migrate_bq.py       # Migración de schema BigQuery
│   │   ├── invite_founder.py   # CLI para invitar founders
│   │   └── normalize_histo.py  # Normalización de datos históricos
│   └── tests/
│       └── test_identity.py    # Tests de IDs híbridos y auth
│
├── frontend/src/
│   ├── app/
│   │   ├── layout.tsx               # Root layout — data-theme="obsidian" SSR
│   │   ├── login/page.tsx           # Auth — Obsidian theme
│   │   ├── analyst/
│   │   │   ├── layout.tsx           # ThemeProvider wrapper
│   │   │   └── dashboard/page.tsx   # Cockpit: Dashboard · Reportes · Cobertura
│   │   ├── founder/onboarding/      # Portal de carga — Pearl theme
│   │   └── success/page.tsx         # Confirmación post-upload — Pearl theme
│   ├── components/analyst/
│   │   ├── AppHeader.tsx
│   │   ├── AnalystSidebar.tsx
│   │   ├── BentoGrid.tsx            # Grid 5×2 KPI cards con inline edit
│   │   ├── BentoCharts.tsx          # Visualizaciones Recharts
│   │   ├── PortfolioHeatmap.tsx     # Mapa de cobertura empresa × período
│   │   ├── AITerminal.tsx           # Chat RAG con SSE streaming
│   │   └── ThemeSwitcher.tsx
│   ├── contexts/ThemeContext.tsx    # 4 temas + injectVars() + localStorage
│   ├── hooks/
│   │   ├── useAnalystData.ts        # Carga de datos del analista
│   │   └── usePeriodFilter.ts       # Filtro Q1–Q4 para todos los años
│   ├── services/
│   │   ├── api-client.ts            # Axios + interceptores JWT + downloadCsv
│   │   ├── analyst.ts               # fetchCoverage, getAnalysisResults, etc.
│   │   └── founder.ts               # uploadDocument, finalizeExpediente
│   └── lib/
│       ├── schemas.ts               # Zod schemas — fuente de verdad frontend
│       └── utils.ts
│
├── docs/                       # Documentación técnica detallada
├── sql/                        # Queries BigQuery de referencia
├── Dockerfile                  # Backend Python 3.11 multistage
├── frontend/Dockerfile         # Frontend Next.js standalone
├── cloudbuild.yaml             # CI/CD Cloud Build
├── deploy.sh                   # Despliegue Cloud Run
├── env.template                # Variables de entorno con documentación
└── requirements.txt
```

---

## Despliegue en producción

Ver `HANDOVER.md` para el proceso completo:
- Secrets en GCP Secret Manager
- Cloud Run: Backend (2Gi RAM · 2 CPU · 20 concurrencia) · Frontend (512Mi · 1 CPU · 80 concurrencia)
- Migración de schema BigQuery
- Dominio cometa.vc y SSL

---

## Documentación técnica

| Documento | Contenido |
|-----------|-----------|
| `docs/DATA_CONTRACT.md` | Contrato de datos, fidelidad Legacy/Verified, submission_id |
| `docs/DATA_ARCHITECTURE.md` | Schema BigQuery, v_data_coverage, pipeline de ingesta |
| `docs/UI_UX.md` | 4 temas, routing por tema, tipografía, heatmap colors |
| `docs/API_REFERENCE.md` | Endpoints, parámetros, respuestas, códigos de error |
| `docs/KPI_REGISTRY.md` | Catálogo de KPIs por vertical con descripciones |
| `docs/WORKFLOW.md` | Flujo completo: carga → extracción → validación → dashboard |
| `HANDOVER.md` | Arquitectura Level-5, deployment, SA permissions, constraints |

---

*Cometa Vault — Cometa VC · 2025–2026*
