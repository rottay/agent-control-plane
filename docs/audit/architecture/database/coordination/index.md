# Coordinación: leases, claims, reservas y outbox

Diccionario físico de los objetos que deciden **vivacidad**: quién tiene el
worktree, quién ejecuta una herramienta, quién consume el margen de una cuenta, y
qué falta entregar. Las reglas transversales viven en el [maestro](../index.md).

---

## 1. Qué posee esta hoja

| Objeto | Archivo | Clase | Perder este objeto cuesta |
| --- | --- | --- | --- |
| `worktree_lease` | `worktree-leases.sqlite` | coordination store | vivacidad |
| `tool_claim` | `tool-claims.sqlite` | coordination store | vivacidad |
| `account_reservation` | `account-reservations.sqlite` | coordination store | vivacidad |
| `outbox_message` | `outbox.sqlite` | coordination store | vivacidad |
| `artifact_blob_lease` | `artifact-blob-leases.sqlite` | coordination store; diccionario en [artefactos §7](../artifacts/index.md), archivo por [decisión 62](../../../decisions/index.md) | vivacidad |
| Archivo de cuentas del owner | fuera de todo repositorio | documento externo | nada: entra por digest |

**Ninguno es autoridad de negocio.** Todos conceden, y el ledger registra. Una
proyección de reservas se deriva de **eventos**, nunca de leer el arbiter mutable.

**El ledger y estos archivos no comparten transacción.** Lo atómico ocurre dentro
del ledger; el `compare-and-set` del arbiter y su acuse se reconcilian por saga
([maestro §11](../index.md)). **Nunca se afirma una transacción cruzada que no
existe.**

---

## 2. Vocabularios

| Vocabulario | Valores |
| --- | --- |
| `tool_claim_state` | `CLAIMED`, `IN_FLIGHT`, `SETTLED` — **existente, se preserva** |
| `reservation_state` | `HELD`, `RELEASED`, `EXPIRED` |
| `outbox_state` | `PENDING`, `INFLIGHT`, `RECONCILING`, `DELIVERED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `ABANDONED` |
| `outbox_command_kind` | `RELEASE_RESERVATION`, `REVOKE_LEASE`, `NOTIFY`, `EXPORT_TELEMETRY` |
| `store_incarnation_id` | UUID por encarnación de un coordination store; ver §8 |

Transiciones admitidas del outbox, y ninguna otra:

```
PENDING   → INFLIGHT | ABANDONED
INFLIGHT  → DELIVERED | FAILED_RETRYABLE | FAILED_TERMINAL | RECONCILING
RECONCILING → DELIVERED | FAILED_RETRYABLE | FAILED_TERMINAL | ABANDONED
FAILED_RETRYABLE → PENDING | ABANDONED
DELIVERED, FAILED_TERMINAL, ABANDONED   terminales
```

---

`FAILED_RETRYABLE` sólo se alcanza cuando está demostrado que no hubo despacho,
o cuando reenviar con la misma clave tiene idempotencia comprobada en el destino.
Desde `RECONCILING`, `ABANDONED` exige no-despacho demostrado o confirmación del
destino de terminación sin efecto pendiente; un desenlace desconocido permanece
`RECONCILING`. El vencimiento no agrega otra transición.

## 3. `worktree_lease` — existente

El DDL aplicado **no tiene** los `CHECK` ni los índices objetivo: hoy sólo declara
las columnas y un único índice parcial sobre el identificador de lease. Decir «se
preserva tal cual» y a la vez listar restricciones que no existen sería falso.

Lo que se hace: una **migración aditiva propia de este store**, con un validador
`BEFORE INSERT` y `BEFORE UPDATE` —SQLite no admite `ADD CONSTRAINT`— y columnas
nuevas nullable. Los nombres legacy `worktree_lease_lease_id` y
`tool_claim_claim_id` se conservan, y los checksums de las migraciones aplicadas no
se tocan.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `worktree_path` | `TEXT` | `NOT NULL` | `pk_worktree_lease` | ruta absoluta del worktree |
| `fence` | `INTEGER` | `NOT NULL`; `ck_worktree_lease__fence_positive`: `> 0` | — | monótono; sólo avanza |
| `lease_id` | `TEXT` | `NULL` cuando no hay lease vivo | `worktree_lease_lease_id` parcial `WHERE lease_id IS NOT NULL` | identificador del lease |
| `holder` | `TEXT` | `NULL` si y sólo si `lease_id` es `NULL` | — | identidad del worker |
| `acquired_at` | `TEXT` | `NULL` si y sólo si `lease_id` es `NULL` | — | |
| `expires_at` | `TEXT` | `NULL` si y sólo si `lease_id` es `NULL` | — | **vencer no concede el worktree a otro**: habilita reconciliar |
| `holder_pid` | `INTEGER` | `NULL` si y sólo si `lease_id` es `NULL` | — | comprobación de vivacidad del proceso |
| `holder_token` | `TEXT` | `NULL` si y sólo si `lease_id` es `NULL` | — | token que las operaciones mediadas comprueban |
| `released_at` | `TEXT` | `NULL` mientras el lease siga vivo | — | |
| `operation_id` | `TEXT` | **aditiva**, `NULL` en filas previas al cambio | — | correlaciona la concesión con su intención en el ledger |
| `revocation_acknowledged_at` | `TEXT` | **aditiva**, `NULL` mientras no haya acuse | — | §6 |
| `store_incarnation_id` | `TEXT` | **aditiva**, `NOT NULL` desde la encarnación actual | — | §8; el token vigente es el par `(store_incarnation_id, fence)` |

Dos triggers distintos, `tr_worktree_lease__validate_insert` (`BEFORE INSERT`) y
`tr_worktree_lease__validate_update` (`BEFORE UPDATE`), imponen las nulidades:
`lease_id`, `holder`, `acquired_at`, `expires_at`, `holder_pid` y `holder_token`
son **todos** `NULL` o **todos** `NOT NULL`; un lease activo exige
`released_at IS NULL`; el slot liberado exige `released_at IS NOT NULL`.

Regla de fence por mutación, no «creciente en cada UPDATE»:

- Primer grant: INSERT con `fence = 1` y encarnación actual. Un replay devuelve
  el grant existente sin cambiarlo.
- Nuevo grant: CAS sobre el par de token esperado, después de la barrera de
  quiescencia, asigna un `lease_id` nuevo y `fence = OLD.fence + 1`.
- Revocación: su CAS asigna `fence = OLD.fence + 1` y despeja la titularidad;
  el acuse posterior no vuelve a incrementar el fence.
- Liberación ordinaria, renovación y acuse: `fence = OLD.fence`; comprobar
  token completo e identidad del titular antes del UPDATE.

El trigger de UPDATE rechaza disminuciones o saltos mayores que uno. Cambiar a
un `lease_id` nuevo no nulo exige exactamente `OLD.fence + 1`; conservar la
misma titularidad exige `OLD.fence`. Despejarla admite el valor previo para
RELEASE o el siguiente para REVOKE: el método CAS de cada comando fija esa
expresión exacta y verifica su identidad. No se aumenta el fence por una mera
actualización de timestamps. INSERT y UPDATE rechazan una encarnación distinta
de `coordination_store_meta` (§8), fuera de la migración/restore bloqueada.

### 3.1 Qué garantiza y qué no un fence

**Un número de fence no impide, por sí solo, que un proceso hijo con los permisos
del host escriba archivos.** El enforcement real está en
[contratos §6.1](../../contracts/index.md):

1. toda operación mutante **mediada** por el plane comprueba `holder_token` contra
   el fence vigente y rechaza si no coincide;
2. un hijo que escribe por su cuenta necesita **un entorno revocable o aislado**, o
   su **detención y reap verificados**, antes de reasignar el workspace.

**No se admite un writer nuevo mientras el origen siga vivo o su ownership sea
incierto.** La condición no es que el `compare-and-set` haya avanzado el número. Un
perfil que no puede impedir escrituras fuera del permiso se anuncia
`TRUSTED_PROCESS`, declara que no ofrece aislamiento y no satisface ninguna
afirmación de sandbox.

---

## 4. `tool_claim` — existente

Es el objeto de coordinación más correcto del árbol actual y su DDL no se reescribe.
Igual que el lease, sus `CHECK` objetivo **no** están en el DDL aplicado y llegan
por un validador `BEFORE INSERT` y `BEFORE UPDATE` en una migración aditiva propia
del store.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `coordinate_key` | `TEXT` | `NOT NULL` | `pk_tool_claim` | coordenada de la llamada |
| `state` | `TEXT` | `NOT NULL`; `ck_tool_claim__state_enum` | — | `tool_claim_state` |
| `claim_id` | `TEXT` | `NULL` cuando no hay claim vivo | `tool_claim_claim_id` parcial | |
| `holder` | `TEXT` | `NULL` si y sólo si `claim_id` es `NULL` | — | |
| `claimed_at` | `TEXT` | `NULL` si y sólo si `claim_id` es `NULL` | — | |
| `expires_at` | `TEXT` | `NULL` si y sólo si `claim_id` es `NULL` | — | |
| `in_flight_at` | `TEXT` | `NULL` salvo en `IN_FLIGHT` o posterior | — | |
| `settled_at` | `TEXT` | `NULL` salvo en `SETTLED` | — | |
| `task_id` | `TEXT` | `NOT NULL` | — | |
| `attempt` | `INTEGER` | `NOT NULL`; `> 0` | — | **legacy**: la coordenada nueva viaja en `coordinate_key` |
| `transition_id` | `TEXT` | `NOT NULL` | — | |
| `submitted_at` | `TEXT` | `NOT NULL` | — | |
| `account_id` | `TEXT` | `NOT NULL` | — | |
| `server_id` | `TEXT` | `NOT NULL` | — | |
| `tool_name` | `TEXT` | `NOT NULL` | — | |
| `argument_bytes` | `INTEGER` | `NOT NULL`; `>= 0` | — | conteo, **nunca los argumentos** |
| `store_incarnation_id` | `TEXT` | aditiva; `NOT NULL` para grants de la encarnación activa; UUID validado contra la metadata (§8) | — | una operación de claim comprueba encarnación más `claim_id`; un claim legacy no se readmite sin reconciliación |

**Un claim vigente no habilita mágicamente una operación nueva**: una coordenada
distinta es un claim distinto, y la compatibilidad de fencing se comprueba, no se
asume.

---

## 5. `account_reservation` — nuevo

Mismo patrón que el lease, por cuenta y por slot. Este arbiter **no decide saldo**:
la intención de cuota, su débito y su admisibilidad ya quedaron registrados por
[cuentas §4](../accounts/index.md) en el ledger. Concede exclusivamente el slot y
su token por el command_id/operation_id de esa intención; comprobar ese anclaje
antes del CAS no constituye una transacción entre archivos.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `account_id` | `TEXT` | `NOT NULL` | `pk_account_reservation` (con `slot`) | cuenta reservada |
| `slot` | `INTEGER` | `NOT NULL`; `ck_account_reservation__slot_non_negative`: `>= 0` | `pk_account_reservation` | el tope de concurrencia por cuenta es la cantidad de slots |
| `fence` | `INTEGER` | `NOT NULL`; `> 0` | — | monótono por `(account_id, slot)` |
| `reservation_id` | `TEXT` | `NULL` cuando el slot está libre | `ux_account_reservation__reservation_id` parcial | |
| `state` | `TEXT` | `NOT NULL`; `ck_..__state_enum` | — | `reservation_state` |
| `store_incarnation_id` | `TEXT` | `NOT NULL`; UUID de `coordination_store_meta`, comprobado en INSERT y UPDATE | — | token `(store_incarnation_id, fence)` por slot |
| `operation_id` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | correlaciona con la intención en el ledger |
| `holder` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | |
| `task_id` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | |
| `revision_number` | `INTEGER` | `NULL` si y sólo si `reservation_id` es `NULL`; `> 0` | — | coordenada completa |
| `attempt_number` | `INTEGER` | `NULL` si y sólo si `reservation_id` es `NULL`; `> 0` | — | |
| `route_segment_id` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | |
| `scope_kind` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | `INITIATIVE`, `STEP` o `TASK` |
| `scope_id` | `TEXT` | `NULL` si y sólo si `scope_kind` es `NULL` | — | |
| `checkpoint_sha256` | `TEXT` | `NULL` cuando la reserva no ancla continuidad; dominio de digest heredado | — | sobre qué continuidad se reservó |
| `acquired_at` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | |
| `expires_at` | `TEXT` | `NULL` si y sólo si `reservation_id` es `NULL` | — | vencer habilita reconciliar, no reasignar a ciegas |
| `released_at` | `TEXT` | `NULL` mientras el estado sea `HELD` | — | |
| `release_reason` | `TEXT` | `NULL` si y sólo si `released_at` es `NULL` | — | |

Bicondicionales del store: `HELD` si y sólo si `reservation_id` es `NOT NULL`;
en `HELD`, todos los campos activos declarados no nulos lo son y `released_at` y
`release_reason` son `NULL`. En `RELEASED` y `EXPIRED`, ambos campos de liberación
son `NOT NULL` y los campos activos son `NULL`. `checkpoint_sha256` conserva su
nulidad específica cuando no ancla continuidad; no es un campo obligatorio de
holder. **`EXPIRED` sólo se alcanza tras reconciliación y su evento**, nunca por
el reloj. Nuevo grant/revocación incrementa fence exactamente uno; liberación,
renovación y acuse lo conservan, mediante CAS por token completo e identidad.
La encarnación actual se valida en ambos tipos de escritura (§8).

La cabecera y los débitos de [cuentas §4](../accounts/index.md) **se derivan de
los eventos** de intención, grant, liberación y reconciliación, no de esta tabla.
Un CAS rechazado necesita su acuse en el ledger para despejar una intención;
perderlo no devuelve saldo. Liberar el slot después de despachar tampoco despeja
un débito de cuota pendiente de observación. No copiar aquí el margen ni mantener
un segundo saldo: la aritmética y sus épocas tienen un solo dueño.

---

## 6. `outbox_message` — nuevo

**Cache de entrega, y nada más.** La transacción del ledger guarda un **evento de
intención de comando completo**, no una fila de esta tabla. Perder este archivo
entero no puede producir un `PENDING` falso: el estado se reconstruye desde los
eventos.

Identidad, decidida:

- `saga_id` **agrupa** los comandos de una misma saga. Una sola saga puede revocar
  un lease **y** liberar una reserva.
- `command_id` es **determinista** por `(saga_id, phase, target_kind, target_id)` y
  es la clave única. **La unicidad es sobre `command_id`, no sobre el agrupador.**
- Cada **intento de entrega** se registra **en el ledger antes de enviar**, con su
  identificador; el desenlace del intento se ancla al evento por sus
  identificadores de metadatos.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `outbox_message_id` | `TEXT` | `NOT NULL` | `pk_outbox_message` | |
| `saga_id` | `TEXT` | `NOT NULL` | `ix_outbox_message__saga_id` | agrupador; **no** es único |
| `command_id` | `TEXT` | `NOT NULL` | `ux_outbox_message__command_id` | determinista por `(saga_id, phase, target_kind, target_id)` |
| `phase` | `TEXT` | `NOT NULL` | — | fase de la saga que emitió el comando |
| `intent_stream` | `TEXT` | `NOT NULL`; CHECK del catálogo de cuatro streams | — | stream del evento de intención; la matriz de comandos de abajo restringe qué combinaciones V1 son válidas |
| `intent_sequence` | `INTEGER` | `NOT NULL`; `CHECK > 0` | — | posición del evento dentro de intent_stream |
| `intent_sha256` | `TEXT` | `NOT NULL`; CHECK SHA común | — | digest de ese evento; para account_events, SHA del sidecar en intent_sequence |
| `command_kind` | `TEXT` | `NOT NULL`; `ck_..__command_kind_enum` | — | `outbox_command_kind` |
| `target_kind` | `TEXT` | `NOT NULL` | — | qué recurso recibe el comando |
| `target_id` | `TEXT` | `NOT NULL` | — | |
| `fence` | `INTEGER` | `NULL` cuando el comando no lleva fence; si existe, `> 0` | — | generación del destino bajo la que se emitió |
| `target_store_incarnation_id` | `TEXT` | `NULL` si y sólo si `fence` es `NULL`; en otro caso UUID | — | encarnación del destino; se conserva desde la intención del ledger, nunca se sustituye por la encarnación actual al reconstruir |
| `state` | `TEXT` | `NOT NULL`; `ck_..__state_enum` | — | `outbox_state`, con las transiciones de §2 |
| `row_version` | `INTEGER` | `NOT NULL`; default `0`; `CHECK >= 0` | — | versión persistida de esta fila; cada mutación efectiva la incrementa exactamente uno; expected_version sólo es parámetro del CAS, no otra columna |
| `attempt_count` | `INTEGER` | `NOT NULL`; default `0`; `>= 0` | — | |
| `next_eligible_at` | `TEXT` | `NULL` en estados terminales | — | backoff |
| `deadline_at` | `TEXT` | `NOT NULL` | — | en `INFLIGHT`, vencer obliga a `RECONCILING`; sólo un comando no despachado o reconciliado sin efecto pendiente puede pasar a `ABANDONED` |
| `response_handle` | `TEXT` | `NULL` mientras no haya respuesta | — | **referencia opaca y segura, jamás un secreto** |
| `last_failure_code` | `TEXT` | `NULL` si nunca falló | — | código tipado del mapa de [contratos §16](../../contracts/index.md), no texto libre |
| `last_attempt_stream` | `TEXT` | `NULL` si nunca se intentó; CHECK del catálogo de cuatro streams | — | mismo stream y sujeto real que la intención |
| `last_attempt_sequence` | `INTEGER` | Igual nulidad; si existe, `CHECK > 0` | — | evento de intento de entrega, registrado **antes** de enviar |
| `last_attempt_sha256` | `TEXT` | Igual nulidad; CHECK SHA común | — | digest del intento exacto, no inferido por posición |
| `owner_process_id` | `INTEGER` | `NULL` salvo en `INFLIGHT` | — | quién lo tiene en vuelo |
| `created_at` | `TEXT` | `NOT NULL` | — | |
| `updated_at` | `TEXT` | `NOT NULL` | — | **legítimo aquí**: es un store de vivacidad, no una proyección |

Índices: `ix_outbox_message__state_next_eligible_at`,
`ix_outbox_message__deadline_at`.
`ck_outbox_message__attempt_anchor` exige las tres columnas last_attempt
todas NULL o todas NOT NULL; `attempt_count = 0` sii el triplete es NULL.
Con intento presente, last_attempt_stream=intent_stream. Un ancla se resuelve al
vector fijado y exige digest coincidente, command_id y sujeto originales.
Una secuencia de otro stream o un hash distinto invalida la fila: reconstruir
desde los eventos correctos o fallar, nunca adivinar el ancla. No hay FK física
entre archivos. Cuentas usa su sidecar verificado ([streams §8](../streams/index.md)).

### 6.1 CAS de entrega y ausencia de ABA

Lectura devuelve (encarnación del outbox, command_id, row_version, state).
Dentro de BEGIN IMMEDIATE del outbox, comprobar encarnación actual y ejecutar
UPDATE con predicado command_id + row_version esperado + state esperado,
`SET row_version = row_version + 1` y la transición legal de §2. Debe modificar
exactamente una fila; cero filas = CONFLICT y releer, nunca éxito ni reenvío
implícito. Todo cambio efectivo, incluidos backoff/handle/owner/timestamps,
incrementa row_version exactamente uno; replay sin cambio conserva la fila.
Overflow de versión rechaza. Identidad, destino, fence y ancla original son
inmutables; BEFORE UPDATE valida esas invariantes, la versión y la transición.

Sólo quien gana PENDING→INFLIGHT puede preparar un despacho. Su intento durable
se registra antes de enviar y se vuelve a comprobar que conserva la fila/token;
el CAS no afirma detener un envío que ya ocurrió. Si otro reconciliador avanzó
la fila, un relay viejo no la cambia a DELIVERED con su versión anterior: registra
el resultado tardío identificado en el ledger para conciliación. Restaurar este
store cambia su encarnación (§8); una fila reconstruida con versión cero no
admite un token de una encarnación anterior.

### 6.2 Stream y sujeto del comando, matriz V1 cerrada

| command_kind | Streams de intención/intento/acuse admitidos | Sujeto |
| --- | --- | --- |
| RELEASE_RESERVATION | control_plane_events | tarea real que posee la reserva |
| REVOKE_LEASE | control_plane_events | tarea real que posee la saga de lease |
| NOTIFY | control_plane_events, initiative_events, account_events | tarea, iniciativa o cuenta **real** según el stream |
| EXPORT_TELEMETRY | control_plane_events, initiative_events | tarea o iniciativa real asociada al dato |

registry_events puede ser una **fuente causal** de configuración, pero no el
ancla de intención de un comando operativo V1. Combinación no listada rechaza
CAPABILITY_UNSUPPORTED antes de crear el comando; no se inventa SYSTEM-task,
iniciativa o documento de registry para alojarlo. Telemetría puramente operativa
sin tarea/iniciativa usa la cola acotada opcional del exporter y declara
best-effort, pérdidas y backpressure; no promete outbox durable.

Intención, intento y acuse usan el mismo stream/sujeto que la fila original:
`OUTBOX_COMMAND_INTENDED`, `OUTBOX_DELIVERY_INTENDED`,
`OUTBOX_DELIVERY_OBSERVED`. Payload neutral versionado
`outbox_contract_version=1`: intención contiene saga_id, command_id, phase,
command_kind, target_kind, target_id, deadline_at y el par nullable de fence/
target_store_incarnation_id; intento contiene command_id y delivery_attempt_id;
observación contiene ambos IDs, outbox_state, failure_code nullable y
response_handle nullable. Se fijan los timestamps en el evento común; el estado
de entrega obedece §2 y el fallo usa contratos §16. Referencias de causalidad
enlazan el evento anterior por stream/secuencia/digest. El payload específico
del comando lleva sólo referencias autorizadas/digests y la configuración
versionada que necesita su contrato; nunca credenciales ni prosa de proveedor.

En tareas/iniciativas son eventos same-state que no afirman ejecución de la
tarea ni una aprobación. En account_events son acciones de entrega con esos
tres nombres, emitter de máquina autorizado, resulting_state igual al estado
actual y la siguiente versión de cuenta obtenida por el CAS existente.
**No** representan decisiones del owner ni habilitan DRAIN, login o cambios de
política. Appends de cuenta incluyen evento, sidecar, cabeza y proyección en la
misma transacción; su catálogo aditivo y ancla viven en [streams §3 y §8](../streams/index.md).
Cada delivery_attempt_id nuevo incrementa attempt_count una vez; replay no.
Un acuse/observación sólo afecta al command_id y al intento que nombra.
La pérdida del outbox exige reconstruir esta historia causal verificada; un
intento durable sin desenlace se reconstruye RECONCILING, nunca PENDING.

**Ante duda, no se reenvía.** Si el estado es incierto, el outbox **se reconstruye
desde los eventos del ledger** o se sondea el destino antes de reintentar.

**Un `INFLIGHT` con deadline vencido va a reconciliación, no a abandono
automático.** La transición a `ABANDONED` sólo ocurre **después** de que la
reconciliación concluya que no hubo despacho, o de que el destino confirme. Se
reintenta **sólo** si está demostrado que no hubo despacho, o si la idempotencia
del destino está comprobada.

---

## 7. La saga, vista desde acá

```
ledger (una transacción)     admisión de cuota + intención y débito pendiente
                             + evento completo de intención de comando
arbiter (compare-and-set)    grant o rechazo tipado, y un fence nuevo
ledger                       acuse del grant, con el fence obtenido
                             ─── sólo aquí empieza el trabajo externo ───
arbiter                      liberación, disparada por el outbox
ledger                       acuse de la liberación
```

Reglas que se derivan, y que ninguna prosa debe contradecir:

- Lo atómico dentro del ledger es la **cuarentena junto con la intención de revocar
  el lease, expresada como evento completo de intención de comando**. La revocación efectiva en el arbiter y su acuse
  **se reconcilian por saga**.
- **No se admite un writer nuevo hasta que existe el acuse y el fencing es
  efectivo** (§3.1).
- Una liberación se completa por **acuse**, nunca por un borrado optimista.
- `saga_id` agrupa toda la saga. Cada comando lleva su propio `command_id`,
  determinista por fase y destino (§6); el `operation_id` de un CAS identifica
  esa operación concreta y se vincula a ese comando, no sustituye el agrupador.
  Reintentar el mismo comando conserva ambos IDs; otro destino o fase no reutiliza
  su clave. El intento de entrega queda registrado antes del efecto y el acuse
  posterior conserva esa identidad.

---

## 8. Pérdida y restauración de un coordination store

### 8.1 Metadata persistente por archivo

Cada archivo de coordinación —leases, claims, reservas, outbox y el store de
`artifact_blob_lease`— contiene su propia tabla `coordination_store_meta`, en el
mismo archivo que las filas que gobierna. No es un quinto stream ni una tabla del
ledger; es metadata de vivacidad, persistida antes de emitir tokens.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `singleton_id` | `INTEGER` | `NOT NULL`; `CHECK(singleton_id = 1)` | PK | una fila por archivo |
| `store_kind` | `TEXT` | `NOT NULL`; enum `WORKTREE_LEASE`, `TOOL_CLAIM`, `ACCOUNT_RESERVATION`, `OUTBOX`, `ARTIFACT_BLOB_LEASE` | — | fijado por la apertura; un archivo de otro tipo rechaza |
| `store_incarnation_id` | `TEXT` | `NOT NULL`; UUID canónico; sin default implícito | UNIQUE | UUID generado y registrado durante apertura inicial o restore bloqueado |
| `created_at` | `TEXT` | `NOT NULL`; instante canónico, sin default | — | instante de esa encarnación |

La tabla nueva es `STRICT`. Cada store lleva una migración aditiva propia que
crea su metadata sin alterar los checksums anteriores; lease y claim agregan
validadores separados BEFORE INSERT y BEFORE UPDATE y sus columnas aditivas.
Reservas y blob lease nacen con CHECKs de estado/nulidad y validadores de token.
El outbox registra aquí su propia encarnación, distinta de la encarnación de
cada destino fijada en `target_store_incarnation_id`.

Tokens de lease/reserva: `(store_incarnation_id, fence)`; de blob lease:
`(store_incarnation_id, generation)`; de claim: encarnación más `claim_id`.
Todos incluyen la identidad del holder o comando exigida por la operación.
El par de encarnación/generación no sustituye la quiescencia ni el aislamiento.
Se verifica en cada mutación mediada y en cada acuse; no se acepta un token viejo
porque coincida su número con uno recreado.

### 8.2 Procedimiento de recuperación

Perder uno de estos archivos cuesta vivacidad, no evidencia. Recuperarlo **no** es
recrearlo vacío y seguir: un fence que vuelve a empezar en cero trataría a un
holder vivo como si hubiera muerto.

```
1. congelar la admisión
2. reconciliar contra el ledger: qué concesiones estaban vigentes
3. probar quiescencia de los holders anteriores: muerte comprobada y reap, o un
   backend que rechace efectivamente un fence viejo
4. generar un store_incarnation_id nuevo (UUID)
5. emitir tokens como el par (store_incarnation_id, fence), y esperar su acuse
6. sólo entonces, admitir trabajo
```

**Si el paso 3 queda incierto, el procedimiento se detiene.** No hay admisión
automática. La garantía de vivacidad está condicionada a que el algoritmo falle de
forma cerrada; no se obtiene por tener un número.

---

## 9. Archivo de cuentas del owner

Vive **fuera de todo repositorio**, con permisos `0600`. Entra al sistema **por
digest**, como un documento declarado; su contenido nunca se copia a una tabla, a
un evento ni a un log. Ninguna columna de ninguna base guarda una credencial.

---

## 10. Negativos de esta hoja

1. Dos procesos compiten por el mismo worktree → un ganador, el resto con rechazo
   tipado, cero crashes de bloqueo.
2. Ocho procesos reales compiten por la misma coordenada de herramienta → una sola
   ejecución.
3. Dos workers compiten por el último margen de una cuenta → sólo se admite la
   intención que satisface cuentas §4.3; la otra ve su débito pendiente. Liberar
   un slot con consumo no reconciliado no recrea margen.
4. Fence viejo tras recuperación: **writer revocado que intenta mutar** → rechazado
   en la operación mediada; **descendiente vivo del proceso anterior** → detenido y
   reapeado, o confinado, antes de reasignar.
5. Reserva vencida → habilita reconciliar, **no** reasignar automáticamente.
6. Mensaje de outbox `INFLIGHT` vencido → se reconcilia, no se reenvía.
7. Outbox perdido entero → se reconstruye desde los eventos del ledger sin duplicar
   ningún efecto conocido.
8. Crash entre el grant del arbiter y su acuse en el ledger → la reconciliación
   deja el estado consistente en las dos bases, y **nunca** «liberado en el arbiter
   y vivo en el ledger».
9. Perfil sin aislamiento → se anuncia `TRUSTED_PROCESS` y **no** se cuenta como
   sandbox.
10. Un `INFLIGHT` con deadline vencido → pasa a `RECONCILING`, **nunca** a
    `ABANDONED` de forma automática.
11. Store perdido y recreado sin encarnación nueva → la admisión queda congelada; un
    token con la encarnación anterior es rechazado.
12. Holder anterior cuya quiescencia no se pudo probar → **no** se admite un writer
    nuevo.
13. Relay con row_version viejo tras RECONCILING → CAS rechaza; tampoco gana con
    la versión numérica repetida después de un restore de distinta encarnación.
14. Dos streams contienen sequence=512 → sólo la tripleta íntegra selecciona el
    evento correcto; SHA alterado rechaza la reconstrucción antes de entregar.
15. NOTIFY de cuenta sin tarea/iniciativa usa esa cuenta real; registry como
    intención operativa rechaza y la telemetría sin sujeto no inventa tareas.
