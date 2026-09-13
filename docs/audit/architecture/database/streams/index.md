# Streams: diccionario físico

Dueño: los cuatro streams, `ledger_meta`, `schema_migrations`, `projection_watermark`,
`account_event_integrity`, perfil de campos comunes de evento.

Reglas transversales (tipos, dominios, JSON, causalidad, migración, invariantes) viven
en [../index.md](../index.md) y no se repiten acá. Esta hoja sólo declara columnas,
claves, índices, frontera transaccional y reconstrucción.

Estado de base inspeccionada: `a92756b`, migraciones 1–6 aplicadas y con checksum
(`packages/persistence/ledger/src/migrations/index.ts`). Lo marcado **Hoy** es el DDL
exacto aplicado, inmutable en su texto de migración. Lo marcado **Aditivo** es una
columna o índice nuevo agregado por una migración ≥7 sin tocar el DDL de una migración
aplicada. Lo marcado **Nuevo** no existe hoy.

---

## 0. Perfil de campos comunes de evento (`event_common_fields`)

Se enumera una sola vez acá. `control_plane_events`, `initiative_events` y
`account_events` heredan un subconjunto según su estado de aplicación (ver §1–3);
`registry_events`, por ser stream nuevo, lo implementa completo desde su primera
migración.

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `sequence` | INTEGER | NOT NULL | `AUTOINCREMENT` | PK física del stream; orden total dentro del stream, no comparable entre streams. |
| `event_id` | TEXT | NOT NULL | — | Identidad de la sumisión; `UNIQUE`. |
| `idempotency_key` | TEXT | NOT NULL | — | Clave de idempotencia de admisión; `UNIQUE`. Preimagen exacta por stream en la hoja dueña de la semántica (`execution`, `planning`, `accounts`). |
| `transition_id` | TEXT | NOT NULL | — | Identificador de la transición que produjo el evento. |
| `type` | TEXT | NOT NULL | — | Vocabulario cerrado por stream; catálogo en la hoja dueña de la semántica. |
| `emitted_by` | TEXT | NOT NULL | — | Identidad del emisor. |
| `occurred_at` | TEXT | NOT NULL | — | ISO-8601 ms UTC, forma canónica + validador de calendario en el borde. |
| `recorded_at` | TEXT | NOT NULL | — | ISO-8601 ms UTC; instante de append, siempre `>= occurred_at`. |
| `causation_stream` | TEXT | NULL | — | **Aditivo/Nuevo.** Uno de `control_plane_events \| initiative_events \| account_events \| registry_events`. `NULL` cuando el evento no tiene causa registrada dentro del sistema (primer evento de una cadena, o disparado por una entrada externa sin evento previo — p. ej. una acción del owner). |
| `causation_sequence` | INTEGER | NULL | — | **Aditivo/Nuevo.** `NOT NULL` si y sólo si `causation_stream` no es `NULL`; impuesto por `ck_`. |
| `causation_sha256` | TEXT | NULL | — | **Aditivo/Nuevo.** Digest del evento causante; mismo `ck_` de forma que `event_sha256`. `NOT NULL` si y sólo si `causation_stream` no es `NULL`. Un digest que no coincide contra `(causation_stream, causation_sequence)` es una referencia inválida, no un enlace débil (§5 canónico). |
| `contract_version` | TEXT | NOT NULL | — | Versión del contrato que interpreta `event_json`. |
| `event_json` | TEXT | NOT NULL | — | JSON canónico, acotado en bytes, payload del evento. Nunca prompt, respuesta, argumento de tool ni credencial. |
| `previous_sha256` | TEXT | NOT NULL | — | Encadenamiento hash dentro del stream. |
| `event_sha256` | TEXT | NOT NULL | — | `UNIQUE`. `CHECK (length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*')`. |

`ck_<tabla>__causation_pair`: `CHECK ((causation_stream IS NULL) = (causation_sequence IS NULL) AND (causation_stream IS NULL) = (causation_sha256 IS NULL))`.

---

## 1. `control_plane_events`

**Hoy** (migración 1, inmutable). Sujeto: una tarea. Contexto dueño de la semántica de
`type`/`event_json`: `runtime`/`execution` (ver [execution](../execution/index.md)).

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `sequence` | INTEGER | NOT NULL | `AUTOINCREMENT` | PK. |
| `event_id` | TEXT | NOT NULL | — | `UNIQUE`. |
| `idempotency_key` | TEXT | NOT NULL | — | `UNIQUE`. |
| `task_id` | TEXT | NOT NULL | — | Sujeto del stream. |
| `attempt` | INTEGER | NOT NULL | — | **Legacy, congelado y `NOT NULL`.** Coordenada `(task_id, attempt)` sólo válida para eventos ya escritos con esta forma. Una fila V2 **igual debe poblarla**: lleva su `legacy_attempt_number` asignado (§1.1). |
| `revision_number` | INTEGER | NULL | — | **Aditiva V2, aplicada en migración 11.** `NULL` sólo en filas legacy. En una fila V2 es `NOT NULL` y `> 0`, y **coincide con el valor del `event_json`**. Todavía **sin productor**: ninguna fila V2 existe hasta P-18. |
| `attempt_number` | INTEGER | NULL | — | **Aditiva V2, aplicada en migración 11.** `NULL` sólo en filas legacy. En una fila V2 es `NOT NULL` y `> 0`, y **coincide con el valor del `event_json`**. Presente **junto con** `revision_number`: las dos o ninguna. Sin productor hasta P-18. |
| `transition_id` | TEXT | NOT NULL | — | Perfil común. |
| `type` | TEXT | NOT NULL | — | Catálogo en [execution](../execution/index.md). |
| `from_state` | TEXT | NULL | — | `NULL` en el evento que abre la tarea. |
| `to_state` | TEXT | NOT NULL | — | Estado resultante. |
| `emitted_by` | TEXT | NOT NULL | — | Perfil común. |
| `occurred_at` | TEXT | NOT NULL | — | Perfil común. |
| `recorded_at` | TEXT | NOT NULL | — | Perfil común. |
| `correlation_id` | TEXT | NULL | — | **Legacy.** Referencia libre pre-existente; no se retira. Para causalidad verificable se usa la tripleta tipada (siguiente fila), no ésta. |
| `causation_id` | TEXT | NULL | — | **Legacy.** Igual tratamiento que `correlation_id`. |
| `causation_stream` | TEXT | NULL | — | **Aditivo** (migración ≥7, `ALTER TABLE ... ADD COLUMN`, precedente: migración 4 sobre `task_read_model`). Sólo poblado por eventos escritos después de la migración aditiva. |
| `causation_sequence` | INTEGER | NULL | — | **Aditivo.** |
| `causation_sha256` | TEXT | NULL | — | **Aditivo.** |
| `contract_version` | TEXT | NOT NULL | — | Perfil común. |
| `event_json` | TEXT | NOT NULL | — | Perfil común. |
| `previous_sha256` | TEXT | NOT NULL | — | Perfil común. |
| `event_sha256` | TEXT | NOT NULL | — | `UNIQUE`. **Sin `CHECK` de forma en el DDL aplicado** (migración 1: sólo `NOT NULL UNIQUE`, verificado contra el SQL fuente). No etiquetar esto como si el `CHECK` correcto de §0 ya rigiera hoy — SQLite no soporta `ALTER TABLE ... ADD CONSTRAINT`, así que la forma correcta se impone hacia adelante con un trigger `BEFORE INSERT` (siguiente fila de índices/triggers), no reescribiendo la tabla. |

### Índices, triggers, OCC, transacción, rebuild

| Objeto | Forma | Nota |
| --- | --- | --- |
| `control_plane_events_by_task` | `INDEX (task_id, sequence)` | Legacy, nombre congelado. |
| `control_plane_events_by_type` | `INDEX (type, sequence)` | Legacy. |
| `control_plane_events_by_emitter` | `INDEX (emitted_by, sequence)` | Legacy. |
| `control_plane_events_by_to_state` | `INDEX (to_state, sequence)` | Legacy. |
| `control_plane_events_by_occurred_at` | `INDEX (occurred_at, sequence)` | Legacy. |
| `control_plane_events_deny_update` | `TRIGGER BEFORE UPDATE ... RAISE(ABORT)` | Legacy. Inventario de objetos lo verifica al abrir. |
| `control_plane_events_deny_delete` | `TRIGGER BEFORE DELETE ... RAISE(ABORT)` | Legacy. |
| `tr_control_plane_events__validate_new_rows` | **Aditivo.** `TRIGGER BEFORE INSERT` que valida forma de `event_sha256`/`previous_sha256` (§0) y el par `causation_*` en toda fila **nueva**; no valida ni corrige filas históricas ya escritas sin esa forma comprobada. | Sustituto de un `CHECK` que SQLite no permite agregar a una tabla existente. |
| `tr_control_plane_events__validate_v2_coordinate` | **Aditivo, aplicado en migración 11.** `TRIGGER BEFORE INSERT`: `revision_number` y `attempt_number` son ambos `NULL` o ambos `NOT NULL` y `> 0`; cuando no son `NULL`, coinciden con los valores del `event_json`; y `attempt` sigue poblado. Impone además la **dirección inversa**: un `event_json` con claves V2 y columnas ausentes o distintas rechaza — sin eso, la coordenada podría quedar sólo en el cuerpo y la fila leerse como legacy para siempre. | §1.1 |
| OCC | `UNIQUE(event_id)`, `UNIQUE(idempotency_key)`, `UNIQUE(event_sha256)` | Un reintento con la misma clave de idempotencia no duplica fila. |
| Transacción | `appendBatch`: cabeza (`ledger_meta.head_*`) + fila(s) + proyección afectada + intención de outbox, una sola transacción `BEGIN IMMEDIATE` (§11 canónico). | |
| Rebuild | No aplica: es autoridad, nunca se borra ni reconstruye. | |

### 1.1 La coordenada V2 sobre un stream que no se puede reescribir

La migración 1 es inmutable y `attempt` es `NOT NULL`. Una tarea con revisiones e
intentos no cabe en un entero plano, y sin embargo cada fila nueva tiene que
poblarlo. La resolución, decidida:

**Columnas aditivas.** `revision_number` y `attempt_number` se agregan por
`ALTER TABLE ... ADD COLUMN` en una migración ≥ 7. Son `NULL` **sólo** en las filas
legacy. En una fila V2 están las dos, son positivas, y **coinciden con el
`event_json`**: el trigger lo comprueba, de modo que la columna y el payload no
pueden divergir.

**`legacy_attempt_number`.** A cada coordenada nueva `(task_id, revision_number,
attempt_number)` se le asigna, **una sola vez**, un entero plano y monótono por
tarea, que es el valor que va en la columna legacy `attempt`.

- La asignación se registra en el evento y se proyecta en
  `task_attempt_read_model` con
  `ux_task_attempt_read_model__task_id_legacy_attempt_number`
  (ver [execution](../execution/index.md)).
- Una repetición **reutiliza** la asignación existente mediante `compare-and-set`
  sobre la proyección. **Nunca se deriva del reloj** y nunca se reinicia.
- Reiniciar la numeración de intentos dentro de una revisión nueva **no** colisiona,
  porque `legacy_attempt_number` es monótono por tarea y no por revisión.

**Identidad mínima de ejecución, P-18/M4.** El evento de apertura V2 del intento
registra invocationId junto con su coordenada completa y legacy_attempt_number;
la proyección exige UNIQUE(invocation_id). No deriva un segundo run del worker
ni del engine. La intención de efecto registra semanticScopeKey,
localOperationKey, logicalOperationSha256, requestContractVersion y requestSha256;
el evento de intención de dispatch registra routeSegmentId efectivo, y la
ocurrencia de prompt registra dispatchAttemptId. Sus schemas, preimágenes y
checks pertenecen únicamente a [execution §§3/6/7/8](../execution/index.md).
Los payloads nuevos tienen versión contractual explícita; valores y referencias
coinciden con sus columnas proyectadas. No son eventos nuevos de composición:
P-18 los exige antes de M7/P-23. Los appends y folds mantienen su orden causal
dentro de la transacción del ledger. No hay backfill de identidades adivinadas,
rehasheo de historia ni otro namespace de idempotencia para los mismos hechos.

**Clave de idempotencia V2.** Lleva un **namespace de versión explícito** y su
preimagen canónica es:

```
"v2" · stream · task_id · revision_number · attempt_number · transition_id
```

La migración que la habilita **comprueba que ninguna clave V2 colisione con una
clave histórica** y **rechaza explícitamente** si encuentra una colisión. **Nada
rehashea eventos antiguos.**

**Aplicado en migración 11 (P-05/B), con un alcance acotado que hay que leer
literal.** Antes de que exista una sola fila V2 la única pregunta comprobable es
si el namespace está libre, y ésa es la que el preflight hace: rehúsa si alguna
`idempotency_key` histórica ya empieza con `v2/`, nombrando las filas y sin
reparar ninguna. Tiene que preguntarse **ahí** y no cuando se escriba la primera
clave V2 — la columna es `UNIQUE`, así que una colisión descubierta después llega
como fallo de restricción que nombra una fila y ninguna coordenada, sobre un
ledger que ya está en producción. La **composición** de la preimagen completa
sigue siendo del productor (P-18); B sólo reserva el namespace y declara el
separador.

**Lectores legacy.** Un lector que sólo entiende la forma V1 **no interpreta** una
fila V2 como si fuera V1: la versión de contrato no soportada produce un rechazo o
una degradación explícita. Las rutas V2 **no** se doblan sobre el read model legacy
ni reinician su clave; su compatibilidad hacia atrás es **de sólo lectura y está
declarada**.

---

## 2. `initiative_events`

**Hoy** (migración 4, inmutable). Sujeto: una iniciativa. Contexto dueño: `planning`
(ver [planning](../planning/index.md)).

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `sequence` | INTEGER | NOT NULL | `AUTOINCREMENT` | PK. |
| `event_id` | TEXT | NOT NULL | — | `UNIQUE`. |
| `idempotency_key` | TEXT | NOT NULL | — | `UNIQUE`. |
| `initiative_id` | TEXT | NOT NULL | — | Sujeto del stream; real, nunca sintético (§4 canónico). |
| `transition_id` | TEXT | NOT NULL | — | Perfil común. |
| `type` | TEXT | NOT NULL | — | Catálogo en [planning](../planning/index.md), incluye `ROUTING_ASSIGNMENT_RECORDED` para scope `INITIATIVE`/`STEP` y `PLAN_SIMULATION_RECORDED` para guardar explícitamente un reporte (§4.1). Scope `GLOBAL` vive en `registry_events` (§4 canónico punto 1). |
| `from_status` | TEXT | NULL | — | `NULL` en el evento que abre la iniciativa. |
| `to_status` | TEXT | NOT NULL | — | — |
| `emitted_by` | TEXT | NOT NULL | — | Perfil común. |
| `occurred_at` | TEXT | NOT NULL | — | Perfil común. |
| `recorded_at` | TEXT | NOT NULL | — | Perfil común. |
| `causation_stream` | TEXT | NULL | — | **Aditivo.** |
| `causation_sequence` | INTEGER | NULL | — | **Aditivo.** |
| `causation_sha256` | TEXT | NULL | — | **Aditivo.** |
| `contract_version` | TEXT | NOT NULL | — | Perfil común. |
| `event_json` | TEXT | NOT NULL | — | Perfil común. |
| `previous_sha256` | TEXT | NOT NULL | — | Perfil común. |
| `event_sha256` | TEXT | NOT NULL | — | `UNIQUE`. **Sin `CHECK` de forma en el DDL aplicado** (migración 4, mismo caso que `control_plane_events` §1). |

### Índices, triggers, OCC, transacción, rebuild

| Objeto | Forma | Nota |
| --- | --- | --- |
| `initiative_events_by_initiative` | `INDEX (initiative_id, sequence)` | Legacy. |
| `initiative_events_by_type` | `INDEX (type, sequence)` | Legacy. |
| `initiative_events_by_emitter` | `INDEX (emitted_by, sequence)` | Legacy. |
| `initiative_events_by_occurred_at` | `INDEX (occurred_at, sequence)` | Legacy. |
| `initiative_events_deny_update` / `_deny_delete` | `TRIGGER` | Legacy. |
| `tr_initiative_events__validate_new_rows` | **Aditivo.** Mismo patrón que §1: `TRIGGER BEFORE INSERT`, sólo filas nuevas. | |
| OCC | `UNIQUE(event_id)`, `UNIQUE(idempotency_key)`, `UNIQUE(event_sha256)` | — |
| Transacción | `appendBatch`, igual que §1. | |
| Rebuild | No aplica. | |

---

## 3. `account_events`

**Hoy** (migración 5, inmutable). Sujeto: una cuenta. Contexto dueño: `accounts`
(ver [accounts](../accounts/index.md)). **No gana `previous_sha256` ni `event_sha256`
por columna**: la migración 5 es inmutable y esas columnas serían `NOT NULL` sin poder
retro-poblar filas ya escritas bajo un trigger `deny_update` que impide un `UPDATE`
posterior. La integridad se resuelve con el sidecar `account_event_integrity` (§8).

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `sequence` | INTEGER | NOT NULL | `AUTOINCREMENT` | PK. |
| `event_id` | TEXT | NOT NULL | — | `UNIQUE`. |
| `idempotency_key` | TEXT | NOT NULL | — | `UNIQUE`. |
| `account_id` | TEXT | NOT NULL | — | Sujeto del stream. |
| `version` | INTEGER | NOT NULL | — | Versión esperada por CAS de la cuenta (§OCC). |
| `action` | TEXT | NOT NULL | — | Catálogo en [accounts](../accounts/index.md); incluye `PLAN_DECLARED`, `LIMIT_DECLARED`. |
| `resulting_state` | TEXT | NOT NULL | — | Uno de `AVAILABLE \| DRAINING \| EXHAUSTED \| COOLDOWN \| AUTH_REQUIRED` (`packages/kernel/contracts/src/schemas/account-record/index.ts:16-22`, preservado sin alias). |
| `actor` | TEXT | NOT NULL | — | — |
| `note` | TEXT | NULL | — | Comentario libre opcional del operador. |
| `occurred_at` | TEXT | NOT NULL | — | Perfil común. |
| `recorded_at` | TEXT | NOT NULL | — | Perfil común. |
| `contract_version` | TEXT | NOT NULL | — | Perfil común. |
| `event_json` | TEXT | NOT NULL | — | Perfil común. |

No lleva `causation_*`: hoy este stream no participa de causalidad cruzada verificable;
si un caso de uso futuro lo requiere, se agrega por la misma vía aditiva que §1–2, en
una migración separada, cuando exista el caso de uso concreto.

### Índices, triggers, OCC, transacción, rebuild

| Objeto | Forma | Nota |
| --- | --- | --- |
| `account_events_by_account` | `INDEX (account_id, version)` | Legacy, **no única**. |
| `ux_account_events__account_id__version` | **Aditivo.** `CREATE UNIQUE INDEX ... ON account_events (account_id, version)` | Corrige el defecto de §9 canónico: hoy dos eventos con la misma `(account_id, version)` y distinta clave son insertables. Es un índice nuevo, no una columna: no viola la inmutabilidad de la migración 5. |
| `account_events_deny_update` / `_deny_delete` | `TRIGGER` | Legacy. |
| OCC | `UNIQUE(event_id)`, `UNIQUE(idempotency_key)`, `ux_account_events__account_id__version` (aditivo) + CAS de aplicación por `expected_version` en `appendAccountAction`. | El índice único es el guardarraíl de base; el CAS decide el `version` esperado antes de intentar el insert. |
| Preflight | La migración que agrega `ux_account_events__account_id__version` cuenta primero las violaciones `(account_id, version)` duplicadas existentes y **falla nombrándolas**; no deduplica en silencio. Resolución de conflicto histórico documentada en `../../../decisions/index.md`. | |
| Transacción | `appendBatch`: fila de `account_events` + fila de `account_event_integrity` + cabeza (`ledger_meta`) + proyección afectada, una sola transacción, con CAS por `expected_version`. | |
| Rebuild | No aplica al stream. | |

---

### 3.1 Eventos de entrega de avisos para una cuenta real

El catálogo objetivo de `account_events.action` incorpora
OUTBOX_COMMAND_INTENDED, OUTBOX_DELIVERY_INTENDED y OUTBOX_DELIVERY_OBSERVED
exclusivamente para NOTIFY. Son acciones de máquina autorizadas, no acciones del
owner: preservan resulting_state, toman expected account version y anexan la
versión siguiente sin cambiar la configuración ni conceder otro permiso.
Sus payloads neutrales y restricciones pertenecen a
[coordinación §6.2](../coordination/index.md). Este namespace versionado no permite
que un productor de avisos emita DRAIN, login u otra decisión administrativa.
Evento, sidecar, cabeza y proyección se confirman juntos; no se añade una FK al
outbox separado. Intento y acuse conservan account_id y causalidad verificable.

Los mismos tres nombres se incorporan al catálogo objetivo de
control_plane_events/initiative_events sólo para las combinaciones de aquella
matriz; son same-state. No se amplía registry_events para comandos operativos.
Las migraciones aplicadas permanecen inmutables y los lectores legacy no
reinterpretan eventos de un contrato nuevo.

---

### 3.2 Catálogo de interacción V1

Los payloads estrictos y preimágenes están en
[interacción](../../contracts/interaction/index.md); no amplían la matriz B3 ni
sus permisos. interaction_contract_version=1 pertenece al payload y no sustituye
contract_version/estado/cohorte del evento común.

| Evento | Stream/sujeto autorizado | Efecto de dominio |
| --- | --- | --- |
| NOTIFICATION_DECISION_RECORDED | control_plane_events/task, initiative_events/initiative o account_events/account real | same-state; sólo decisión/rate, nunca aprobación o acción administrativa |
| APPROVAL_WAIT_REQUESTED, APPROVAL_WAIT_RESOLVED | initiative_events/iniciativa de owner_approval | espera exacta, con decisión/cancelación/vencimiento del permiso en el mismo append |
| MODEL_DUEL_REQUESTED, MODEL_DUEL_STARTED, MODEL_DUEL_ADJUDICATION_STARTED, MODEL_DUEL_CHECKS_RECORDED, MODEL_DUEL_RESOLVED | initiative_events/iniciativa de las dos tareas | header/candidatos/checks/adjudicación, sin fingir que un worker corrió |
| ANOMALY_EVALUATED, ANOMALY_ACTION_OBSERVED | control_plane_events/tarea e intento reales TaskV2 | detector y confirmación separados; no cambia routing ni amplía autoridad |

NOTIFICATION_DECISION_RECORDED de cuenta es acción de máquina same-state:
expected_version/CAS, versión siguiente, sidecar/cabeza/folds atómicos; no puede
emitir DRAIN/login. Los tres OUTBOX_* conservan la matriz B3 y su mismo sujeto.
Los pines de policy/artefacto del registry son referencias causales, nunca una
SYSTEM-task ni un quinto stream. Cualquier combinación fuera de esta tabla
rechaza antes de mutar. No se reinterpretan eventos LEGACY con estos schemas.

## 4. `registry_events`

**Nuevo.** Sujeto: un documento de configuración versionado (`subject_kind =
'DOCUMENT'`) o, desde la migración 15, un artefacto (`subject_kind = 'ARTIFACT'`,
[artefactos §1.1](../artifacts/index.md)). Almacenamiento; la semántica de cada
`document_kind` la poseen `planning`, `accounts` y `economy` (§4 canónico punto 2),
y la de cada `artifact_event_kind` la hoja de artefactos. No decide elegibilidad, no
puntúa modelos, no fija precios: sólo persiste versiones con digest, autor y
vigencia, y hechos de artefactos sin sus bytes.

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `sequence` | INTEGER | NOT NULL | `AUTOINCREMENT` | PK. |
| `event_id` | TEXT | NOT NULL | — | `UNIQUE`. |
| `idempotency_key` | TEXT | NOT NULL | — | `UNIQUE`. |
| `subject_kind` | TEXT | NOT NULL | — | `CHECK IN ('DOCUMENT','ARTIFACT')`, sin default: todo escritor declara su plano. Migración 15. |
| `document_kind` | TEXT | NULL | — | `CHECK IN ('CAPABILITY_POLICY','MODEL_VERSION','PRICE_TABLE','MODEL_PERFORMANCE','ROUTING_ASSIGNMENT_GLOBAL','ESTIMATION_POLICY','INTEGRATION_PROFILE','INTEGRATION_INSTALLATION','COMPOSITION_POLICY','COMPOSITION_EVIDENCE','NOTIFICATION_POLICY','APPROVAL_WAIT_POLICY','DUEL_POLICY','ANOMALY_POLICY')`. Regla espejo `ck_registry_events__document_kind_matches_subject`: presente si y sólo si `subject_kind = 'DOCUMENT'`. NOT NULL hasta la migración 15, que lo reconstruye NULLable. |
| `artifact_event_kind` | TEXT | NULL | — | `CHECK IN` los nueve nombres de [artefactos §2](../artifacts/index.md) (`PUBLICATION_INTENDED`, `PUBLICATION_SUCCEEDED`, `PUBLICATION_ABANDONED`, `REFERENCE_RECORDED`, `PIN_ACQUIRED`, `PIN_RELEASED`, `RECLAIM_INTENDED`, `RECLAIM_COMPLETED`, `REFERENCE_TOMBSTONED`); la puerta registra seis y rechaza por nombre los tres restantes. Regla espejo `ck_registry_events__artifact_event_kind_matches_subject`: presente si y sólo si `subject_kind = 'ARTIFACT'`. Migración 15. |
| `document_id` | TEXT | NOT NULL | — | Identidad estable del documento (§7.8 canónico). Para `MODEL_VERSION` = `model_version_id`; para `PRICE_TABLE` = id del catálogo; para `ROUTING_ASSIGNMENT_GLOBAL` = `routing:GLOBAL:<role>:<slot>`; para `CAPABILITY_POLICY` y `ESTIMATION_POLICY`, identidad propia del perfil; para `MODEL_PERFORMANCE` = `performance_id` del snapshot (§4.1). En una fila ARTIFACT, el sujeto: `content_sha256` en los tres eventos de publicación, `artifact_reference_id` en `REFERENCE_RECORDED`, `artifact_pin_id` en los dos de pin. Un sujeto conserva su `subject_kind` entre eventos. |
| `document_version` | INTEGER | NOT NULL | — | `CHECK >= 1`. En una fila ARTIFACT, el ordinal del evento dentro de su sujeto: `1 + MAX(document_version)` por `document_id`, propuesto por el productor y verificado por el ledger; `parent_document_version` es el ordinal previo o `NULL`. |
| `content_digest` | TEXT | NOT NULL | — | Digest sha256 del artefacto de contenido (§0 `ck_`), ver [artifacts](../artifacts/index.md). |
| `parent_document_version` | INTEGER | NULL | — | `NULL` en la primera versión de un `document_id`. El padre **comparte** `document_id` (no se usa `UNIQUE(document_kind, document_version)`: dos documentos distintos de la misma clase son legítimos, §7.8 canónico). |
| `recorded_by` | TEXT | NOT NULL | — | Identidad que registró la versión; para `MODEL_PERFORMANCE` puede ser una identidad de proceso (`system:model-performance-job`), no humana. |
| `effective_from` | TEXT | NOT NULL | — | ISO ms UTC; instante a partir del cual esta versión rige. En una fila ARTIFACT, `occurred_at`; `content_digest` es el `content_sha256` del blob y `recorded_by` la identidad del productor. `subject_kind` y `artifact_event_kind` viajan también en `event_json`, porque las columnas quedan fuera de la preimagen. |
| `occurred_at` | TEXT | NOT NULL | — | Perfil común. |
| `recorded_at` | TEXT | NOT NULL | — | Perfil común. |
| `causation_stream` | TEXT | NULL | — | Perfil común completo. |
| `causation_sequence` | INTEGER | NULL | — | — |
| `causation_sha256` | TEXT | NULL | — | — |
| `contract_version` | TEXT | NOT NULL | — | Perfil común. |
| `event_json` | TEXT | NOT NULL | — | Perfil común; namespace de extensión versionado por `document_kind` (§3.5 canónico). |
| `previous_sha256` | TEXT | NOT NULL | — | Perfil común. |
| `event_sha256` | TEXT | NOT NULL | — | `UNIQUE`. `CHECK` correcto (§0). |

Los cuatro kinds de interacción tienen schema propio: NOTIFICATION_POLICY de
observation; APPROVAL_WAIT_POLICY/DUEL_POLICY de planning; ANOMALY_POLICY de economy.
Su contenido POLICY_DOCUMENT y referencia autorizada se publican antes del evento.
El payload específico lleva artifact_reference_id; content_digest debe coincidir
con ese artefacto. No son aliases de CAPABILITY_POLICY ni de ESTIMATION_POLICY.
document_id conserva document_kind entre versiones; el UNIQUE, parent/OCC,
autoridad e integridad ya definidos siguen vigentes.

### Índices, triggers, OCC, transacción, rebuild

| Objeto | Forma | Nota |
| --- | --- | --- |
| `ux_registry_events__document_id__document_version` | `UNIQUE INDEX (document_id, document_version)` | Identidad de versión (§7.8 canónico). |
| `ix_registry_events__document_kind__document_id__document_version` | `INDEX (document_kind, document_id, document_version)` | Resolución de "versión vigente" por clase. |
| `ix_registry_events__document_id__effective_from` | `INDEX (document_id, effective_from)` | Resolución de precedencia por vigencia. |
| `ix_registry_events__subject_kind__document_id` | `INDEX (subject_kind, document_id)` | Acceso por sujeto del fold de artefactos. Migración 15. |
| `tr_registry_events__deny_update` / `tr_registry_events__deny_delete` | `TRIGGER` | Convención nueva (§3.2 canónico), no legacy. |
| OCC | `UNIQUE(event_id)`, `UNIQUE(idempotency_key)`, `UNIQUE(event_sha256)`, `ux_registry_events__document_id__document_version` | Reintentar el registro de la misma versión con la misma clave de idempotencia no duplica. Para un sujeto ARTIFACT el mismo índice es el CAS del ordinal por sujeto. |
| Transacción | `appendBatch`, igual patrón que §1–3. | |
| Rebuild | No aplica: es autoridad. | |

**No** existe un `initiative_id` sintético para configuración `GLOBAL`: una asignación
de routing `GLOBAL` vive acá como `ROUTING_ASSIGNMENT_GLOBAL`; las de scope
`INITIATIVE`/`STEP` viven en `initiative_events` (§2). El read model
`routing_assignment_read_model` (dueño: [planning](../planning/index.md)) se alimenta
de **ambos** streams contra un vector de watermarks. Otra proyección explícita de
varias fuentes es [notification_read_model](../execution/notifications/index.md):
particiones disjuntas por owner_stream, con cohortes/watermarks y reemplazo parcial
acotados; jamás se mezclan secuencias ni se borran filas de una partición vecina.

### 4.1 Publicación de reportes derivados

Los documentos INTEGRATION_PROFILE, INTEGRATION_INSTALLATION, COMPOSITION_POLICY
y COMPOSITION_EVIDENCE siguen el mismo envelope de registry y tienen como dueño
semántico a planning. Sus schemas strict, pines y comprobaciones pertenecen a
[composición](../../integrations/composition/contracts/index.md); no amplían el
catálogo de modelos ni duplican precios. Los hechos de preflight/binding se
registran en control_plane_events, sobre una tarea real y sin cambio de estado,
según [validación §5](../../integrations/composition/validation/index.md).

La política de estimación se registra como `ESTIMATION_POLICY` en este registry
único. `document_id` identifica el perfil, `document_version` su versión y
`content_digest` su pin; padre, vigencia y CAS siguen §4. Contenido cerrado:
`EstimationPolicyV1` de [estimación](../../contracts/estimation/index.md).
Su dueño semántico es economy; no otro registry de modelos ni resultado JSON
consultado por campos.

Los reportes tienen dos dueños de publicación:

| Reporte | Evento y proyección |
| --- | --- |
| Simulación/forecast/what-if guardados | `PLAN_SIMULATION_RECORDED` en initiative_events; [planning/simulation](../planning/simulation/index.md) y plan_simulation_quota (§11.2 planning). |
| Desempeño | `MODEL_PERFORMANCE` en registry_events; [economy/performance](../economy/performance/index.md). `document_id=performance_id`, primera y única `document_version=1` por snapshot. Otro corte/corrección crea otro request_sha256 y otro performance_id. |

El dry-run sólo lee y devuelve Report. Guardar es una operación separada,
explícita y autorizada, sin outbox, notificación, efecto externo ni nueva cadena
de eventos. PLAN_SIMULATION_RECORDED requiere una iniciativa real, no concede
aprobación ni cambia estados de ejecución; conserva el estado de iniciativa con
from_status=to_status. Su idempotency_key identifica el guardado, no una
ejecución. Los DTOs Request/Report o PerformanceRequest/PerformanceResult y
sus pines de muestras/efectos son strict y versionados.

La orden de guardar lleva expected_head de su sujeto/stream y reportSha256.
En BEGIN IMMEDIATE se compara esa cabeza, se validan Request/policy/refs/vector
y valores, y se busca el reporte por su hash; desempeño también resuelve
request_sha256 UNIQUE a su performance_id estable. Evento, cabeza, header,
hijas y watermark se publican atómicamente. Mismo hash/contenido devuelve
existente; id mismo/digest distinto es CONFLICT. Cortes diferentes producen
snapshots distintos, no UPDATE histórico. sourceHeads puede ser anterior a la
cabeza vigente: se verifica integridad, no se exige latest. El vector de
fuentes de desempeño precede a su propio publication_sequence.

El evento conserva el request/result completo y los pines seleccionados como
arrays tipados. No se consulta JSON para filtrar métricas: el fold normaliza
sus tablas, verifica preimágenes/invariantes, conserva las fuentes y no consulta
el reloj, reautoriza decisiones ni selecciona latest. Replay explícito abre
lecturas al vector original; evidencia autorizada ausente devuelve
SOURCE_UNAVAILABLE, no una estimación nueva. Una corrección de uso/precio
produce otro reporte y conserva los anteriores.

Este protocolo no cambia preimágenes de eventos existentes, TaskEnvelope,
effect_id o invocation ni reinterpreta eventos legacy.


---

## 5. `ledger_meta`

**Hoy** (migración 3, inmutable en su DDL), pero **mutable en filas**: no es un
stream, es meta de coordinación de cabezas, sin trigger `deny_update`. Cada clave se
actualiza dentro de la misma transacción que el `appendBatch` que la produce.

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `key` | TEXT | NOT NULL | — | PK. Vocabulario cerrado, ver tabla de claves. |
| `value` | TEXT | NOT NULL | — | Interpretación según `key`. |

### Vocabulario de `key` (cerrado; cada fila nueva es aditiva, no requiere migración de esquema)

| `key` | Estado | Semántica |
| --- | --- | --- |
| `head_sequence`, `head_event_sha256`, `event_count` | Hoy | Cabeza de `control_plane_events`. |
| `initiative_head_sequence`, `initiative_head_event_sha256`, `initiative_event_count` | Hoy | Cabeza de `initiative_events`. |
| `account_integrity_baseline_sequence`, `account_integrity_baseline_sha256` | Nuevo | `baseline_sequence = H`, la cabeza de `account_events` al momento de activar el sidecar; **no** el punto desde el que arranca la cobertura — la cobertura retroactiva cubre `1..H` completo (§8). `baseline_sha256` es el `event_sha256` computado para la fila `H` del sidecar, ancla de los appends futuros. Se escribe una sola vez, bajo bloqueo migratorio, y nunca se reescribe salvo una decisión de reparación explícita fuera de la migración normal (§8). |
| `account_integrity_activated_at` | Nuevo | Instante ISO-8601 UTC con milisegundos de activación del sidecar; sin default. Se fija una sola vez en la misma transacción que `account_integrity_baseline_sequence` y `account_integrity_baseline_sha256`, incluso si `H = 0`. No cambia con appends ni rebuilds. |
| `account_integrity_head_sequence`, `account_integrity_head_event_sha256` | Nuevo | Cabeza del sidecar, avanza con cada fila nueva de `account_event_integrity`. |
| `registry_head_sequence`, `registry_head_event_sha256`, `registry_event_count` | Nuevo | Cabeza de `registry_events`. |
| `instance_id` | Nuevo | UUID v4 generado una sola vez al crear el archivo físico; estable de por vida. Viaja en el frame `hello` del stream SSE (invariante 7 canónica). |
| `restore_id` | Nuevo | UUID v4 aleatorio, **no un contador**. Se reescribe en **cada** restore formal, **antes** de admitir trabajo nuevo. Un contador colisiona si el mismo backup se restaura dos veces; el UUID no. Viaja en el frame `hello`; el cursor del cliente es `(instance_id, restore_id, stream, sequence, event_sha256)`. |
| `restore_epoch` | Nuevo | Entero monótono, informativo únicamente (orden humano-legible de restores); **no** participa de ninguna unicidad — esa función la cumple `restore_id`. |

Detección: esto detecta un restore **formal** (el propio proceso que restaura escribe
el `restore_id` antes de admitir). **No** se promete detectar una copia manual
arbitraria del archivo con metadatos idénticos, sin estado externo que lo delate
(§12 canónico).

### OCC, transacción, rebuild

| Objeto | Forma |
| --- | --- |
| OCC | `PRIMARY KEY(key)`; cada `UPDATE` de una cabeza ocurre dentro de la misma transacción `appendBatch` que la fila que la produce. |
| Transacción | Ver `appendBatch` en §1–4. `restore_id` se escribe en su propia transacción, antes de cualquier `appendBatch` posterior al restore. |
| Rebuild | No aplica: no es derivable de los streams, es el propio puntero de cabeza. |

---

## 6. `schema_migrations`

**Hoy** (bootstrap DDL, `SCHEMA_MIGRATIONS_DDL`), sin cambios.

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `version` | INTEGER | NOT NULL | — | PK. |
| `name` | TEXT | NOT NULL | — | — |
| `sha256` | TEXT | NOT NULL | — | Checksum del texto SQL de la migración; comparado en cada apertura. |
| `applied_at` | TEXT | NOT NULL | — | — |

### OCC, transacción, rebuild

| Objeto | Forma |
| --- | --- |
| OCC | `PRIMARY KEY(version)`. Aplicación en orden estricto por posición y versión (`checkMigrationConformance`). |
| Transacción | Cada migración se aplica y se registra en la misma llamada (`applyMigrations`); un fallo a mitad de camino no deja schema parcial. |
| Rebuild | No aplica. |

---

## 7. `projection_watermark` (nuevo, reemplaza `projection_meta`)

**Nuevo.** `projection_meta` (migración 3) tiene una sola fila por proyección y no
puede describir una proyección alimentada por más de un stream (p. ej.
`routing_assignment_read_model`, §4). `projection_watermark` tiene una fila por
`(projection_name, source_stream)`.

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `projection_name` | TEXT | NOT NULL | — | PK (compuesta). |
| `source_stream` | TEXT | NOT NULL | — | PK (compuesta). `CHECK IN ('control_plane_events','initiative_events','account_events','registry_events')`. |
| `projector_version` | INTEGER | NOT NULL | — | `CHECK >= 1`. Un cambio de algoritmo de fold invalida la tabla derivada sin tocar el stream. |
| `applied_sequence` | INTEGER | NOT NULL | — | `CHECK >= 0`. Cabeza fijada de este stream para esta proyección. |
| `event_count` | INTEGER | NOT NULL | — | `CHECK >= 0`. |
| `source_head_sha256` | TEXT | NOT NULL | — | `CHECK` de forma sha256 (§0). Digest verificado **en applied_sequence**, no en la cabeza actual posterior. Para account_events es account_event_integrity.event_sha256 en account_sequence=applied_sequence; para los otros streams, event_sha256 de su fila. Secuencia cero usa 64 ceros. Sin sidecar de cuentas activado/verificado no se publica un watermark certificado de ese stream. |
| `updated_at` | TEXT | NOT NULL | — | ISO ms UTC. Bookkeeping operativo de cuándo corrió el projector; **no** es autoridad de negocio y no sustituye a `applied_sequence` como definición de la fila canónica (§5 canónico distingue esto de un `updated_at` de negocio, que desaparece de las filas del read model mismo). |

### OCC, transacción, rebuild

| Objeto | Forma |
| --- | --- |
| `pk_projection_watermark` | `PRIMARY KEY (projection_name, source_stream)` |
| OCC | El `UPDATE` de `applied_sequence` ocurre atómicamente con la escritura del read model, en la misma transacción del projector; un projector concurrente que lea un `applied_sequence` desactualizado no avanza dos veces sobre el mismo rango porque el `UPDATE` es la única fuente de verdad de "hasta dónde". |
| Transacción | Proyección + watermark, una transacción por lote aplicado. |
| Rebuild | Antes de borrar un read model para regenerarlo se verifica la cadena del stream (§8 canónico); una reconstrucción sobre cadena rota se rehúsa para los cuatro streams. Al reconstruir, la fila de watermark se borra y se reescribe junto con el read model, nunca se conserva "a medias". |

---

## 8. `account_event_integrity` (nuevo, sidecar de `account_events`)

**Nuevo.** Sidecar append-only. Al activarse, cubre **retroactivamente todos los bytes
históricos existentes**, `account_sequence` 1 hasta `H` (§9 canónico: "computados sobre
los bytes canónicos históricos sin modificar"), con génesis `previous_sha256` de
sesenta y cuatro ceros para la fila 1 — mismo patrón que el génesis de
`ledger_meta.head_event_sha256`. Esto demuestra que nada cambió **desde** que se computó
ese chain (protección de integridad); **no** demuestra que las filas 1..H eran
auténticas *antes* de esa computación — nadie las hasheó cuando se escribieron
originalmente, así que un cambio anterior a la activación no queda excluido. `verifyIntegrity`
reporta cobertura completa `1..head` desde la activación en adelante.

| Columna | Tipo | Nullable | Default | Semántica |
| --- | --- | --- | --- | --- |
| `account_sequence` | INTEGER | NOT NULL | — | PK; **FK** `REFERENCES account_events(sequence)`. Uno a uno con **cada** fila de `account_events`, desde `sequence = 1` (no sólo desde donde se activó el sidecar). |
| `previous_sha256` | TEXT | NOT NULL | — | Para `account_sequence = 1`, sesenta y cuatro ceros (génesis). Para las siguientes, el `event_sha256` de la fila anterior de este sidecar. |
| `event_sha256` | TEXT | NOT NULL | — | `UNIQUE`. `CHECK` de forma correcta (§0). SHA-256 de la preimagen versionada exacta de §8.1: incluye `previous_sha256`, secuencia y todos los valores almacenados de la fila de `account_events`, sin reinterpretarlos ni normalizarlos. |
| `computed_at` | TEXT | NOT NULL | — | ISO ms UTC; instante en que esta fila del sidecar fue calculada y anexada. Para las filas `1..H` es exactamente `ledger_meta.account_integrity_activated_at` (posterior, típicamente muy posterior, a `account_events.recorded_at` de esa misma fila); para las filas `> H` coincide con el append normal. |

### 8.1 Preimagen exacta del sidecar, versión 1

La codificación siguiente es específica de `account_event_integrity`; no cambia
los hashes ni la serialización de los otros streams. `||` significa concatenación
de bytes, sin separadores implícitos. Se definen:

- `T(s) = ASCII("T" + decimal(length(B)) + ":") || B`, donde `B` son los bytes
  UTF-8 del valor TEXT **tal como está almacenado**, sin normalizar Unicode,
  espacios, escapes, fechas ni finales de línea. Se leen como bytes UTF-8 del
  valor SQL, sin volver a parsear su contenido.
- `I(n) = ASCII("I" + decimal(n) + ";")`, con representación exacta del INTEGER
  de 64 bits, sin signo `+`, ceros iniciales ni conversión por coma flotante.
- `N = ASCII("N;")` para SQL `NULL`; no es `T("")` ni `T("null")`.

El decimal de una longitud es base diez sin ceros iniciales; cero se escribe `0`.
Para una fila `r` de `account_events`, el orden y la lista son **cerrados**:

```text
preimage_v1 = ASCII("acp/account-event-integrity/v1\n")
  || T(previous_sha256)
  || I(r.sequence)
  || T(r.event_id)
  || T(r.idempotency_key)
  || T(r.account_id)
  || I(r.version)
  || T(r.action)
  || T(r.resulting_state)
  || T(r.actor)
  || (N si r.note IS NULL; T(r.note) en otro caso)
  || T(r.occurred_at)
  || T(r.recorded_at)
  || T(r.contract_version)
  || T(r.event_json)
event_sha256 = lowercase_hex(SHA256(preimage_v1))
```

En el prefijo, `\n` es un único byte LF (`0x0a`), no dos caracteres. La versión
`v1` pertenece al formato de integridad y es distinta de `r.contract_version`, que
también queda hasheada. El `event_json` almacenado entra como TEXT completo:
**nunca** `JSON.parse`/reserialización, ordenamiento de propiedades ni extracción
selectiva. La codificación por tipo y longitud evita ambigüedad de concatenación.
`r.sequence` debe ser igual al `account_sequence` del sidecar; `previous_sha256`
es el `event_sha256` anterior, o exactamente 64 ceros en la fila 1. Añadir campos
al stream exige una nueva versión de preimagen explícita; nunca se cambia `v1`
en el lugar ni se rehashea su historia. `computed_at` es metadata del sidecar,
no un campo de la fila histórica de cuenta ni parte de `preimage_v1`.

### 8.2 Reporte de cobertura de integridad

Extensión tipada por stream de `verifyIntegrity`; describe la cobertura, no
sustituye su resultado de verificación ni convierte una cadena corrupta en PASS.

| Campo | Dominio/nulidad | Valor decidido |
| --- | --- | --- |
| `source_stream` | catálogo de cuatro streams | stream examinado |
| `coverage_kind` | CHAIN_FROM_APPEND / BASELINED_AT_ACTIVATION / NOT_ACTIVATED | procedencia de la cobertura, no un score |
| `covered_since_sequence` | INTEGER >=1 o NULL | 1 con cadena verificada instalada; NULL para NOT_ACTIVATED |
| `checked_through_sequence` | INTEGER >=0 | cabeza del corte examinado; [1,0] denota stream vacío |
| `integrity_activated_at` | instante canónico o NULL | metadata exacta de activación para cuentas; NULL en los otros casos |
| `baseline_sequence` | INTEGER >=0 o NULL | H fijado al activar cuentas, incluso H=0; NULL en los otros casos |
| `baseline_sha256` | SHA o NULL | hash baseline de metadata; 64 ceros si H=0; NULL en los otros casos |

Control_plane_events, initiative_events y registry_events con su esquema de
cadena instalado: CHAIN_FROM_APPEND, covered_since_sequence=1 y los tres campos
de baseline NULL. Account_events activado: BASELINED_AT_ACTIVATION,
covered_since_sequence=1 y los tres campos de baseline obligatorios, tomados de
ledger_meta sin recalcular H desde la cabeza actual. Cuenta sin sidecar activado:
NOT_ACTIVATED, covered_since_sequence NULL y todos los campos de baseline NULL;
no satisface el gate de integridad aunque una lectura legacy sea posible.

La cobertura 1..H de cuentas significa **bytes preservados desde la activación**,
no autenticidad previa ni evidencia de que fueron hasheados al insertarse.
El chequeo verifica además que el baseline almacenado coincide con la fila H
del sidecar y que éste enlaza con la cabeza actual. Baseline/metadatos parciales
o divergentes son error de integridad; no se degradan a NOT_ACTIVATED para
ocultarlos. Rebuild/restore no cambian activación, H ni su SHA. Un corte histórico
se verifica contra las filas de ese corte; no reemplaza su hash con la cabeza
actual ni inventa una activación anterior.

Negativos: activar con H>0 emite siempre 1 junto con H/instante/SHA explícitos;
activación vacía emite H=0 y génesis; antes de activar no se afirma cobertura;
alterar el baseline o la fila histórica rechaza. Dos implementaciones emiten
los mismos campos para el mismo archivo/corte.

### Índices, OCC, transacción, rebuild

| Objeto | Forma | Nota |
| --- | --- | --- |
| `pk_account_event_integrity` | `PRIMARY KEY (account_sequence)` | También sirve de único-por-fila-de-stream. |
| `fk_account_event_integrity__account_events` | `FOREIGN KEY (account_sequence) REFERENCES account_events(sequence) ON DELETE RESTRICT` | Misma cohorte de reconstrucción: ambas tablas viven y mueren juntas en el mismo archivo físico. |
| `ux_account_event_integrity__event_sha256` | `UNIQUE INDEX (event_sha256)` | — |
| `tr_account_event_integrity__deny_update` / `tr_account_event_integrity__deny_delete` | `TRIGGER` | Es append-only igual que un stream, aunque no es uno de los cuatro streams de negocio. |
| Preflight | Antes de crear el sidecar: contar violaciones de `(account_id, version)` existentes en `account_events` y fallar nombrándolas (ver §3). El cómputo retroactivo del hash chain histórico corre **después** del preflight limpio. | |
| Transacción | Carga inicial: bajo bloqueo migratorio y `BEGIN IMMEDIATE`, se fija `H = COALESCE(MAX(account_events.sequence), 0)` y un único instante `account_integrity_activated_at`; se computa `1..H` con §8.1 y se escribe atómicamente el sidecar, `account_integrity_baseline_sequence = H`, `account_integrity_baseline_sha256`, el instante y `account_integrity_head_*`. Para `H = 0` no hay filas de sidecar y ambos hashes de baseline/head son 64 ceros. Para `H > 0` ambos hashes son el `event_sha256` de la fila `H`. Hacia adelante, el CAS por `expected_version` escribe `account_events` + `account_event_integrity` + cabeza `account_integrity_head_*` + proyección y watermark en una sola transacción; nunca modifica la tripleta de activación. | |
| Rebuild | El sidecar **no** se reconstruye desde cero como un read model: es evidencia append-only igual que un stream. Ante corrupción detectada: **fail-closed**, se preserva el segmento afectado sin modificarlo y **no** se reancla automáticamente ni se mueve el punto de cobertura reportado — la reparación es una decisión explícita e inmutable, registrada en `../../../decisions/index.md`, fuera del flujo de migración normal. | |

---

## 9. Mapeo legado → destino (objetos de esta hoja)

| Objeto legado | Estado hoy | Destino | Nota |
| --- | --- | --- | --- |
| `control_plane_events` (tabla + 5 índices + 2 triggers) | Hoy, mig. 1 | Se preserva; gana `causation_*` aditivo. | §1 |
| `initiative_events` (tabla + 4 índices + 2 triggers) | Hoy, mig. 4 | Se preserva; gana `causation_*` aditivo. | §2 |
| `account_events` (tabla + 1 índice) | Hoy, mig. 5 | Se preserva; gana `ux_account_events__account_id__version` aditivo + sidecar. | §3 |
| `ledger_meta` | Hoy, mig. 3 | Se preserva; gana claves nuevas (filas, no columnas). | §5 |
| `projection_meta` | Hoy, mig. 3 | **Reemplazado** por `projection_watermark`: una fila por proyección no describe una proyección multi-stream. | §7 |
| `schema_migrations` | Hoy, bootstrap | Sin cambios. | §6 |
| — (no existía) | — | `registry_events` nuevo. | §4 |
| `registry_events` (mig. 9) | Hoy, mig. 9 | Reconstruido en la migración 15 con `subject_kind`, `document_kind` NULLable y `artifact_event_kind`; filas, cadena, `sequence`, índices y triggers conservados (los dos triggers ajenos, byte-idénticos). Cuatro read models de artefactos lo referencian por FK desde entonces. | §4; [artefactos](../artifacts/index.md) |
| — (no existía) | — | `account_event_integrity` nuevo. | §8 |

El inventario completo de las migraciones 1–6 contiene **dieciocho índices y
seis triggers**; incluye índices de streams y de proyecciones, no dieciocho índices
sólo sobre las tres tablas de eventos. Se preservan además los objetos de
`ledger_meta`, `projection_meta` y `schema_migrations` declarados arriba.
