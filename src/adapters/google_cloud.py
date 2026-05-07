import os
import vertexai
from vertexai.generative_models import GenerativeModel, GenerationConfig, Part
from google.auth.exceptions import DefaultCredentialsError
from google.oauth2 import service_account

class GeminiAuditor:
    def __init__(self, project_id, location="us"):
        # Inicialización con región global de EE.UU.
        self.project_id = project_id
        self.location = os.getenv("VERTEX_AI_LOCATION", location)
        self.model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        
        print(f"🔧 [Gemini] Inicializando Vertex AI...")
        print(f"   Proyecto: {project_id}")
        print(f"   Región: {self.location}")
        
        # Inicialización con credenciales explícitas cuando sea posible
        import json as _json
        creds = None

        def _parse(raw: str) -> dict:
            raw = raw.strip()
            parsed = _json.loads(raw)
            if isinstance(parsed, str):
                print("⚠️  [Gemini] JSON doblemente serializado — decodificando de nuevo")
                parsed = _json.loads(parsed)
            required = {"type", "project_id", "private_key", "client_email"}
            missing = required - parsed.keys()
            if missing:
                raise ValueError(f"[Gemini] GCP_SERVICE_ACCOUNT_JSON le faltan campos: {missing}. Claves: {list(parsed.keys())}")
            print(f"✅  [Gemini] SA JSON OK — client_email: {parsed.get('client_email')}")
            return parsed

        # ── Prioridad 1: GCP_SERVICE_ACCOUNT_JSON (Cloud Run + Secret Manager) ──
        sa_json_str = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
        if sa_json_str:
            print("🔐 [Gemini] Usando GCP_SERVICE_ACCOUNT_JSON (Secret Manager)")
            sa_info = _parse(sa_json_str)
            creds = service_account.Credentials.from_service_account_info(sa_info)
            creds_project = getattr(creds, "project_id", None)
            if creds_project and creds_project != project_id:
                print(f"⚠️  [Gemini] project_id del JSON ({creds_project}) != project_id ({project_id})")
        else:
            # ── Prioridad 2: GOOGLE_APPLICATION_CREDENTIALS o fallback a archivo ─
            sa_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            if not sa_path:
                repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
                fallback = os.path.join(repo_root, "cometa_key.json")
                sa_path = fallback if os.path.exists(fallback) else None

            if sa_path:
                if not os.path.isabs(sa_path):
                    sa_path = os.path.abspath(sa_path)
                print(f"🔐 [Gemini] Service Account JSON: {sa_path}")
                if not os.path.exists(sa_path):
                    raise DefaultCredentialsError(f"Service Account JSON no existe en: {sa_path}")

                creds = service_account.Credentials.from_service_account_file(sa_path)
                creds_project = getattr(creds, "project_id", None)
                if creds_project and creds_project != project_id:
                    print(
                        f"⚠️  [Gemini] project_id del JSON ({creds_project}) no coincide con project_id ({project_id})"
                    )

        if creds is not None:
            vertexai.init(project=project_id, location=self.location, credentials=creds)
        else:
            print("⚠️  [Gemini] Sin credenciales explícitas; intentando ADC (Default Credentials)")
            vertexai.init(project=project_id, location=self.location)
        
        # Alias oficial: siempre apunta al modelo activo más reciente
        self.model = GenerativeModel(self.model_name)
        print(f"   Modelo: {self.model_name}")
        print(f"✅ [Gemini] Vertex AI inicializado correctamente")

    def extraer_y_auditar(self, pdf_path, prompt_configuracion):
        # 1. Preparar el PDF para la IA
        with open(pdf_path, "rb") as f:
            pdf_data = f.read()
        
        pdf_part = Part.from_data(data=pdf_data, mime_type="application/pdf")

        # 2. Prueba de vida antes de procesar el PDF
        print(f"\n🧪 [Gemini] Prueba de vida del modelo...")
        try:
            life_response = self.model.generate_content("¿Estás activo?")
            print(f"✅ [Gemini] Modelo activo: {life_response.text[:50]}...")
        except Exception as life_error:
            print(f"❌ [Gemini] ERROR en prueba de vida: {life_error}")
            print(f"   Si esto falla, el pipeline está bloqueado")
            raise life_error
        
        # 3. Llamar a Gemini con el PDF y el prompt dinámico
        print(f"\n🧠 [Gemini] Conectando a Gemini en el proyecto {self.project_id} (Región: {self.location})...")
        print(f"   Enviando PDF: {os.path.basename(pdf_path)}")
        print(f"   Tamaño: {len(pdf_data)} bytes")
        
        # Build a typed GenerationConfig:
        #   temperature=0.0  → deterministic, maximum precision
        #   top_p=0.95       → near-full token distribution considered
        #   response_mime_type → native JSON mode (no markdown fences)
        generation_config = GenerationConfig(
            temperature=0.0,
            top_p=0.95,
            response_mime_type="application/json",
        )

        try:
            response = self.model.generate_content(
                [pdf_part, prompt_configuracion],
                generation_config=generation_config,
            )
            print(f"✅ [Gemini] Respuesta recibida correctamente")
            return response.text
        except Exception as e:
            if "404" in str(e) or "Not Found" in str(e):
                print(f"\n🚨 [Gemini] Error 404 - API no encontrada")
                print(f"   Por favor verifica que la API de Vertex AI esté habilitada en la consola de GCP")
                print(f"   Proyecto: {self.project_id}")
                print(f"   Región: {self.location}")
                print(f"   Modelo: gemini-2.5-flash")
            else:
                print(f"\n🚨 [Gemini] Error inesperado: {e}")
            raise e

    def analizar_texto(self, contenido_texto: str, prompt: str) -> str:
        """
        Analyze plain text content (DOCX extraction or tabular summary) with Gemini.
        No PDF Part — sends text-only prompt + content.
        """
        print(f"\n🧠 [Gemini] Analizando texto ({len(contenido_texto)} chars)...")
        generation_config = GenerationConfig(
            temperature=0.0,
            top_p=0.95,
            response_mime_type="application/json",
        )
        try:
            response = self.model.generate_content(
                [prompt, contenido_texto],
                generation_config=generation_config,
            )
            print(f"✅ [Gemini] Respuesta de texto recibida")
            return response.text
        except Exception as e:
            print(f"🚨 [Gemini] Error analizando texto: {e}")
            raise e
