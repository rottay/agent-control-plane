# Planning: diccionario físico

Dueño: iniciativa, revisiones de roadmap, pasos y dependencias, DAG de tareas,
asignaciones de routing y sus fallbacks, plan del coordinador, aprobaciones,
recomendaciones, simulaciones, adjudicación y consulta.

Reglas transversales en [../index.md](../index.md), no repetidas acá. Fuente de
eventos: `initiative_events` para scope `INITIATIVE`/`STEP` y para todo lo demás salvo
routing `GLOBAL`; `registry_events` (`document_kind = 'ROUTING_ASSIGNMENT_GLOBAL'`,
dueño físico en [streams](../streams/index.md) §4) para scope `GLOBAL`. Todo lo
declarado acá es proyección: se borra y reconstruye a un vector de cabezas fijado.

---

## 1. `initiative_read_model`

**Hoy** (migración 4) + **aditivo**. PK `initiative_id`.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `initiative_id` | TEXT | NOT NULL | PK. |
| `current_status` | TEXT | NOT NULL | — |
| `title` | TEXT | NULL | **Aditivo.** `NULL` hasta que el primer evento que declara título se proyecta; una iniciativa admitida sin título todavía no existe en la práctica, pero la columna es nullable por si el fold corre antes de ese evento. |
| `objective_sha256` | TEXT | NULL | **Aditivo.** Digest sha256, ver [artifacts](../artifacts/index.md). |
| `repository_sha256` | TEXT | NULL | **Aditivo.** — |
| `event_count` | INTEGER | NOT NULL | — |
| `first_sequence` | INTEGER | NOT NULL | Legacy, presente en el DDL aplicado. |
| `last_sequence` | INTEGER | NOT NULL | Sustituye a `updated_at` como definición de "hasta dónde" (§5 canónico). |
| `last_event_id` | TEXT | NOT NULL | Legacy, sin cambio. |
| `last_event_type` | TEXT | NOT NULL | Legacy, sin cambio. |
| `last_transition_id` | TEXT | NOT NULL | Legacy, sin cambio. |
| `last_emitted_by` | TEXT | NOT NULL | Legacy, sin cambio. |
| `created_at` | TEXT | NOT NULL | `occurred_at` del evento fundacional. |
| `updated_at` | TEXT | NOT NULL | **Legacy, no autoritativo.** No se puede eliminar (migración 4 inmutable, sin `DROP COLUMN` de columna con datos); se sigue poblando por compatibilidad, pero `last_sequence` es la fuente de verdad de orden. |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `initiative_read_model_by_status` | `INDEX (current_status, initiative_id)`, legacy. |
| OCC | No aplica (proyección, un solo escritor lógico: el projector). |
| Transacción | Fold + `projection_watermark` en una transacción. |
| Rebuild | Determinista desde `initiative_events` a `applied_sequence` fijado. |

---

## 2. `roadmap_version_read_model`

**Hoy** (migración 4) + índice **aditivo**.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `roadmap_version_id` | TEXT | NOT NULL | PK. |
| `initiative_id` | TEXT | NOT NULL | `fk_roadmap_version_read_model__initiative_read_model`, misma cohorte. |
| `version` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `content_digest` | TEXT | NOT NULL | — |
| `parent_version_id` | TEXT | NULL | `NULL` en la primera versión. |
| `kind` | TEXT | NOT NULL | — |
| `restores_version_id` | TEXT | NULL | Distinto de `parent_version_id`: un roadmap puede restaurar una versión anterior sin ser su hijo lineal directo. |
| `recorded_by` | TEXT | NOT NULL | — |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | `applied_sequence` de esta fila en `initiative_events`. |
| `recording_contract_version` | TEXT | NULL en DDL | **Aditivo** (migración 25, P-26 corte B; admisión del DT, ND-B1). Versión de contrato con que se registró la versión: la llave de la cohorte. Requerida en toda fila por trigger; la migración la escribe desde el evento de cada versión. |
| `step_count` | INTEGER | NULL | **Aditivo** (migración 25). Pasos que declara la versión, `0..200`. `NULL` exactamente en la cohorte anterior (`2.2.0` … `2.9.0`, lista cerrada); requerida desde `2.10.0`. |
| `step_manifest_artifact_reference_id` | TEXT | NULL | **Aditivo** (migración 25). La referencia del manifiesto privado de pasos (`PLAN_DOCUMENT`, scope `INITIATIVE`); nula junto con el digest. |
| `step_manifest_sha256` | TEXT | NULL | **Aditivo** (migración 25). Digest del manifiesto; nulo junto con la referencia, y sólo presente con `step_count > 0`. |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `tr_roadmap_version_read_model__validate_steps_on_insert` / `__on_update` | **Aditivo** (migración 25). La cohorte por lista cerrada, en los dos caminos por los que llega una fila; la primera sentencia atrapa la versión `NULL`. |
| `roadmap_version_read_model_by_initiative` | `INDEX (initiative_id, version)`, legacy. |
| `ux_roadmap_version_read_model__initiative_id__version` | **Aditivo.** `UNIQUE INDEX (initiative_id, version)`. Dos versiones de roadmap con el mismo número para la misma iniciativa es corrupción del fold, no un caso válido. |
| Transacción / Rebuild | Igual patrón que §1. |

---

## 3. `roadmap_step_read_model`

**Nuevo.** Un paso pertenece a exactamente una versión de roadmap: una revisión nueva
no muta los pasos de la anterior (§7.4 canónico).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `roadmap_version_id` | TEXT | NOT NULL | PK (compuesta). `fk_roadmap_step_read_model__roadmap_version_read_model`. |
| `step_id` | TEXT | NOT NULL | PK (compuesta). |
| `step_index` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `title` | TEXT | NOT NULL | — |
| `objective_sha256` | TEXT | NOT NULL | — |
| `acceptance_sha256` | TEXT | NOT NULL | — |
| `expected_write_set_sha256` | TEXT | NOT NULL | — |
| `state` | TEXT | NOT NULL | `CHECK IN ('DECLARED','READY','RUNNING','PAUSED','DONE','CANCELLED')`. |
| `routing_assignment_version` | INTEGER | NULL | `NULL` hasta que exista una asignación con scope `STEP` para este paso; en su ausencia rige la precedencia `INITIATIVE` luego `GLOBAL` (ver §6). |
| `dependency_rank` | INTEGER | NOT NULL | `CHECK >= 0`. **Admisión del DT (ND-B1, P-26 corte B).** El resultado del cómputo de ciclo de §4, registrado en el evento que declaró las dependencias del paso: el camino más largo desde un paso sin dependencias (0 para uno así). Un grafo acíclico es exactamente uno donde todo rango existe; la puerta lo recalcula desde el manifiesto y rechaza una diferencia. |
| `sequence` | INTEGER | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_roadmap_step_read_model` | `PRIMARY KEY (roadmap_version_id, step_id)` — corrige el defecto: la forma legada (`step_id` PK simple) colisionaba entre versiones de roadmap. |
| `ux_roadmap_step_read_model__roadmap_version_id__step_index` | `UNIQUE INDEX (roadmap_version_id, step_index)` (P-26 corte B): un índice por paso dentro de su versión. |
| `ix_roadmap_step_read_model__state` | `INDEX (roadmap_version_id, state, step_index)`. |
| Rebuild | Determinista desde `initiative_events`. |

---

## 4. `roadmap_step_dependency`

**Nuevo, versionado** (la forma legada era `PRIMARY KEY(step_id, depends_on_step_id)`
sin versión de roadmap).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `roadmap_version_id` | TEXT | NOT NULL | PK (compuesta). |
| `step_id` | TEXT | NOT NULL | PK (compuesta). `fk_roadmap_step_dependency__roadmap_step_read_model` sobre `(roadmap_version_id, step_id)`. |
| `depends_on_step_id` | TEXT | NOT NULL | PK (compuesta). `fk_roadmap_step_dependency__roadmap_step_read_model__depends_on` sobre `(roadmap_version_id, depends_on_step_id)`. |
| `sequence` | INTEGER | NOT NULL | — |

`ck_roadmap_step_dependency__no_self`: `CHECK (step_id <> depends_on_step_id)`. Ciclos
de más de un paso no se impiden por `CHECK` (SQL no expresa alcanzabilidad); se validan
en el punto de escritura, fail-closed, y el resultado del cómputo de ciclo se registra
como parte del evento que declaró la dependencia — no hay una tabla separada de
"ciclo detectado" en esta hoja.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_roadmap_step_dependency` | `PRIMARY KEY (roadmap_version_id, step_id, depends_on_step_id)` |
| `ix_roadmap_step_dependency__depends_on` | `INDEX (roadmap_version_id, depends_on_step_id, step_id)`, para resolver predecesores. |
| Rebuild | Determinista desde `initiative_events`. |

---

## 5. `task_graph_revision_read_model`, `task_graph_node_read_model` y `task_dependency_read_model`

**Nuevo.** El grafo de tareas de un paso puede re-planificarse; cada re-planificación
es una revisión nueva del grafo, no una edición de la anterior — mismo principio que
un roadmap.

### 5.1 `task_graph_revision_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `graph_revision_id` | TEXT | NOT NULL | PK. |
| `roadmap_version_id` | TEXT | NOT NULL | `fk_task_graph_revision_read_model__roadmap_step_read_model` (junto con `step_id`). |
| `step_id` | TEXT | NOT NULL | — |
| `declared_at` | TEXT | NOT NULL | — |
| `superseded_by` | TEXT | NULL | `graph_revision_id` de la revisión siguiente; `NULL` mientras es la vigente. |
| `sequence` | INTEGER | NOT NULL | — |

### 5.2 `task_graph_node_read_model`

**Nuevo.** Preserva la pertenencia de un nodo al grafo aunque no tenga aristas (un
`JOIN` sólo sobre `task_dependency_read_model` pierde las tareas sin dependencias ni
dependientes).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `graph_revision_id` | TEXT | NOT NULL | PK (compuesta). `fk_task_graph_node_read_model__task_graph_revision_read_model`. |
| `task_id` | TEXT | NOT NULL | PK (compuesta). |
| `task_revision_number` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 1`. |
| `sequence` | INTEGER | NOT NULL | — |

### 5.3 `task_dependency_read_model`

Cada arista referencia la revisión del grafo **y** la revisión de tarea de ambos
extremos (§7.5 canónico): una tarea reintentada como revisión nueva no reutiliza
tácitamente la arista de la revisión vieja. Ambos extremos son nodos existentes del
mismo grafo — no referencias sueltas.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `graph_revision_id` | TEXT | NOT NULL | PK (compuesta). `fk_task_dependency_read_model__task_graph_revision_read_model`. |
| `task_id` | TEXT | NOT NULL | PK (compuesta). `fk_task_dependency_read_model__task_graph_node_read_model` sobre `(graph_revision_id, task_id, task_revision_number)`. |
| `task_revision_number` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 1`. |
| `depends_on_task_id` | TEXT | NOT NULL | PK (compuesta). `fk_task_dependency_read_model__task_graph_node_read_model__depends_on` sobre `(graph_revision_id, depends_on_task_id, depends_on_task_revision_number)`. |
| `depends_on_task_revision_number` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 1`. |
| `fail_policy` | TEXT | NOT NULL | `CHECK IN ('WAIT_SUCCESS','ALLOW_FAILURE','REQUIRE_TERMINAL')`. Catálogo cerrado, definido por el contrato del scheduler — no una cadena libre; una política fuera de este catálogo se rechaza en la escritura, nunca se admite como referencia inexistente. |
| `step_id` | TEXT | NOT NULL | Denormalizado desde `task_graph_revision_read_model` para no forzar un `JOIN` en el hot path del scheduler; misma cohorte, se refolda junto. |
| `sequence` | INTEGER | NOT NULL | — |

`ck_task_dependency_read_model__no_self`: `CHECK (NOT (task_id = depends_on_task_id AND task_revision_number = depends_on_task_revision_number))`.

### Índices / OCC / transacción / rebuild (las tres tablas)

| Objeto | Forma |
| --- | --- |
| `pk_task_graph_node_read_model` | `PRIMARY KEY (graph_revision_id, task_id, task_revision_number)` |
| `pk_task_dependency_read_model` | `PRIMARY KEY (graph_revision_id, task_id, task_revision_number, depends_on_task_id, depends_on_task_revision_number)` |
| `ix_task_dependency_read_model__depends_on` | `INDEX (graph_revision_id, depends_on_task_id, depends_on_task_revision_number)` |
| Predicado `READY` | No es una columna: se computa por `JOIN` entre `task_dependency_read_model` (con su `fail_policy`) y el estado terminal de cada `depends_on_*` en [execution](../execution/index.md); no se cachea acá para no duplicar autoridad de estado de tarea. |
| Política de dependencia fallida | La decide `fail_policy` por arista (columna, ya no una regla de lectura implícita); el cruce con el desenlace real de la tarea referenciada sigue viviendo en [execution](../execution/index.md). |
| Rebuild | Determinista desde `initiative_events` (declaración del grafo) — las revisiones/estados de tarea referenciados se leen de `execution` contra el mismo vector de watermarks, nunca se copian. |

---

## 6. `routing_assignment_read_model`

**Nuevo.** Única proyección de esta hoja alimentada por **dos** streams: `initiative_events`
(scope `INITIATIVE`/`STEP`) y `registry_events` (scope `GLOBAL`, ver
[streams](../streams/index.md) §4). Precedencia de lectura: `STEP` > `INITIATIVE` > `GLOBAL`,
resuelta contra un vector de watermarks (uno por stream, §5 canónico), nunca contra
"lo último" de un solo stream.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `assignment_id` | TEXT | NOT NULL | PK. |
| `scope_kind` | TEXT | NOT NULL | `CHECK IN ('GLOBAL','INITIATIVE','STEP')`. |
| `scope_id` | TEXT | NULL | `NULL` si y sólo si `scope_kind = 'GLOBAL'`; impuesto por `ck_routing_assignment_read_model__scope_id_required`. |
| `version` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `role` | TEXT | NOT NULL | `CHECK IN ('coordinator','implementer','reviewer','consultant','verifier')`. |
| `slot` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `provider` | TEXT | NOT NULL | — |
| `model_version_id` | TEXT | NOT NULL | Id exacto, nunca alias; validado fail-closed contra `model_version_read_model.status = 'ACTIVE'` en [accounts](../accounts/index.md) — comprobación tipada, no FK física (cohortes de reconstrucción distintas). |
| `recorded_by` | TEXT | NOT NULL | — |
| `recorded_at` | TEXT | NOT NULL | — |
| `superseded_by` | TEXT | NULL | `assignment_id` siguiente; `NULL` mientras vigente. |
| `source_stream` | TEXT | NOT NULL | `CHECK IN ('initiative_events','registry_events')`. |
| `source_sequence` | INTEGER | NOT NULL | Secuencia en `source_stream`. |
| `sequence` | INTEGER | NOT NULL | Orden de aplicación de la proyección (no comparable entre streams; ver `projection_watermark`). |

`ck_routing_assignment_read_model__source_scope`: `CHECK ((source_stream = 'registry_events' AND scope_kind = 'GLOBAL') OR (source_stream = 'initiative_events' AND scope_kind IN ('INITIATIVE','STEP')))`.

### 6.1 `routing_assignment_fallback` (reemplaza `allowed_fallbacks_json`)

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `assignment_id` | TEXT | NOT NULL | PK (compuesta). `fk_routing_assignment_fallback__routing_assignment_read_model`. |
| `ordinal` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 0`, orden de intento. |
| `model_version_id` | TEXT | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ux_routing_assignment_read_model__global` | **Partial.** `UNIQUE INDEX (role, slot, version) WHERE scope_kind = 'GLOBAL'`. |
| `ux_routing_assignment_read_model__scoped` | **Partial.** `UNIQUE INDEX (scope_kind, scope_id, role, slot, version) WHERE scope_kind <> 'GLOBAL'`. Corrige el defecto: `UNIQUE` con columna `NULL` (`scope_id`) no garantiza unicidad por sí sola (§7.7 canónico). |
| `ix_routing_assignment_read_model__resolution` | `INDEX (scope_kind, scope_id, role, slot, superseded_by)`, para resolver la asignación vigente. |
| `pk_routing_assignment_fallback` | `PRIMARY KEY (assignment_id, ordinal)` |
| Transacción | Fold de un evento de un solo stream a la vez; el watermark del otro stream no se toca. Consistencia de precedencia se resuelve en lectura, no en escritura. |
| Rebuild | Reconstrucción requiere ambos streams a un vector de cabezas fijado; se rehúsa si cualquiera de las dos cadenas está rota. |

---

## 7. `coordinator_plan_read_model` (reemplaza `dt_plan_read_model`)

**Nuevo** (renombrado: la sigla anterior no es vocabulario estable).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `plan_id` | TEXT | NOT NULL | PK. |
| `initiative_id` | TEXT | NOT NULL | — |
| `step_id` | TEXT | NOT NULL | — |
| `request_prompt_sha256` | TEXT | NOT NULL | Ver [artifacts](../artifacts/index.md); nunca el prompt en bytes. |
| `plan_sha256` | TEXT | NOT NULL | — |
| `coordinator_identity` | TEXT | NOT NULL | — |
| `requested_at` | TEXT | NOT NULL | — |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ix_coordinator_plan_read_model__step` | `INDEX (step_id, requested_at)` |
| Rebuild | Determinista desde `initiative_events`. |

---

## 8. `owner_approval_read_model`

**Nuevo.** Toda aprobación lleva contexto de iniciativa y digest del sujeto (§4 punto 3
canónico). Enum parcialmente poblado según estado (§3.4 canónico).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `approval_id` | TEXT | NOT NULL | PK. |
| `initiative_id` | TEXT | NOT NULL | Contexto obligatorio, siempre. |
| `subject_kind` | TEXT | NOT NULL | `CHECK IN ('PLAN','STEP','COMMIT','TASK')`. |
| `subject_id` | TEXT | NOT NULL | — |
| `subject_revision_sha256` | TEXT | NOT NULL | Digest de la revisión exacta a la que aplica; una aprobación no libera trabajo cuyo sujeto tiene un digest distinto (invariante 8 canónica). |
| `requested_at` | TEXT | NOT NULL | — |
| `requested_by` | TEXT | NOT NULL | — |
| `expires_at` | TEXT | NULL | `NULL` si la aprobación no vence por diseño; si tiene vencimiento, obligatorio desde que se solicita. Vencer no libera trabajo aunque el estado proyectado siga en `GRANTED`: la lectura de consumo compara `expires_at` contra el instante de uso, no sólo el `state`. |
| `state` | TEXT | NOT NULL | `CHECK IN ('PENDING','GRANTED','DENIED','EXPIRED','CANCELLED','REVOKED')`. `EXPIRED`/`CANCELLED`/`REVOKED` son estados **emitidos por un evento con autoridad**, nunca inferidos del reloj al leer. `REVOKED` sólo alcanzable desde `GRANTED`; una revocación no borra `decision`/`decider_identity`/`decided_at` — el grant original se preserva, y `revoked_at`/`revoked_reason` documentan el hecho posterior. |
| `decision` | TEXT | NULL | `CHECK (decision IS NULL OR decision IN ('GRANTED','DENIED'))`. `NULL` exactamente en `PENDING`, `EXPIRED` y `CANCELLED`. `GRANTED` y `REVOKED` conservan `GRANTED`; `DENIED` exige `DENIED`. Una concesión posterior invalidada usa `REVOKED`, preservando decisión y autoridad originales; no se limpia el historial para convertirla en `EXPIRED` o `CANCELLED`. |
| `decider_identity` | TEXT | NULL | Igual nulidad que `decision`. |
| `decided_at` | TEXT | NULL | Igual nulidad que `decision`. |
| `authority_sha256` | TEXT | NULL | Digest de la autoridad exacta (rol/policy) bajo la que se decidió; igual nulidad que `decision`. Distinto de `subject_revision_sha256`: éste identifica el sujeto aprobado, aquél identifica quién tenía permiso de aprobarlo. |
| `revoked_at` | TEXT | NULL | `NULL` salvo `state = 'REVOKED'`. |
| `revoked_reason` | TEXT | NULL | Igual nulidad que `revoked_at`. |
| `note_sha256` | TEXT | NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

`ck_owner_approval_read_model__decision_pair`:
```sql
CHECK (
  (decision IS NULL AND decider_identity IS NULL
    AND decided_at IS NULL AND authority_sha256 IS NULL)
  OR
  (decision IS NOT NULL AND decider_identity IS NOT NULL
    AND decided_at IS NOT NULL AND authority_sha256 IS NOT NULL)
)
```

`ck_owner_approval_read_model__decision_state`:
```sql
CHECK ((
  (state IN ('PENDING','EXPIRED','CANCELLED') AND decision IS NULL)
  OR (state IN ('GRANTED','REVOKED') AND decision = 'GRANTED')
  OR (state = 'DENIED' AND decision = 'DENIED')
) IS TRUE)
```

`IS TRUE` es obligatorio: una comparación con `NULL` no puede pasar el `CHECK`
por la regla ternaria de SQL. La coherencia incluye la autoridad, no sólo el actor
y la fecha.

`ck_owner_approval_read_model__revoked_pair`:
`CHECK (((state = 'REVOKED') = (revoked_at IS NOT NULL)) AND ((revoked_at IS NULL) = (revoked_reason IS NULL)))`.
`ck_owner_approval_read_model__revoked_from_granted`:
`CHECK ((state <> 'REVOKED' OR decision = 'GRANTED') IS TRUE)`.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ix_owner_approval_read_model__subject` | `INDEX (subject_kind, subject_id, state)` |
| `ix_owner_approval_read_model__initiative` | `INDEX (initiative_id, state)` |
| OCC | La orden de decidir lleva `expected_version`: `sequence` del último evento de **esa iniciativa** en `initiative_events`, no la cabeza global de otras iniciativas ni una nueva columna de versión de aprobación. En `BEGIN IMMEDIATE`, el append compara esa cabeza autoritativa y exige que la aprobación siga `PENDING`, con `initiative_id`, `subject_kind`, `subject_id` y `subject_revision_sha256` exactos; valida la autoridad que quedará en `authority_sha256` y que no haya vencido/cancelación/revocación. Una cabeza distinta o una transición no admisible rehúsa sin append. |
| Transacción | La transición CAS `PENDING → GRANTED` o `PENDING → DENIED` escribe evento de iniciativa, cabeza, proyección y watermark en una sola transacción. Dos decisores con la misma versión esperada no pueden ganar. Repetir la misma clave idempotente y el mismo contenido devuelve el resultado ya registrado; reutilizarla con otra decisión o autoridad es conflicto. `expected_version` es precondición de admisión registrada en el evento, no autoridad mutable en la proyección. |
| Rebuild | Determinista desde `initiative_events`: aplica la decisión y autoridad registradas sin volver a autorizar ni consultar el reloj. `EXPIRED`/`CANCELLED` cierran una solicitud aún no decidida; `REVOKED` conserva el grant original. El consumo vuelve a validar vigencia, sujeto/revisión y revocaciones contra la cabeza vigente: no basta una fila atrasada en `GRANTED`. |

---

### 8.1 Espera durable: approval_wait_read_model

Nueva. Dueño planning; fuente APPROVAL_WAIT_REQUESTED/RESOLVED en
initiative_events. [Interacción §3](../../contracts/interaction/index.md) define
el algoritmo; owner_approval sigue siendo la única autoridad del permiso.

El SQL siguiente es completo para las tablas nuevas, sin defaults implícitos.
Los CHECK de fecha fijan representación; el schema de admisión exige además que
parsear y volver a serializar produzca exactamente la misma fecha UTC válida.
Cada referencia a policy exige documento/version/digest/artefacto coincidentes.
FK sólo entre tablas de la misma cohorte; las referencias cross-stream/artefactos
son tipadas y se validan antes del append y durante rebuild. No FK al outbox.
No se ejecuta este DDL contra el checkout vivo ni se reescriben migraciones aplicadas.

```sql
CREATE TABLE approval_wait_read_model (
  wait_id TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__wait_id CHECK (length(wait_id) = 64 AND wait_id NOT GLOB '*[^0-9a-f]*'),
  approval_id TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__approval_id CHECK (length(approval_id) > 0),
  initiative_id TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__initiative_id CHECK (length(initiative_id) > 0),
  policy_document_id TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__policy_document_id CHECK (length(policy_document_id) > 0),
  policy_version INTEGER NOT NULL CONSTRAINT ck_approval_wait_read_model__policy_version CHECK (typeof(policy_version) = 'integer' AND policy_version >= 1),
  policy_sha256 TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__policy_sha256 CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__policy_artifact_reference_id CHECK (length(policy_artifact_reference_id) > 0),
  requested_at TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__requested_at CHECK (length(requested_at) = 24 AND requested_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  evaluated_at TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__evaluated_at CHECK (length(evaluated_at) = 24 AND evaluated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  deadline_at TEXT CONSTRAINT ck_approval_wait_read_model__deadline_at CHECK (deadline_at IS NULL OR (length(deadline_at) = 24 AND deadline_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')),
  timer_id TEXT CONSTRAINT ck_approval_wait_read_model__timer_id CHECK (timer_id IS NULL OR (length(timer_id) = 64 AND timer_id NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CONSTRAINT ck_approval_wait_read_model__state CHECK (state IN ('WAITING','GRANTED','DENIED','CANCELLED','TIMED_OUT')),
  resolved_at TEXT CONSTRAINT ck_approval_wait_read_model__resolved_at CHECK (resolved_at IS NULL OR (length(resolved_at) = 24 AND resolved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')),
  resolution_sequence INTEGER CONSTRAINT ck_approval_wait_read_model__resolution_sequence CHECK (resolution_sequence IS NULL OR (typeof(resolution_sequence) = 'integer' AND resolution_sequence >= 1)),
  sequence INTEGER NOT NULL CONSTRAINT ck_approval_wait_read_model__sequence CHECK (typeof(sequence) = 'integer' AND sequence >= 1),
  CONSTRAINT pk_approval_wait_read_model PRIMARY KEY (wait_id),
  CONSTRAINT ux_approval_wait_read_model__approval UNIQUE (approval_id),
  CONSTRAINT fk_approval_wait_read_model__owner_approval_read_model FOREIGN KEY (approval_id) REFERENCES owner_approval_read_model(approval_id) ON DELETE RESTRICT,
  CONSTRAINT ck_approval_wait_read_model__timer CHECK ((deadline_at IS NULL) = (timer_id IS NULL)),
  CONSTRAINT ck_approval_wait_read_model__resolution CHECK (((state='WAITING') = (resolved_at IS NULL)) AND ((resolved_at IS NULL) = (resolution_sequence IS NULL))),
  CONSTRAINT ck_approval_wait_read_model__times CHECK (requested_at <= evaluated_at AND (deadline_at IS NULL OR requested_at <= deadline_at) AND (resolved_at IS NULL OR resolved_at=evaluated_at)),
  CONSTRAINT ck_approval_wait_read_model__timely_decision CHECK ((state NOT IN ('GRANTED','DENIED') OR deadline_at IS NULL OR resolved_at < deadline_at) IS TRUE),
  CONSTRAINT ck_approval_wait_read_model__timeout CHECK (state <> 'TIMED_OUT' OR (deadline_at IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at >= deadline_at))
);
CREATE UNIQUE INDEX ux_approval_wait_read_model__timer ON approval_wait_read_model(timer_id) WHERE timer_id IS NOT NULL;
CREATE INDEX ix_approval_wait_read_model__pending ON approval_wait_read_model(state,deadline_at);
CREATE INDEX ix_approval_wait_read_model__clock ON approval_wait_read_model(initiative_id,evaluated_at);
```

wait_id/timer_id tienen la preimagen del protocolo. initiative_id debe coincidir
con la aprobación padre; se valida tipadamente antes del append y en rebuild.
La copia sirve al índice de cota por iniciativa, no autoriza mover la aprobación.
requested_at es el instante de solicitud fijado; evaluated_at inicialmente igual
y después el último instante de resolución. Nunca cambia por una lectura/tick
rechazado. sequence es el último evento de esa iniciativa aplicado a la fila;
resolution_sequence es la resolución exacta, ambas en initiative_events.

Transiciones: WAITING → GRANTED|DENIED|CANCELLED|TIMED_OUT, terminales inmutables.
Resolución de wait y transición de aprobación son un appendBatch con CAS de
la cabeza de iniciativa y PENDING comprobado: no basta el CHECK de una fila.
Una revocación posterior sólo cambia owner_approval preservando su grant y el wait.
El consumo vuelve a validar autoridad/revisión; GRANTED no afirma ejecución.

Cota durable = MAX(evaluated_at) de esta iniciativa, incluyendo terminales, bajo
el mismo BEGIN IMMEDIATE. now<cota rechaza WAIT_CLOCK_UNTRUSTED; nunca se usa MAX
para producir una hora nueva. Rebuild conserva los instantes, sin reloj actual.
Timer/driver son caches de vivacidad reconstructibles desde la solicitud; sus
IDs apuntan al wait original. FK, unicidad y CHECK no sustituyen comparación del
deadline ni CAS. Dos decisiones con expected_version igual no pueden ganar.
Retención no elimina la evidencia que sustenta la cota. Revisión/grant/timeout
tardíos, NULL incoherente y timer de otro wait son negativos obligatorios.

---

## 9. `adjudication_read_model` y `consultation_read_model`

**Nuevo** (faltaban en el modelo anterior pese a estar nombrados en el mapa de
operaciones; los tipos de evento correspondientes son `ADJUDICATION_RECORDED` y
`CONSULTATION_RECORDED` en `initiative_events`, emitidos por el coordinador o por un
worker con rol `consultant`). `adjudication_read_model` es **genérica, no sólo de
duelo**: también adjudica una corrección tras un `REJECT` de auditoría
([execution](../execution/index.md) `audit_verdict_read_model`). `duel_id` sólo existe
en la rama `MODEL_DUEL`, no es `NOT NULL` universal.

### 9.1 `adjudication_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `adjudication_id` | TEXT | NOT NULL | PK. |
| `initiative_id` | TEXT | NOT NULL | — |
| `adjudication_kind` | TEXT | NOT NULL | `CHECK IN ('REVIEW_CORRECTION','MODEL_DUEL')`. |
| `subject_kind` | TEXT | NOT NULL | `CHECK IN ('TASK','STEP')`. |
| `subject_id` | TEXT | NOT NULL | — |
| `subject_revision_sha256` | TEXT | NOT NULL | Revisión exacta adjudicada. |
| `source_rejection_id` | TEXT | NULL | `NULL` sii `adjudication_kind <> 'REVIEW_CORRECTION'`. Referencia tipada (no FK física, streams distintos) a `audit_verdict_read_model` en [execution](../execution/index.md) con `verdict = 'REJECT'`. |
| `correction_ref` | TEXT | NULL | Referencia/digest de la corrección emitida; `NULL` salvo `verdict = 'CORRECTION_ISSUED'`. |
| `duel_id` | TEXT | NULL | `NULL` sii `adjudication_kind <> 'MODEL_DUEL'`. |
| `winner_task_id` | TEXT | NULL | `NULL` salvo `verdict = 'WINNER_SELECTED'` (sólo alcanzable en rama `MODEL_DUEL`). |
| `verdict` | TEXT | NOT NULL | Rama `MODEL_DUEL`: `CHECK IN ('WINNER_SELECTED','TIE','INCONCLUSIVE')`. Rama `REVIEW_CORRECTION`: `CHECK IN ('CORRECTION_ISSUED','NO_CORRECTION_NEEDED')`. Un solo dominio cerrado por fila, impuesto por `ck_adjudication_read_model__verdict_kind`. |
| `criteria_sha256` | TEXT | NOT NULL | — |
| `adjudicator_identity` | TEXT | NOT NULL | — |
| `authority_sha256` | TEXT | NOT NULL | Digest de la autoridad bajo la que se adjudicó. |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

`ck_adjudication_read_model__duel_pair`: `CHECK ((adjudication_kind = 'MODEL_DUEL') = (duel_id IS NOT NULL))`.
`ck_adjudication_read_model__rejection_pair`: `CHECK ((adjudication_kind = 'REVIEW_CORRECTION') = (source_rejection_id IS NOT NULL))`.
`ck_adjudication_read_model__winner_pair`: `CHECK ((verdict = 'WINNER_SELECTED') = (winner_task_id IS NOT NULL))`.
`ck_adjudication_read_model__correction_pair`: `CHECK ((verdict = 'CORRECTION_ISSUED') = (correction_ref IS NOT NULL))`.
`ck_adjudication_read_model__verdict_kind`: `CHECK ((adjudication_kind = 'MODEL_DUEL' AND verdict IN ('WINNER_SELECTED','TIE','INCONCLUSIVE')) OR (adjudication_kind = 'REVIEW_CORRECTION' AND verdict IN ('CORRECTION_ISSUED','NO_CORRECTION_NEEDED')))`.

Los dos casos de prueba obligados (C4: rechazo de auditoría → corrección; duelo de
modelos) corren **independientes** — ninguno pasa por la columna `duel_id` del otro.

### 9.2 `consultation_read_model`

No requiere `duel_id`: una consulta puede darse fuera de todo duelo.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `consultation_id` | TEXT | NOT NULL | PK. |
| `initiative_id` | TEXT | NOT NULL | — |
| `subject_kind` | TEXT | NOT NULL | `CHECK IN ('PLAN','STEP','TASK')`. |
| `subject_id` | TEXT | NOT NULL | — |
| `consultant_identity` | TEXT | NOT NULL | — |
| `question_sha256` | TEXT | NOT NULL | — |
| `answer_sha256` | TEXT | NOT NULL | — |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### Índices / OCC / transacción / rebuild (ambas)

| Objeto | Forma |
| --- | --- |
| `ix_adjudication_read_model__duel` | `INDEX (duel_id)` |
| `ix_consultation_read_model__subject` | `INDEX (subject_kind, subject_id)` |
| Rebuild | Determinista desde `initiative_events`. |

---

### 9.3 Duelo V1: header, candidatos y checks

Nuevas, fuente initiative_events: MODEL_DUEL_REQUESTED/STARTED,
MODEL_DUEL_ADJUDICATION_STARTED, MODEL_DUEL_CHECKS_RECORDED y MODEL_DUEL_RESOLVED.
[Interacción §4](../../contracts/interaction/index.md) fija QUALITY_ONLY y las
preimágenes. No existe una segunda autoridad de tarea, uso, resultado o veredicto.

El SQL siguiente es completo para las tablas nuevas, sin defaults implícitos.
Los CHECK de fecha fijan representación; el schema de admisión exige además que
parsear y volver a serializar produzca exactamente la misma fecha UTC válida.
Cada referencia a policy exige documento/version/digest/artefacto coincidentes.
FK sólo entre tablas de la misma cohorte; las referencias cross-stream/artefactos
son tipadas y se validan antes del append y durante rebuild. No FK al outbox.
No se ejecuta este DDL contra el checkout vivo ni se reescriben migraciones aplicadas.

```sql
CREATE TABLE model_duel_read_model (
  duel_id TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__duel_id CHECK (length(duel_id) = 64 AND duel_id NOT GLOB '*[^0-9a-f]*'),
  initiative_id TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__initiative_id CHECK (length(initiative_id) > 0),
  client_scope TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__client_scope CHECK (length(client_scope) > 0),
  client_request_key TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__client_request_key CHECK (length(client_request_key) > 0),
  request_sha256 TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__request_sha256 CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__request_artifact_reference_id CHECK (length(request_artifact_reference_id) > 0),
  policy_document_id TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__policy_document_id CHECK (length(policy_document_id) > 0),
  policy_version INTEGER NOT NULL CONSTRAINT ck_model_duel_read_model__policy_version CHECK (typeof(policy_version) = 'integer' AND policy_version >= 1),
  policy_sha256 TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__policy_sha256 CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__policy_artifact_reference_id CHECK (length(policy_artifact_reference_id) > 0),
  criteria_sha256 TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__criteria_sha256 CHECK (length(criteria_sha256) = 64 AND criteria_sha256 NOT GLOB '*[^0-9a-f]*'),
  criteria_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__criteria_artifact_reference_id CHECK (length(criteria_artifact_reference_id) > 0),
  requested_at TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__requested_at CHECK (length(requested_at) = 24 AND requested_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  candidate_deadline_at TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__candidate_deadline_at CHECK (length(candidate_deadline_at) = 24 AND candidate_deadline_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  adjudicator_deadline_at TEXT CONSTRAINT ck_model_duel_read_model__adjudicator_deadline_at CHECK (adjudicator_deadline_at IS NULL OR (length(adjudicator_deadline_at) = 24 AND adjudicator_deadline_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')),
  state TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__state CHECK (state IN ('REQUESTED','RUNNING','SETTLED')),
  adjudicator_identity TEXT NOT NULL CONSTRAINT ck_model_duel_read_model__adjudicator_identity CHECK (length(adjudicator_identity) > 0),
  adjudication_id TEXT CONSTRAINT ck_model_duel_read_model__adjudication_id CHECK (adjudication_id IS NULL OR (length(adjudication_id) > 0)),
  sequence INTEGER NOT NULL CONSTRAINT ck_model_duel_read_model__sequence CHECK (typeof(sequence) = 'integer' AND sequence >= 1),
  CONSTRAINT pk_model_duel_read_model PRIMARY KEY (duel_id),
  CONSTRAINT ux_model_duel_read_model__request UNIQUE (client_scope,client_request_key),
  CONSTRAINT fk_model_duel_read_model__initiative_read_model FOREIGN KEY (initiative_id) REFERENCES initiative_read_model(initiative_id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_duel_read_model__adjudication_read_model FOREIGN KEY (adjudication_id) REFERENCES adjudication_read_model(adjudication_id) ON DELETE RESTRICT,
  CONSTRAINT ck_model_duel_read_model__settled CHECK (((state='SETTLED') = (adjudication_id IS NOT NULL)) AND (state <> 'SETTLED' OR adjudicator_deadline_at IS NOT NULL)),
  CONSTRAINT ck_model_duel_read_model__deadline CHECK (candidate_deadline_at >= requested_at AND (adjudicator_deadline_at IS NULL OR adjudicator_deadline_at >= requested_at))
);
CREATE INDEX ix_model_duel_read_model__initiative ON model_duel_read_model(initiative_id,state,requested_at);

CREATE TABLE model_duel_candidate_read_model (
  duel_id TEXT NOT NULL CONSTRAINT ck_model_duel_candidate_read_model__duel_id CHECK (length(duel_id) = 64 AND duel_id NOT GLOB '*[^0-9a-f]*'),
  candidate_number INTEGER NOT NULL CONSTRAINT ck_model_duel_candidate_read_model__candidate_number CHECK (typeof(candidate_number) = 'integer' AND candidate_number >= 1),
  task_id TEXT NOT NULL CONSTRAINT ck_model_duel_candidate_read_model__task_id CHECK (length(task_id) > 0),
  revision_number INTEGER NOT NULL CONSTRAINT ck_model_duel_candidate_read_model__revision_number CHECK (typeof(revision_number) = 'integer' AND revision_number >= 1),
  CONSTRAINT pk_model_duel_candidate_read_model PRIMARY KEY (duel_id,candidate_number),
  CONSTRAINT fk_model_duel_candidate_read_model__model_duel_read_model FOREIGN KEY (duel_id) REFERENCES model_duel_read_model(duel_id) ON DELETE RESTRICT,
  CONSTRAINT ux_model_duel_candidate_read_model__task UNIQUE (duel_id,task_id,revision_number),
  CONSTRAINT ck_model_duel_candidate_read_model__ordinal CHECK (candidate_number IN (1,2))
);


CREATE TABLE model_duel_check_read_model (
  duel_id TEXT NOT NULL CONSTRAINT ck_model_duel_check_read_model__duel_id CHECK (length(duel_id) = 64 AND duel_id NOT GLOB '*[^0-9a-f]*'),
  candidate_number INTEGER NOT NULL CONSTRAINT ck_model_duel_check_read_model__candidate_number CHECK (typeof(candidate_number) = 'integer' AND candidate_number >= 1),
  check_id TEXT NOT NULL CONSTRAINT ck_model_duel_check_read_model__check_id CHECK (length(check_id) > 0),
  weight INTEGER NOT NULL CONSTRAINT ck_model_duel_check_read_model__weight CHECK (typeof(weight) = 'integer' AND weight >= 1),
  required INTEGER NOT NULL CONSTRAINT ck_model_duel_check_read_model__required CHECK (typeof(required) = 'integer' AND required >= 0),
  outcome TEXT NOT NULL CONSTRAINT ck_model_duel_check_read_model__outcome CHECK (outcome IN ('PASS','FAIL','UNDETERMINED')),
  evidence_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_model_duel_check_read_model__evidence_artifact_reference_id CHECK (length(evidence_artifact_reference_id) > 0),
  evidence_sha256 TEXT NOT NULL CONSTRAINT ck_model_duel_check_read_model__evidence_sha256 CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  sequence INTEGER NOT NULL CONSTRAINT ck_model_duel_check_read_model__sequence CHECK (typeof(sequence) = 'integer' AND sequence >= 1),
  CONSTRAINT pk_model_duel_check_read_model PRIMARY KEY (duel_id,candidate_number,check_id),
  CONSTRAINT fk_model_duel_check_read_model__model_duel_candidate_read_model FOREIGN KEY (duel_id,candidate_number) REFERENCES model_duel_candidate_read_model(duel_id,candidate_number) ON DELETE RESTRICT,
  CONSTRAINT ck_model_duel_check_read_model__required CHECK (required IN (0,1))
);

```

- Header fija solicitud, policy, criterios, árbitro e iniciativa. La solicitud
  íntegra es PLAN_DOCUMENT privado; criterios POLICY_DOCUMENT/EVIDENCE autorizado.
  requested_at y candidate_deadline_at se fijan juntos. adjudicator_deadline_at
  nace sólo al registrar aceptación real del árbitro y no se extiende por retry.
- State REQUESTED → RUNNING → SETTLED. RUNNING exige aceptación real de un worker
  del duelo; REQUESTED no simula ejecución. Un árbitro ausente no permite SETTLED.
- Header y exactamente dos candidatos se anexan juntos con las dos tareas reales
  y sus intenciones presupuestarias por appendBatch/CAS; cardinalidad dos,
  referencias task/revision, modelos distintos y misma iniciativa se validan en
  el append. FK física entre header/hijas; task/revision es referencia tipada
  cross-stream, no FK a execution.
- Los pines de modelo/transporte/autoridad pertenecen a las revisiones/rutas
  referenciadas. No se copian como columnas mutables del candidato.
- criteria_sha256 fija la lista 1..64 de checks y sus weights/required. Cada
  candidate_number debe tener exactamente esa lista; admitir el evento compara
  claves, pesos y required con el artefacto, no sólo con valores positivos SQL.
  Los CHECK de filas no fingen validar cardinalidad o ejecución del árbitro.
- evidence_artifact_reference_id/hash apunta a EVIDENCE publicado y autorizado.
  UNDETERMINED tiene evidencia del motivo/resultado ausente, no una referencia NULL.
  El árbitro real ejecuta la evaluación; un payload que dice PASS no acredita nada.
- Checks registrados son inmutables por PK. Replay igual no muta, otra salida
  bajo la misma PK es conflicto. No actualizar pesos/outcomes para obtener ganador.
- adjudication_id refiere a adjudication_read_model del mismo stream; debe ser
  MODEL_DUEL con ese duel_id, ese árbitro y esos criterios. winner_task_id, cuando
  existe, debe estar entre los dos candidatos. Se verifica antes del append.
  Adjudicación y SETTLED se confirman juntos, insertando primero la adjudicación
  para satisfacer la FK; el veredicto no se duplica en el header.
- sequence es la última iniciativa-event aplicada a header o fila de check.
  Candidatos son la relación inmutable creada por la solicitud. Rebuild aplica
  eventos con referencias a cortes originales: no relanza candidatos/árbitro.
- Costos/resultados permanecen en execution/economy por sus referencias. UNKNOWN
  queda visible y no impide ganador técnico QUALITY_ONLY; no desempata ni
  constituye una recomendación económica.

Negativos: candidato3, misma tarea duplicada, check ajeno/faltante, NULL en peso,
required fuera de 0/1, evidencia alterada o árbitro igual al candidato rechazan.
Un check puntuable UNDETERMINED produce INCONCLUSIVE, no score cero. Un veredicto
que nombra tarea externa o árbitro no ejecutado nunca liquida el duelo.

---

## 10. `recommendation_read_model`

**Nuevo**, sin cambio de forma respecto del modelo anterior.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `recommendation_id` | TEXT | NOT NULL | PK. |
| `scope_kind` | TEXT | NOT NULL | — |
| `scope_id` | TEXT | NOT NULL | — |
| `kind` | TEXT | NOT NULL | `CHECK = 'INDEPENDENCE'` hoy; catálogo cerrado que crece por migración aditiva. |
| `code` | TEXT | NOT NULL | `CHECK IN ('SAME_WORKER','SAME_PROVIDER')`. |
| `detail_sha256` | TEXT | NOT NULL | — |
| `recorded_at` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ix_recommendation_read_model__scope` | `INDEX (scope_kind, scope_id)` |
| Rebuild | Determinista. |

---

## 11. `plan_simulation_read_model` y `plan_simulation_quota`

**Nuevo.** `quota_by_account_json` pasa a filas hijas (§3.5 canónico: si hay `WHERE`/`JOIN`
sobre el contenido, es tabla).

### 11.1 `plan_simulation_read_model`

El header completo y las hijas de nodos, métricas, calendarios, precios, muestras,
vector y dimensiones de cuota se definen una sola vez en
[simulation/index.md](simulation/index.md). La consulta efímera no escribe;
su guardado explícito usa `PLAN_SIMULATION_RECORDED` y el protocolo de
[streams §4.1](../streams/index.md#41-publicación-de-reportes-derivados).

`estimated_tokens`, `estimated_cost_nanos` y `estimated_seconds` son nullable
según sus estados KNOWN/ESTIMATED/UNKNOWN; no existe DEFAULT 0 para ausencia de
muestra/precio. La política, la fórmula de cuota y sus inputs/outputs strict
tienen un único dueño en [estimación](../../contracts/estimation/index.md#41-cuota-v1-dimensión-explícita-resta-y-reset).
La hija por cuenta de §11.2 conserva su propia definición y fuente histórica.

### 11.2 `plan_simulation_quota` (reemplaza `quota_by_account_json`)

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | PK (compuesta). `fk_plan_simulation_quota__plan_simulation_read_model`. |
| `account_id` | TEXT | NOT NULL | PK (compuesta). |
| `estimated_tokens_remaining` | INTEGER | NULL | `CHECK (estimated_tokens_remaining IS NULL OR estimated_tokens_remaining >= 0)`; valor fijado por la simulación, NULL sii quota_observation_status=UNKNOWN. |
| `quota_observation_status` | TEXT | NOT NULL | `CHECK IN ('KNOWN','ESTIMATED','UNKNOWN')`; estado del valor de esta simulación, no el estado móvil de la cuenta. |
| `source_observation_id` | TEXT | NULL | Fuente numérica fijada al corte; NULL sólo si no había observación utilizable. Una observación que registra UNKNOWN puede conservar su referencia. |
| `source_metric` | TEXT | NULL | Presente junto con la fuente; `CHECK IN ('TOKENS','USAGE_LIMIT_TOKENS')`; unidad TOKENS fijada por el contrato de esta fila. |
| `source_account_events_sequence` | INTEGER | NULL | Presente junto con la fuente; `CHECK > 0`. |
| `source_account_events_sha256` | TEXT | NULL | Presente junto con la fuente; digest del sidecar en esa secuencia. |

`ck_plan_simulation_quota__value_status`:
CHECK((quota_observation_status='UNKNOWN')=(estimated_tokens_remaining IS NULL)).
Los cuatro campos source son todos NULL o todos NOT NULL; fuente ausente exige
UNKNOWN. El evento de simulación fija el valor, estado, fórmula versionada y
referencia completa leída; si resta demanda estimada, el resultado es ESTIMATED,
no KNOWN. La fuente corresponde a la cuenta y fila (observation_id,source_metric,
'TOKENS') exactas. Referencia tipada con digest al vector, **sin FK física**
desde la cohorte initiative_events hacia la proyección de account_events.
El cálculo se guarda por cuenta/dimensión elegida y no agrega ventanas
incompatibles como si fueran saldos sumables; la política de simulación fija
la dimensión limitante y registra esa elección.

Lectura y rebuild no consultan la cuota «en curso»: recuperan el par histórico
y sus fuentes al corte original. Cambiar la observación actual de UNKNOWN a
KNOWN después de simular no altera ni el valor ni su interpretación.
Negativos: NULL/KNOWN y valor/UNKNOWN rechazan; fuente parcial o hash inválido
rechaza; estado actual distinto tras rebuild conserva la misma respuesta.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_plan_simulation_quota` | `PRIMARY KEY (simulation_id, account_id)` |
| Header e hijas extensas | Definición e índices únicos en [simulation](simulation/index.md). |
| Publicación | `PLAN_SIMULATION_RECORDED`, guardado explícito separado del dry-run; [streams §4.1](../streams/index.md#41-publicación-de-reportes-derivados). |
| Rebuild | Determinista desde initiative_events, con el corte y las referencias registradas; nunca consulta la cuota en curso. |

---

## 12. Mapeo legado → destino

| Objeto legado | Estado hoy | Destino | Nota |
| --- | --- | --- | --- |
| `initiative_read_model` | Hoy, mig. 4 | Se preserva + aditivo `title`/`objective_sha256`/`repository_sha256`. | §1 |
| `roadmap_version_read_model` | Hoy, mig. 4 | Se preserva + índice único aditivo. | §2 |
| `roadmap_step_read_model` (propuesto en el modelo anterior, PK `step_id` simple) | No existe | `roadmap_step_read_model`, PK `(roadmap_version_id, step_id)`. | §3, corrige colisión entre versiones |
| `roadmap_step_dependency` (propuesto en el modelo anterior, sin versión) | No existe | `roadmap_step_dependency`, versionado por `roadmap_version_id`. | §4 |
| `routing_assignment_read_model` (propuesto en el modelo anterior, con `allowed_fallbacks_json`) | No existe | `routing_assignment_read_model` + `routing_assignment_fallback`, alimentado por dos streams, con partial-unique GLOBAL/no-GLOBAL. | §6 |
| `task_dependency_read_model` (propuesto en el modelo anterior, PK `task_id` simple) | No existe | `task_graph_revision_read_model` + `task_dependency_read_model`, PK con revisión de grafo y de ambos extremos. | §5 |
| `dt_plan_read_model` | No existe (propuesto en el modelo anterior) | `coordinator_plan_read_model`, mismo esquema, nombre estable. | §7 |
| `owner_approval_read_model` | No existe (propuesto en el modelo anterior) | Igual nombre, forma expandida con nulidad exacta de decisión. | §8 |
| — (no nombrado en olddictionary; mencionado en revisión de documentación) | No existe | `adjudication_read_model`, `consultation_read_model`. | §9 |
| `recommendation_read_model` | No existe (propuesto en el modelo anterior) | Igual nombre, sin cambio de forma. | §10 |
| `plan_simulation_read_model` (propuesto en el modelo anterior, con `quota_by_account_json`) | No existe | `plan_simulation_read_model` + hijas normalizadas en [simulation](simulation/index.md); `plan_simulation_quota` permanece en §11.2. Dinero exacto y UNKNOWN nullable. | §11 |

Inventario aditivo de interacción (sin tablas legacy equivalentes):
`approval_wait_read_model` (§8.1), `model_duel_read_model`,
`model_duel_candidate_read_model`, `model_duel_check_read_model` (§9.3).
