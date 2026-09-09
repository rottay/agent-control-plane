# Datos: reglas, DER e invariantes

Dueño único de las **reglas transversales de persistencia**: clases de objeto,
normalización de identificadores, tipos y dominios, causalidad entre streams,
identidad, frontera transaccional, migración e invariantes.

El **diccionario físico por columna** vive en las hojas de este directorio.
Ninguna regla de esta página se repite allí; ninguna columna se declara aquí.

[Índice](../../README.md) · [Arquitectura](../index.md) · [Contratos](../contracts/index.md) · [Estructura](../structure/index.md) · [Requisitos](../../requirements/index.md) · [Hallazgos](../../findings/index.md)

| Hoja | Entidades que posee |
| --- | --- |
| [streams](streams/index.md) | los cuatro streams, `ledger_meta`, `schema_migrations`, `projection_watermark`, `account_event_integrity`, perfil de campos comunes |
| [planning](planning/index.md) | iniciativa, revisiones de roadmap, pasos y dependencias, DAG de tareas, asignaciones y fallbacks, plan del coordinador, aprobaciones/esperas, duelos, recomendaciones, simulaciones |
| [execution](execution/index.md) | tarea, revisión, intento, segmentos de ruta y handoffs, efectos e intentos de despacho, ocurrencias de prompt y respuesta, tool calls, checkpoints, verificación, veredicto, commit, anomalías; [avisos particionados](execution/notifications/index.md) sin otra outbox |
| [accounts](accounts/index.md) | cuenta y plan declarado, ventanas de cuota, observaciones de cuota, proyección de reservas, handoffs de cuenta, **el registry único: versión de modelo y sus hijas de capacidades, roles elegibles y transportes admitidos** |
| [economy](economy/index.md) | observaciones y liquidación de uso, catálogo de precios, snapshots de costo, período y asignación de suscripción, **desempeño medido por modelo y rol**, que referencia al registry sin duplicarlo |
| [artifacts](artifacts/index.md) | blobs, referencias, pins, tombstones, protocolo de publicación y recolección |
| [coordination](coordination/index.md) | `worktree_lease`, `tool_claim`, `account_reservation`, outbox, archivo de cuentas del owner |

Estado: **especificación**. Base inspeccionada `a92756b`. No autoriza migraciones ni
escritura de producto. *Hoy* fue leído en el árbol; *objetivo* todavía no existe.

---

## 1. Alcance

Deciden estas páginas: el vocabulario físico, la clase de cada objeto, qué es
autoridad y qué es derivado, la frontera transaccional de cada efecto y el orden
de migración compatible.

No deciden: qué caso de uso escribe cada hecho ([contratos](../contracts/index.md)),
en qué paquete vive el código ([estructura](../structure/index.md)), ni qué
requisito lo exige ([requisitos](../../requirements/index.md)).

**La base es agnóstica de motor con semántica transaccional explícita.** SQLite es
la implementación actual; un segundo backend debe ofrecer transacción serializable
sobre el stream, `compare-and-set` sobre cabezas y lectura consistente de una
proyección respecto de su `applied_sequence`. El journal de un motor de
orquestación **no** es una cache descartable: [contratos §9](../contracts/index.md).

---

## 2. Cuatro clases de objeto

| Clase | Qué es | Regla | Qué se pierde si desaparece |
| --- | --- | --- | --- |
| Stream | tabla append-only, encadenada por hash, con triggers que abortan `UPDATE` y `DELETE` | única autoridad; un hecho existe si está acá | evidencia: inaceptable |
| Read model | tabla derivada por proyección desde uno o más streams | se borra y se reconstruye de forma determinista, a cabezas fijadas | disponibilidad de consulta: recuperable |
| Coordination store | archivo aparte, sin historia, con fence monotónico y CAS | decide vivacidad: lease, reserva, claim, entrega | vivacidad: nunca evidencia |
| Blob | bytes direccionados por contenido en el filesystem | el stream guarda referencia y digest; los bytes tienen retención propia | contenido: la referencia sobrevive y lo declara |

Un objeto que no se puede reconstruir desde los streams **no es un read model**. Es
un coordination store y vive en su propio archivo. Ésta es la prueba, no el nombre
de la carpeta.

Un caso especial que se nombra porque induce a error: el **outbox** es un
coordination store, no autoridad de negocio. Almacena **sólo una cache de entrega
reconstruible**. La intención de negocio y su acuse viven en eventos del ledger.
Ante duda, se reconstruye desde el ledger o se sondea el destino antes de reenviar.

---

## 3. Normalización de identificadores

Regla general: **SQL en `lower_snake_case`, sin comillas, sin abreviaturas
inventadas, sin prefijo de paquete, sin identificador de packet ni de fase.**

### 3.1 Tablas

| Familia | Patrón | Ejemplo |
| --- | --- | --- |
| Stream | `<subject>_events` | `control_plane_events` |
| Proyección | `<concepto_singular>_read_model` | `task_revision_read_model` |
| Proyección de relación | `<izquierda>_<derecha>_read_model` | `worker_task_read_model` |
| Coordinación | `<concepto_singular>` | `worktree_lease`, `tool_claim`, `outbox_message` |
| Metadatos | `<concepto>_meta` o nombre propio | `ledger_meta`, `schema_migrations`, `projection_watermark` |

### 3.2 Índices, restricciones y triggers

| Objeto | Patrón |
| --- | --- |
| Índice | `ix_<tabla>__<columnas_en_orden>` |
| Índice único | `ux_<tabla>__<columnas_en_orden>` |
| Índice único parcial | `ux_<tabla>__<columnas>__<condicion>` |
| Clave primaria | `pk_<tabla>` |
| Clave foránea | `fk_<tabla>__<tabla_referida>` |
| Check | `ck_<tabla>__<regla>` |
| Trigger append-only | `tr_<tabla>__deny_update`, `tr_<tabla>__deny_delete` |

Doble guion bajo separa el nombre de la tabla de las columnas, porque los nombres
de tabla ya contienen guiones bajos.

### 3.3 Columnas

| Tipo de columna | Patrón | Ejemplo |
| --- | --- | --- |
| Identificador de concepto | `<concepto>_id` | `task_id`, `route_segment_id` |
| Digest | `<qué>_sha256` | `event_sha256`, `envelope_sha256` |
| Versión monótona | `<qué>_version` o `<qué>_number` | `contract_version`, `attempt_number` |
| Referencia a un stream | `<stream>_sequence` | `account_events_sequence` |
| Cantidad con unidad | `*_bytes`, `*_tokens`, `*_milliseconds`, `*_nanos` | `payload_bytes`, `amount_nanos` |
| Instante | `*_at`, siempre UTC | `occurred_at`, `expires_at` |
| Estado cerrado | `<concepto>_state` o `<concepto>_status` | `dispatch_state`, `valuation_status` |
| Booleano | `is_<predicado>`, `has_<predicado>` | `is_terminal` |

Prohibido: magnitudes sin unidad (`size`, `count`, `duration` sueltos), un `*_json`
cuya relación se consulta (§3.5), y una columna que repita el nombre de su tabla.

### 3.4 Tipos y dominios

Todas las tablas nuevas se declaran `STRICT`; las doce actuales ya lo son. Las
claves foráneas se aplican con la comprobación del motor activada, como ya hace la
apertura del ledger.

Un digest se nombra siempre `*_sha256`, nunca `*_digest`. Un instante se nombra
siempre `*_at`. Toda magnitud lleva su unidad en el nombre.

| Contenido | Tipo |
| --- | --- |
| Identificadores, digests, enums, instantes | `TEXT` |
| Conteos, booleanos, dinero | `INTEGER` |
| Payload de evento, documento versionado, extensión opaca | `TEXT` con JSON canónico, acotado en bytes y con `contract_version` |

Reglas de dominio. En **tablas nuevas** se expresan con `ck_`; en las tablas de
autoridad ya aplicadas se expresan con un **trigger `BEFORE INSERT` validador**,
porque SQLite no admite `ADD CONSTRAINT` y las migraciones aplicadas no se
reescriben (§3.6).

- **Digest SHA-256:**
  ```sql
  CHECK (length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*')
  ```
  La forma `GLOB '[0-9a-f]*'` es **incorrecta**: sólo restringe el primer carácter
  y acepta `a` seguido de sesenta y tres letras arbitrarias.

  **Ninguna tabla actual tiene esta comprobación**: es una regla objetivo, no una
  descripción del estado vigente.
- Conteos: `>= 0`. `attempt_number`, `revision_number`, `segment_number`,
  `projector_version`: `>= 1`.
- Booleanos: `IN (0, 1)`.
- Instantes: forma ISO-8601 canónica con milisegundos y sufijo `Z` verificada en
  SQL, más un **validador de calendario en el borde**, porque la forma no rechaza
  `2026-02-30T00:00:00.000Z`.
- Dinero: entero con signo de 64 bits en **nanounidades de la moneda declarada**,
  con `currency` explícita. Nunca punto flotante, nunca conversión implícita.

**Desconocido es `NULL` más un estado explícito, nunca `0`.** En
`quota_observation_metric_read_model`, un margen no observado tiene
`remaining_value NULL` y `remaining_status = 'UNKNOWN'`
([cuentas](accounts/index.md)); las demás métricas usan sus pares tipados. Un uso
sin precio aplicable tiene `amount_nanos NULL` y `valuation_status = 'PRICE_MISSING'`;
**no existe una tarifa de respaldo igual a cero**. Toda columna nullable declara en
su hoja la razón exacta de su nulidad.

Enums parcialmente poblados según el estado: una aprobación pendiente tiene
`decision`, `decider_identity` y `decided_at` en `NULL`; una aprobada o denegada
los exige, y un `ck_` lo impone. `EXPIRED` y `CANCELLED` son estados emitidos por
un evento con autoridad, no efectos secundarios de que pase el tiempo.

### 3.5 JSON: cuándo se permite

Permitido: payload de evento, documento de configuración versionado, extensión de
adapter en namespace versionado con schema. Siempre acotado en bytes, siempre con
la versión de contrato que lo interpreta.

Prohibido: una relación que alguien consulta. `enabled_models_json`,
`allowed_fallbacks_json`, `eligible_roles_json`, `transports_json` y
`quota_by_account_json` pasan a filas hijas ordenadas por `ordinal`. La prueba: si
existe o existirá un `WHERE` o un `JOIN` sobre ese contenido, es una tabla.

### 3.6 Excepciones legacy, inmutables

Las migraciones 1–6 están aplicadas y verificadas por checksum. **No se reescriben
para normalizar nombres.** Conservan su forma para siempre los dieciocho índices
existentes y los seis triggers `<tabla>_deny_update` / `<tabla>_deny_delete`. El
mapeo completo, objeto por objeto, está en [streams](streams/index.md).

Toda migración a partir de la 7 usa la convención de §3.2. La coexistencia es
deliberada y se documenta una sola vez.

### 3.7 Cómo se refuerza una tabla de autoridad ya aplicada

Cuatro mecanismos, y ninguno reescribe bytes existentes:

1. **Columnas aditivas nullable.** Una columna nueva es `NULL` en las filas
   históricas. `control_plane_events` recibe así `revision_number` y
   `attempt_number`: **ausentes en las filas legacy, y presentes y positivas las
   dos juntas en las filas nuevas**, con los mismos valores que el payload canónico
   del evento.
2. **Triggers `BEFORE INSERT` validadores**, para las restricciones de dominio que
   no se pueden añadir como `CHECK`.
3. **Tablas sidecar**, para lo que no cabe como columna (§9).
4. **Índices únicos parciales**, que pueden excluir el tramo histórico por
   condición explícita.

**La columna legacy `attempt` sigue siendo `NOT NULL`.** Para que una coordenada
nueva `(task_id, revision_number, attempt_number)` pueda escribirse en el stream,
se le asigna un `legacy_attempt_number` **plano y monótono por tarea**, una sola
vez por coordenada, registrado en el evento y en la proyección de intentos con
`ux_task_attempt_read_model__task_id_legacy_attempt_number`. Una repetición
**reutiliza** la asignación por `compare-and-set`; **no** se deriva del reloj.

**Un lector legacy no interpreta un evento nuevo como uno viejo.** Una versión de
contrato no soportada rechaza o degrada de forma explícita. Las rutas nuevas **no**
se doblan sobre el read model legacy ni reinician su clave: su compatibilidad es
de sólo lectura y está declarada.

**La clave de idempotencia de la forma nueva lleva un namespace de versión
explícito**, y su preimagen canónica incluye stream, sujeto, revisión, intento y
transición. La migración **comprueba que no colisione con ninguna clave histórica**
y rechaza explícitamente si colisiona. **Nada rehashea eventos antiguos.**

---

## 4. Los cuatro streams y su dueño

Un hecho pertenece a exactamente un stream. La regla es el sujeto de vida más
larga, no el momento en que se descubre.

| Stream | Sujeto | Contexto dueño de la semántica |
| --- | --- | --- |
| `control_plane_events` | una tarea | `runtime` |
| `initiative_events` | una iniciativa | `planning` |
| `account_events` | una cuenta | `accounts` |
| `registry_events` | un documento de configuración versionado, y el ciclo de vida de un artefacto | almacenamiento; la semántica la poseen `planning`, `accounts`, `economy` y `artifacts` |

Tres consecuencias que se fijan acá:

1. **No se inventa una iniciativa sintética para la configuración global.** El
   stream de iniciativas exige un `initiative_id` real. Una asignación de routing
   con scope `GLOBAL` es un documento versionado y vive en `registry_events`; las
   de scope `INITIATIVE` y `STEP` viven en `initiative_events`. La resolución de
   precedencia lee ambas fuentes contra un vector de watermarks.
2. **`registry_events` es almacenamiento de configuración, no un segundo motor
   semántico.** No decide elegibilidad, no puntúa modelos y no fija precios.
   `planning` posee la asignación, `accounts` posee el único registry de
   capacidades, `economy` posee el catálogo de precios. Un manifiesto de
   instalación de integraciones es otra cosa y no duplica ratings
   ([integraciones §4](../integrations/index.md)).
3. **Toda aprobación lleva contexto de iniciativa y digest del sujeto**:
   `initiative_id`, `subject_kind`, `subject_id`, `subject_revision_sha256`.
   `runtime` consume una autorización durable ya emitida; no la crea.
4. **Un solo registry de modelos, y su dueño es `accounts`.** La versión de modelo
   y sus tablas hijas —capacidades, roles elegibles, transportes admitidos— viven
   en la hoja de cuentas. `economy` posee precios, mediciones y desempeño, y **los
   referencia por identificador y por digest de snapshot**; no copia una puntuación
   de calidad ni crea un segundo registry. Un manifiesto de instalación de
   integraciones tampoco es un registry de modelos: son tres cosas distintas y no
   se fusionan.
5. **Un artefacto puede no tener tarea.** Un catálogo de precios, un documento de
   política o un artefacto de sistema no pertenecen a ninguna. Sus eventos de ciclo
   de vida, referencia, pin y tombstone viven en `registry_events` con
   `subject_kind = 'ARTIFACT'`. **No se abre un quinto stream, no hay clave foránea
   obligatoria hacia el stream de tareas, y no se inventa una tarea ni una
   iniciativa falsa.** El enlace desde una tarea, una iniciativa o una cuenta se
   hace por causalidad tipada con digest (§5). Ver
   [artifacts §1.1](artifacts/index.md).

**No hay `tenant_id` en ninguna tabla**, y ninguna base compartida de Rottay entra
en este producto. Los *scopes* de este modelo no son tenancy.

---

## 5. Causalidad entre streams

Las secuencias de dos streams **no son comparables**. El orden entre streams se
expresa de dos maneras, y sólo de esas dos:

1. **Referencia causal tipada:** `causation_stream`, `causation_sequence` y
   `causation_sha256`. La tripleta es verificable; un digest que no coincide es una
   referencia inválida, no un enlace débil.
2. **Vector de watermarks:** toda lectura que cruza streams se hace contra cabezas
   fijadas, nunca contra «lo último». `projection_watermark`
   ([streams](streams/index.md)) reemplaza a `projection_meta`, que tiene una sola
   fila por proyección y no puede describir una proyección alimentada por dos
   streams.

**Un read model determinista se define por sus filas canónicas a un vector de
cabezas fijado**, no por los bytes del archivo SQLite ni por un `updated_at` de
reloj de pared. `updated_at` desaparece de las proyecciones; en su lugar va
`applied_sequence` y, cuando importa el momento de negocio, el `occurred_at` del
evento que produjo la fila.

`projector_version` existe para que un cambio del algoritmo de fold invalide la
tabla derivada sin tocar el stream.

---

## 6. Identidad

El defecto N01 es que la identidad de una sumisión no incorpora objetivo ni
autoridad. La corrección no es «hashear todo»: es declarar la preimagen.

### 6.1 Escalera de identidad

| Nivel | Identificador | Qué lo cambia |
| --- | --- | --- |
| Tarea | `task_id` | nada; estable de por vida |
| Revisión | `(task_id, revision_number)`, con `revision_id` único | cualquier cambio semántico del trabajo |
| Intento/run V1 | `(task_id, revision_number, attempt_number)` ↔ `invocation_id` único | un reintento real de la misma revisión; replay y handoff conservan la biyección |
| Segmento de ruta | `route_segment_id` | cada handoff dentro de un intento |
| Efecto lógico | `effect_id` | una operación lógica nueva |
| Intento de despacho | `dispatch_attempt_id` | cada entrega externa del mismo efecto |
| Ocurrencia | `occurrence_id` | cada envío o recepción concreta |

`effect_id` es **estable** para el mismo paso lógico dentro del run V1. El lookup
por identidad lógica de [execution §6.1](execution/index.md) ocurre **antes** de
asignar ordinal o derivar el efecto. Replay devuelve el efecto original sin crear
otro despacho; una nueva entrega autorizada crea `dispatch_attempt_id`, no otro
efecto. Handoff produce un segmento con linaje, pero no cambia el efecto ni su
clave de idempotencia. Este mínimo pertenece a P-18/M4, no espera a P-23/M7.

### 6.2 Preimagen del `envelope_sha256`

**Cubre todos los campos del contrato `TaskEnvelope`**, no una selección. Incluye,
además del objetivo, la autoridad, los sets y la política: comandos permitidos,
acciones prohibidas, claves de conflicto, reglas de validación, criterios de
elegibilidad, forma de salida esperada, política de checkpoint, requisito de
evidencia visual, clasificación y emisor de la autoridad. El contrato maestro es
`kernel/contracts` y esta página **no** reproduce una preimagen parcial que se
desactualizaría.

Queda fuera de la preimagen: el reloj por defecto, el `attempt_number`, el
`account_id`, el `model_version_id` resuelto y cualquier identificador de proceso.
Cambiar de cuenta no crea una revisión; cambiar cualquier campo del envelope, sí.

### 6.3 Preimagen de la clave de idempotencia

Se conserva la fórmula existente: `effect_kind`, la coordenada `(task_id,
revision_number, attempt_number, segment_number, operation_ordinal)` y
`envelope_sha256`. Se aplica **una sola vez**, al crear una operación lógica
nueva, con el segmento **inicial de ese efecto**. Antes se hace el lookup de
[execution §6.1](execution/index.md): si la operación ya existe se devuelve su
identidad/preimagen original, incluso después de handoff; no se recalcula con
el segmento actual. El segmento efectivo de cada entrega vive en dispatch_attempt.

**El reloj por defecto queda fuera.** Cuando el efecto depende genuinamente del
tiempo, el instante entra como parámetro explícito y registrado. El índice lógico
adicional no sustituye ni rehashea effect_id, idempotency_key o envelope_sha256.

### 6.4 Catálogo mínimo de estados

Cerrado, exhaustivo, compartido por todos los efectos externos:

| Vocabulario | Valores |
| --- | --- |
| `effect_outcome_status` | `SUCCEEDED`, `FAILED`, `CANCELLED`, `OUTCOME_UNKNOWN` |
| `dispatch_state` | `INTENDED`, `CLAIMED`, `INFLIGHT`, `SETTLED`, `ABANDONED` |
| `observation_status` | `KNOWN`, `ESTIMATED`, `UNKNOWN` |
| `valuation_status` | `VALUED`, `PRICE_MISSING`, `USAGE_UNKNOWN`, `EXTERNAL` |
| `refusal_class` | `REQUEST_INVALID`, `PRECONDITION_FAILED`, `AUTHORITY_REFUSED`, `CAPABILITY_UNSUPPORTED`, `RESOURCE_EXHAUSTED`, `CONFLICT`, `TRANSPORT_UNAVAILABLE` |
| `model_resolution_status` | `RESOLVED`, `UNKNOWN`, `NOT_OBSERVABLE` |
| `dependency_failure_policy` | `WAIT_SUCCESS` (por defecto), `ALLOW_FAILURE`, `REQUIRE_TERMINAL` |
| `approval_state` | `PENDING`, `GRANTED`, `DENIED`, `EXPIRED`, `CANCELLED`, `REVOKED` |
| `adjudication_kind` | `REVIEW_CORRECTION`, `MODEL_DUEL` |

`OUTCOME_UNKNOWN` no es un fallo y no habilita reintento. Un `INFLIGHT` vencido
**no** implica que reintentar sea seguro: implica reconciliar por handle o por
postcondición.

### 6.5 Cómo se representa la ausencia de dato

Un dato que no se conoce **no se inventa y no se codifica como cadena vacía**.

- **Modelo resuelto.** `model_version_id` es `NULL` cuando el estado es `UNKNOWN` o
  `NOT_OBSERVABLE`, **incluso después de haber ejecutado**. `provider_id` y
  `requested_model_id` se preservan siempre. La ocurrencia de prompt sigue el mismo
  contrato que el segmento de ruta.
- **Despacho.** `CLAIMED` **no** significa que el destino externo haya aceptado.
  `accepted_at` existe sólo si hubo aceptación; es `NULL` si el intento fue
  abandonado antes de despachar. `terminal_at` es explícito y sólo existe en
  `SETTLED` o `ABANDONED`.
- **Efecto.** `outcome_status` y `outcome_recorded_at` son `NULL` antes del
  desenlace. `OUTCOME_UNKNOWN` se registra **sólo** cuando hay una exposición
  incierta real; nunca es el valor por defecto de una intención que jamás se envió.

### 6.6 Aprobación, receipt y commit

- **Estado y decisión son coherentes por construcción.** `GRANTED` exige
  `decision = 'GRANTED'`; `DENIED` exige `decision = 'DENIED'`. `PENDING`,
  `EXPIRED` y `CANCELLED` no llevan decisión.
- **Revocar no borra.** Una aprobación concedida y luego revocada pasa a `REVOKED`
  conservando el vínculo con su concesión. Vencida, revocada o cancelada **no se
  puede consumir**, aunque una proyección la haya mostrado concedida.
- La transición de pendiente a decidida se resuelve por `compare-and-set` sobre la
  **versión esperada** contra la cabeza del stream de iniciativas. Toda aprobación
  lleva `authority_sha256` y el sujeto y la revisión exactos.
- **Adjudicación es un concepto general, no un duelo.** Lleva
  `(subject_kind, subject_id, subject_revision_sha256)`, `adjudication_kind`, el
  actor y su autoridad, la decisión y la referencia a la corrección.
  `source_rejection_id` es `NULL` sólo cuando no hay corrección de origen;
  `duel_id` y el ganador existen **sólo** en la rama de duelo. Una consulta de hito
  tampoco necesita un duelo.
- **El receipt lleva metadata obligatoria**: tarea, revisión, `base_sha`,
  `tree_sha`, `policy_sha256`, `write_set_sha256`, identidad y corrida del
  verificador, estado, checks y su digest, más la referencia al artefacto privado
  que contiene la salida completa.
- **El commit valida antes de tocar Git**: igualdad exacta contra el receipt, un
  `PASS` independiente, y revalidación de la base, el tree y el write-set actuales.
  Después registra el SHA **observado**. Una referencia foránea no autoriza nada.
- **Un envelope privado se lee por referencia autorizada de artefacto**, no por
  conocer su `envelope_sha256`.

**El vocabulario de estado de cuenta ya existe y se preserva**: `AVAILABLE`,
`DRAINING`, `EXHAUSTED`, `COOLDOWN`, `AUTH_REQUIRED`
(`kernel/contracts/src/schemas/account-record/index.ts:15`). Cualquier estado nuevo
se agrega con mapeo explícito contra ese enum; no se inventan alias como `READY` o
`DRAINED` para nombrar lo que ya tiene nombre.

---

## 7. Claves, unicidad y preservación de la historia

Reglas que gobiernan los siete dominios del diccionario y sus hojas subordinadas;
los detalles por tabla están allí.

1. **Una clave primaria no puede colisionar tras un restore, una revisión nueva o
   un reinicio de la numeración de intentos.** La coordenada completa incluye la
   revisión.
2. **`(task_id, attempt)` es una clave legacy** y sirve sólo para los eventos ya
   escritos con esa forma. Lo nuevo usa revisión y segmentos.
3. **No existe `UNIQUE(task_id, envelope_sha256)`.** Restaurar un envelope anterior
   es una **revisión nueva** con el mismo digest, y esa unicidad lo impediría.
4. Un paso de roadmap se identifica por `(roadmap_version_id, step_id)`: una
   revisión de roadmap no muta los pasos de la anterior.
5. Una arista del grafo de tareas se identifica incluyendo la revisión del grafo y
   la de ambos extremos.
6. Un tool call se identifica por su `effect_id`; el identificador de transición
   por sí solo no distingue dos ejecuciones del mismo punto.
7. **`UNIQUE` con una columna `NULL` no garantiza unicidad.** Un único documento
   `GLOBAL` se impone con un **índice único parcial** sobre la condición
   `scope_kind = 'GLOBAL'`; los scopes no globales usan un índice parcial
   complementario con `scope_id NOT NULL` comprobado por `ck_`.
8. Un documento de configuración tiene identidad estable propia
   (`document_id`) y se versiona con `UNIQUE(document_id, document_version)`; el
   padre comparte `document_id`. **No** se usa `UNIQUE(document_kind, version)`:
   dos documentos distintos de la misma clase son legítimos.

---

## 8. Claves foráneas y reconstrucción

1. **Una FK física sólo dentro de una misma cohorte de reconstrucción**, con
   `ON DELETE RESTRICT` y `DEFERRABLE` donde el orden lo exija.
2. **Un evento autoritativo nunca lleva FK hacia una proyección descartable.**
3. **Referencias entre streams y referencias polimórficas** (`subject_kind` +
   `subject_id`) no se expresan como FK: se validan con comprobación tipada, se
   sostienen con un índice de búsqueda y se anclan con el digest de la fuente.
4. La reconstrucción se define por filas canónicas a un vector de cabezas fijado.
   Una tabla compartida por particiones de fuente declara su cohorte por predicado,
   nombres lógicos de projector, vector y alcance exacto de reemplazo. El caso
   [notifications](execution/notifications/index.md#21-cohortes-y-watermarks-tres-particiones-no-mezcla-implícita)
   tiene tres particiones owner_stream; una reconstrucción parcial no toca filas
   vecinas y su lectura combinada exige las tres al mismo vector causalmente cerrado.
5. **Antes de borrar una proyección para regenerarla se verifica la cadena.** Una
   reconstrucción sobre cadena rota se rehúsa; hoy se rehúsa para dos streams y
   debe rehusarse para los cuatro.

---

## 9. Integridad de `account_events`

Hoy `account_events` no tiene cadena de hashes, `verifyIntegrity` no la cubre, y
`appendAccountAction` comprueba `event_id` e `idempotency_key` pero **no una
versión esperada**: dos eventos con la misma `(account_id, version)` y distinta
clave son insertables. El índice existente `account_events_by_account` no es único.

Las migraciones 1–6 son inmutables, así que no se agregan columnas al stream. La
solución es un sidecar append-only, `account_event_integrity`, con clave y clave
foránea sobre la secuencia del stream, `previous_sha256` y `event_sha256` único.

Construcción del baseline, exacta:

1. Bajo **bloqueo migratorio**, se fija transaccionalmente la cabeza `H` del stream
   de cuentas.
2. El sidecar se construye sobre **todos** los bytes históricos existentes, de la
   secuencia 1 a `H`. La génesis es sesenta y cuatro ceros.
3. Cada hash se computa sobre un **formato versionado documentado**: el hash
   anterior más la fila canónica **exacta de los valores almacenados**, sin
   modificarla.
4. La metadata de activación registra `H`, el hash final y el momento de
   activación.

Cuatro condiciones no negociables:

- **La autenticidad anterior a la activación no queda probada.** El sidecar
  cubre los bytes históricos 1..H tal como estaban al activarlo y detecta
  cambios posteriores. `verifyIntegrity` distingue cobertura de bytes y
  procedencia de la cadena mediante el contrato exacto de
  [streams §8.2](streams/index.md); no presenta ambos hechos como equivalentes.
- **`covered_since` no se mueve y no se reancla automáticamente.** Si se detecta
  corrupción, el sistema falla de forma cerrada, **preserva el segmento** y exige
  una decisión de reparación explícita e inmutable, fuera de una migración normal.
- **Preflight de duplicados antes de la restricción.** La migración cuenta las
  violaciones existentes y falla nombrándolas; **no deduplica en silencio**. La
  resolución de un conflicto histórico se registra en
  [decisiones](../../decisions/index.md).
- Después de la activación, evento, hash, cabeza y proyección ocurren en **una sola
  transacción**, y el append hace `compare-and-set` por versión esperada.

---

## 10. Durabilidad: lo que la configuración actual garantiza

`journal_mode = WAL` y `synchronous = NORMAL`
(`persistence/ledger/src/ledger/index.ts:457–458`). Con `NORMAL` en WAL, SQLite no
hace `fsync` en cada commit: una **muerte del proceso** no pierde transacciones
confirmadas, pero un **corte de energía o un pánico del sistema operativo** puede
perder las últimas.

- Los drills de SIGKILL prueban recuperación ante muerte de proceso. **No prueban
  durabilidad ante pérdida de energía**, y no se puede afirmar lo contrario.
- El perfil certificado de producción declara `synchronous = FULL`; el de
  desarrollo mantiene `NORMAL`. El perfil vigente es observable en `/status`, no
  una suposición.
- La matriz de crash por perfil está en
  [quality/testing](../../quality/testing/index.md).

---

## 11. Frontera transaccional y saga

Tres bases distintas —ledger, arbiter de leases, arbiter de reservas— no comparten
transacción. La secuencia es fija:

```
1. ledger BEGIN IMMEDIATE
     validar admisión de cuota y contabilizar débitos pendientes (cuentas §4)
     append INTENT (effect_id, idempotency_key, revisión de política, reclamo de presupuesto)
     + evento completo de intención de comando (saga_id, command_id, fase y destino)
   COMMIT
2. arbiter CAS de la operación vinculada a command_id
     → token (store_incarnation_id, fence) + grant, o rechazo tipado
3. ledger append ACK de reserva o lease, con el fence obtenido
4. sólo entonces: trabajo externo
5. dispatch_attempt → clave de idempotencia del proveedor → handle externo registrado
6. desenlace: SUCCEEDED | FAILED | CANCELLED | OUTCOME_UNKNOWN
7. artefacto de resultado publicado ANTES de su referencia en el ledger
8. liberación por acuse de outbox, no por borrado optimista
```

Las entidades que esta saga necesita existen y están declaradas, no aludidas:
`effect_read_model` y `dispatch_attempt_read_model` en
[execution](execution/index.md); `outbox_message` y los stores de lease, claim y
reserva en [coordination](coordination/index.md).

Reglas derivadas:

- `appendBatch`: cabeza, eventos, proyección afectada e intención de outbox en
  **una** transacción del ledger. La cuarentena deja de ser tres transacciones.
- **El ledger y un coordination store no comparten transacción**, porque son
  archivos distintos. Lo que es atómico es lo que ocurre **dentro del ledger**: la
  cuarentena junto con el **evento completo de intención de comando** que revoca
  el lease; nunca una fila del archivo separado `outbox.sqlite`.
  La revocación efectiva en el arbiter —el `compare-and-set` que avanza el fence—
  y su acuse se reconcilian **por saga**, no por transacción.
- **No se admite un writer nuevo hasta que ese acuse existe y el fencing es
  efectivo.** Mientras tanto la admisión queda bloqueada. El holder viejo falla por
  fence.
- **Nunca se afirma una transacción cruzada que no existe.** Cualquier prosa que
  sugiera atomicidad entre el ledger y un arbiter es incorrecta.
- Un `INFLIGHT` vencido habilita **reconciliación**, no reintento.
- **La proyección de reservas se deriva de eventos**, nunca de leer el arbiter
  mutable. El arbiter concede y libera; el ledger registra.
- El outbox separado es sólo cache. `saga_id` agrupa; cada `command_id` es único
  y determinista por `(saga_id, phase, target_kind, target_id)`. Dos destinos de
  una saga tienen comandos distintos. El `operation_id` del CAS se vincula al
  comando concreto; reintentar no inventa una identidad nueva.
- El intento de entrega se registra en el ledger **antes** de enviar. Perder la
  cache no convierte un envío incierto en PENDING. `INFLIGHT` vencido pasa a
  `RECONCILING`; sólo se reintenta con no-despacho demostrado o idempotencia
  comprobada del destino. La tabla cerrada de transiciones y el acuse están en
  [coordinación §2 y §6](coordination/index.md).
- Todos los archivos de coordinación, incluido el blob lease, tienen metadata
  `coordination_store_meta` persistente. Restore o pérdida congela admisión,
  reconcilia contra el ledger y exige quiescencia previa a una nueva encarnación
  UUID y sus acuses. Tokens viejos se rechazan aunque coincida el fence numérico.
  No se admite trabajo si no se probó esa quiescencia; el procedimiento físico
  está en [coordinación §8](coordination/index.md).

---

## 12. Artefactos

**Identidad de bytes e identidad de acceso son distintas.** El digest identifica
contenido; la referencia identifica un acceso con dueño, scope, política y
retención. Dos referencias al mismo blob con políticas distintas son legítimas: por
eso **no** existe `UNIQUE(scope, digest, producer)`.

Publicación:

```
staged → bytes escritos → hash verificado → fsync(archivo)
       → rename atómico → fsync(directorio) → referencia en el ledger
```

Ciclo de vida bajo generación exclusiva:

- Los eventos de lifecycle, referencia, pin y tombstone viven en `registry_events`
  con `subject_kind = 'ARTIFACT'`; las FK de secuencias y el watermark apuntan a
  ese stream. No se inventa una tarea para un artefacto SYSTEM ni un quinto stream.
  M1 crea registry y metadata de artefactos antes del primer prompt.
- La publicación **adquiere exclusión efectiva antes de registrar intención y pin**,
  y reserva el pin antes de escribir en el filesystem. Éxito o abandono
  reconciliado libera el pin por append/fold atómico; la exclusión se conserva
  hasta el acuse. `PUBLICATION_INTENDED` crea la generación STAGED y su pin en
  la misma transacción; una generación ya publicada deduplicada conserva su historia.
- La recolección actúa sólo tras una **intención de reclamo** bajo generación
  exclusiva (lease o CAS sobre el blob), con recomprobación contra la cabeza de
  eventos, y sólo sobre blobs sin referencias vivas, sin pins y pasado el período
  de gracia. La secuencia exacta de adquisición, recomprobación, borrado y acuse,
  y su recuperación ante crash, está en [artifacts](artifacts/index.md). No se
  apoya en «mientras haya una transacción abierta», que no cruza al filesystem.
- **Borrado de acceso referenciado:** tombstone irreversible por referencia;
  leerla devuelve GONE aunque sobrevivan otras referencias o se republican bytes.
  La PK del blob es `(content_sha256, blob_generation)` y las FK de referencias,
  pins y tombstones fijan esa generación. Sólo hay una generación no reclamada
  por digest; las históricas permanecen. Republicar después del reclamo crea
  generación y referencia nuevas, sin levantar tombstones previos.
- Los metadatos `first_published_sequence/at` permanecen ambos NULL para una
  generación que nunca se publicó, también si se abandona y recolecta. Un éxito
  real los fija; el resto del lifecycle los preserva. La gracia parte del primer
  evento de intención de esa generación y no se reinicia por recuperación.
- El GC sostiene la misma exclusión efectiva durante toda la comprobación,
  unlink y acuse; ningún publicador puede intercalar una mutación de pin o
  referencia. TTL vencido sólo habilita reconciliación. Transferir exige muerte
  y reap/quiescencia probada o backend que impida I/O con token viejo; la duda
  bloquea. CAS numérico por sí solo no protege el filesystem.
- **Vencer no revoca permiso** por sí solo: la revocación es una decisión de
  política registrada.
- **Compartir un digest no concede permiso.** El acceso se resuelve por referencia
  y scope, nunca por conocer el digest.
- Las rutas se derivan del digest, jamás de una referencia no confiable; los
  symlinks se rechazan y toda ruta se comprueba contra la raíz resuelta.
- **Backup consistente:** ledger, WAL y artefactos bajo la misma ventana. Un
  restore formal escribe un `restore_id` nuevo —UUID aleatorio, no un contador—
  **antes** de admitir trabajo. Un contador colisiona si se restaura dos veces el
  mismo backup. El cursor del cliente es `(instance_id, restore_id, stream,
  sequence, event_sha256)`. Esto detecta un restore formal; **no** se promete
  detectar una copia manual arbitraria con metadatos idénticos sin estado externo.

---

## 13. Economía: reglas de valuación

- `*_nanos` entero con signo, `currency` explícita, **sin conversión implícita**.
  Un reporte multi-moneda es multi-columna, no una suma.
- Aritmética con **racional exacto por operación**: numerador decimal canónico en
  texto de precisión arbitraria y denominador entero positivo, porque los precios
  se expresan por millón de tokens. El **redondeo `HALF_TO_EVEN` se aplica una sola
  vez, después de la suma racional**, con comprobación de rango antes de convertir
  a entero de 64 bits.
- **La moneda forma parte de la identidad monetaria** y de la de desempeño; no es
  un adorno de la fila.
- **El costo no es un hecho autoritativo independiente**: es un *snapshot* derivado
  de uso liquidado y de una versión de catálogo fijada. Su encabezado lleva la
  versión del cálculo; sus hijos referencian el **vector** de cabezas de origen por
  stream, secuencia y digest. **Un vector no es un entero** y no cabe en una
  columna escalar. Referencia liquidación histórica u observaciones exactas, no una
  proyección mutable.
- `computed_at` es el instante del **evento de cálculo registrado**, nunca el reloj
  del proceso que reconstruye. El `as_of` se ancla a un watermark por la misma
  razón.
- Un catálogo tiene identidad estable `catalog_document_id` más `catalog_version`,
  y **ambos aparecen en toda clave y en toda búsqueda**. Su vigencia es un
  intervalo semiabierto `[effective_from, effective_to)`, con fin `NULL` para
  infinito y fin estrictamente mayor que el inicio. **El catálogo entero se valida
  sin solapes por proveedor, modelo, clase de token y moneda, y se publica de forma
  atómica.**
- La versión de catálogo se fija **antes del gasto**, en el despacho, y **un replay
  jamás selecciona otra versión**. Una línea de snapshot referencia la clave
  completa del intervalo. Sin precio aplicable no hay tarifa de respaldo cero: hay
  exposición desconocida. Un catálogo con vigencia retroactiva es una versión
  nueva y no recalcula en silencio los snapshots históricos.
- Un catálogo de precios es **configuración**; el registry de capacidades y calidad
  es otra cosa y tiene otro dueño. No se fusionan.
- **Tres medidas separadas:** gasto API medido, prorrateo contable de la
  suscripción, y valor equivalente a precio de API. La asignación del período usa
  **resto mayor** sobre los pesos exactos del equivalente **conocido**, con
  desempate estable por orden de `effect_id` y un bucket explícito para lo
  desconocido; asignado más no asignado es exactamente el costo del período.
- Los hechos del período de suscripción y sus **cortes de asignación** son tablas
  distintas: la asignación tiene encabezado y corte propios, referencia las
  revisiones de costo que usó y conserva los cortes anteriores. Cerrar o reabrir un
  período es un evento de control con su corte de origen, no una edición de hechos
  de costo.
- El costo por resultado aceptado es `NULL` cuando no hubo aceptados; **no es
  cero**. Costo real y valor equivalente son estados distintos y no se suman.
- **No se publica una «brecha» sin nombrar su fuente.**

### 13.1 Liquidación de uso

- Las observaciones llegan por **flujos de medición** identificados, con su fuente,
  cuenta, segmento de ruta y época de origen. Dentro de un flujo, el ordinal es
  único.
- `DELTA` cubre un rango explícito del contador de uso. `CUMULATIVE` **sustituye**
  los rangos que declara. `CORRECTION` señala la observación que corrige, dentro
  del mismo flujo y sin ciclos, y la reemplaza. Un indicador de dato final **no
  prohíbe** una corrección tardía: genera una versión nueva.
- **Un rango ambiguo o un solapamiento de deltas no explicado se rechaza.** No se
  suma dos veces.
- **Prioridad de fuentes congelada** por adapter y política: lo autoritativo del
  proveedor por encima de lo medido por el envoltorio, y eso por encima de una
  estimación. **Nunca se suman dos reportes del mismo gasto provenientes de fuentes
  distintas.** Un desacuerdo incomparable produce un estado en disputa o
  desconocido con su exposición, **no un cero**.
- Las clases de token son **mutuamente excluyentes** y las declara el contrato
  normalizado del adapter: la entrada cacheada no se vuelve a sumar dentro de la
  entrada no cacheada.
- El orden de llegada al ledger permite reconstruir si hubo llegada tardía.

---

## 14. Invariantes

1. Ningún byte de prompt, respuesta, argumento de herramienta ni credencial en
   ninguna tabla. Sólo digests, conteos, referencias y vocabulario cerrado.
2. Todo read model se reconstruye desde los streams, a un vector de cabezas fijado,
   con filas canónicas idénticas. Lo que no cumple esto es coordinación.
3. Los cuatro streams se verifican en `verifyIntegrity`, y el resultado declara
   `covered_since_sequence` por stream.
4. Una asignación de routing referencia un `model_version_id` `ACTIVE`; uno
   `RETIRED` bloquea y propone migración, nunca degrada en silencio.
5. Un snapshot de costo referencia una `valuation_revision` y una versión de
   catálogo fijadas; un cambio de precios crea filas nuevas y jamás reescribe.
6. Un handoff de cuenta sólo es `SUCCEEDED` si existe un segmento de ruta posterior
   en la cuenta destino, con sesión abierta y checkpoint rehidratado.
7. `instance_id` y `restore_id` viajan en el frame `hello` del stream; el cursor
   del cliente los incluye.
8. Una aprobación no libera trabajo cuyo `subject_revision_sha256` difiere del
   aprobado, ni después de `expires_at`.
9. Un efecto con desenlace `OUTCOME_UNKNOWN` conserva su exposición de costo y no
   se reintenta ciegamente.
10. Los mismos bytes son un blob y N ocurrencias; compartir digest no concede
    permiso fuera del scope de la referencia.
11. La suma de asignado más no asignado de un período es exactamente el costo de
    ese período.
12. Ninguna migración reescribe una migración aplicada.
13. Toda columna nullable tiene una razón declarada y, cuando el estado la exige
    poblada, un `ck_` que lo impone.

---

## 15. Migración

Reglas, no cronograma. El cronograma está en [roadmap](../../roadmap/index.md) y
los write-sets en [packets](../../implementation/packets/index.md).

1. **Aditiva siempre.** Tablas y columnas nuevas, índices nuevos. Nunca `DROP` de
   una columna con datos, nunca reescritura de una migración con checksum aplicado.
2. **Preflight antes de toda restricción nueva.** Una migración que agrega `UNIQUE`
   cuenta primero las violaciones y **falla nombrándolas**.
3. **Baseline histórico explícito** en toda garantía que empieza a mitad de la vida
   de una tabla (§9).
4. **Compatibilidad de lectura y de admisión** mientras conviven la forma vieja y
   la nueva; la admisión declara cuál está vigente.
5. Orden de aterrizaje, cada escalón utilizable por sí solo:
   1. `instance_id`, `restore_id`, `appendBatch`, `projection_watermark` y
      `registry_events` para configuración y lifecycle de artefactos (§12).
   2. `account_event_integrity` con baseline, preflight, unicidad de versión y CAS.
   3. Escalera de identidad: revisión, intento, segmentos de ruta.
   4. Efectos e intentos de despacho, outbox, ocurrencias, blobs y referencias.
   5. Versiones de modelo y catálogo de precios sobre el registry ya creado;
      después uso, liquidación, snapshots de costo y período de suscripción.
   6. Cuentas: cuenta, ventanas y observaciones de cuota, reservas, handoffs.
   7. Planificación: pasos, dependencias versionadas, asignaciones, aprobaciones,
      plan del coordinador, simulaciones.
   8. Proyecciones de los beats que hoy son `PLAIN`: checkpoint, verificación,
      veredicto, commit.
   9. Desempeño y anomalías.

Registry precede a blobs/referencias, nunca al revés. El bootstrap de asignación y
las fuentes de uso/catálogo preceden al primer efecto que las consume; el cierre
completo de equipos y economía puede ser posterior. Las entregas internas de
[packets §1.8](../../implementation/packets/index.md) fijan esos cortes sin dividir
las unidades transaccionales ni alterar los checksums aplicados.

---

## 16. Negativos obligatorios

Viven en [quality/testing](../../quality/testing/index.md); acá se nombra el hecho
de datos que deben falsar.

1. Dos eventos de cuenta con la misma `(account_id, version)` → rechazo tipado.
2. Aprobación vencida, o con digest de revisión distinto → no libera trabajo.
3. Los mismos bytes de prompt enviados dos veces → dos ocurrencias, un blob.
4. Varios handoffs en un intento → linaje completo de segmentos.
5. Uso parcial, cumulativo, con corrección y con llegada tardía → una liquidación
   correcta, sin doble conteo, con la tardanza visible.
6. Uso sin precio aplicable → exposición desconocida, nunca costo cero.
7. Artefacto de otra iniciativa conocido por digest → acceso denegado.
8. Crash en **cada** frontera de la saga de §11 → sin efecto duplicado conocido y
   con exposición registrada donde el desenlace es incierto.
9. Fence viejo tras recuperación → el holder anterior no puede continuar.
10. Trigger append-only borrado → el inventario de objetos lo detecta al abrir.
11. Blob ausente para una referencia viva → error explícito, no fila vacía.
12. Reconstrucción multi-stream desde cero, dos veces, al mismo vector de cabezas →
    filas canónicas idénticas.
13. Digest de sesenta y cuatro caracteres con una letra fuera de `[0-9a-f]` en
    posición distinta de la primera → rechazado por el `ck_`.
