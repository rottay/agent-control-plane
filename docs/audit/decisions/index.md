# Decisiones: mandatos, adjudicaciones y elecciones abiertas

Dueño único del concepto **decisión**: qué está resuelto, quién lo resolvió, qué
quedó explícitamente superseded, y qué sigue abierto sin bloquear el trabajo.

[Índice](../README.md) · [Arquitectura](../architecture/index.md) · [Datos](../architecture/database/index.md) · [Roadmap](../roadmap/index.md) · [Implementación](../implementation/index.md) · [Hallazgos](../findings/index.md)

Una decisión de esta página **no** es permiso para implementar, gastar cuota,
instalar nada ni publicar. Los permisos viven en
[implementación](../implementation/index.md) y los emite el owner.

---

## 1. Mandatos del owner, vigentes

| Tema | Decisión |
| --- | --- |
| Funcionalidad y neutralidad | Cumplir funciones reales con proveedores y frameworks elegibles mediante adapters; no acoplar el negocio a una marca |
| Prioridad de producto | Entregar casos de uso completos con arquitectura reemplazable; no integrar todas las herramientas ni construir adapters sin consumidor. Extensibilidad no equivale a soporte universal. [Priorización por entregables](../roadmap/index.md#11-casos-de-uso-antes-que-catálogo-de-integraciones) |
| Roles y modelos | Responsabilidades y modelos configurables y evolutivos; ninguna marca queda cableada como dueña permanente de un rol |
| Suscripciones, API y local | Mantener suscripciones, permitir clave de API y modelos locales bajo contratos reales. Que exista un login no implica soporte operativo |
| Cuentas | Identidad, cuota y renovaciones observables; continuidad al cambiar de cuenta con contexto durable; no automatizar el bypass de políticas del proveedor |
| Eficiencia | Eventos, checkpoints y contexto compacto; evitar polling intensivo y reauditorías circulares. Medir uso y latencia, no contar agentes |
| Gestión de esta implementación | Kimi K3 dirige, audita y gestiona commits; Opus implementa. Codex revisa ediciones propias de Kimi e hitos importantes. Protocolo y kickoff únicos en [coordinación](../kickoff.md); no confundir esta flota con roles configurables del producto |
| Planificación previa | Preservar lo hecho. La auditoría contrasta el cierre; no trasplanta hallazgos viejos sin verificación |
| Anatomía | Folder/index, tests espejo separados, agrupaciones semánticas, tipos por dueño y sin duplicación de conceptos |
| **Separación de tipos** | Interfaces, enums y tipos **separados** del código de implementación, dentro del concepto y su dueño, sin depósito global ([arquitectura §7](../architecture/index.md)) |
| **Normalización de datos** | Nombres de tablas y columnas coherentes, diccionario completo e invariantes exactos ([datos](../architecture/database/index.md)) |
| UI | No se implementa UI en esta ronda. Primero el diseño; el backend contempla contratos sin construir visuales ni shell de escritorio |
| Producto local | No requiere plataforma multi-tenant ni bases compartidas de Rottay. Un login futuro va desacoplado de la autorización |
| Git | Sin ramas ni worktrees nuevos; conservar `main` y su estado. No se piden commits ni publicación para este trabajo documental |
| Cutover | P9 y la adopción en repositorios de producto no autorizados. Tener un plan nuevo no habilita adoptar el control plane allí |
| Herramienta de evaluación pesada | Se conserva la decisión de no instalarla en el grafo actual; productor y runner externos con alcance explícito |
| Consolidación documental | Autorizado consolidar `docs/audit` y retirar los borradores duplicados **después** de la verificación independiente. La retirada la ejecuta el root, no este writer |

---

## 2. Adjudicaciones técnicas de esta ronda

Resueltas con evidencia, sin consultar al owner, porque son elecciones de contrato,
de test o de atomicidad. Cada una tiene su desarrollo en el documento dueño.

| # | Decisión | Dónde vive |
| --- | --- | --- |
| 1 | El dominio **no** importa el paquete de persistencia: consume su propio puerto y el entrypoint adapta | [arquitectura §2](../architecture/index.md) |
| 2 | Un puerto se declara donde está su consumidor; un contrato del kernel que ya sirve se **reutiliza**, no se duplica; una interfaz que sólo usa un edge se queda en ese edge | [arquitectura §4](../architecture/index.md) |
| 3 | El vocabulario de un vendor va a su edge, incluidos pins y puertos; el kernel recibe sólo topología neutral | [estructura §4.2](../architecture/structure/index.md) |
| 4 | Las declaraciones de tipo viven en `types/`; `vocabulary/` sólo tiene valores; la derivación cruza en un solo sentido | [arquitectura §7](../architecture/index.md) |
| 5 | Grafía única `usecases/{mutations,queries}`, sin guion | [arquitectura §5](../architecture/index.md) |
| 6 | Cuatro streams; la configuración global va al stream de registry, **sin** iniciativa sintética | [datos §4](../architecture/database/index.md) |
| 7 | Escalera de identidad: tarea, revisión, intento, segmento, efecto lógico, intento de despacho, ocurrencia | [datos §6](../architecture/database/index.md) |
| 8 | La preimagen del envelope cubre **todos** los campos del contrato; el reloj y la cuenta quedan fuera | [datos §6.2](../architecture/database/index.md) |
| 9 | No existe hecho de costo independiente: el costo es un snapshot derivado con revisión de valuación | [datos §13](../architecture/database/index.md) |
| 10 | La identidad de bytes y la de acceso son distintas; compartir digest no concede permiso | [datos §12](../architecture/database/index.md) |
| 11 | La integridad del stream de cuentas se agrega por sidecar con baseline explícito, **sin** reescribir migraciones | [datos §9](../architecture/database/index.md) |
| 12 | La garantía de durabilidad se declara por perfil; SIGKILL no prueba pérdida de energía | [datos §10](../architecture/database/index.md) |
| 13 | `NO_COMMIT` permite editar dentro del write-set; `READ_ONLY` permite estado interno del plane | [contratos §12](../architecture/contracts/index.md) |
| 14 | Un efecto de desenlace desconocido no se reintenta: se reconcilia | [contratos §7](../architecture/contracts/index.md) |
| 15 | La habilitación operativa del commit exige el mínimo de recuperación | [contratos §12](../architecture/contracts/index.md) |
| 16 | `UNKNOWN` no es `0` en la rúbrica, y las compuertas críticas no se compensan con promedios | [calidad §1](../quality/index.md) |
| 17 | Se retiran como criterios: la relación numérica carpetas/archivos, la lista negra universal de nombres y el `grep` de marca como prueba semántica | [calidad §2](../quality/index.md) |
| 18 | Los objetivos numéricos de release quedan **fijados ahora** como objetivos de diseño, con perfil y carga; el implementador no los inventa ni los ajusta después del resultado | [tests §9](../quality/testing/index.md) |
| 21 | Contrato de contenido v1 y contrato de resultado v1 congelados; error de herramienta produce resultado fallido aunque el transporte responda bien | [contratos §4](../architecture/contracts/index.md) |
| 22 | `COMPLETED` es el terminal exitoso; `NO_COMMIT` termina en `COMPLETED` sin fabricar un commit | [contratos §2.1](../architecture/contracts/index.md) |
| 23 | La admisión ejecutable **rechaza** verificador o auditor igual al writer por identidad emitida por el supervisor; el mismo proveedor sólo produce una recomendación | [contratos §5](../architecture/contracts/index.md) |
| 24 | La idempotencia de sumisión es por clave del cliente; el digest del envelope es una precondición comparada, no parte de la clave | [contratos §15](../architecture/contracts/index.md) |
| 25 | El ledger y un coordination store no comparten transacción: lo atómico es la intención, y el acuse se reconcilia por saga | [datos §11](../architecture/database/index.md) |
| 26 | Un solo registry de modelos, propiedad de `accounts`; `economy` lo referencia por identificador y digest | [datos §4](../architecture/database/index.md) |
| 19 | La suite completa no se corre hasta aislar los tests que escriben el checkout vivo | [tests §5](../quality/testing/index.md) |
| 20 | Una familia se anuncia **intercambiable** sólo con dos implementaciones reales conformes; **funcional** admite una | [integraciones §2](../architecture/integrations/index.md) |
| 27 | Aceptar la revisión K3 con correcciones, preservando arquitectura y alcance; el root adjudica, los reviewers no gobiernan ni editan el canon | [revisión independiente](../evidence/review/index.md) |
| 28 | Compatibilidad por operación, responsabilidad, recurso y scope; selección explícita, snapshot inmutable y evidencia específica antes de binding/dispatch | [composición](../architecture/integrations/composition/index.md) |
| 29 | Preservar vocabularios originales de capacidades y estados legacy; evaluación neutral e historia etiquetada, sin coerciones a éxito/soporte | [contratos §2.0–2.2](../architecture/contracts/index.md) |
| 30 | El ledger admite la cuota incluyendo débitos pendientes; arbiter concede slot. Liberarlo no borra gasto sin observación reconciliada | [cuentas §4](../architecture/database/accounts/index.md) |
| 31 | Outbox anclada a stream/secuencia/hash de un sujeto real; CAS por row_version, estado y encarnación. No hay tarea SYSTEM ni segundo outbox | [coordinación §6](../architecture/database/coordination/index.md) |
| 32 | Un requisito tiene un packet primario y un hito de aceptación; entregas internas no aumentan porcentajes ni sustituyen gates | [correspondencia](../implementation/packets/requirements/index.md) |
| 33 | Cortes de identidad, artefactos, catálogo, captura y admisión preceden a sus consumidores; desarrollo no equivale a habilitación | [paralelismo](../roadmap/parallelism/index.md) |
| 34 | Un invocador CLI opaco puede ser funcional en su frontera probada; no se le adjudican control de retries internos, hard cap o telemetría inexistentes | [composición §7](../architecture/integrations/composition/index.md) |
| 35 | El puente documental utiliza ADR sucesor y conserva el cuerpo histórico congelado; no cambia la ley durante la auditoría para autoaprobarse | [migración](../implementation/migration/index.md) |
| 36 | Estimaciones y desempeño fijan política, cohorte y vector de fuentes; UNKNOWN se propaga por dependencias y recursos. Simular no consume cuota ni ejecuta modelos | [estimación](../architecture/contracts/estimation/index.md) |
| 37 | Avisos locales reutilizan outbox y sujeto reales; recepción durable no significa lectura humana. Rate y reloj sobreviven a replay y a cambios de policy | [interacción §2](../architecture/contracts/interaction/index.md) |
| 38 | Espera humana con plazo/CAS y cota temporal durable; grant sólo habilita revalidación, aviso/timer no conceden permiso | [interacción §3](../architecture/contracts/interaction/index.md) |
| 39 | Duelo QUALITY_ONLY compara dos tareas READ_ONLY/NO_COMMIT con árbitro independiente; costo UNKNOWN visible no impide ganador técnico ni acredita ventaja económica | [interacción §4](../architecture/contracts/interaction/index.md) |
| 40 | Anomalías reutilizan la estadística de estimación; detección, intención y confirmación son distintas. No repausar ni ampliar autoridad por detecciones repetidas | [interacción §5](../architecture/contracts/interaction/index.md) |
| 41 | `task_revision_read_model` nace sin `envelope_artifact_reference_id`: la columna la agrega P-36/local por `ADD COLUMN` + trigger `BEFORE INSERT` por cohorte de `contract_version` + clave en el payload del evento de revisión; `NULL` en toda revisión anterior; **nunca** se inventa una referencia por digest | [execution §2](../architecture/database/execution/index.md); ADR de P-05/B |
| 43 | El tope de 10.000 intentos acumulados por tarea se mantiene y el CAS lo conoce: el desborde es un rechazo tipado documentado, nunca un overflow opaco; una tarea que agota la cota se resuelve con una tarea nueva | [ejecución §3](../architecture/database/execution/index.md); ADR 0073 |
| 42 | El namespace `v2/` y la composición de la clave V2 viven en `@acp/contracts`, no en `@acp/ledger` — revisa el emplazamiento que declaró P-05/B («el separador se declara acá y en ningún otro lado»): un namespace es gramática de la clave, y la clave es del contrato. El ledger lo importa; el literal queda en un solo archivo `src`. La puerta es **estricta**: coordenada V2 completa en el payload ⇔ clave V2; sin coordenada ⇔ clave V1, y ninguna otra forma pasa — un productor no cambia de namespace para convertir un conflicto en un hecho nuevo | [streams §1.1](../architecture/database/streams/index.md); [ADR 0072](../../architecture/0072-the-v2-key-composes-at-the-contract.md) |
| 44 | El outbox **no deriva** `command_id`: la clave es determinista por `(saga_id, phase, target_kind, target_id)` y la computa el productor en P-18/F, mientras el store impone `UNIQUE` y nada más — un store que la derivara tendría gramática de saga, y la gramática de una clave es del contrato (mismo reparto que la decisión 42). Si resulta ser gramática, F la emplaza en `@acp/contracts`; E2 no lo prejuzga y un test fija que el store no deriva la clave | [coordinación §6](../architecture/database/coordination/index.md); [ADR 0074](../../architecture/0074-the-outbox-is-a-store-with-a-version.md) |
| 45 | `last_failure_code` es `TEXT` **sin CHECK**: el vocabulario tipado vive en [contratos §16](../architecture/contracts/index.md) y lo impone el escritor (P-18/F), no el esquema. Un CHECK acoplaría una migración inmutable de `outbox.sqlite` a un catálogo que no lo es, y cada crecimiento del catálogo sería una migración de esta base. El costo queda declarado: hasta que F escriba, nada impide a un escritor directo guardar un código que §16 no define — una sola columna, nombrada, con dueño | [coordinación §6](../architecture/database/coordination/index.md); [ADR 0074](../../architecture/0074-the-outbox-is-a-store-with-a-version.md) |
| 46 | El retrofit de `worktree_lease` que pide [coordinación §3](../architecture/database/coordination/index.md) `:90-107` —validadores `BEFORE INSERT`/`BEFORE UPDATE` y CAS por token esperado con los cuatro casos de la regla de fence— es **packet propio**, con destino declarado. E1 hace sólo lo aditivo: `coordination_store_meta`, `store_incarnation_id`, y `operation_id`/`revocation_acknowledged_at` como columnas que ningún verbo del store escribe. La aritmética del fence no cambia: un retrofit que moviera la semántica del fence tocaría a C2/C3/C4, que este escalón no puede abrir | [coordinación §3](../architecture/database/coordination/index.md); [ADR 0075](../../architecture/0075-every-coordination-store-names-its-own-incarnation.md) |
| 47 | La autoridad de identidad de un archivo de coordinación es su `store_kind`, **no el nombre del archivo**: [coordinación §1](../architecture/database/coordination/index.md) dice `worktree-leases.sqlite` y el árbol dice `leases.sqlite`, y ninguno se renombra. Renombrar el archivo de un árbitro vivo cuesta vivacidad y no compra nada; lo que se comprueba en `open` es el kind declarado, contra el diccionario de cinco de §8.1. Por eso el CHECK carga los cinco kinds y no sólo el propio: estrechado a uno, el rechazo del kind ajeno sería inconstruible, y una guardia que nadie puede ejercitar no es una guardia | [coordinación §8.1](../architecture/database/coordination/index.md); [ADR 0075](../../architecture/0075-every-coordination-store-names-its-own-incarnation.md) |
| 48 | `CONTRACT_VERSION` pasa a `"2.3.0"` en P-18/protocolo C, y la regla de admisión es **«se emite sólo la vigente»**: `SUPPORTED_CONTRACT_VERSIONS` (lectura) queda en `["2.2.0", "2.3.0"]` y `"2.2.0"` se queda para siempre, mientras `AdmittedContractVersion` (emisión) pina la vigente en los tres shapes que el ADR 0072 nombró —`TaskEnvelope`, `WorkerSlot`, `CommitAuthorizationReceipt`— y en la puerta de append del ledger para una inserción **nueva**. La exención es el replay exacto: un evento ya registrado, reenviado idéntico, devuelve su registro sin llegar al chequeo. `ControlPlaneEvent` conserva el set de lectura a propósito, porque es el schema con el que el ledger re-parsea cada fila almacenada. El criterio por el cual C porta el bump y B no: los payloads de C llevan digests que el fold verifica y una versión de contrato propia por payload, es decir historia cuya reconstrucción depende de preimágenes nuevas. Consecuencia declarada (V3): `envelope_sha256` difiere para el mismo trabajo emitido antes y después, y los vectores pineados de `envelope-identity` se mueven con el fixture | [streams §1.1](../architecture/database/streams/index.md); [ADR 0072](../../architecture/0072-the-v2-key-composes-at-the-contract.md); [ADR 0076](../../architecture/0076-an-effect-is-looked-up-by-its-logical-key.md) |
| 49 | Las ocurrencias de [ejecución §8](../architecture/database/execution/index.md) llegan en P-18/protocolo D con **dos** tipos de evento, `PROMPT_OCCURRENCE_RECORDED` y `RESPONSE_OCCURRENCE_RECORDED`, porque la respuesta tiene PK, instante y secuencia propios y puede llegar tardía. `prompt_sha256` no es único y `dispatch_attempt_id` es FK no única: los mismos bytes enviados dos veces son dos ocurrencias y un solo digest. El `ordinal` lo asigna el ledger (uno más que el mayor del segmento, `0` si no hay), `identity` es el `emittedBy` del evento, el cuarteto de modelo viaja en el payload del prompt y `REDACTION_VERDICTS` vive en `@acp/ledger` (clase de la decisión 45). Los tres digests se **conservan sin recomputar**: sus preimágenes son los bytes que §8 `:433` deja fuera. Los payloads son cerrados, y la respuesta no puede nombrar despacho, segmento ni cuenta: se atribuye sólo por su prompt, y su coordenada V2 es la del prompt. `prompt_record_read_model` nunca existió en este árbol. **Sin bump**: D agrega hechos (digests conservados, conteos, vocabulario) y ninguna fórmula de identidad, que es el criterio del ADR 0076 para portar el bump; `CONTRACT_VERSION` sigue `"2.3.0"` | [ejecución §8](../architecture/database/execution/index.md); [streams §1.1](../architecture/database/streams/index.md); [ADR 0076](../../architecture/0076-an-effect-is-looked-up-by-its-logical-key.md); [ADR 0077](../../architecture/0077-a-prompt-occurrence-is-a-use-never-a-blob.md) |
| 50 | `CONTRACT_VERSION` pasa a `"2.4.0"` en P-18/protocolo F y `SUPPORTED_CONTRACT_VERSIONS` queda en `["2.2.0", "2.3.0", "2.4.0"]`, con la misma regla de la decisión 48: se emite sólo la vigente, el replay exacto está exento y `"2.3.0"` se lee para siempre. El criterio del ADR 0076 da a favor por sus dos brazos: la puerta **y** el fold recomputan `command_id` sobre una preimagen nueva, y cada payload de outbox lleva `outboxContractVersion`. La preimagen se fija como `OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 + canonicalJson([sagaId, phase, targetKind, targetId])` con el prefijo en `@acp/contracts` y el cómputo en `@acp/ledger` —el lugar que la decisión 44 anticipó «si resulta gramática»—. La causalidad viaja sólo en `CausationRef`, nunca como digest en el payload. Consecuencia V3 declarada otra vez: los vectores de `envelope_sha256` se mueven con el fixture | [coordinación §6](../architecture/database/coordination/index.md); [datos §11](../architecture/database/index.md); [ADR 0076](../../architecture/0076-an-effect-is-looked-up-by-its-logical-key.md); [ADR 0078](../../architecture/0078-a-command-intention-commits-with-its-quarantine.md) |
| 51 | Dentro del ledger la cuarentena y la intención `REVOKE_LEASE` son atómicas: la intención se admite sólo inmediatamente después de un evento de cuarentena (`WRITE_SET_VIOLATION_DETECTED` o `TASK_STATE_CHANGED → SUSPECT_WORKTREE`) de la misma tarea **insertado por la misma transacción**, y dentro de `appendBatch` un lote que mueve una tarea a `SUSPECT_WORKTREE` sin su intención se revierte entero. El `append` unitario de ese movimiento queda como **ventana legacy declarada** en un solo sitio, el gate de conformance del daemon (`daemon/src/composition/ports`), que hoy registra la violación en tres transacciones; `L-P18F-1` lo nombra y falla ante un segundo sitio, y la cierra la adopción, no este packet. `LEASE_REVOKED` no integra el lote: dentro de la transacción del ledger nada ocurrió todavía en el arbiter | [contratos §13](../architecture/contracts/index.md); [datos §11](../architecture/database/index.md); [ADR 0078](../../architecture/0078-a-command-intention-commits-with-its-quarantine.md) |
| 52 | `worktree_lease` gana los dos verbos de [coordinación §3](../architecture/database/coordination/index.md) `:96-97`: `REVOKE { at, operationId }` exige lease vivo, asigna `fence = OLD.fence + 1`, despeja la titularidad y estampa `operation_id`; `ACKNOWLEDGE_REVOCATION { at }` exige una fila revocada sin acuse y **conserva** el fence. `LeaseGrant.operationId` es opcional y lo estampa `GRANT`, que además despeja un acuse previo; `RELEASE` y `sweep` de un grant **vivo** despejan `operation_id`, para que una fila liberada nunca pase por revocada. La aritmética del fence gana ese caso; los validadores y el CAS por token de la decisión 46 siguen siendo packet propio | [coordinación §3](../architecture/database/coordination/index.md); [ADR 0075](../../architecture/0075-every-coordination-store-names-its-own-incarnation.md); [ADR 0078](../../architecture/0078-a-command-intention-commits-with-its-quarantine.md) |
| 53 | El vocabulario de `last_failure_code` es `OUTBOX_FAILURE_CODES`, cerrado en seis palabras (`TARGET_REFUSED`, `TARGET_STALE_TOKEN`, `TARGET_INCARNATION_MISMATCH`, `TARGET_UNAVAILABLE`, `DEADLINE_EXCEEDED`, `NOT_DISPATCHED_PROVEN`), declarado en `@acp/contracts` junto a los tres tipos e impuesto **al escribir** por la puerta de `OUTBOX_DELIVERY_OBSERVED`: obligatorio con `FAILED_RETRYABLE` y `FAILED_TERMINAL`, admitido con `ABANDONED`, rechazado con cualquier otro estado. Es el `code` del registro de [contratos §16](../architecture/contracts/index.md) para `origin ∈ {DURABILITY, EXECUTION}` y `phase ∈ {DISPATCH, RECOVERY}`; el mapa exhaustivo de §16 es packet posterior y la columna de E2 sigue guardando `TEXT` (decisión 45) | [contratos §16](../architecture/contracts/index.md); [ADR 0074](../../architecture/0074-the-outbox-is-a-store-with-a-version.md); [ADR 0078](../../architecture/0078-a-command-intention-commits-with-its-quarantine.md) |
| 54 | F **registra y pliega**; no construye reconciliador ni dispatcher, que son de P-18/recuperación. Quedan como reglas vinculantes para ellos: (O-2) un `INFLIGHT` vencido **sin ancla** sale a `FAILED_RETRYABLE`, no a `RECONCILING`, porque sin intento durable no hubo despacho; (O-3) un rechazo de trigger del outbox es excepción `LedgerQueryError`, no un cuarto verbo, y nunca se lee como éxito ni como motivo de reenvío; y una cache reconstruida escribe un intento sin desenlace como `RECONCILING`, conservando ancla y encarnación del destino. El fold de F pliega un intento sin observación a `RECONCILING`, nunca `PENDING` ni `INFLIGHT`, y las fronteras de crash 1-3 se prueban en proceso; la matriz SIGKILL es del perfil certificado | [coordinación §2 y §6](../architecture/database/coordination/index.md); [testing §7 y §10](../quality/testing/index.md); [ADR 0078](../../architecture/0078-a-command-intention-commits-with-its-quarantine.md) |
| 55 | **Un desenlace conocido se reutiliza, nunca se reentrega** (CORR-2): la puerta de despacho refusa `DISPATCH_INTENDED` sobre un efecto cuyo `outcome_status` no es nulo, los cuatro valores. `OUTCOME_UNKNOWN` conserva su rechazo y su texto; `SUCCEEDED`, `FAILED` y `CANCELLED` refusan con el mensaje terminal en `payload.dispatch.effectId`, **sin excepción** para `FAILED` ni `CANCELLED` —reintentar uno sería decisión escrita del owner, no default—. La guardia lee el desenlace del efecto y no el estado de las entregas: tras una entrega `ABANDONED`, o `SETTLED` sin desenlace, la siguiente se admite, y el replay exacto de la primera sigue siendo replay. Sólo puerta, con el precedente de O-1: el fold no cambia; sin contrato, migración ni versión | [ejecución §6.1](../architecture/database/execution/index.md); [ADR 0076](../../architecture/0076-an-effect-is-looked-up-by-its-logical-key.md); [ADR 0079](../../architecture/0079-a-known-outcome-is-reused-and-a-present-invalid-word-is-refused-by-name.md) |
| 56 | **Presente-inválido no es ausente** (CORR-2): `dispatchOutcomeRecord` devuelve la unión rechazante `DispatchOutcomeReading` (forma de `OccurrenceReading`, escalón D) y cada uno de los cuatro campos opcionales de una resolución —`effectOutcomeStatus`, `acceptedAt`, `externalHandle`, `providerIdempotencyKey`— se lee de tres maneras: clave ausente → `null`; valor legal (palabra de `EFFECT_OUTCOME_STATUSES` o texto no vacío) → el valor; cualquier otro valor presente —palabra fuera del vocabulario, número, objeto, cadena vacía o `null` JSON **explícito**— → rechazo en `payload.outcome.<campo>`, con el valor mostrado sólo vía `printable` y nunca como bytes arbitrarios. La puerta y `applyEventToSnapshot` lanzan el mismo issue, así que un historial plantado falla el rebuild con las palabras de la puerta. Un payload que no constituye resolución sigue leyéndose `null`. Los tipos de valor de la era P-18 pasan a hojas de tipos puras del concepto dueño (`src/projection/types`, `src/outbox-store/types`), re-exportadas sin cambio de imports | [ejecución §6 y §7](../architecture/database/execution/index.md); [ADR 0077](../../architecture/0077-a-prompt-occurrence-is-a-use-never-a-blob.md); [ADR 0079](../../architecture/0079-a-known-outcome-is-reused-and-a-present-invalid-word-is-refused-by-name.md) |

---

## 3. Diseño explícitamente superseded

Se lista para que nadie lo reintroduzca creyendo que sigue vigente.

| Idea | Motivo del retiro |
| --- | --- |
| Factories obligatorias de cero argumentos | favorecen globals ocultos; inyección explícita en el composition root |
| Mudanza atómica masiva del árbol como prerequisito | bloquea entregar función útil; la anatomía se aplica por funcionalidad |
| «Un caso de uso, un archivo» como ley | produce archivos gigantes o abstracciones prematuras |
| Artefactos sin límite y vault sin borrado | contradice almacenamiento acotado; retención por clase y tombstone explícito |
| «Nada sale de la máquina» | falso en un producto que usa modelos y telemetría externos; egress explícito y mínimo |
| El journal del motor durable es una cache descartable | retirar su estado sin exportar timers, señales y efectos pierde continuidad |
| Enum cerrado de proveedores como mecanismo de extensibilidad | totalizar un `Record` es higiene; la extensibilidad es un descriptor validado |
| Estado real de una cuenta y prorrateo contable como una sola medida | son dos cosas; una decide admisión, la otra factura |
| Congelar la expansión del motor externo equivale a resolver la recuperación | son problemas separados: uno es alcance, el otro es corrección del journal |
| Roles de staffing dinámico de producto = staffing de agentes de este repositorio | son dos vocabularios distintos y no se mezclan |
| Ratio carpetas/archivos, lista negra universal y `grep` de marca como criterios de calidad | miden forma, no responsabilidad ([calidad §2](../quality/index.md)) |
| Estados de cuenta `READY` y `DRAINED` como nombres nuevos | el enum real es `AVAILABLE`, `DRAINING`, `EXHAUSTED`, `COOLDOWN`, `AUTH_REQUIRED`; se preserva y se mapea, no se inventan alias |

---

## 4. Elecciones abiertas, sin bloquear el trabajo

Cada una nombra **cuándo** deja de poder postergarse. Ninguna impide abrir el
primer packet.

| Elección | Recomendación inicial | Cuándo hay que resolverla |
| --- | --- | --- |
| Cambiar de proveedor en un run activo | tarea o iniciativa nueva, y reanudar desde un checkpoint compatible; un run activo conserva su driver hasta una frontera segura | antes de prometer migración transparente de runs activos. Se consultó al owner; sin respuesta no se presume migración en caliente |
| Segundo motor externo | mantener el actual; evaluar un segundo si aporta un perfil concreto. El supervisor local debe cumplir lo que anuncia | antes del packet que agregue un motor nuevo; no hace falta instalarlo para cerrar los hallazgos actuales |
| Perfil de proveedores del primer release | un CLI de suscripción operativo más una ruta de API y una local reales; el resto explícitamente no soportado hasta su conformidad | antes del smoke real y de la matriz de integraciones; exige elegir cuenta y límite de consumo |
| Segundo backend de datos | definir puerto y migraciones desde ahora; elegir el motor adicional por necesidad real | antes de anunciar intercambio de base a usuarios |
| Login local, escritorio y comercial | operador local primero; identidad federada sólo detrás de un adapter | en el diseño de distribución; no bloquea el backend local |
| Audio, voz, imagen, retrieval y comunicación entre agentes | contratos extensibles y perfiles separados; priorizar un caso real | antes del pack respectivo; audio en tiempo real necesita diseño propio |
| Adapters de terceros instalables | packs auditables y versionados con permisos explícitos; no ejecutar plugins arbitrarios dentro del dominio | antes de distribuir plugins |
| Recibos históricos ausentes | revalidar retrospectivamente o exceptuar con una lista nombrada | antes de la certificación; es decisión del owner, no del writer |
| Conflictos históricos de versión de cuenta, si el preflight los encuentra | resolver caso por caso y registrar aquí; **nunca** deduplicar en silencio | durante la migración de integridad de cuentas |
| Verificación de los objetivos numéricos de release | los números **ya están fijados** como objetivos de diseño en [tests §9](../quality/testing/index.md), con su perfil y su carga. Lo que falta es medirlos y aceptarlos | antes de la certificación. **Un objetivo no se redefine después de una corrida**: cambiarlo es una decisión previa, versionada y con motivo |

**No se pide al owner que resuelva cada detalle técnico.** Se le pide decisión
cuando cambia el alcance del producto, el gasto, las credenciales, la publicación o
el acceso a repositorios fuera de este.

---

## 5. Relación entre el programa anterior y esta especificación

El programa anterior alcanzó un registro acotado con siete criterios y cinco
deudas declaradas; su checker tiene contraejemplos que corregir. Esta fase **no**
vuelve a marcar todo en cero: reutiliza lo acreditado y mantiene las deudas
explícitas.

Tres clases de trabajo, deliberadamente separadas:

1. **Correcciones de garantías existentes:** identidad, contenido perdido, éxito
   falso, replay, evidencia, privacidad y tests inseguros.
2. **Ensamblaje pendiente:** clientes compuestos, checkpoints leídos, cuentas,
   daemon residente, exporter conectado y flujo completo.
3. **Funcionalidades ampliadas:** planificación y economía, registry de
   integraciones y packs de proveedores y frameworks.

Esta separación evita la confusión anterior entre terminar un programa de leyes,
certificar un producto y agregar casos de uso nuevos.
