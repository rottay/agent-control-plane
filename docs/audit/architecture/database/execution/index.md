# Execution: diccionario físico

Dueño: tarea, revisión, intento, segmentos de ruta y handoffs, efectos e intentos de
despacho, ocurrencias de prompt y respuesta, tool calls, checkpoints, verificación,
veredicto, commit, anomalías, worker.

Reglas transversales en [../index.md](../index.md). Fuente de eventos:
`control_plane_events` (sujeto: una tarea). La escalera de identidad completa es la de
§6 canónico: `task_id` → `(task_id, revision_number)` → `(task_id, revision_number,
attempt_number)` → `route_segment_id` → `effect_id` → `dispatch_attempt_id` →
`occurrence_id`.

---

## 1. `task_read_model`

**Hoy** (migración 2, con `ALTER TABLE ... ADD COLUMN initiative_id` en migración 4) +
**aditivo**.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `task_id` | TEXT | NOT NULL | PK. Estable de por vida (§6.1 canónico). |
| `initiative_id` | TEXT | NULL | Aditivo mig. 4; `NULL` sólo en filas de antes de esa migración, nunca en escritura nueva. |
| `step_id` | TEXT | NULL | **Aditivo, aplicado en migración 11, sin productor todavía.** `NULL` para tareas fuera de un roadmap (si el caso de uso lo permite); documentado explícitamente, no un `NULL` accidental. |
| `role` | TEXT | NULL | **Aditivo, aplicado en migración 11, sin productor todavía.** Vigente desde la primera revisión; `NULL` sólo antes de existir la primera revisión. Ningún evento la trae hoy y nadie inventa una clave de payload para llenarla: `NULL` significa «no registrado aún», no «ausente». |
| `envelope_sha256` | TEXT | NULL | **Aditivo, aplicado en migración 11.** Denormalización de conveniencia del `envelope_sha256` de la **revisión vigente** (`task_revision_read_model`, §2); no autoritativo — la autoridad es la fila de revisión. Se mueve junto con las dos siguientes o no se mueve: una tarea que anunciara el número de una revisión y el envelope de otra es el único fallo que una columna de conveniencia no puede producir. |
| `commit_policy` | TEXT | NULL | **Aditivo, aplicado en migración 11, sin productor todavía.** |
| `duel_id` | TEXT | NULL | **Aditivo, NO aplicado en migración 11.** Su productor es el flujo de duelos ([planning](../planning/index.md) §9 `adjudication_read_model`) y la columna va con ese packet: una columna sin productor apunta a un puerto vacío. `NULL` fuera de un duelo de modelos. |
| `current_state` | TEXT | NOT NULL | Valor preservado de la cohorte indicada por `state_vocabulary`, nunca traducción por similitud de nombre ([contratos §2.2](../../contracts/index.md)). |
| `state_vocabulary` | TEXT | NOT NULL | **Aditivo, NO aplicado en migración 11.** Va con la transición de vocabulario de estados ([contratos §2.2](../../contracts/index.md)), que trae su `CHECK` y su escritura por cohorte; separarla de su productor dejaría una columna `NOT NULL` con default y sin nadie que escriba el valor explícito. Cuando llegue: default de migración `LEGACY` para filas preexistentes; `CHECK IN ('LEGACY','TASK_V2')`; el fold siempre escribe el valor explícito según la cohorte del evento y el default no autoriza inserts nuevos sin versión. No se modifica ningún evento histórico. |
| `latest_revision_number` | INTEGER | NULL | **Aditivo, aplicado en migración 11.** `NULL` sólo antes de existir la primera revisión (transición desde el legacy `latest_attempt`), y `NULL` para siempre en una tarea cuya historia entera precede a esa migración. |
| `latest_attempt_number` | INTEGER | NULL | **Aditivo, aplicado en migración 11.** Igual nulidad. |
| `latest_attempt` | INTEGER | NOT NULL | **Legacy, congelado.** Contador plano pre-revisión; se sigue poblando por compatibilidad de lectura mientras conviven ambas formas (§15.4 canónico), no se lee para lógica nueva. |
| `event_count` | INTEGER | NOT NULL | — |
| `first_sequence` | INTEGER | NOT NULL | — |
| `last_sequence` | INTEGER | NOT NULL | Reemplaza a `updated_at` como definición de orden. |
| `last_event_id` | TEXT | NOT NULL | Legacy. |
| `last_event_type` | TEXT | NOT NULL | Legacy. |
| `last_transition_id` | TEXT | NOT NULL | Legacy. |
| `last_emitted_by` | TEXT | NOT NULL | Legacy. |
| `created_at` | TEXT | NOT NULL | — |
| `updated_at` | TEXT | NOT NULL | **Legacy, no autoritativo** (no se puede hacer `DROP COLUMN` de una migración aplicada). |
| `is_terminal` | INTEGER | NOT NULL | `CHECK IN (0, 1)`. |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `task_read_model_by_state` | `INDEX (current_state, task_id)`, legacy. |
| Rebuild | Determinista desde `control_plane_events`. |

---

## 2. `task_revision_read_model`

**Aplicado en migración 11 (P-05/B)**, salvo la columna de artefacto que la fila
siguiente declara diferida. `revision_id` único, PK compuesta
`(task_id, revision_number)` (§6.1 canónico). Cambiar de cuenta no crea revisión;
cambiar cualquier campo del envelope, sí (§6.2 canónico).

La fila es **insert-only**: una segunda llegada a la misma coordenada con el mismo
contenido es replay idempotente y no escribe; con contenido distinto se rechaza.
`ON CONFLICT DO UPDATE` está prohibido — una revisión registra lo que se pidió, y
una coordenada sobreescribible haría de «revisión 2» el nombre del último evento
que llegó. **Todavía sin productor**: ninguna fila existe hasta P-18.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `task_id` | TEXT | NOT NULL | PK (compuesta). |
| `revision_number` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 1`. |
| `revision_id` | TEXT | NOT NULL | `UNIQUE`. Identificador global estable de esta revisión, para referenciarla sin la coordenada compuesta. |
| `envelope_sha256` | TEXT | NOT NULL | Cubre **todos** los campos de `TaskEnvelope` — objetivo, autoridad, `allowedCommands`, `forbiddenActions`, `conflictKeys`, reglas de validación, criterios de elegibilidad, forma de salida esperada, política de checkpoint, `visualEvidenceRequired`, clasificación y emisor de la autoridad (§6.2 canónico). **No** se duplica campo por campo acá: la preimagen exacta vive en el contrato maestro `kernel/contracts`. |
| `envelope_artifact_reference_id` | TEXT | NULL en la cohorte anterior; NOT NULL desde P-36/local | **Aditivo en P-36/local** (decisión 41): la columna no existe en las migraciones anteriores; `NULL` sólo en revisiones registradas antes de esa migración, y nunca se inventa una referencia por digest. El contenido íntegro del envelope es un artefacto de `artifact_class = 'TASK_ENVELOPE'` ([artifacts §2](../artifacts/index.md)). **Se recupera por esta referencia autorizada, no por el digest**: conocer `envelope_sha256` no concede acceso a los bytes. |
| `restored_from_revision_id` | TEXT | NULL | `NULL` salvo que esta revisión sea la restauración de un envelope anterior. Puede compartir `envelope_sha256` con la revisión restaurada: eso es exactamente el caso que impide una `UNIQUE(task_id, envelope_sha256)` (§7.3 canónico). |
| `created_at` | TEXT | NOT NULL | — |
| `created_by` | TEXT | NOT NULL | — |
| `contract_version` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

**No existe `UNIQUE(task_id, envelope_sha256)`.** Restaurar un envelope anterior es una
revisión nueva con el mismo digest; esa unicidad lo impediría (§7.3 canónico). Esto
**corrige** el modelo anterior, que no distinguía revisión de intento y no dejaba
espacio para esta semántica de restore.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_task_revision_read_model` | `PRIMARY KEY (task_id, revision_number)` |
| `ux_task_revision_read_model__revision_id` | `UNIQUE INDEX (revision_id)` |
| `ix_task_revision_read_model__envelope_sha256` | `INDEX (envelope_sha256, task_id, revision_number)` — resuelve "qué revisiones comparten este envelope", sin ser única. |
| Rebuild | Determinista; todo restore retiene el historial completo de revisiones anteriores (nunca se sobreescriben). |

---

## 3. `task_attempt_read_model`

**Nuevo.** PK `(task_id, revision_number, attempt_number)` (§6.1 canónico). Un
reintento de la misma revisión, no una revisión nueva.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `task_id` | TEXT | NOT NULL | PK (compuesta). |
| `revision_number` | INTEGER | NOT NULL | PK (compuesta). `fk_task_attempt_read_model__task_revision_read_model`. |
| `attempt_number` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 1`. Reinicia en 1 en cada revisión nueva — no colisiona con un restore porque la coordenada completa incluye la revisión (§7.1 canónico). |
| `legacy_attempt_number` | INTEGER | NOT NULL | Sin default. `CHECK (legacy_attempt_number >= 1)`. Asignación plana, monótona por tarea y estable para esta coordenada; se copia del evento V2 y coincide con `control_plane_events.attempt`. `UNIQUE (task_id, legacy_attempt_number)`; no es un contador por revisión ni una segunda autoridad ([streams §1.1](../streams/index.md#11-la-coordenada-v2-sobre-un-stream-que-no-se-puede-reescribir)). |
| `invocation_id` | TEXT | NOT NULL | Identidad durable neutral del run V1, registrada por el evento de apertura. `UNIQUE`; junto con la PK del intento fija la biyección. No es worker_run_id ni identificador privado de engine; replay y handoff la conservan. |
| `started_at` | TEXT | NOT NULL | — |
| `ended_at` | TEXT | NULL | `NULL` mientras el intento está en curso. |
| `outcome` | TEXT | NULL | `effect_outcome_status`: `CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED','FAILED','CANCELLED','OUTCOME_UNKNOWN'))`. `NULL` sii `ended_at IS NULL`. |
| `sequence` | INTEGER | NOT NULL | — |

`ck_task_attempt_read_model__outcome_pair`: `CHECK ((ended_at IS NULL) = (outcome IS NULL))`.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_task_attempt_read_model` | `PRIMARY KEY (task_id, revision_number, attempt_number)` |
| `ux_task_attempt_read_model__task_id_legacy_attempt_number` | `UNIQUE INDEX (task_id, legacy_attempt_number)` |
| `ux_task_attempt_read_model__invocation_id` | `UNIQUE INDEX (invocation_id)` |
| OCC / transacción | En `BEGIN IMMEDIATE`, se compara la cabeza esperada de la tarea y se busca la coordenada completa. Si ya existe, se reutilizan su asignación e invocation_id y se rechaza un invocationId distinto para la misma coordenada; si no, el evento fija invocationId y se asigna `1 + MAX(attempt)` de los eventos de esa tarea, incluidos los legacy (sin eventos: 1). Se rechaza el desborde de INTEGER int64. Evento V2, columna legacy `attempt`, proyección, cabeza y watermark se escriben en la misma transacción; ningún contador independiente ni escritura previa sólo en la proyección. |
| Rebuild | Determinista: copia `legacy_attempt_number` e `invocation_id` registrados por el evento V2, nunca vuelve a asignarlos ni usa el reloj. Todos los eventos de la misma coordenada deben repetirlo; otra coordenada de esa tarea no puede reutilizarlo. Los eventos legacy se conservan y no reciben revisiones inventadas. |

---

## 4. `execution_route_segment_read_model`

**Nuevo**, reemplaza hacia adelante a `execution_route_read_model` (§5 abajo, que
queda congelada para eventos legacy). Cada handoff produce un segmento nuevo, con
linaje explícito hacia el anterior (§6.1 canónico).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `route_segment_id` | TEXT | NOT NULL | PK. |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | — |
| `attempt_number` | INTEGER | NOT NULL | `fk_execution_route_segment_read_model__task_attempt_read_model` sobre `(task_id, revision_number, attempt_number)`. |
| `segment_number` | INTEGER | NOT NULL | `CHECK >= 1`, orden dentro del intento. |
| `predecessor_segment_id` | TEXT | NULL | `NULL` en el primer segmento del intento; en los siguientes, el `route_segment_id` del segmento que hizo handoff hacia éste. |
| `handoff_reason` | TEXT | NULL | `NULL` sii `predecessor_segment_id IS NULL`. |
| `provider` | TEXT | NOT NULL | — |
| `model` | TEXT | NOT NULL | Alias pedido. |
| `model_resolution_status` | TEXT | NOT NULL | `CHECK IN ('RESOLVED','UNKNOWN','NOT_OBSERVABLE')`. `RESOLVED` = `model_version_id` poblado; `UNKNOWN` = no se pudo resolver la versión exacta pese a intentarlo; `NOT_OBSERVABLE` = el transporte no expone versión resoluble. `model_version_id` permanece `NULL` en los dos últimos casos **incluso después de ejecutar** — nunca se inventa un valor para llenar la columna. |
| `model_version_id` | TEXT | NULL | Versión resuelta; `NULL` sii `model_resolution_status <> 'RESOLVED'`. |
| `account_id` | TEXT | NULL | `NULL` hasta que exista una reserva. |
| `transport_kind` | TEXT | NOT NULL | — |
| `capability_policy_version` | TEXT | NOT NULL | — |
| `routing_assignment_id` | TEXT | NULL | Ver [planning](../planning/index.md) §6; comprobación tipada, no FK física (cohortes distintas). |
| `reservation_id` | TEXT | NULL | Ver [accounts](../accounts/index.md); `NULL` hasta la reserva. |
| `escalated_from_attempt` | INTEGER | NULL | `NULL` salvo escalamiento; **no** referencia el legacy `attempt` plano — referencia `attempt_number` de este mismo `(task_id, revision_number)`. |
| `escalation_reason` | TEXT | NULL | Igual nulidad que `escalated_from_attempt`. |
| `resolved_at` | TEXT | NULL | `NULL` hasta resolución. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

`ck_execution_route_segment_read_model__handoff_pair`: `CHECK ((predecessor_segment_id IS NULL) = (handoff_reason IS NULL))`.
`ck_execution_route_segment_read_model__model_resolution_pair`: `CHECK ((model_resolution_status = 'RESOLVED') = (model_version_id IS NOT NULL))`.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_execution_route_segment_read_model` | `PRIMARY KEY (route_segment_id)` |
| `ux_execution_route_segment_read_model__attempt_segment` | `UNIQUE INDEX (task_id, revision_number, attempt_number, segment_number)` |
| `ix_execution_route_segment_read_model__account` | `INDEX (account_id, task_id)` |
| Rebuild | Determinista; varios handoffs en un intento quedan como linaje completo de segmentos (negativo obligatorio 4). |

---

### 4.1 Presión por generación de ruta — cierre requerido en P-20

La clave actual `pressure.<operationIndex>.<trailIndex>` omite generación
(`packages/domains/runtime/src/pressure/index.ts:65`; productores en
`packages/entrypoints/daemon/src/index.ts:916` y `:1251`). Origen y destino
pueden registrar la misma operación/trail con cuentas distintas y colisionar.
ADR 0046 lo difirió explícitamente; no se considera corregido hoy.

Forma objetivo única: `pressure.<generation>.<operationIndex>.<trailIndex>`,
tres enteros no negativos, siempre los tres presentes. Se pasa la generación
durable de landing, igual que `usageTransitionId`; en coordenada V2,
generation = segment_number - 1. No es contador local ni reloj, y la generación
cero no tiene una forma abreviada. La misma observación reentregada conserva
la clave; otro segmento usa otra. El índice de trail sigue siendo la posición
observada por ACP, no un ordinal inventado o repetido por el proveedor.

P-20 debe corregir el helper, ambos productores y sus pruebas espejo antes de
habilitar presión con handoffs; P-19 puede construir el parser, pero no habilita
esa combinación sin este cierre. Las claves de eventos históricos se preservan
y el lector mantiene su compatibilidad declarada. No se regraban observaciones
históricas bajo claves nuevas; reanudar un intento legacy sin un mapeo probado
a generación/segmento exige reconciliación, nunca asumir generación cero.

Negativo: misma tarea/intento/operación/trail reporta presión en tres segmentos:
tres hechos con cuentas/segmentos correctos y cero conflictos; repetir cada
observación no agrega filas. El fold mantiene filtros de tarea/intento y la
semántica de presión, no interpreta una fila de decisión como nueva observación.

---

## 5. `execution_route_read_model` (legacy, congelado)

**Hoy** (migración 6, inmutable). `(task_id, attempt)` es una clave legacy que **sólo**
sirve para los eventos ya escritos con esa forma; no recibe filas nuevas después de que
`execution_route_segment_read_model` entra en servicio (§7.2 canónico).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `task_id` | TEXT | NOT NULL | PK (compuesta). |
| `attempt` | INTEGER | NOT NULL | PK (compuesta). Contador plano, no revisión. |
| `provider` | TEXT | NOT NULL | — |
| `model` | TEXT | NOT NULL | — |
| `account_id` | TEXT | NOT NULL | — |
| `transport_kind` | TEXT | NOT NULL | — |
| `capability_policy_version` | TEXT | NOT NULL | — |
| `resolved_at` | TEXT | NOT NULL | — |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `execution_route_read_model_by_policy_version` | `INDEX (capability_policy_version, task_id, attempt)`, legacy. |
| `execution_route_read_model_by_account` | `INDEX (account_id, task_id, attempt)`, legacy. |
| Rebuild | Determinista sólo sobre el rango legacy del stream; congelado hacia adelante. |

---

## 6. `effect_read_model`

**Nuevo** (§11 canónico, saga). Proyecta intención y desenlace desde el ledger; no es
autoridad independiente — el efecto lógico se reconoce por la identidad del run,
scope semántico y paso lógico de §6.1, antes de asignar su coordenada física.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK. Conserva la fórmula existente sobre `(task_id, revision_number, attempt_number, segment_number, operation_ordinal)`, aplicada una sola vez con el segmento inicial después del lookup lógico de §6.1. Sólo una operación lógica nueva crea otro efecto; handoff no cambia el de una operación existente. |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | — |
| `attempt_number` | INTEGER | NOT NULL | — |
| `route_segment_id` | TEXT | NOT NULL | `fk_effect_read_model__execution_route_segment_read_model`; segmento **inicial**, inmutable. Los despachos posteriores guardan su propio segmento (§7). |
| `operation_ordinal` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `effect_kind` | TEXT | NOT NULL | Contrato de la operación de negocio; se valida con request_contract_version. |
| `semantic_scope_key` | TEXT | NOT NULL | LocalKey de §6.1; `run` en el mínimo P-18, estable durante el run. |
| `local_operation_key` | TEXT | NOT NULL | LocalKey de §6.1; paso lógico fijado antes de la intención, preservado en continuidad/checkpoint. |
| `logical_operation_sha256` | TEXT | NOT NULL | CHECK SHA común; UNIQUE, con verificación de la tupla completa en lookup/fold (§6.1). |
| `request_contract_version` | TEXT | NOT NULL | Versión exacta del schema de neutralRequest para effect_kind; no se usa una versión implícita o desconocida. |
| `request_sha256` | TEXT | NOT NULL | CHECK SHA común; digest de consistencia de §6.1, no otro effect_id. |
| `idempotency_key` | TEXT | NOT NULL | `UNIQUE`. Misma preimagen: `effect_kind` + `(task_id, revision_number, attempt_number, segment_number, operation_ordinal)` + `envelope_sha256`, con segmento inicial fijado sólo al crear el efecto. Replay/handoff conservan los bytes originales; reloj por defecto fuera (§6.3 canónico). |
| `intended_at` | TEXT | NOT NULL | Instante del `BEGIN IMMEDIATE` que registró la intención (§11 canónico paso 1). |
| `outcome_status` | TEXT | NULL | `CHECK (outcome_status IS NULL OR outcome_status IN ('SUCCEEDED','FAILED','CANCELLED','OUTCOME_UNKNOWN'))`. `NULL` antes de todo desenlace — una intención nunca despachada no es `OUTCOME_UNKNOWN`, es ausencia de dato. `OUTCOME_UNKNOWN` sólo se escribe cuando efectivamente se registra una exposición incierta (p. ej. tras agotar reconciliación de un `INFLIGHT` vencido), nunca como default de creación. No es fallo y no habilita reintento ciego (invariante 9 canónica). |
| `outcome_recorded_at` | TEXT | NULL | Igual nulidad que `outcome_status`: `NULL` sii `outcome_status IS NULL`. |
| `sequence` | INTEGER | NOT NULL | — |

`ck_effect_read_model__outcome_pair`: `CHECK ((outcome_status IS NULL) = (outcome_recorded_at IS NULL))`.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_effect_read_model` | `PRIMARY KEY (effect_id)` |
| `ux_effect_read_model__idempotency_key` | `UNIQUE INDEX (idempotency_key)` |
| `ux_effect_read_model__logical_operation_sha256` | `UNIQUE INDEX (logical_operation_sha256)` |
| `ix_effect_read_model__segment` | `INDEX (route_segment_id, operation_ordinal)` |
| Transacción | Fold del paso 1 (intención) y del paso 6 (desenlace) de §11 canónico; cada uno en la transacción del `appendBatch` correspondiente. |
| Rebuild | Determinista desde `control_plane_events`. |

---

### 6.1 Identidad lógica mínima y lookup — P-18/M4

Estos campos pertenecen al mínimo de recuperación, antes de P-23. No se crea una
tabla execution_run 1:1: invocation_id se obtiene de task_attempt_read_model.
LocalKey es string ASCII `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, comparación ordinal;
no es ruta ni glob. P-18 usa semantic_scope_key=`run`; el driver fija una
local_operation_key estable del paso antes de la intención y la conserva en
checkpoint. Composición puede declarar subscopes, pero no renombrar el mismo
trabajo ni hacer que la identidad dependa del perfil, cuenta o segmento.

Preimágenes adicionales de **búsqueda y consistencia**, no sustituciones:

```
logical_operation_sha256 = SHA256(canonicalJson([
 "execution-logical-operation",1,invocation_id,semantic_scope_key,local_operation_key
]))
request_sha256 = SHA256(canonicalJson([
 "execution-logical-request",1,effect_kind,request_contract_version,
 envelope_sha256,neutralRequest
]))
```

neutralRequest es el payload de negocio validado por el schema exacto de
effect_kind/request_contract_version. Referencias/digests de artefacto forman
parte de él; datos resueltos de dispatch (segmento, cuenta, perfil, fence, handle)
no. No se introducen bytes de prompt en el evento ni se acepta un hash del caller
sin comprobar las fuentes. canonicalJson es el formato del ledger; claves y
listas de conjunto se normalizan según el contrato neutral de esa operación.

En BEGIN IMMEDIATE, **antes** de asignar ordinal o derivar effect_id:

1. Buscar por logical_operation_sha256 y comprobar la tupla completa usando el
   invocation_id del intento. Si existe, comparar también effect_kind,
   request_contract_version, envelope y request_sha256: diferencia => CONFLICT;
   igualdad => effect_id/idempotency_key originales, sin ordinal ni intención
   nuevos. Un desenlace terminal se reutiliza; uno incierto exige reconciliar.
2. Si no existe, comprobar límites aplicables, asignar ordinal y usar la fórmula
   canónica vigente con el segmento inicial actual. Append de intención, índice
   lógico, proyecciones, hashes/cabezas y watermark en la misma transacción.
   Un competidor que pierde UNIQUE relee y aplica el punto 1; nunca cambia la
   clave para convertir el conflicto en operación nueva.

Sólo una entrega realmente nueva y autorizada crea un dispatch_attempt; repetir
la misma petición/id de despacho es replay, no permiso de enviar otra vez.
Cambiar cuenta/proveedor no transporta mágicamente la garantía de idempotencia:
sin no-despacho demostrado o idempotencia aplicable al destino, OUTCOME_UNKNOWN
bloquea el reenvío incluso si el destino tiene un preflight verde.

Fold/rebuild comprueban los digests contra intención/fuentes y conservan los
valores registrados; no los recalculan con la configuración o segmento actuales.
NOT NULL se exige en eventos nuevos de este contrato. Historia legacy no se
rehashea ni recibe claves adivinadas; continuidad legacy sin identidad probada
se rechaza hasta reconciliación explícita. P-23 sólo añade selección/owners:
no otro índice lógico ni preflights históricos ficticios.

Negativo mínimo P-18: perder acuse → handoff → repetir scope/local_operation_key
devuelve el effect_id original y exige reconciliación, sin nueva intención ni
nuevo envío. Payload distinto bajo esa clave rechaza. Despacho posterior realmente
autorizado conserva el efecto inicial y registra el segmento efectivo aparte.

---

## 7. `dispatch_attempt_read_model`

**Nuevo.** Cada intento de despacho es una entrega externa concreta del mismo efecto
lógico; retransmitir no crea un efecto nuevo, sí un `dispatch_attempt_id` nuevo (§6.1
canónico).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `dispatch_attempt_id` | TEXT | NOT NULL | PK. |
| `effect_id` | TEXT | NOT NULL | `fk_dispatch_attempt_read_model__effect_read_model`. |
| `route_segment_id` | TEXT | NOT NULL | `fk_dispatch_attempt_read_model__execution_route_segment_read_model`; segmento efectivo de **esta entrega**, fijado por su intención. Puede diferir del segmento inicial del efecto, nunca de su intento/run. |
| `attempt_ordinal` | INTEGER | NOT NULL | `CHECK >= 1`; orden de entrega dentro del mismo `effect_id`. |
| `provider_idempotency_key` | TEXT | NULL | `NULL` hasta el paso 5 de §11 canónico (clave de idempotencia del proveedor). |
| `external_handle` | TEXT | NULL | Handle externo registrado; opaco, no secreto. `NULL` hasta que el proveedor lo entrega. |
| `dispatch_state` | TEXT | NOT NULL | `CHECK IN ('INTENDED','CLAIMED','INFLIGHT','SETTLED','ABANDONED')`. |
| `requested_at` | TEXT | NOT NULL | — |
| `accepted_at` | TEXT | NULL | `NULL` mientras no hubo aceptación externa real: `CLAIMED` (reclamado localmente) **no** implica aceptación del proveedor — sólo se puebla al entrar a `INFLIGHT` con confirmación externa, o directamente en `SETTLED` si el proveedor no distingue aceptación de resultado. |
| `terminal_at` | TEXT | NULL | `NULL` mientras `dispatch_state NOT IN ('SETTLED','ABANDONED')`; explícito y obligatorio en ambos. Un `ABANDONED` puede ocurrir antes de cualquier despacho real, en cuyo caso `accepted_at` permanece `NULL`. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

La intención del despacho fija route_segment_id antes de enviar. El fold exige
que ese segmento y el efecto compartan (task_id,revision_number,attempt_number),
pero **no exige igualdad con effect.route_segment_id**, que conserva el origen.
FKs de esta cohorte usan ON DELETE RESTRICT y DEFERRABLE cuando el appendBatch
materializa las fuentes juntas. Rebuild conserva cada destino registrado.

Un `INFLIGHT` vencido habilita **reconciliación**, no reintento (§11 canónico). La
reconciliación se hace por `external_handle` o por postcondición, nunca reintentando a
ciegas sobre un intento incierto.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_dispatch_attempt_read_model` | `PRIMARY KEY (dispatch_attempt_id)` |
| `ux_dispatch_attempt_read_model__effect_ordinal` | `UNIQUE INDEX (effect_id, attempt_ordinal)` |
| `ix_dispatch_attempt_read_model__state` | `INDEX (dispatch_state, terminal_at)`, para el sondeo de `INFLIGHT` vencidos. |
| Rebuild | Determinista. |

---

## 8. `prompt_occurrence_read_model` y `response_occurrence_read_model`

**Nuevo**, reemplaza a `prompt_record_read_model` (PK legado `prompt_sha256`, que
mezclaba identidad de bytes con ocurrencia de uso). Los mismos bytes de prompt
enviados dos veces son dos ocurrencias, un solo blob (negativo obligatorio 3).

### 8.1 `prompt_occurrence_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `occurrence_id` | TEXT | NOT NULL | PK. |
| `route_segment_id` | TEXT | NOT NULL | `fk_prompt_occurrence_read_model__execution_route_segment_read_model`; segmento efectivo del despacho enlazado, no inferido desde el origen del efecto. |
| `effect_id` | TEXT | NOT NULL | `fk_prompt_occurrence_read_model__effect_read_model`. |
| `dispatch_attempt_id` | TEXT | NOT NULL | `fk_prompt_occurrence_read_model__dispatch_attempt_read_model`; la ocurrencia registra el despacho que la produjo. Varios prompts pueden pertenecer a un despacho; esta FK no es UNIQUE. |
| `ordinal` | INTEGER | NOT NULL | `CHECK >= 0`, orden dentro del segmento. |
| `identity` | TEXT | NOT NULL | Identidad del worker que emitió el prompt. |
| `requested_model_id` | TEXT | NOT NULL | Alias/modelo pedido, preservado siempre — mismo contrato que `execution_route_segment_read_model.model` (§4), incluso cuando la resolución falla. |
| `provider` | TEXT | NOT NULL | Preservado siempre, mismo contrato que §4. |
| `model_resolution_status` | TEXT | NOT NULL | `CHECK IN ('RESOLVED','UNKNOWN','NOT_OBSERVABLE')`. Mismo vocabulario que `execution_route_segment_read_model` (§4): ambas tablas siguen idéntico contrato de ausencia de dato. |
| `model_version_id` | TEXT | NULL | `NULL` sii `model_resolution_status <> 'RESOLVED'`, incluso tras ejecutar. |
| `account_id` | TEXT | NOT NULL | — |
| `prompt_sha256` | TEXT | NOT NULL | Digest del blob (ver [artifacts](../artifacts/index.md)); **no es único** — el mismo digest puede repetirse en ocurrencias distintas. |
| `prompt_bytes` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `context_sha256` | TEXT | NULL | `NULL` cuando el prompt no lleva contexto adicional direccionado por separado. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### 8.2 `response_occurrence_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `occurrence_id` | TEXT | NOT NULL | PK, propio (distinto del `occurrence_id` del prompt que responde). |
| `prompt_occurrence_id` | TEXT | NOT NULL | `fk_response_occurrence_read_model__prompt_occurrence_read_model`. |
| `response_sha256` | TEXT | NOT NULL | — |
| `response_bytes` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `redaction_verdict` | TEXT | NOT NULL | `CHECK IN ('CLEAN','REDACTED')`. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

`ck_prompt_occurrence_read_model__model_resolution_pair`: `CHECK ((model_resolution_status = 'RESOLVED') = (model_version_id IS NOT NULL))`.

El fold comprueba igualdad de effect_id y route_segment_id entre prompt y
su dispatch_attempt. La respuesta conserva su enlace existente al prompt:
una respuesta tardía del origen no se atribuye a la cuenta/segmento destino.
Evento de ocurrencia, fila y watermark se confirman juntos, después de registrar
la intención de ese despacho o en el mismo appendBatch en orden causal. No se
crean ocurrencias para llamadas internas que un transporte no hace observables.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_prompt_occurrence_read_model` | `PRIMARY KEY (occurrence_id)` |
| `ix_prompt_occurrence_read_model__segment` | `INDEX (route_segment_id, ordinal)` |
| `ix_prompt_occurrence_read_model__sha256` | `INDEX (prompt_sha256)`, no única — a propósito. |
| `pk_response_occurrence_read_model` | `PRIMARY KEY (occurrence_id)` |
| `ux_response_occurrence_read_model__prompt` | `UNIQUE INDEX (prompt_occurrence_id)` — una respuesta por ocurrencia de prompt. |
| Rebuild | Determinista. Nunca bytes de prompt/respuesta en estas filas, sólo digests y conteos (invariante 1 canónica). |

---

## 9. `tool_call_read_model`

**Nuevo**, corrige el defecto legado (`transition_id` como PK, que no distingue dos
ejecuciones del mismo punto tras un reintento).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK. Identidad del tool call (§7.6 canónico). |
| `transition_id` | TEXT | NOT NULL | **Ya no es PK por sí solo.** Se conserva por trazabilidad hacia el evento fuente. |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `attempt_number` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `server_id` | TEXT | NOT NULL | — |
| `tool_name` | TEXT | NOT NULL | — |
| `argument_bytes` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `result_bytes` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `outcome` | TEXT | NOT NULL | — |
| `postcondition` | TEXT | NOT NULL | `CHECK IN ('SETTLED','UNKNOWN')`. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_tool_call_read_model` | `PRIMARY KEY (effect_id)` |
| `ix_tool_call_read_model__transition` | `INDEX (transition_id)` |
| Rebuild | Determinista. |

---

## 10. `checkpoint_read_model`, `verification_read_model`, `audit_verdict_read_model`, `commit_read_model`

**Nuevo** (el store de bytes ya existe, pero nadie produce la proyección
hoy). Migradas de `attempt` plano a `(revision_number, attempt_number)`.

### 10.1 `checkpoint_read_model`

Proyección de metadata del checkpoint registrado, no un segundo store de bytes.
Tabla `STRICT`. Todas las columnas carecen de default: el fold debe aportar cada
valor explícitamente. Los digests identifican contenido; no conceden acceso al
artefacto privado ([artifacts](../artifacts/index.md)).

| Columna | Tipo SQL | Nullable / default / dominio | Clave / referencia | Fuente y semántica |
| --- | --- | --- | --- | --- |
| `checkpoint_sha256` | TEXT | NOT NULL; sin default; SHA-256 según §3.4 canónico | `pk_checkpoint_read_model` | Digest del checkpoint completo validado, no de esta proyección parcial. |
| `task_id` | TEXT | NOT NULL; sin default; identificador de tarea del evento | Componente de `fk_checkpoint_read_model__task_attempt_read_model` | Igual al sujeto del evento `CHECKPOINT_WRITTEN`. |
| `revision_number` | INTEGER | NOT NULL; sin default; `CHECK (revision_number >= 1)` | Componente de la FK de intento | Igual a la revisión V2 del evento. |
| `attempt_number` | INTEGER | NOT NULL; sin default; `CHECK (attempt_number >= 1)` | Componente de la FK de intento | Igual al intento V2 del evento, nunca al `attempt` plano legacy. |
| `route_segment_id` | TEXT | NOT NULL; sin default; identificador de segmento | `fk_checkpoint_read_model__execution_route_segment_read_model` | Segmento que produjo el checkpoint; su tarea/revisión/intento deben coincidir con esta fila. |
| `step_index` | INTEGER | NOT NULL; sin default; `CHECK (step_index BETWEEN 0 AND 10000)` | Sin clave ni referencia | `lastAtomicStep.index`: último paso atómico realmente completado, no un paso parcial. |
| `head_sha` | TEXT | NOT NULL; sin default; `CHECK (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*')` | Referencia a objeto Git validada en el borde, no FK SQL | `git.head`: commit completo de 40 hex minúsculas, conforme al contrato `GitCommitSha` vigente. |
| `authority_sha256` | TEXT | NOT NULL; sin default; SHA-256 según §3.4 canónico | Sin clave ni FK | Digest del valor completo `authorityDigest` del checkpoint. |
| `read_set_sha256` | TEXT | NOT NULL; sin default; SHA-256 según §3.4 canónico | Sin clave ni FK | Digest del valor completo `readSetDigest` del checkpoint. |
| `write_set_sha256` | TEXT | NOT NULL; sin default; SHA-256 según §3.4 canónico | Sin clave ni FK | Digest del valor completo `writeSetDigest` del checkpoint. |
| `pending_work_count` | INTEGER | NOT NULL; sin default; `CHECK (pending_work_count BETWEEN 0 AND 100)` | Sin clave ni referencia | Longitud de `pendingWork`, no contenido de sus entradas. |
| `next_safe_action_sha256` | TEXT | NOT NULL; sin default; SHA-256 según §3.4 canónico | Sin clave ni FK | Digest del valor completo `nextSafeAction`; la acción privada no se copia a SQL. |
| `recorded_at` | TEXT | NOT NULL; sin default; instante canónico ISO-8601 ms UTC (§3.4 canónico) | Sin clave ni referencia | `recorded_at` del primer evento que registra este checkpoint; no reloj del rebuild ni `createdAt` del blob. |
| `sequence` | INTEGER | NOT NULL; sin default; `CHECK (sequence >= 1)` | `fk_checkpoint_read_model__control_plane_events` | Secuencia del mismo evento de registro en `control_plane_events`. |

Los límites 10000/100 y el SHA Git de 40 caracteres preservan el contrato
`packages/kernel/contracts/src/schemas/checkpoint/index.ts` y sus primitivas; no
se ensanchan silenciosamente al crear la proyección. Para cada columna
`c ∈ {checkpoint_sha256, authority_sha256, read_set_sha256, write_set_sha256,
next_safe_action_sha256}`, se materializa un CHECK nombrado
`ck_checkpoint_read_model__<c>_shape` con la expresión SQL
`CHECK (length(c) = 64 AND c NOT GLOB '*[^0-9a-f]*')`, sustituyendo `c` por el
nombre real de columna. El CHECK de forma de `recorded_at` es:

```sql
CHECK (length(recorded_at) = 24 AND recorded_at GLOB
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
```

Se llama `ck_checkpoint_read_model__recorded_at_shape`; además, el borde valida
calendario real antes del append. Cada CHECK numérico se nombra
`ck_checkpoint_read_model__<columna>_range`, y el SHA Git,
`ck_checkpoint_read_model__head_sha_shape`.

| Objeto | Forma |
| --- | --- |
| `pk_checkpoint_read_model` | `PRIMARY KEY (checkpoint_sha256)` |
| `fk_checkpoint_read_model__task_attempt_read_model` | `FOREIGN KEY (task_id, revision_number, attempt_number) REFERENCES task_attempt_read_model(task_id, revision_number, attempt_number) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED` |
| `fk_checkpoint_read_model__execution_route_segment_read_model` | `FOREIGN KEY (route_segment_id) REFERENCES execution_route_segment_read_model(route_segment_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED` |
| `fk_checkpoint_read_model__control_plane_events` | `FOREIGN KEY (sequence) REFERENCES control_plane_events(sequence) ON DELETE RESTRICT` |
| `ix_checkpoint_read_model__attempt` | `INDEX (task_id, revision_number, attempt_number)`, el índice común de §10; se crea una sola vez. |
| Validación de referencia | Además de las FK, el productor y el fold comprueban que el segmento y el evento referidos tienen la misma tarea/revisión/intento que esta fila; una discrepancia rehúsa, no se corrige reasignando el checkpoint. |
| OCC / transacción | Sólo el projector escribe esta proyección. Registro de `CHECKPOINT_WRITTEN`, cabeza del stream, inserción de metadata y avance de `projection_watermark` ocurren en el mismo `appendBatch`. Un checkpoint nuevo no sustituye filas anteriores. |
| Fold / rebuild | Toma los escalares de metadata registrados por `CHECKPOINT_WRITTEN` V2, a un corte de `control_plane_events` fijado y verificado. No vuelve a abrir el blob ni calcula digests durante rebuild. Una repetición idempotente conserva la fila y el primer `sequence`/`recorded_at`; el mismo `checkpoint_sha256` con metadata distinta es corrupción y rehúsa. |

**Fuente suficiente para el fold.** El payload versionado de `CHECKPOINT_WRITTEN`
lleva `checkpoint_sha256`, `route_segment_id`, `step_index`, `head_sha`,
`authority_sha256`, `read_set_sha256`, `write_set_sha256`, `pending_work_count` y
`next_safe_action_sha256`; las otras columnas se toman del sobre V2 y de la
secuencia asignada al append. El productor calcula los cuatro digests de campos
con SHA-256 sobre sus valores JSON canónicos completos en UTF-8 conforme al
contrato versionado del checkpoint, y valida esas nueve piezas de metadata contra
el checkpoint antes de registrarlas. Los arrays vacíos y la cadena de próxima
acción siguen siendo valores reales, nunca un digest inventado como sustituto de
un dato ausente. El digest del checkpoint completo y la referencia autorizada a
su artefacto conservan los bytes existentes; esta tabla no cambia su formato ni
concede acceso por digest.

### 10.2 `verification_read_model`

PK `receipt_sha256`. El receipt referencia un artefacto privado por **`artifact_ref_id`
autorizado**, no sólo por su digest — compartir un digest no concede acceso a los bytes
(§12 canónico); ver [artifacts](../artifacts/index.md).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `receipt_sha256` | TEXT | NOT NULL | PK. |
| `task_id` | TEXT | NOT NULL | tarea verificada. |
| `revision_number` | INTEGER | NOT NULL | `ck_verification_read_model__revision_number_positive`: `> 0`. |
| `attempt_number` | INTEGER | NOT NULL | `ck_verification_read_model__attempt_number_positive`: `> 0`. |
| `verifier_identity` | TEXT | NOT NULL | identidad uniforme del verificador. |
| `verifier_worker_id` | TEXT | NOT NULL | identidad de instancia **emitida por el supervisor**; es la que decide, no la etiqueta de rol. |
| `verifier_run_id` | TEXT | NOT NULL | corrida concreta del verificador. |
| `writer_identity` | TEXT | NOT NULL | identidad uniforme del writer. |
| `writer_worker_id` | TEXT | NOT NULL | identidad de instancia del writer. `ck_verification_read_model__distinct_workers`: `CHECK (verifier_worker_id <> writer_worker_id)`. |
| `base_sha` | TEXT | NOT NULL | **el commit base** sobre el que se verificó; no es un árbol. |
| `tree_sha` | TEXT | NOT NULL | SHA del árbol resultante verificado. |
| `policy_sha256` | TEXT | NOT NULL | Digest de la política de verificación aplicada. |
| `write_set_sha256` | TEXT | NOT NULL | Digest del write-set verificado contra la política del envelope. |
| `artifact_ref_id` | TEXT | NOT NULL | Referencia de acceso autorizada al artefacto privado del receipt completo (checks detallados); ver [artifacts](../artifacts/index.md) — **no** el mero `checks_sha256`, que sólo identifica bytes. |
| `checks_sha256` | TEXT | NOT NULL | Digest de los checks ejecutados. |
| `run_status` | TEXT | NOT NULL | `CHECK IN ('PASS','FAIL')`. Independiente de `all_checks_zero`: éste resume el conteo, aquél el veredicto de ejecución del run de verificación en sí. |
| `all_checks_zero` | INTEGER | NOT NULL | `CHECK IN (0, 1)`. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### 10.3 `audit_verdict_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `audit_id` | TEXT | NOT NULL | PK. |
| `task_id` | TEXT | NOT NULL | tarea auditada. |
| `revision_number` | INTEGER | NOT NULL | `ck_audit_verdict_read_model__revision_number_positive`: `> 0`. |
| `attempt_number` | INTEGER | NOT NULL | `ck_audit_verdict_read_model__attempt_number_positive`: `> 0`. |
| `auditor_identity` | TEXT | NOT NULL | identidad uniforme del auditor. |
| `auditor_worker_id` | TEXT | NOT NULL | identidad de instancia emitida por el supervisor. `ck_audit_verdict_read_model__distinct_from_writer`: distinta de la del writer. |
| `verdict` | TEXT | NOT NULL | `ck_audit_verdict_read_model__verdict`: `CHECK (verdict IN ('ACCEPT','ACCEPT_WITH_CORRECTIONS','REJECT'))`. |
| `evidence_sha256` | TEXT | NOT NULL | digest de la evidencia. |
| `artifact_ref_id` | TEXT | NOT NULL | referencia de acceso autorizada a la evidencia; conocer el digest no concede acceso. |
| `recorded_at` | TEXT | NOT NULL | instante del append. |
| `sequence` | INTEGER | NOT NULL | secuencia del evento; `> 0`. |

### 10.4 `commit_read_model`

PK `commit_sha` — el SHA de commit **observado**, registrado sólo tras verificación
independiente; un `fk_commit_read_model__verification_read_model` por sí solo no
autoriza nada, es sólo trazabilidad.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `commit_sha` | TEXT | NOT NULL | PK. SHA observado del commit real en Git, registrado después de un `PASS` independiente. |
| `task_id` | TEXT | NOT NULL | tarea. |
| `revision_number` | INTEGER | NOT NULL | `ck_commit_read_model__revision_number_positive`: `> 0`. |
| `attempt_number` | INTEGER | NOT NULL | `ck_commit_read_model__attempt_number_positive`: `> 0`. |
| `receipt_sha256` | TEXT | NOT NULL | `fk_commit_read_model__verification_read_model`. |
| `revalidated_base_sha` | TEXT | NOT NULL | commit base revalidado **al momento del commit**, no copiado del receipt. **Debe ser igual** a `verification_read_model.base_sha`. |
| `revalidated_tree_sha` | TEXT | NOT NULL | árbol revalidado; **debe ser igual** a `verification_read_model.tree_sha`. |
| `revalidated_write_set_sha256` | TEXT | NOT NULL | write-set revalidado; **igualdad exacta** contra el autorizado, nunca una aproximación. |
| `worktree_sha256` | TEXT | NOT NULL | digest del worktree en el momento del commit. |
| `authorized_at` | TEXT | NOT NULL | instante de la autorización, tomado del evento. |
| `recorded_at` | TEXT | NOT NULL | instante del append. |
| `sequence` | INTEGER | NOT NULL | secuencia del evento que produjo la fila; `> 0`. |

**La revalidación no admite diferencias.** El commit exige las tres igualdades de
arriba **más** un `PASS` independiente **antes** de tocar Git. Cualquier diferencia
invalida el receipt y obliga a una verificación nueva: no se commitea sobre una
base que se movió. Una clave foránea por sí sola no autoriza nada.

### Índices / OCC / transacción / rebuild (las cuatro)

| Objeto | Forma |
| --- | --- |
| `ix_<tabla>__attempt` | `INDEX (task_id, revision_number, attempt_number)` en cada una. |
| Rebuild | Determinista desde `control_plane_events`. |

---

## 11. Anomalías: evaluación, fuentes y muestras

Sustituye la forma propuesta (no aplicada) con kind/observed_value/baseline_median
y action=PAUSED|NOTIFIED. Ese action confundía intención con confirmación; dinero
no podía conservar su racional exacto. No se toca una migración histórica.
Dueño economy; proyecciones de control_plane_events de una tarea real. Algoritmo
en [interacción §5](../../contracts/interaction/index.md), primitiva estadística
única en estimation. No es autoridad nueva de uso, precios ni desempeño.

El SQL siguiente es completo para las tablas nuevas, sin defaults implícitos.
Los CHECK de fecha fijan representación; el schema de admisión exige además que
parsear y volver a serializar produzca exactamente la misma fecha UTC válida.
Cada referencia a policy exige documento/version/digest/artefacto coincidentes.
FK sólo entre tablas de la misma cohorte; las referencias cross-stream/artefactos
son tipadas y se validan antes del append y durante rebuild. No FK al outbox.
No se ejecuta este DDL contra el checkout vivo ni se reescriben migraciones aplicadas.

```sql
CREATE TABLE anomaly_read_model (
  anomaly_id TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__anomaly_id CHECK (length(anomaly_id) = 64 AND anomaly_id NOT GLOB '*[^0-9a-f]*'),
  task_id TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__task_id CHECK (length(task_id) > 0),
  revision_number INTEGER NOT NULL CONSTRAINT ck_anomaly_read_model__revision_number CHECK (typeof(revision_number) = 'integer' AND revision_number >= 1),
  attempt_number INTEGER NOT NULL CONSTRAINT ck_anomaly_read_model__attempt_number CHECK (typeof(attempt_number) = 'integer' AND attempt_number >= 1),
  metric TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__metric CHECK (metric IN ('TOTAL_TOKENS','EQUIVALENT_COST_NANOS','ACTIVE_WORK_SECONDS')),
  unit TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__unit CHECK (unit IN ('TOKENS','NANOS','SECONDS')),
  currency TEXT CONSTRAINT ck_anomaly_read_model__currency CHECK (currency IS NULL OR (length(currency)=3 AND currency NOT GLOB '*[^A-Z]*')),
  policy_document_id TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__policy_document_id CHECK (length(policy_document_id) > 0),
  policy_version INTEGER NOT NULL CONSTRAINT ck_anomaly_read_model__policy_version CHECK (typeof(policy_version) = 'integer' AND policy_version >= 1),
  policy_sha256 TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__policy_sha256 CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__policy_artifact_reference_id CHECK (length(policy_artifact_reference_id) > 0),
  source_cut_sha256 TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__source_cut_sha256 CHECK (length(source_cut_sha256) = 64 AND source_cut_sha256 NOT GLOB '*[^0-9a-f]*'),
  inputs_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__inputs_artifact_reference_id CHECK (length(inputs_artifact_reference_id) > 0),
  evaluated_at TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__evaluated_at CHECK (length(evaluated_at) = 24 AND evaluated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  recorded_at TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__recorded_at CHECK (length(recorded_at) = 24 AND recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  observed_status TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__observed_status CHECK (observed_status IN ('KNOWN','UNKNOWN')),
  observed_numerator TEXT CONSTRAINT ck_anomaly_read_model__observed_numerator CHECK (observed_numerator IS NULL OR ((observed_numerator = '0' OR (length(observed_numerator) > 0 AND substr(observed_numerator,1,1) GLOB '[1-9]' AND observed_numerator NOT GLOB '*[^0-9]*')))),
  observed_denominator INTEGER CONSTRAINT ck_anomaly_read_model__observed_denominator CHECK (observed_denominator IS NULL OR (typeof(observed_denominator) = 'integer' AND observed_denominator >= 1)),
  baseline_status TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__baseline_status CHECK (baseline_status IN ('KNOWN','UNKNOWN')),
  baseline_numerator TEXT CONSTRAINT ck_anomaly_read_model__baseline_numerator CHECK (baseline_numerator IS NULL OR ((baseline_numerator = '0' OR (length(baseline_numerator) > 0 AND substr(baseline_numerator,1,1) GLOB '[1-9]' AND baseline_numerator NOT GLOB '*[^0-9]*')))),
  baseline_denominator INTEGER CONSTRAINT ck_anomaly_read_model__baseline_denominator CHECK (baseline_denominator IS NULL OR (typeof(baseline_denominator) = 'integer' AND baseline_denominator >= 1)),
  sample_count INTEGER NOT NULL CONSTRAINT ck_anomaly_read_model__sample_count CHECK (typeof(sample_count) = 'integer' AND sample_count >= 0),
  decision TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__decision CHECK (decision IN ('NORMAL','DETECTED','UNDETERMINED')),
  reason_code TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__reason_code CHECK (reason_code IN ('THRESHOLD_EXCEEDED','WITHIN_THRESHOLD','OBSERVATION_UNKNOWN','INSUFFICIENT_SAMPLES','STALE_SAMPLES','COHORT_UNAVAILABLE','UNIT_MISMATCH')),
  requested_action TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__requested_action CHECK (requested_action IN ('NONE','NOTIFY','PAUSE')),
  action_state TEXT NOT NULL CONSTRAINT ck_anomaly_read_model__action_state CHECK (action_state IN ('NOT_REQUESTED','REQUESTED','CONFIRMED','UNKNOWN')),
  action_key TEXT CONSTRAINT ck_anomaly_read_model__action_key CHECK (action_key IS NULL OR (length(action_key) = 64 AND action_key NOT GLOB '*[^0-9a-f]*')),
  confirmation_stream TEXT CONSTRAINT ck_anomaly_read_model__confirmation_stream CHECK (confirmation_stream IS NULL OR (confirmation_stream IN ('control_plane_events','initiative_events','account_events','registry_events'))),
  confirmation_sequence INTEGER CONSTRAINT ck_anomaly_read_model__confirmation_sequence CHECK (confirmation_sequence IS NULL OR (typeof(confirmation_sequence) = 'integer' AND confirmation_sequence >= 1)),
  confirmation_sha256 TEXT CONSTRAINT ck_anomaly_read_model__confirmation_sha256 CHECK (confirmation_sha256 IS NULL OR (length(confirmation_sha256) = 64 AND confirmation_sha256 NOT GLOB '*[^0-9a-f]*')),
  sequence INTEGER NOT NULL CONSTRAINT ck_anomaly_read_model__sequence CHECK (typeof(sequence) = 'integer' AND sequence >= 1),
  CONSTRAINT pk_anomaly_read_model PRIMARY KEY (anomaly_id),
  CONSTRAINT fk_anomaly_read_model__task_attempt_read_model FOREIGN KEY (task_id,revision_number,attempt_number) REFERENCES task_attempt_read_model(task_id,revision_number,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT ck_anomaly_read_model__metric CHECK ((metric='TOTAL_TOKENS' AND unit='TOKENS' AND currency IS NULL) OR (metric='ACTIVE_WORK_SECONDS' AND unit='SECONDS' AND currency IS NULL) OR (metric='EQUIVALENT_COST_NANOS' AND unit='NANOS' AND currency IS NOT NULL)),
  CONSTRAINT ck_anomaly_read_model__observed CHECK (((observed_status='UNKNOWN')=(observed_numerator IS NULL)) AND ((observed_numerator IS NULL)=(observed_denominator IS NULL))),
  CONSTRAINT ck_anomaly_read_model__baseline CHECK (((baseline_status='UNKNOWN')=(baseline_numerator IS NULL)) AND ((baseline_numerator IS NULL)=(baseline_denominator IS NULL))),
  CONSTRAINT ck_anomaly_read_model__decision CHECK ((decision='NORMAL' AND reason_code='WITHIN_THRESHOLD' AND observed_status='KNOWN' AND baseline_status='KNOWN') OR (decision='DETECTED' AND reason_code='THRESHOLD_EXCEEDED' AND observed_status='KNOWN' AND baseline_status='KNOWN') OR (decision='UNDETERMINED' AND reason_code IN ('OBSERVATION_UNKNOWN','INSUFFICIENT_SAMPLES','STALE_SAMPLES','COHORT_UNAVAILABLE','UNIT_MISMATCH'))),
  CONSTRAINT ck_anomaly_read_model__action CHECK (((action_state='NOT_REQUESTED') = (action_key IS NULL)) AND ((requested_action='NONE') = (action_state='NOT_REQUESTED')) AND (decision='DETECTED' OR action_state='NOT_REQUESTED')),
  CONSTRAINT ck_anomaly_read_model__confirmation CHECK (((action_state='CONFIRMED')=(confirmation_stream IS NOT NULL)) AND ((confirmation_stream IS NULL)=(confirmation_sequence IS NULL)) AND ((confirmation_sequence IS NULL)=(confirmation_sha256 IS NULL)))
);
CREATE INDEX ix_anomaly_read_model__task ON anomaly_read_model(task_id,revision_number,attempt_number,recorded_at);
CREATE UNIQUE INDEX ux_anomaly_read_model__action ON anomaly_read_model(action_key) WHERE action_key IS NOT NULL;

CREATE TABLE anomaly_source_head_read_model (
  anomaly_id TEXT NOT NULL CONSTRAINT ck_anomaly_source_head_read_model__anomaly_id CHECK (length(anomaly_id) = 64 AND anomaly_id NOT GLOB '*[^0-9a-f]*'),
  source_stream TEXT NOT NULL CONSTRAINT ck_anomaly_source_head_read_model__source_stream CHECK (source_stream IN ('control_plane_events','initiative_events','account_events','registry_events')),
  source_sequence INTEGER NOT NULL CONSTRAINT ck_anomaly_source_head_read_model__source_sequence CHECK (typeof(source_sequence) = 'integer' AND source_sequence >= 0),
  source_sha256 TEXT NOT NULL CONSTRAINT ck_anomaly_source_head_read_model__source_sha256 CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT pk_anomaly_source_head_read_model PRIMARY KEY (anomaly_id,source_stream),
  CONSTRAINT fk_anomaly_source_head_read_model__anomaly_read_model FOREIGN KEY (anomaly_id) REFERENCES anomaly_read_model(anomaly_id) ON DELETE RESTRICT,
  CONSTRAINT ck_anomaly_source_head_read_model__genesis CHECK (source_sequence <> 0 OR source_sha256 = '0000000000000000000000000000000000000000000000000000000000000000')
);


CREATE TABLE anomaly_sample_read_model (
  anomaly_id TEXT NOT NULL CONSTRAINT ck_anomaly_sample_read_model__anomaly_id CHECK (length(anomaly_id) = 64 AND anomaly_id NOT GLOB '*[^0-9a-f]*'),
  sample_number INTEGER NOT NULL CONSTRAINT ck_anomaly_sample_read_model__sample_number CHECK (typeof(sample_number) = 'integer' AND sample_number >= 1),
  task_id TEXT NOT NULL CONSTRAINT ck_anomaly_sample_read_model__task_id CHECK (length(task_id) > 0),
  revision_number INTEGER NOT NULL CONSTRAINT ck_anomaly_sample_read_model__revision_number CHECK (typeof(revision_number) = 'integer' AND revision_number >= 1),
  value_numerator TEXT NOT NULL CONSTRAINT ck_anomaly_sample_read_model__value_numerator CHECK ((value_numerator = '0' OR (length(value_numerator) > 0 AND substr(value_numerator,1,1) GLOB '[1-9]' AND value_numerator NOT GLOB '*[^0-9]*'))),
  value_denominator INTEGER NOT NULL CONSTRAINT ck_anomaly_sample_read_model__value_denominator CHECK (typeof(value_denominator) = 'integer' AND value_denominator >= 1),
  completed_at TEXT NOT NULL CONSTRAINT ck_anomaly_sample_read_model__completed_at CHECK (length(completed_at) = 24 AND completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  sample_proof_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_anomaly_sample_read_model__sample_proof_artifact_reference_id CHECK (length(sample_proof_artifact_reference_id) > 0),
  sample_proof_sha256 TEXT NOT NULL CONSTRAINT ck_anomaly_sample_read_model__sample_proof_sha256 CHECK (length(sample_proof_sha256) = 64 AND sample_proof_sha256 NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT pk_anomaly_sample_read_model PRIMARY KEY (anomaly_id,sample_number),
  CONSTRAINT fk_anomaly_sample_read_model__anomaly_read_model FOREIGN KEY (anomaly_id) REFERENCES anomaly_read_model(anomaly_id) ON DELETE RESTRICT,
  CONSTRAINT fk_anomaly_sample_read_model__task_revision_read_model FOREIGN KEY (task_id,revision_number) REFERENCES task_revision_read_model(task_id,revision_number) ON DELETE RESTRICT,
  CONSTRAINT ux_anomaly_sample_read_model__sample UNIQUE (anomaly_id,task_id,revision_number)
);

```

### Procedencia, atomicidad y semántica de columnas

- anomaly_id/source_cut_sha256/action_key tienen las preimágenes del protocolo.
  inputs_artifact_reference_id fija el AnomalyInputsV1 completo, publicado como
  EVIDENCE privado. policy_* es pin inmutable a ANOMALY_POLICY.
- observed_* y baseline_* son valores exactos en unit/currency; sus status son
  independientes. Baseline insuficiente puede ser UNKNOWN con observado KNOWN.
  La ausencia de una entrada no se representa como racional 0/1.
- TOTAL_TOKENS y ACTIVE_WORK_SECONDS exigen denominador1 en los valores conocidos,
  también en todas las muestras; EQUIVALENT_COST_NANOS usa racional reducido,
  gcd(n,d)=1 y d>0. La admisión valida normalización BigInt, sin conversión Number.
- metric/unit/currency están fijados por policy; sample_count debe coincidir con
  las filas hijas seleccionadas. reason_code explica decisión, no texto remoto.
- observed UNKNOWN, muestras insuficientes/vencidas o cohorte inválida no accionan.
  Si la primera razón aplicable es OBSERVATION_UNKNOWN, después COHORT_UNAVAILABLE,
  UNIT_MISMATCH, INSUFFICIENT_SAMPLES, STALE_SAMPLES, se conserva ese orden fijo.
  NORMAL/DETECTED exigen ambos valores conocidos y cálculo recomputado.
- Header, cuatro source heads y muestras ordenadas se anexan/fold juntas con
  ANOMALY_EVALUATED. La cantidad exacta de heads, orden/contigüidad de muestras y
  hashes al corte se validan en el método de append, no con un CHECK local falso.
  Secuencia0 es génesis de ese stream; el hash se verifica contra su corte real.
- Cada muestra pertenece a otra task/revision y debe satisfacer CohortV1 de la
  primitiva de estimación. sample_proof_artifact_reference_id/hash fija esa
  comprobación y sus referencias de fuente. Moneda/unidad se heredan del header,
  no se repiten ni se reinterpretan.
- Fuentes cruzadas: registry para policy/precios, accounts para cuota/consumo y
  control/initiative para tarea/permiso. Todos se fijan en el vector; no se
  consulta la cuenta o versión “actual” al reconstruir.
- action_key es NOT NULL sólo en la primera fila que admite una acción para la
  clave semántica; índice UNIQUE serializa ese guard. DETECTED posterior puede
  tener requested_action=NONE/action_state=NOT_REQUESTED por acción ya existente.
  No copia la acción como una solicitud nueva.
- NOTIFY usa H-6/B3; intención de acción + decisión/comando se confirman en ese
  appendBatch. PAUSE admite primero la intención; después usa P-22 y reconciliación.
  ANOMALY_ACTION_OBSERVED cambia sólo action_state y confirmación del header dueño:
  REQUESTED → CONFIRMED|UNKNOWN, UNKNOWN → CONFIRMED tras prueba; jamás
  UNKNOWN → REQUESTED por una observación nueva.
- CONFIRMED requiere la tripleta íntegra y un evento que prueba esa acción sobre
  ese intento; unknown no tiene confirmación. Es referencia tipada cross-stream,
  no FK a un store mutable. NOTIFY no significa leído por humano; PAUSE exige
  quiescencia comprobada, no sólo señal enviada.
- recorded_at se fija al evaluar; evaluated_at es el instante del corte.
  sequence es el último evento control aplicado, incluida observación de acción.
  Fuentes/muestras/policy/decisión originales son inmutables después de creación.
- Rebuild aplica decisiones/acciones originales y recompone watermarks, sin reloj,
  detección nueva, envío o pausa. Tokens/costo/duración duplicados para la evaluación
  son snapshots derivados y trazables, no eventos autoritativos de gasto.

Negativos: muestra duplicada/propia/fuera de corte, head faltante/hash alterado,
denominador0/NULL incoherente y metric/currency incompatible rechazan. Repetir
detección con otro corte no repausa. Baseline cero conocido funciona; ausente no
da cero. Una acción sin ack no se representa como PAUSED/NOTIFIED.

---

## 12. `worker_read_model` y `worker_task_read_model`

**Hoy** (migración 2), sin cambios.

| Tabla | PK | Columnas |
| --- | --- | --- |
| `worker_read_model` | `identity` | `provider`, `model`, `role`, `instance`, `event_count`, `task_count`, `first_sequence`, `last_sequence`, `first_seen_at`, `last_seen_at`, `last_task_id`, `last_event_type` |
| `worker_task_read_model` | `(identity, task_id)` | `event_count`, `last_sequence`; **única FK física entre proyecciones** (`fk_worker_task_read_model__worker_read_model`, `ON DELETE CASCADE`), preservada tal cual del legado — es la excepción nombrada en la nota original del DER. |

### Índices (legacy)

| Objeto | Forma |
| --- | --- |
| `worker_read_model_by_role` | `INDEX (role, identity)` |
| `worker_read_model_by_provider` | `INDEX (provider, identity)` |
| `worker_task_read_model_by_task` | `INDEX (task_id, identity)` |

---

## 13. Mapeo legado → destino

| Objeto legado | Estado hoy | Destino | Nota |
| --- | --- | --- | --- |
| `task_read_model` | Hoy, mig. 2+4 | Se preserva + aditivo. | §1 |
| — (no existía como revisión) | — | `task_revision_read_model` nuevo. | §2, corrige defecto de identidad |
| — (no existía) | — | `task_attempt_read_model` nuevo. | §3 |
| `execution_route_read_model` (PK `(task_id, attempt)`) | Hoy, mig. 6 | **Congelado**, sólo eventos legacy; reemplazo hacia adelante `execution_route_segment_read_model`. | §4, §5 |
| — (no existía) | — | `effect_read_model`, `dispatch_attempt_read_model` nuevos (saga). | §6, §7 |
| `prompt_record_read_model` (PK `prompt_sha256`) | No existe (propuesto en el modelo anterior) | `prompt_occurrence_read_model` + `response_occurrence_read_model`, separa identidad de bytes de ocurrencia. | §8 |
| `tool_call_read_model` (PK `transition_id`) | No existe (propuesto en el modelo anterior) | Mismo nombre, PK `effect_id`. | §9 |
| `checkpoint_read_model`, `verification_read_model`, `audit_verdict_read_model`, `commit_read_model` | No existe (propuesto en el modelo anterior) | Mismos nombres, coordenada de intento actualizada. | §10 |
| `worker_read_model`, `worker_task_read_model` | Hoy, mig. 2 | Sin cambio. | §12 |
| `artifact_index_read_model` | No existe (propuesto en el modelo anterior) | Ver [artifacts](../artifacts/index.md), no vive en esta hoja. | — |
| `anomaly_read_model` | No existe (propuesto en el modelo anterior) | Conserva el nombre; snapshot racional/policy, fuentes y muestras normalizadas; solicitud y confirmación de acción separadas. | §11 |

Relaciones aditivas de anomalía, sin equivalente legacy:
`anomaly_source_head_read_model` y `anomaly_sample_read_model` (§11).
