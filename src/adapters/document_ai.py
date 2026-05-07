import os
import json
import time
from google.cloud import documentai_v1 as documentai
from google.cloud import storage
from google.api_core import exceptions as gcp_exceptions
from google.api_core import client_options
from google.api_core import operations_v1
from google.oauth2 import service_account

class DocumentAIAdapter:
    def __init__(self, project_id, location="us", processor_id=None):
        self.project_id = project_id
        self.location = location
        self.processor_id = processor_id

        # Prioridad 1: GCP_SERVICE_ACCOUNT_JSON (Cloud Run + Secret Manager)
        sa_json_str = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
        if sa_json_str:
            print("🔐 [Document AI] Usando GCP_SERVICE_ACCOUNT_JSON (Secret Manager)")
            raw = sa_json_str.strip()
            parsed = json.loads(raw)
            if isinstance(parsed, str):
                print("⚠️  [Document AI] JSON doblemente serializado — decodificando de nuevo")
                parsed = json.loads(parsed)
            required = {"type", "project_id", "private_key", "client_email"}
            missing = required - parsed.keys()
            if missing:
                raise ValueError(f"[Document AI] GCP_SERVICE_ACCOUNT_JSON le faltan campos: {missing}. Claves: {list(parsed.keys())}")
            print(f"✅  [Document AI] SA JSON OK — client_email: {parsed.get('client_email')}")
            credentials = service_account.Credentials.from_service_account_info(parsed)
        else:
            # Prioridad 2: GOOGLE_APPLICATION_CREDENTIALS (archivo, dev local)
            ruta_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            print(f"🔍 [Document AI] GOOGLE_APPLICATION_CREDENTIALS: {ruta_json}")
            if not ruta_json or not os.path.exists(ruta_json):
                raise ValueError(f"🚨 ERROR CRÍTICO: No existe el archivo de llaves en: {ruta_json}")
            print(f"🔐 [Document AI] Usando credenciales desde: {ruta_json}")
            credentials = service_account.Credentials.from_service_account_file(ruta_json)
        
        # Inicializar cliente con endpoint específico y credenciales
        client_opts = client_options.ClientOptions(
            api_endpoint=f"{location}-documentai.googleapis.com"
        )
        self.client = documentai.DocumentProcessorServiceClient(
            client_options=client_opts,
            credentials=credentials
        )
        
        # Inicializar cliente de Storage con las mismas credenciales
        self.storage_client = storage.Client(credentials=credentials)

    def extraer_tablas(self, file_path):
        """
        Método legacy para compatibilidad. Usa batch processing para PDFs grandes.
        """
        if not self.processor_id:
            raise ValueError("❌ Se requiere el PROCESSOR_ID de Document AI.")
        
        # Para archivos pequeños (<15 páginas), usar método síncrono
        if self._is_small_file(file_path):
            return self._process_sync(file_path)
        
        # Para archivos grandes, usar batch processing
        raise ValueError("❌ Archivo demasiado grande para procesamiento síncrono. Use extraer_tablas_batch().")
    
    def extraer_tablas_batch(self, gcs_input_uri, gcs_output_uri):
        """
        Procesa PDFs grandes usando Batch Processing de Document AI.
        
        Args:
            gcs_input_uri: gs://bucket/input.pdf
            gcs_output_uri: gs://bucket/output/
        
        Returns:
            str: Texto de las tablas extraídas
        """
        if not self.processor_id:
            raise ValueError("❌ Se requiere el PROCESSOR_ID de Document AI.")
        
        # Asegurar que el output URI termine con /
        if not gcs_output_uri.endswith("/"):
            gcs_output_uri = gcs_output_uri + "/"
        
        print(f"\n🔧 [Document AI] Output URI final: {gcs_output_uri}")
        
        print(f"📥 [Document AI] Iniciando batch processing:")
        print(f"   Input: {gcs_input_uri}")
        print(f"   Output: {gcs_output_uri}")
        print(f"   Processor: {self.processor_id}")
        print(f"   Project: {self.project_id}")
        print(f"   Location: {self.location}")
        
        # 1. Configurar el nombre del recurso
        name = self.client.processor_path(self.project_id, self.location, self.processor_id)
        
        # 2. Configurar input y output para batch processing
        input_config = documentai.BatchDocumentsInputConfig(
            gcs_documents=documentai.GcsDocuments(
                documents=[
                    documentai.GcsDocument(
                        gcs_uri=gcs_input_uri,
                        mime_type="application/pdf"  # Asegurar mime_type exacto
                    )
                ]
            )
        )
        
        output_config = documentai.DocumentOutputConfig(
            gcs_output_config=documentai.DocumentOutputConfig.GcsOutputConfig(
                gcs_uri=gcs_output_uri
            )
        )
        
        # 3. Crear request de batch processing
        request = documentai.BatchProcessRequest(
            name=name,
            input_documents=input_config,
            document_output_config=output_config
        )
        
        # Print de debug con configuración exacta
        print(f"\n🔧 [Document AI] Configuración exacta:")
        print(f"   Project ID: {self.project_id}")
        print(f"   Location: {self.location}")
        print(f"   Processor ID: {self.processor_id}")
        print(f"   Processor Path: {name}")
        print(f"   Input URI: {gcs_input_uri}")
        print(f"   Output URI: {gcs_output_uri}")
        print(f"   Client Endpoint: {self.client._transport._host}")
        
        # Confirmación del endpoint para procesador en 'us'
        if self.location == "us" and "us-documentai.googleapis.com" not in str(self.client._transport._host):
            print(f"\n⚠️  [Document AI] ADVERTENCIA: Endpoint incorrecto para location 'us'")
            print(f"   Expected: us-documentai.googleapis.com")
            print(f"   Actual: {self.client._transport._host}")
        
        # Validación adicional del Project ID
        if not self.project_id or self.project_id == "tu-project-id":
            raise ValueError(f"❌ Project ID no configurado correctamente: {self.project_id}")
        
        try:
            # 4. Iniciar operación de batch processing
            operation = self.client.batch_process_documents(request=request)
            print(f"⏳ [Document AI] Operación iniciada: {operation.operation.name}")
            
            # 5. Esperar a que termine (LRO - Long Running Operation) con mejor manejo de errores
            try:
                result = operation.result(timeout=1800)  # 30 minutos timeout
                print(f"✅ [Document AI] Batch processing completado")
                
                # 6. Descargar y procesar resultados
                return self._process_batch_results(gcs_output_uri, result)
                
            except Exception as result_error:
                print(f"\n🚨 [Document AI] Error en operation.result():")
                print(f"   Error: {str(result_error)}")
                print(f"   Tipo: {type(result_error).__name__}")
                
                # Imprimir TODO el objeto operation.operation
                print(f"\n📋 [Document AI] OBJETO OPERATION COMPLETO:")
                print(f"{operation.operation}")
                
                # Usar operation.operation.name para consultar el estado manualmente
                try:
                    if hasattr(operation, 'operation') and operation.operation.name:
                        print(f"\n🔍 [Document AI] Consultando estado manualmente...")
                        print(f"   Operation Name: {operation.operation.name}")
                        
                        # Obtener la operación actualizada del servidor
                        op_detail = self.client.get_operation(
                            request={"name": operation.operation.name}
                        )
                        
                        print(f"\n📋 [Document AI] OBJETO OPERATION DETALLADO:")
                        print(f"{op_detail}")
                        
                        # Buscar el error dentro de la metadata de la respuesta
                        if op_detail.metadata and "individual_process_statuses" in str(op_detail.metadata):
                            for status in op_detail.metadata.individual_process_statuses:
                                print(f"❌ ERROR REAL EN DOCUMENTO: {status.status.message}")
                        else:
                            print(f"⚠️ No hay detalles individuales. Error general: {op_detail.error.message}")
                            
                except Exception as detail_error:
                    print(f"   Error obteniendo detalles: {str(detail_error)}")
                
                raise result_error
            
        except gcp_exceptions.GoogleAPICallError as e:
            # Error detallado para debugging
            error_details = str(e)
            print(f"\n🔍 [Document AI] Error detallado:")
            print(f"   Código: {getattr(e, 'code', 'N/A')}")
            print(f"   Mensaje: {getattr(e, 'message', 'N/A')}")
            print(f"   Detalles: {error_details}")
            
            # Si hay metadata de error, imprimirla
            if hasattr(e, 'errors') and e.errors:
                for i, error in enumerate(e.errors):
                    print(f"   Error {i+1}: {error}")
            
            # Información adicional para error 400
            if hasattr(e, 'code') and e.code == 400:
                print(f"\n🚨 [Document AI] Error 400 - Sugerencias:")
                print(f"   1. Verificar que el archivo PDF sea válido y accesible en GCS")
                print(f"   2. Confirmar que el processor ID sea correcto: {self.processor_id}")
                print(f"   3. Asegurar que el bucket de salida tenga permisos adecuados")
                print(f"   4. Verificar que el URI de entrada sea accesible públicamente o con la cuenta de servicio")
            
            raise RuntimeError(f"❌ Error en Document AI batch processing: {e}")
        except Exception as e:
            print(f"\n🔍 [Document AI] Error inesperado:")
            print(f"   Tipo: {type(e).__name__}")
            print(f"   Mensaje: {str(e)}")
            raise RuntimeError(f"❌ Error inesperado en batch processing: {e}")

    def _is_small_file(self, file_path):
        """
        Verifica si el archivo es pequeño para procesamiento síncrono (<15 páginas).
        Para PDFs, estimamos ~1MB por página como referencia.
        """
        try:
            file_size = os.path.getsize(file_path)
            # Para PDFs de 116 páginas, el tamaño será mucho mayor
            # Umbral conservador: 5MB (aprox 5 páginas)
            print(f"📊 [Document AI] Tamaño del archivo: {file_size / (1024*1024):.2f} MB")
            return file_size < 5 * 1024 * 1024  # 5MB threshold
        except OSError:
            return False
    
    def _process_sync(self, file_path):
        """
        Método síncrono original para archivos pequeños.
        """
        name = self.client.processor_path(self.project_id, self.location, self.processor_id)
        
        with open(file_path, "rb") as image:
            image_content = image.read()
        
        raw_document = documentai.RawDocument(content=image_content, mime_type="application/pdf")
        request = documentai.ProcessRequest(name=name, raw_document=raw_document)
        result = self.client.process_document(request=request)
        document = result.document
        
        tablas_texto = ""
        for page in document.pages:
            for table in page.tables:
                tablas_texto += self._table_to_text(table, document.text)
        
        return tablas_texto
    
    def _process_batch_results(self, gcs_output_uri, operation_result):
        """
        Procesa los resultados del batch processing desde GCS.
        """
        try:
            # Extraer bucket y prefix del URI
            bucket_name = gcs_output_uri.replace("gs://", "").split("/")[0]
            prefix = "/".join(gcs_output_uri.replace("gs://", "").split("/")[1:])
            
            bucket = self.storage_client.bucket(bucket_name)
            
            # Buscar archivos de salida
            blobs = list(bucket.list_blobs(prefix=prefix.rstrip("/")))
            
            if not blobs:
                raise RuntimeError("❌ No se encontraron archivos de salida en GCS")
            
            tablas_texto = ""
            
            for blob in blobs:
                if blob.name.endswith(".json"):
                    print(f"📄 [Document AI] Procesando resultado: {blob.name}")
                    
                    # Descargar JSON
                    json_content = blob.download_as_text()
                    document = documentai.Document.from_json(json_content)
                    
                    # Extraer tablas del documento
                    for page in document.pages:
                        for table in page.tables:
                            tablas_texto += self._table_to_text(table, document.text)
            
            if not tablas_texto.strip():
                print("⚠️  [Document AI] No se encontraron tablas en el documento")
            
            return tablas_texto
            
        except Exception as e:
            raise RuntimeError(f"❌ Error procesando resultados de batch: {e}")
    
    def _table_to_text(self, table, text):
        """Helper para convertir las celdas de Document AI en un string legible."""
        rows_data = []
        for row in table.header_rows:
            rows_data.append([self._get_text(cell.layout, text) for cell in row.cells])
        for row in table.body_rows:
            rows_data.append([self._get_text(cell.layout, text) for cell in row.cells])
        
        return "\n".join([" | ".join(row) for row in rows_data]) + "\n\n"

    def _get_text(self, layout, text):
        """Extrae el texto de un segmento específico del documento."""
        return "".join([text[int(segment.start_index):int(segment.end_index)] 
                        for segment in layout.text_anchor.text_segments]).strip().replace("\n", " ")

