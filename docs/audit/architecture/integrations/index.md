# Integraciones: familias, niveles y prueba de sustitución

Dueño único del concepto **interoperabilidad**: qué familias de integración
existen, qué contrato posee cada una, qué significa que una sea intercambiable y
qué evidencia hace falta para afirmarlo.

[Índice](../../README.md) · [Arquitectura](../index.md) · [Contratos](../contracts/index.md) · [Datos](../database/index.md) · [Requisitos](../../requirements/index.md) · [Tests](../../quality/testing/index.md)

Estado: **especificación**. Base `a92756b`. Los nombres de puerto nuevos son
propuestas semánticas: se reutiliza o se evoluciona el existente antes de crear
otro.

Desarrollo por responsabilidad: [comparativa de mercado](market/index.md) conserva
alternativas y fuentes; [composición](composition/index.md) define la selección
sin solapamientos. Ninguno convierte una integración propuesta en implementada.

---

## 1. Tres niveles, y no se confunden

| Nivel | Qué significa | Qué exige |
| --- | --- | --- |
| **Seleccionar** | elegir una implementación instalada para una tarea o iniciativa nueva | descriptor validado, preflight, versión resuelta registrada |
| **Reanudar por checkpoint** | continuar desde un checkpoint neutral validado en la implementación destino | checkpoint portable, validación de capacidades del destino, rechazo explícito si es incompatible |
| **Migrar en vivo** | transferir ownership y trabajo pendiente entre motores activos | el protocolo de [contratos §9](../contracts/index.md), con fencing, export de timers y señales, y rollback |

**El objetivo inicial es el nivel 2.** El nivel 3 es una capacidad específica que
se adjudica por familia; no se deduce de compartir una interfaz y no es un cambio
silencioso de endpoint.

---

## 2. Funcional, opcional, intercambiable

Tres afirmaciones distintas, con tres pruebas distintas. Confundirlas es el defecto
que esta sección existe para impedir.

| Afirmación | Prueba requerida |
| --- | --- |
| **Funcional** | una implementación real, conectada, ejecuta el caso de uso de punta a punta desde una puerta del producto |
| **Opcional** | el sistema funciona **con** la integración, **sin** ella y **durante su fallo**, sin corromper otras capacidades. No alcanza con que no exista un import |
| **Intercambiable** | **dos** implementaciones reales pasan la misma suite contractual dentro del perfil publicado, más el negativo de adapter retirado o incompatible |

Un mock sirve para desarrollar el contrato. **No vende compatibilidad.** Un puerto
sin caller no es una integración. Una integración funcional con una sola
implementación se anuncia como funcional y **no** reclama sustitución probada.

---

## 3. Las diecinueve familias

Cada fila: quién posee el contrato, qué implementaciones se contemplan, y qué
prueba cierra la afirmación. La columna «hoy» describe el árbol en `a92756b`.

| # | Familia | Contrato y dueño | Implementaciones contempladas | Prueba que cierra | Hoy |
| --- | --- | --- | --- | --- | --- |
| 1 | Ejecución de modelos | `ModelExecutionPort` en `kernel/contracts`; evoluciona con bloques de contenido, uso, cancelación y errores | CLI de suscripción, API autenticada, servidor local; proveedor, modelo, cuenta y transporte son ejes distintos | el mismo pedido por cada transporte entrega contenido y devuelve resultado y uso; modelo no admitido rechaza antes de gastar | puerto correcto; API y local no transportan instrucciones (N02) |
| 2 | Adapters de proveedor | privados de `edges/providers`; el dominio no los conoce | Claude, Codex, Kimi por CLI; API key; local | handshake, payload, cancelación y uso verificados por adapter; `UNSUPPORTED` explícito antes del spawn | tres adapters CLI; Codex y Kimi rechazan `HANDSHAKE_REQUIRED` antes del spawn |
| 3 | Harness de agente | `AgentHarnessPort` en `domains/runtime` **cuando exista consumidor**; hasta entonces vive en el edge | nativo primero; LangGraph u otro como adapter opcional | la misma tarea y autoridad con dos harness; cancelación y presupuesto atraviesan las dos capas | interfaz en el edge, sin consumidor de dominio |
| 4 | Orquestación durable | `OrchestrationDriver` en `domains/runtime`; submit, status, cancel, attach, señales, timers, ownership | supervisor SQLite completo; Restate existente; Temporal como segundo motor candidato | suite contractual compartida con procesos reales; driver no soportado rechaza al planificar | dos drivers reales; `advance` del driver Restate lanza; SQLite rechaza las cuatro capacidades avanzadas |
| 5 | Planificación y equipos | `planning` posee DAG, roles, asignaciones, aprobaciones y revisiones; un planner externo devuelve una propuesta | planner de reglas y planner LLM; el owner por encima de ambos | cambiar coordinador o modelo sin rehacer tareas; propuesta inválida no se ejecuta | no existe |
| 6 | Herramientas | `ToolProtocolPort` al dominio; discover, execute, result, schema, versión | herramientas locales y MCP por stdio o loopback; remoto separado y deshabilitado hasta política explícita | schema alterado, `isError`, timeout y formato no admitido no producen éxito; dos implementaciones bajo el mismo contrato | puerto en el edge; `isError` se convierte en éxito (N07) |
| 7 | Comunicación entre agentes | mensajes y tareas delegadas con origen, destino, correlación, causalidad e idempotencia | buzón local durable; A2A como edge futuro | entrega repetida no duplica trabajo; un agente externo no obtiene más autoridad que la delegada | no existe |
| 8 | Ledger | `LedgerReadPort`, `LedgerWritePort`; transacciones, CAS, cabeza y epoch, append idempotente | SQLite hoy; otro backend transaccional por adapter y migración | conformidad transaccional, replay idéntico, concurrencia, corrupción y migración ida y vuelta | SQLite; aperturas directas e imports concretos en dominios inventariados en [estructura §3](../structure/index.md) |
| 9 | Artefactos y contexto | `ArtifactStorePort`, `ContextStorePort`; bytes por referencia, clasificación, permisos, retención | filesystem local; almacenamiento de objetos opcional | cambiar de backend conserva digest, accesos y referencias; la pérdida de un objeto se informa | store de contenido existe; falta scope, retención y tombstone |
| 10 | Memoria y retrieval | puertos por operación: búsqueda, embeddings, memoria con scope | búsqueda local; motor, vector store y modelo de embeddings elegibles | citaciones y permisos conservados; índices reconstruibles; sin memoria cruzada entre iniciativas | no existe |
| 11 | Identidad y credenciales | `CredentialResolverPort`, `OperatorIdentityPort`, `AuthorizationPort`, **separados** | keychain o archivo protegido; auth local; OIDC opcional futuro | ninguna credencial en el ledger; la política no cambia al cambiar de resolver; una lectura sensible exige autorización | archivo del owner fuera del repositorio, `0600` |
| 12 | Cuentas y cuota | `accounts` posee inventario, observaciones y reservas; el adapter observa capacidades de auth y cuota | un directorio de configuración por cuenta; login manual o refresh según el proveedor | identidad de cuenta probada; DRAIN efectivo; reserva concurrente; una estimación desconocida nunca se muestra como 100 % | bindings plurales y DRAIN reparados; faltan reservas y presión real |
| 13 | Economía y routing | un registry de modelos versionado; medición, precios y políticas propias | fuentes de precios y de uso, reglas configurables | cuenta, modelo y rol cambiables por política; el presupuesto se aplica antes y durante el efecto | registry existe; ranking medido determinista; sin precios |
| 14 | Observabilidad | `TelemetryExporterPort` al dominio, consumido por `observation` y por la composición | OTLP; Phoenix opcional; cualquier receptor OTLP sin tocar el dominio | encendido produce señal; apagado y caído no alteran la ejecución; éxito parcial y descartes visibles | exporter existe sin dispatcher productivo; cualquier 2xx se toma como éxito (N11) |
| 15 | Evaluación | contrato de caso, dataset, resultado, juez y productor; el registry existente como único destino | runner nativo o proceso externo; Promptfoo fuera del grafo según R15 | datos inválidos no crean versión; evidencia trazable; tokens reales contabilizados; publicación y reversión de política controladas | productor acepta artefactos inválidos (N12) |
| 16 | Procesos y sandbox | `ExecutionEnvironmentPort`; filesystem, red, recursos y terminación | proceso local con perfil honesto; contenedor u otro aislamiento opcional | un intento de escritura o de red fuera de permiso falla de verdad; la ausencia de sandbox no se vende como aislamiento | entorno del hijo construido clave a clave; sin sandbox |
| 17 | Workspace y VCS | `WorkspacePort`, `VersionControlPort`, `PublicationPort`, separados | Git CLI local; adapters externos futuros | commit vinculado a tree más receipt; un cambio de base invalida el receipt; publicación sólo por autoridad explícita | observador de Git cableado; commit sin efecto real (N03) |
| 18 | Notificaciones y relojes | puertos de entrega y de reloj; hechos durables de planificación | terminal y local; webhook o correo como adapters futuros | el fallo del aviso no congela la tarea; sin duplicados sin clasificar; los timers persisten | no existe |
| 19 | Modalidades | entrada y salida con referencias y metadata; STT, TTS y realtime como capacidades distintas | texto primero; voz, imagen, video y documentos como packs | `UNSUPPORTED` explícito; límites de formato; interrupción de voz y su costo; ninguna grabación sensible en el stream público | sólo texto |

**Superficies** (CLI, API, consola, integraciones) no son una familia de
integración: son puertas y su regla vive en
[estructura §4.3](../structure/index.md). La misma operación, la misma
autorización y la misma respuesta por cada puerta; la lectura desacoplada del
renderizado.

---

## 4. Descriptor de adapter

Un adapter se declara, no se adivina. El descriptor lleva:

```
adapter_id · adapter_version
contract_versions_supported[]
operations[]                     con sus límites
modalities[]                     con sus límites de formato y tamaño
transport · authentication
idempotency_support              NONE | KEY | HANDLE_QUERY
cancellation_support             NONE | REQUEST | TERMINATE
continuity_kind                  NONE | CHECKPOINT | LIVE_MIGRATION
evidence_profile                 qué se probó, con qué sujeto y cuándo
extensions[]                     namespaces versionados con schema
```

- **Los ids de proveedor y de adapter son abiertos y versionados.** Las
  operaciones, los errores y los estados de cada contrato siguen siendo cerrados,
  validados y exhaustivos. Convertir un `Record<string, ...>` en una unión cerrada
  de tres marcas tapa un agujero de compilación; no produce extensibilidad.
- **Las extensiones son namespaces versionados con schema**, no bolsas de JSON
  desconocido que el core ignora.
- El registro se hace en el composition root con validación fail-closed: un
  adapter cuyo descriptor no valida no se registra, y la composición lo dice.

**El manifiesto de instalación es otra cosa.** Declara qué adapters están
disponibles en esta instalación y qué contratos implementan. **No** duplica
ratings, precios ni elegibilidad: eso vive en el registry de capacidades, que es
uno solo ([datos §4](../database/index.md)).

---

## 5. Packs opcionales

Un pack agrupa una familia o una modalidad y se instala aparte. Reglas:

- Un pack puede faltar. Ausente, el producto declara `UNSUPPORTED` para lo que ese
  pack habilita y sigue funcionando.
- Un pack nuevo necesita tres cosas antes de entrar: un caso de uso real, un
  contrato que pueda satisfacer y una suite de compatibilidad.
- **No se incorporan varios frameworks equivalentes al núcleo.** Restate y Temporal
  pertenecen a la misma familia; LangGraph también persiste checkpoints y ejecuta
  grafos. Meter un grafo entero dentro de un paso durable y activar reintentos en
  las dos capas es el error que la jerarquía de [contratos §9](../contracts/index.md)
  impide.
- **Anunciar «extensible» no es lo mismo que anunciar «soportado».** Lo no
  construido queda como `extensible, no implementado`.

El primer release no debe imponer WebRTC, Temporal, LangGraph, S3 y un segundo SQL
a la vez. Cierra primero: ejecución útil, cuentas, recuperación, equipo y plan,
tools, observabilidad y pruebas.

---

## 6. SDKs dentro de un edge

Permitidos, con tres condiciones: sus tipos **no cruzan** el contrato compartido,
el costo de instalación es razonable, y el consumidor puede prescindir de ellos.
«Cero SDKs» no es un objetivo por sí mismo; «cero tipos de vendor en contratos
compartidos» sí lo es.

Hoy hay un caso a corregir: `DurableStepContext = Pick<Context, ...>` sobre el SDK
de Restate sale por un barrel público y sobrevive en el `.d.ts` emitido. El
remedio es declarar los tres miembros de forma estructural y comprobar la
conformidad con el SDK en un test del lado del driver.

La decisión R15 sobre no instalar Promptfoo en el grafo actual se mantiene y no
implica prohibir todo tooling futuro.

---

## 7. Referencias externas primarias

Consultadas el 2026-09-08. Documentan semánticas; **no** prueban las versiones
instaladas en este repositorio. Cada adapter fija su versión exacta al
implementarse.

- [Restate durable steps](https://docs.restate.dev/develop/ts/durable-steps) — el journal guarda resultados de operaciones y gobierna replay y reintentos.
- [Temporal workflow execution](https://docs.temporal.io/workflow-execution) y [activity execution](https://docs.temporal.io/activity-execution) — la historia del workflow y los reintentos de actividad son responsabilidades distintas.
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) — checkpoints y recuperación internos del grafo requieren integración explícita.
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) y [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — negociación de capacidades y errores de herramienta.
- [OTLP](https://opentelemetry.io/docs/specs/otlp/) — protocolo neutral, respuestas parciales y límites.
- [A2A specification](https://a2a-protocol.org/latest/specification/) — candidato de comunicación entre agentes externos; no integrado por este plan.
