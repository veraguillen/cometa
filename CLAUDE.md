# Cometa Pipeline — Guía para Claude

## Comandos esenciales

| Acción | Comando |
|---|---|
| Crear entorno virtual | `python -m venv venv` |
| Activar entorno (Windows) | `.\venv\Scripts\activate` |
| Instalar dependencias | `pip install -r requirements.txt` |
| Levantar backend | `.\venv\Scripts\python.exe -m uvicorn src.api:app --reload --port 8000` |
| Ejecutar tests | `pytest src/tests/` |
| Ejecutar test específico | `pytest src/tests/test_identity.py -v` |
| Frontend dev | `cd frontend && npm run dev` |

## Arquitectura del proyecto

```
cometa-pipeline/
├── src/
│   ├── api.py              # FastAPI — rutas, middleware, endpoints
│   ├── auth_utils.py       # JWT helpers, generador de IDs híbridos
│   ├── users.json          # Usuarios (no commitear con contraseñas reales)
│   ├── tests/
│   │   └── test_identity.py
│   ├── adapters/           # Google Cloud, Document AI
│   └── core/               # Lógica de negocio (KPIs, auditoría, BQ)
├── frontend/               # Next.js 16 + React 19
│   └── src/
│       ├── app/            # App Router
│       ├── components/     # UI components
│       ├── hooks/          # Custom hooks
│       └── lib/
│           └── api-client.ts  # Axios + interceptores JWT
├── requirements.txt
└── CLAUDE.md
```

## Sistema de IDs Híbridos

### Formato
```
^(ANA|FND)-[A-Za-z0-9]{6}$
```

| Prefijo | Condición | Ejemplo |
|---|---|---|
| `ANA-` | Dominio `@cometa.vc`, `@cometa.com`, `@cometa.fund`, `@cometavc.com` | `ANA-3kL9pZ` |
| `FND-` | Cualquier otro dominio | `FND-X7mQr2` |

### Generación
- Función: `generate_hybrid_id(email)` en `src/auth_utils.py`
- Entropía: `secrets.choice` sobre 62 chars (`a-z A-Z 0-9`) — **nunca** `random`
- IDs legacy (`U001`, `U002`, etc.) se migran automáticamente al primer login

### Viaje del ID
```
login → generate_hybrid_id() → persist users.json → JWT claim "user_id" → /api/me → frontend state
```

## Regla Crítica: Escritura Atómica en users.json

**Obligatorio** usar escritura atómica en cualquier modificación de `users.json`.
Patrón aprobado (implementado en `_save_users` de `api.py`):

```python
def _save_users(users: list[dict]) -> None:
    tmp = _USERS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"users": users}, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_USERS_FILE)   # os.replace — atómico en POSIX y Windows
```

**Por qué:** Si el proceso muere entre la apertura y el cierre de `users.json` en modo escritura directa, el archivo queda corrupto y todos los usuarios pierden acceso. `replace()` garantiza que el archivo anterior permanece intacto hasta que el nuevo está completamente escrito en disco.

**Nunca hacer:**
```python
# ❌ No atómico — riesgo de corrupción
with open(_USERS_FILE, "w") as f:
    json.dump({"users": users}, f)
```

## JWT — Claims del token

| Claim | Tipo | Descripción |
|---|---|---|
| `sub` | string | Email del usuario (identificador principal) |
| `email` | string | Duplicado de `sub` para compatibilidad interna |
| `role` | string | `ANALISTA` \| `FOUNDER` \| `SOCIO` |
| `name` | string | Nombre de display |
| `user_id` | string | ID Híbrido para auditoría (`ANA-XXXXXX` / `FND-XXXXXX`) |
| `iat` | timestamp | Issued-at |
| `exp` | timestamp | Expiración (24 h desde emisión) |

- **Secreto:** Variable de entorno `JWT_SECRET` (nunca hardcodeado en producción)
- **Algoritmo:** HS256
- **Verificación:** `_require_auth` en `api.py` — lanza 401 si inválido o expirado

## Variables de entorno requeridas

```bash
# .env (nunca commitear)
JWT_SECRET=secreto-seguro-minimo-32-chars
SKIP_ORIGIN_CHECK=true          # solo en desarrollo local
GOOGLE_CLOUD_PROJECT=...        # proyecto GCP
CORS_ORIGINS=["http://localhost:3000"]
```

## Validación de esquemas — Regla obligatoria

**Toda nueva entidad de API debe tener un schema de validación en ambos lados:**

| Capa | Archivo | Librería |
|---|---|---|
| Backend | `src/schemas.py` | Pydantic v2 |
| Frontend | `frontend/src/lib/schemas.ts` | Zod |

### Backend (`src/schemas.py`)

Modelos activos:

| Modelo | Uso |
|---|---|
| `StoredUser` | Lectura permisiva desde `users.json` (acepta IDs legacy) |
| `UserOut` | **Puerta de escritura** — validación estricta antes de `_save_users()` |
| `UserPublic` | Datos del usuario expuestos por `/api/login` y `/api/me` |
| `LoginApiResponse` | Shape completo de `POST /api/login` |
| `MeApiResponse` | Shape completo de `GET /api/me` |

Patrón obligatorio para toda escritura en `users.json`:

```python
# 1. Modificar el objeto en memoria
users[idx]["id"] = generate_hybrid_id(email)

# 2. Validar con Pydantic ANTES de escribir
try:
    UserOut.model_validate(users[idx])
except ValidationError as exc:
    raise HTTPException(status_code=500, detail=exc.errors())

# 3. Escritura atómica
_save_users(users)
```

### Frontend (`frontend/src/lib/schemas.ts`)

Schemas activos:

| Schema | Valida |
|---|---|
| `hybridIdSchema` | `^(ANA\|FND)-[A-Za-z0-9]{6}$` |
| `userRoleSchema` | `"ANALISTA" \| "FOUNDER" \| "SOCIO"` |
| `userInfoSchema` | Datos públicos del usuario |
| `loginResponseSchema` | Respuesta de `POST /api/login` |
| `meResponseSchema` | Respuesta de `GET /api/me` |

Patrón obligatorio en `api-client.ts` para cualquier llamada que retorne una entidad:

```typescript
const { data } = await apiClient.post<unknown>("/api/nueva-ruta", body);
const parsed = nuevaEntidadSchema.parse(data);  // lanza ZodError si falla
```

Los tipos TypeScript **no se declaran a mano** — se derivan del schema:

```typescript
export type NuevaEntidad = z.infer<typeof nuevaEntidadSchema>;
```

## Seguridad Zero Trust — Backend ↔ Frontend

El sistema opera bajo el principio de **Zero Trust**: ninguna capa confía en los
datos de otra sin validarlos explícitamente en tiempo de ejecución.

### Modelo de confianza

```
Usuario → LoginScreen → /api/login → JWT → /api/me → Estado React
   ↓            ↓            ↓         ↓        ↓          ↓
Zod form   bcrypt verify  Pydantic  HS256   Pydantic    Zod parse
validate   (checkpw)     UserSchema verify  UserSchema  (schema.ts)
```

### Contraseñas — bcrypt obligatorio

- **Almacenamiento**: siempre hash `$2b$12$...` — nunca texto plano en disco.
- **Verificación**: `bcrypt.checkpw(plain.encode(), hash.encode())` en `api.py`.
- **Migración lazy**: en el primer login de un usuario con contraseña legacy,
  el sistema la hashea automáticamente y reescribe `users.json` de forma atómica.
- **Función**: `_hash_password()` y `_verify_password()` en `api.py`.

### Validación de schema en cada capa

| Capa | Qué se valida | Con qué | Cuándo |
|---|---|---|---|
| Backend — request | Body/query params | Pydantic `LoginRequest` | Antes del handler (FastAPI automático) |
| Backend — escritura | Usuario a persistir | `UserSchema.model_validate()` | Antes de `_save_users()` |
| Backend — respuesta | Shape del JSON | Pydantic response models | En construcción del dict de retorno |
| Frontend — recepción | Respuesta del servidor | Zod `schema.parse()` | Dentro de `apiGet` / `apiPost` |
| Frontend — formulario | Input del usuario | Zod `loginRequestSchema` | Antes de enviar el request |

### Helpers Zero Trust en api-client.ts

```typescript
// Toda nueva llamada de API usa estos helpers — parse es estructuralmente obligatorio
const portfolio = await apiGet("/api/portfolio/XYZ", portfolioSchema);
const result    = await apiPost("/api/recurso", body, recursoResponseSchema);
```

No es posible llamar `apiGet` o `apiPost` sin pasar un schema Zod — el compilador TypeScript lo rechaza.

### Espejo Backend ↔ Frontend

| Pydantic (src/schemas.py) | Zod (frontend/src/lib/schemas.ts) |
|---|---|
| `UserPublic` | `userInfoSchema` |
| `LoginApiResponse` | `loginResponseSchema` |
| `MeApiResponse` | `meResponseSchema` |
| `LoginRequest` | `loginRequestSchema` |
| `_format_validation_errors` | `validationErrorSchema` |

Ante cualquier cambio en el backend, el espejo frontend debe actualizarse en el mismo commit.

### Archivos de reglas automáticas

- `.claude/rules/backend.md` — reglas R-B1…R-B6 para revisión de código Python
- `.claude/rules/frontend.md` — reglas R-F1…R-F6 para revisión de código TypeScript

---

## Manejo de Errores

### Códigos HTTP estándar

| Código | Cuándo se usa |
|---|---|
| `200` | Operación exitosa |
| `401` | Token ausente, inválido o expirado |
| `403` | Token válido pero sin permisos para el recurso |
| `422` | **Fallo de validación de esquema** (Pydantic / Zod) — ver abajo |
| `429` | Rate limit excedido (slowapi) |
| `500` | Error interno no anticipado |

### 422 Unprocessable Entity — fallas de validación

Desde la sesión actual, **toda falla de validación Pydantic devuelve 422** con estructura uniforme:

```json
{
  "detail": [
    {
      "loc":  ["body", "id"],
      "msg":  "user_id 'U001' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{6}$",
      "type": "value_error"
    }
  ]
}
```

**Dos handlers globales registrados en `api.py` (antes de cualquier ruta):**

| Handler | Tipo de excepción capturada | Caso típico |
|---|---|---|
| `pydantic_validation_handler` | `pydantic.ValidationError` | `UserSchema.model_validate()` falla internamente |
| `request_validation_handler` | `fastapi.exceptions.RequestValidationError` | Body/query params del request no cumplen el modelo |

**Garantía de orden:** Los handlers se registran antes de las rutas → siempre activos cuando `UserSchema.model_validate()` se ejecuta antes de `_save_users()`. Si la validación falla, el disco **nunca** se toca.

### En el Frontend

El cliente Axios (`api-client.ts`) recibe el 422 como un error Axios normal.
Acceder al detalle:

```typescript
import { ZodError } from "zod";
import axios from "axios";

try {
  await loginWithCredentials(email, password);
} catch (err) {
  if (axios.isAxiosError(err) && err.response?.status === 422) {
    const detail = err.response.data.detail;
    // detail: Array<{ loc: string[], msg: string, type: string }>
    const firstError = detail[0]?.msg ?? "Error de validación";
  }
}
```

## Reglas de desarrollo

- **Python:** PEP 8 estricto, type hints obligatorios, docstrings en funciones de IA/core
- **Frontend:** componentes funcionales, custom hooks para lógica de negocio
- **No tocar:** archivos en `venv/`, `.next/`, `dist/`
- **No commitear:** `.env`, `*.tmp`, `cometa_key.json`
- **Interceptores Axios** (`api-client.ts`): no eliminar — son críticos para compatibilidad con todos los componentes existentes
