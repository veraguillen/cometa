# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Build — instala dependencias en un entorno aislado
# ──────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# Dependencias de sistema necesarias para compilar paquetes con extensiones C
# (cryptography, grpcio) y para PyMuPDF en tiempo de instalación
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
        libssl-dev \
        gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime — imagen mínima de producción
# ──────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# Librerías de sistema requeridas en RUNTIME por PyMuPDF y grpcio
# (las de compilación quedan fuera → imagen más pequeña)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgomp1 \
        libgl1 \
        libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# Copiar dependencias Python desde el builder
COPY --from=builder /install /usr/local

# Usuario no-root por seguridad (creado antes de COPY para --chown)
RUN useradd --no-create-home --shell /bin/false appuser

# Copiar código fuente con ownership correcto
COPY --chown=appuser:appuser src/    ./src/
COPY --chown=appuser:appuser assets/ ./assets/

# Cloud Run exige el puerto 8080
ENV PORT=8080 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

# Health check: Cloud Run probe + load-balancer readiness
# Interval 30s, 3 retries → instance marked unhealthy after ~90 s of failures.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" \
    || exit 1

USER appuser

# --timeout-keep-alive 120: cubre SSE streams del /api/chat/stream endpoint.
# --workers 2: seguro para 1 vCPU; Cloud Run escala instancias según demanda.
# Para PDF chunking (CPU intensivo) la concurrencia se limita al nivel Cloud Run
# (--concurrency 10-20 recomendado en la consola).
CMD ["sh", "-c", "uvicorn src.api:app --host 0.0.0.0 --port ${PORT:-8080} --workers 2 --timeout-keep-alive 120"]
