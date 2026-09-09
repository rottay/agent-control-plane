# diccionario de composición bajo execution

Especificación adjudicada del diseño de composición. No acredita soporte de adapters,
implementación, certificación de producto ni autorización operativa.

Dueño: execution. Esta es su subsección, no una octava área de datos. [Contratos strict](../../../integrations/composition/contracts/index.md) · [Algoritmo/consumo](../../../integrations/composition/validation/index.md) · [Execution base](../index.md)

Las referencias §3.x de tablas remiten a contratos de composición; las convenciones generales siguen en el maestro de datos. El índice lógico y las coordenadas de efectos/dispatches no se duplican aquí.

## 6. Diccionario físico

Ubicación: `database/execution/composition/index.md`, subsección del dueño
execution, no octava área. El mínimo P-18 queda en execution/index.md §§3/6/7/8;
streams enumera por referencia eventos/document_kind y planning conserva su plan.
La distribución de responsabilidades está en el índice de composición.
Todas las tablas son `STRICT`, derivadas, en el ledger. DDL nuevo usa nombres
`pk_/fk_/ck_/ux_/ix_` de datos §3.2; ningún cambio a migraciones aplicadas.

Notación exacta de columnas: `T=TEXT NOT NULL`, `I=INTEGER NOT NULL`, `T?`/`I?`
nullable; todo `*_sha256` lleva CHECK SHA; toda versión positiva; todo conteo
no negativo; booleanos 0/1; vocabularios con CHECK cerrado; timestamps con los
checks comunes. Toda tabla hija incluye las columnas PK indicadas —no están
implícitas fuera de esta declaración. No JSON en ninguna tabla siguiente.

### 6.1 Evaluación y entradas inmutables

| Tabla | Columnas (todas) | Clave y restricciones adicionales |
| --- | --- | --- |
| `composition_preflight_read_model` | `preflight_id T`, `task_id T`, `revision_number I`, `attempt_number I`, `invocation_id T`, `envelope_sha256 T`, `plan_id T`, `plan_artifact_reference_id T`, `plan_revision_sha256 T`, `installation_document_id T`, `installation_document_version I`, `policy_document_id T`, `policy_document_version I`, `algorithm_version I`, `contract_version I`, `evaluated_at T`, `support T`, `composition_sha256 T?`, `sequence I` | PK preflight_id; FK(task_id,revision_number,attempt_number) a task_attempt; composition_sha256 NOT NULL sii support=SUPPORTED; versiones del algoritmo/contrato =1; sequence>0; índice NO UNIQUE(composition_sha256) |
| `composition_source_head_read_model` | `preflight_id T`, `source_stream T`, `source_sequence I`, `source_sha256 T` | PK(preflight_id,source_stream); exactamente cuatro filas por evaluación; FK preflight; source_stream catálogo de cuatro streams; sequence>=0 |
| `composition_source_document_read_model` | `preflight_id T`, `document_id T`, `document_version I`, `document_kind T`, `content_sha256 T`, `registry_sequence I`, `registry_event_sha256 T` | PK(preflight_id,document_id,document_version); FK preflight; referencia causal tipada al registro exacto; registry_sequence>0 y <= su head |

El evento guarda el request y los contenidos estructurados necesarios del
resultado; los documentos de configuración siguen sus referencias autorizadas.
No inventar FK transversal física a models/registry/artifacts: validar pin y
digest contra el corte, conforme a cohortes del maestro. Una fuente ausente se
describe en el diagnóstico; no fabricar una fila source_document con digest
vacío. Installation/policy pines completos se verifican contra esas filas cuando
existen; request-invalid antes de formar evaluación no requiere persistencia.

### 6.2 Snapshot aceptado: filas hijas completas

Estas tablas sólo tienen filas para support=SUPPORTED (guarda de fold). Los
campos son los efectivos, derivados de las fuentes; no un segundo documento
editable. Denormalización prohibida: una tabla hija no repite adapter/modelo/
cuenta cuando su padre o el segmento ya poseen la referencia.

| Tabla | Columnas (todas) | Clave y reglas |
| --- | --- | --- |
| `composition_scope_read_model` | `preflight_id T`, `scope_key T`, `parent_scope_key T?`, `scope_kind T`, `max_effects_count I`, `max_dispatch_attempts I`, `deadline_at T` | PK(preflight_id,scope_key); FK preflight; self FK(preflight_id,parent_scope_key); parent NULL sii RUN; índice UNIQUE parcial(preflight_id) WHERE parent_scope_key IS NULL; max_dispatch_attempts>=1; fold comprueba exactamente una raíz y sin ciclo |
| `composition_node_read_model` | `preflight_id T`, `node_key T`, `scope_key T`, `installation_member_key T`, `profile_document_id T`, `profile_document_version I`, `effect_boundary T`, `retry_mode T`, `fallback_mode T`, `delegation_mode T`, `cancellation_support T`, `continuity_kind T`, `effect_accounting T`, `enforcement T` | PK(preflight_id,node_key); FK scope; FK(preflight_id,profile_document_id,profile_document_version) a source_document; campos de controles son los declarados en §3.1 y comprobados, no flags de UI |
| `composition_resource_read_model` | `preflight_id T`, `resource_key T`, `resource_kind T`, `resource_identity_sha256 T` | PK(preflight_id,resource_key); FK preflight; aliases permitidos con mismo digest, ownership usa digest |
| `composition_node_resource_read_model` | `preflight_id T`, `node_key T`, `resource_slot T`, `resource_key T` | PK(preflight_id,node_key,resource_slot); FK node y resource |
| `composition_operation_selection_read_model` | `preflight_id T`, `node_key T`, `scope_key T`, `contract_id T`, `contract_version I`, `operation T` | PK(preflight_id,node_key,scope_key,contract_id,contract_version,operation); FK node/scope; CHECK de la unión cerrada §3.4; fold prueba oferta del perfil exacto |
| `composition_dependency_read_model` | `preflight_id T`, `consumer_node_key T`, `requirement_key T`, `supplier_node_key T`, `contract_id T`, `contract_version I`, `operation T` | PK(preflight_id,consumer_node_key,requirement_key); dos FK node; versión exacta y verbo validado para contract_id; consumer<>supplier |
| `composition_claim_read_model` | `preflight_id T`, `node_key T`, `claim_key T`, `responsibility T`, `extent T`, `claim_role T`, `is_delegable I`, `resource_key T?` | PK(preflight_id,node_key,claim_key); FK node, FK resource nullable; CHECK claim_role=OWNER OR is_delegable=0; resource NULL exactamente para responsabilidades no ResourceKind |
| `composition_delegation_read_model` | `preflight_id T`, `delegation_key T`, `parent_node_key T`, `child_node_key T`, `child_scope_key T`, `responsibility T`, `resource_key T?`, `subwork_key T` | PK(preflight_id,delegation_key); dos FK node, FK scope/resource; UNIQUE(preflight_id,subwork_key); parent<>child; subwork_key digest canónico de [1,invocation_id,delegation_key,child_scope_key] |
| `composition_owner_read_model` | `preflight_id T`, `scope_key T`, `responsibility T`, `resource_identity_key T`, `node_key T`, `claim_key T` | PK(preflight_id,scope_key,responsibility,resource_identity_key); FK scope y claim; resource_identity_key es SHA real para estado, literal reservado `NO_RESOURCE` exclusivamente en responsabilidades no estado; CHECK explícito por clase. No NULL dentro de PK; no serializar objetos como clave |
| `composition_data_flow_read_model` | `preflight_id T`, `producer_node_key T`, `consumer_node_key T`, `contract_id T`, `contract_version I`, `operation T`, `flow_kind T`, `data_policy_reference_id T`, `data_policy_sha256 T` | PK(preflight_id,producer_node_key,consumer_node_key,contract_id,contract_version,operation,flow_kind); dos FK node; producer<>consumer; flow_kind PIPELINE/OBSERVATION; políticas externas referenciadas con acceso y digest, no copiadas |

FK a claim del owner usa `(preflight_id,node_key,claim_key)`. La cobertura y la
identidad de recurso se prueban por fold; el esquema no pretende que un FK pruebe
la ausencia de ciclo o la exclusividad entre dos aliases. Un campo nullable
resource_key significa no aplica, nunca recurso desconocido admisible.
Las ofertas completas siguen en el perfil versionado; operation_selection es la
única lista habilitada del snapshot, no una copia de todas las ofertas.

### 6.3 Diagnósticos y bindings

| Tabla | Columnas (todas) | Clave y reglas |
| --- | --- | --- |
| `composition_guarantee_read_model` | `preflight_id T`, `node_key T`, `guarantee T`, `is_required I`, `support T`, `evidence_document_id T?`, `evidence_document_version I?` | PK(preflight_id,node_key,guarantee); FK preflight; pin de evidencia ambos NULL o ambos no NULL, FK(preflight_id,evidence_document_id,evidence_document_version) a source_document cuando existe; CHECK(support<>'SUPPORTED' OR evidence_document_id IS NOT NULL); NO FK node porque también se registra en evaluaciones rechazadas; guarantee/support CHECK cerrados; una fila por garantía/nodo evaluado |
| `composition_diagnostic_read_model` | `preflight_id T`, `diagnostic_id T`, `ordinal I`, `rule_code T`, `severity T`, `refusal_class T?`, `scope_key T?`, `at T`, `remedy_code T` | PK(preflight_id,diagnostic_id); UNIQUE(preflight_id,ordinal); FK preflight; refusal NULL sii INFO; scope puede no existir en grafo inválido y por eso NO FK scope |
| `composition_diagnostic_participant_read_model` | `preflight_id T`, `diagnostic_id T`, `node_key T`, `profile_document_id T?`, `profile_document_version I?`, `profile_content_sha256 T?` | PK(preflight_id,diagnostic_id,node_key); FK diagnostic; los tres campos del pin todos NULL o todos no NULL; NO FK node: también describe nodos ausentes |
| `composition_run_binding_read_model` | `invocation_id T`, `initial_preflight_id T`, `driver_node_key T`, `sequence I` | PK invocation_id; FK invocation_id a task_attempt; FK(initial_preflight_id,driver_node_key) a node; sólo preflight SUPPORTED del mismo invocation; no repite coordenada ni biyección; no edición de driver |
| `composition_segment_binding_read_model` | `route_segment_id T`, `preflight_id T`, `sequence I` | PK route_segment_id; FK route segment y preflight; fold exige mismo intento/invocation/envelope del run, y driver pin idéntico al run inicial |
| `composition_effect_binding_read_model` | `effect_id T`, `initial_executor_node_key T`, `contract_id T`, `contract_version I`, `operation T`, `sequence I` | PK effect_id; FK effect. Snapshot se deriva del segmento inicial del efecto; fold exige selección exacta de initial_executor_node_key en semantic_scope_key y todos los owners |
| `composition_dispatch_binding_read_model` | `dispatch_attempt_id T`, `executor_node_key T`, `retry_owner_node_key T`, `sequence I` | PK dispatch_attempt_id; FK dispatch_attempt; efecto/segmento/scope se derivan de execution. Fold exige selección exacta del executor y owners del snapshot de ese segmento; no copia coordenada ni identidad |

Todos los eventos de binding llevan exactamente los campos no derivados de su
fila, y el event_id/sequence vienen del stream, no de contadores auxiliares. No se
duplican fences/reservas/handles de vendors en estas tablas: runtime los toma de
sus dueños existentes. No hay coordination store `composition_lock`.

Rebuild: cortar los cuatro streams a vector fijo, verificar causalidad, reconstruir
configuraciones referenciadas y después evaluaciones/bindings de tareas en orden
de control_plane_events. Un fold no pregunta al SDK, instalación actual, arbiter
ni reloj; copia datos fijados y valida el algoritmo versionado registrado.
Mantener lectores/folds de V1 tras publicar V2; nunca reinterpretar historia con
la nueva política. Snapshot histórico con evidencia hoy revocada conserva su
decisión histórica: revalidación presente bloquea su nuevo uso. Comprobar digest
contra filas canónicas y contra evento; pérdida de proyección se recupera sin
inventar certificados. Folds/watermarks se publican juntos en su cohorte.
