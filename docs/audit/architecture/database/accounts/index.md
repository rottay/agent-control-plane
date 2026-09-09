# Accounts: diccionario físico

Dueño: cuenta y plan declarado, modelos habilitados, ventanas y observaciones de
cuota, proyección de reservas, handoffs de cuenta — **y** el registry único de
versiones de modelo (`model_version_read_model` + hijas de elegibilidad/transporte),
consolidado acá para que exista un solo registry de capacidades, no dos. `economy`
sigue siendo dueño exclusivo de precios, mediciones de uso y desempeño
([economy](../economy/index.md)); esta hoja referencia el desempeño por id/ventana de
snapshot, **no** duplica un `quality_score` libre.

**El registry de modelos es uno solo y vive acá.** La versión de modelo y sus tablas
hijas —capacidades, roles elegibles, transportes admitidos— pertenecen a `accounts`.
`economy` posee precios, mediciones y desempeño, y los referencia por identificador
y por digest de snapshot ([maestro §4](../index.md)).

Reglas transversales en [../index.md](../index.md). Fuentes de eventos:
`account_events` (declaraciones y acciones de cuenta) y `control_plane_events`
(reservas y handoffs, porque los emite una tarea concreta aunque el dominio dueño de
la proyección sea `accounts`).

---

## 1. `account_read_model`

**Nuevo.** Hoy las cuentas se sirven desde el archivo del owner más un fold ad-hoc de
`account_events`, sin tabla propia.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `account_id` | TEXT | NOT NULL | PK. |
| `provider` | TEXT | NOT NULL | — |
| `alias` | TEXT | NOT NULL | — |
| `plan_tier` | TEXT | NULL | `NULL` hasta el primer `PLAN_DECLARED`. |
| `plan_fee_nanos` | INTEGER | NULL | `CHECK (plan_fee_nanos IS NULL OR plan_fee_nanos >= 0)`. Igual nulidad que `plan_tier`. Nanounidades de `currency`, nunca punto flotante. |
| `currency` | TEXT | NULL | Igual nulidad que `plan_fee_nanos`. |
| `reset_schedule_sha256` | TEXT | NULL | Igual nulidad. |
| `effective_state` | TEXT | NOT NULL | `CHECK IN ('AVAILABLE','DRAINING','EXHAUSTED','COOLDOWN','AUTH_REQUIRED')` — vocabulario existente preservado exacto (`packages/kernel/contracts/src/schemas/account-record/index.ts:16-22`), **no** `READY`/`DRAINED` inventados. |
| `last_action_version` | INTEGER | NOT NULL | Espejo del `version` del último `account_events` aplicado; junto con `ux_account_events__account_id__version` ([streams](../streams/index.md) §3) sostiene el CAS de admisión. |
| `max_concurrency` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `owner_file_sha256` | TEXT | NOT NULL | Digest del archivo `accounts.local.json` que originó el último `PLAN_DECLARED`/`LIMIT_DECLARED`; el archivo en sí queda fuera de todo repositorio (§dueño legado). |
| `last_sequence` | INTEGER | NOT NULL | Reemplaza `updated_at` como definición de orden. |
| `created_at` | TEXT | NOT NULL | — |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ix_account_read_model__state` | `INDEX (effective_state, account_id)` |
| Rebuild | Determinista desde `account_events`, contra `last_action_version`. |

---

## 2. `account_enabled_model` (reemplaza `enabled_models_json`)

**Nuevo.** Fila hija ordenada por `ordinal` (§3.5 canónico: hay `WHERE`/`JOIN` sobre
esta relación al resolver elegibilidad).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `account_id` | TEXT | NOT NULL | PK (compuesta). `fk_account_enabled_model__account_read_model`. |
| `ordinal` | INTEGER | NOT NULL | PK (compuesta). `CHECK >= 0`. |
| `model_version_id` | TEXT | NOT NULL | `fk_account_enabled_model__model_version_read_model` (§6, misma hoja ahora); comprobación de `status` fail-closed sigue siendo lógica de escritura, no expresable en `CHECK` puro (requiere leer otra tabla). |

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_account_enabled_model` | `PRIMARY KEY (account_id, ordinal)` |
| `ux_account_enabled_model__model` | `UNIQUE INDEX (account_id, model_version_id)` — un modelo no se habilita dos veces para la misma cuenta. |
| Rebuild | Determinista. |

---

## 3. Cuota: observaciones y estado derivado por ventana

Las cuatro tablas de esta sección se reconstruyen desde `account_events`. La
observación y sus métricas son proyecciones de evidencia registrada, **no otro log
autoritativo**. Ventanas y métricas vigentes se derivan únicamente de esas filas:
ningún fold recupera del archivo del owner valores que el evento no registró.

### 3.1 `quota_observation_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `observation_id` | TEXT | NOT NULL | PK. Identidad estable del reporte normalizado. |
| `account_id` | TEXT | NOT NULL | Cuenta observada. |
| `kind` | TEXT | NOT NULL | `CHECK IN ('USAGE','RATE_LIMIT','USAGE_LIMIT','RESET','AUTH')`. |
| `observation_status` | TEXT | NOT NULL | `CHECK IN ('KNOWN','ESTIMATED','UNKNOWN')`; confianza de la señal, no reemplaza el estado individual de cada cifra. |
| `scope` | TEXT | NOT NULL | `CHECK IN ('ACCOUNT','MODEL','TRANSPORT')`; registrado por la fuente normalizada. |
| `scope_ref` | TEXT | NULL | `NULL` sii `scope = 'ACCOUNT'`; identificador exacto de modelo/transporte en los otros casos. |
| `window_start` | TEXT | NULL | Inicio incluido; ambos extremos son `NULL` si no se conoce la ventana o la señal no tiene ventana. |
| `window_end` | TEXT | NULL | Fin excluido; presente junto con inicio y estrictamente posterior. |
| `auth_state` | TEXT | NULL | `CHECK (auth_state IS NULL OR auth_state IN ('AUTH_REQUIRED','AUTHENTICATED'))`; sólo poblado para AUTH conocida/estimada. |
| `reset_at` | TEXT | NULL | Sólo poblado para RESET conocido/estimado; no se inventa desde el reloj del rebuild. |
| `observed_at` | TEXT | NOT NULL | Instante de origen registrado en el evento. |
| `recorded_at` | TEXT | NOT NULL | Instante de registro del evento fuente. |
| `source_task_id` | TEXT | NULL | `NULL` cuando la señal no procede de una tarea. |
| `metric_contract_version` | INTEGER | NOT NULL | `CHECK >= 1`; versión del vocabulario y de la normalización de métrica/unidad. |
| `sequence` | INTEGER | NOT NULL | Secuencia fuente en `account_events`. |

`ck_quota_observation__scope`: `CHECK ((scope = 'ACCOUNT') = (scope_ref IS NULL))`.
`ck_quota_observation__window`: `CHECK ((window_start IS NULL AND window_end IS NULL) OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_start < window_end))`.
`ck_quota_observation__auth`: `CHECK (((kind = 'AUTH' AND observation_status <> 'UNKNOWN') AND auth_state IS NOT NULL) OR ((kind <> 'AUTH' OR observation_status = 'UNKNOWN') AND auth_state IS NULL))`.
`ck_quota_observation__reset`: la misma forma para `kind = 'RESET'` y `reset_at`.
AUTH/RESET no requieren cifras. No existe una columna ambigua `observed_tokens`
en esta tabla: cualquier cifra está en la hija por métrica/unidad.

### 3.2 `quota_observation_metric_read_model` (evidencia numérica)

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `observation_id` | TEXT | NOT NULL | PK compuesta; FK a la observación. |
| `metric` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('TOKENS','REQUESTS','USAGE_LIMIT_TOKENS')`. |
| `unit` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('COUNT','TOKENS')`. |
| `observed_value` | INTEGER | NULL | Cantidad observada; `NULL` sii estado UNKNOWN; `CHECK (observed_value IS NULL OR observed_value >= 0)`. |
| `observed_status` | TEXT | NOT NULL | `CHECK IN ('KNOWN','ESTIMATED','UNKNOWN')`. |
| `limit_value` | INTEGER | NULL | Límite observado; `NULL` sii estado UNKNOWN; `CHECK (limit_value IS NULL OR limit_value >= 0)`. |
| `limit_status` | TEXT | NOT NULL | `CHECK IN ('KNOWN','ESTIMATED','UNKNOWN')`. |
| `remaining_value` | INTEGER | NULL | Margen observado; `NULL` sii estado UNKNOWN; `CHECK (remaining_value IS NULL OR remaining_value >= 0)`. |
| `remaining_status` | TEXT | NOT NULL | `CHECK IN ('KNOWN','ESTIMATED','UNKNOWN')`. |

PK `(observation_id, metric, unit)`. FK `observation_id` a
`quota_observation_read_model`, misma cohorte, `ON DELETE RESTRICT`.
Tres checks independientes de forma
`CHECK ((<status> = 'UNKNOWN') = (<value> IS NULL))`.
`ck_quota_observation_metric__unit`:
`CHECK ((metric = 'REQUESTS' AND unit = 'COUNT') OR (metric IN ('TOKENS','USAGE_LIMIT_TOKENS') AND unit = 'TOKENS'))`.
Si límite y restante están presentes, `CHECK (remaining_value IS NULL OR limit_value IS NULL OR remaining_value <= limit_value)`.
La admisión del evento exige cero hijas para AUTH/RESET y al menos una para
USAGE/RATE_LIMIT/USAGE_LIMIT; una señal de límite por requests no exige tokens.
Una métrica desconocida se registra con su estado, nunca con un cero de respaldo.

### 3.3 `quota_window_read_model` (ventana vigente)

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `window_id` | TEXT | NOT NULL | PK; SHA-256 de la tupla canónica versionada `(account_id, scope, scope_ref, window_start, window_end)`. |
| `account_id` | TEXT | NOT NULL | Copia del sujeto de la observación fuente. |
| `scope` | TEXT | NOT NULL | Mismo dominio cerrado de §3.1. |
| `scope_ref` | TEXT | NULL | `NULL` sii scope ACCOUNT. |
| `window_start` | TEXT | NOT NULL | Inicio de la ventana registrada. |
| `window_end` | TEXT | NOT NULL | `CHECK (window_start < window_end)`. |
| `auth_state` | TEXT | NULL | Última señal AUTH conocida para la cuenta; dominio de §3.1. |
| `auth_observation_id` | TEXT | NULL | FK a la observación AUTH que sostiene el estado; `NULL` junto con `auth_state`. |
| `last_observation_id` | TEXT | NOT NULL | FK a la última observación aplicada sobre esta ventana. |
| `computed_at` | TEXT | NOT NULL | `recorded_at` del evento que produjo esta fila, no reloj del rebuild. |
| `sequence` | INTEGER | NOT NULL | Secuencia de dicho evento en `account_events`. |

Checks de scope y par auth/ref; referencia tipada comprueba misma cuenta y kind
AUTH para `auth_observation_id`. Una observación sin extremos conocidos permanece
consultable en §3.1–3.2, pero **no fabrica una ventana**.
Unicidad natural mediante dos índices parciales:
`UNIQUE(account_id, window_start, window_end) WHERE scope = 'ACCOUNT'` y
`UNIQUE(account_id, scope, scope_ref, window_start, window_end) WHERE scope <> 'ACCOUNT'`.

### 3.4 `quota_window_metric_read_model` (estado por métrica)

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `window_id` | TEXT | NOT NULL | PK compuesta; FK a la ventana. |
| `metric` | TEXT | NOT NULL | PK compuesta; dominio de §3.2. |
| `unit` | TEXT | NOT NULL | PK compuesta; dominio y combinación admitida de §3.2. |
| `source_observation_id` | TEXT | NOT NULL | Junto con metric/unit, FK a la fila exacta de §3.2 que produjo todos los valores de esta fila. |
| `observed_value` | INTEGER | NULL | Copia de la métrica fuente; mismo check de rango/nulidad. |
| `observed_status` | TEXT | NOT NULL | Mismo dominio de §3.2. |
| `limit_value` | INTEGER | NULL | Copia de la métrica fuente; mismo check de rango/nulidad. |
| `limit_status` | TEXT | NOT NULL | Mismo dominio de §3.2. |
| `remaining_value` | INTEGER | NULL | Copia de la métrica fuente; mismo check de rango/nulidad. |
| `remaining_status` | TEXT | NOT NULL | Mismo dominio de §3.2. |

PK `(window_id, metric, unit)`; FK compuesta
`(source_observation_id, metric, unit)` a §3.2. El fold comprueba igualdad de
cuenta/scope/ventana con la observación fuente; no combina cifras de observaciones
distintas en una fila ni convierte UNKNOWN en el último valor conocido.

### Índices, transacción y rebuild

- `ix_quota_observation__account_sequence`: `INDEX(account_id, sequence)`;
  `ix_quota_observation__kind`: `INDEX(account_id, kind, observed_at)`.
- `ix_quota_window__account`: `INDEX(account_id, scope, scope_ref, window_start)`.
- El append de cuenta, sidecar de integridad, cabeza, observación, hijas numéricas
  y ventanas afectadas se confirman en **una transacción del ledger**, según el
  maestro §9. No hay lectura del arbiter para reconstruir cuota.
- Fold en orden de `account_events.sequence`: materializar observación/hijas;
  derivar ventana sólo con ambos extremos; para cada métrica escoger la fila
  íntegra de mayor (observed_at, account_events.sequence), sin dejar que un
  reporte atrasado reemplace uno más reciente; aplicar AUTH desde
  su observación referenciada. Rebuild al mismo head produce filas canónicas
  idénticas, incluidos estados UNKNOWN y referencias de origen.
- Negativos: AUTH/RESET sin tokens aceptados; rate-limit en requests aceptado;
  una métrica sin fuente rechazada; ventana inválida rechazada; replay del mismo
  evento no duplica métricas; valores desconocidos siguen NULL tras rebuild.

---

## 4. Reserva de cuenta: intención, concesión y débitos de cuota

**Nuevo.** Estas proyecciones se reconstruyen desde eventos de
`control_plane_events`, nunca leyendo el arbiter mutable. La admisión de cuota
pertenece a `accounts` y se serializa en el ledger; el store de coordinación
sólo concede el slot y su token por saga. No hay una segunda aritmética de cuota
en el arbiter ni una transacción que abarque los dos archivos.

### 4.1 `account_reservation_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `reservation_id` | TEXT | NOT NULL | PK; identidad estable de la intención de reserva. |
| `account_id` | TEXT | NOT NULL | Cuenta real. |
| `slot` | INTEGER | NOT NULL | `CHECK >= 0`; slot solicitado al arbiter. |
| `operation_id` | TEXT | NOT NULL | Identidad del CAS enlazado al comando de la saga; no se identifica por conveniencia con `effect_id` ni con `saga_id` ([coordinación §7](../coordination/index.md)). |
| `task_id` | TEXT | NOT NULL | Coordenada del intento que reserva. |
| `revision_number` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `attempt_number` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `reservation_state` | TEXT | NOT NULL | `CHECK IN ('INTENDED','HELD','RELEASED','REJECTED')`; el estado de esta proyección no es el enum del arbiter. |
| `intended_at` | TEXT | NOT NULL | Instante fijado al admitir la intención en el ledger. |
| `reserved_at` | TEXT | NULL | `NOT NULL` exactamente en HELD/RELEASED; se fija por el acuse real de grant. |
| `released_at` | TEXT | NULL | `NOT NULL` exactamente en RELEASED/REJECTED; instante del acuse o rechazo definitivo. |
| `release_reason` | TEXT | NULL | Igual nulidad que `released_at`; código cerrado del desenlace, no texto de proveedor. |
| `sequence` | INTEGER | NOT NULL | Último evento de la reserva en `control_plane_events`. |

Checks independientes de los dos bicondicionales de timestamps y del par de
liberación. Transiciones cerradas: INTENDED→HELD/REJECTED; HELD→RELEASED;
RELEASED/REJECTED terminales. Un timeout de grant no prueba rechazo: conserva
INTENDED hasta reconciliar. Expirar un HELD no lo libera por reloj.

`ux_account_reservation_read_model__operation`: UNIQUE(operation_id).
`ix_account_reservation_read_model__account`: INDEX(account_id, slot, reservation_state).
Evento `ACCOUNT_RESERVATION_INTENDED` crea cabecera e hijas; `ACCOUNT_RESERVED`
registra el grant; `ACCOUNT_RESERVATION_REJECTED` registra no-grant demostrado;
`ACCOUNT_RELEASED` registra el acuse de liberación. Identidad de evento y CAS V2
son los de streams §1.1. Repetir la intención idéntica devuelve la existente;
cambiar cantidad, dimensiones o coordenada bajo la misma clave es CONFLICT.

### 4.2 `account_reservation_quota_read_model`

Única hija nueva: una reserva/slot puede consumir varias ventanas o métricas.
No se duplican cabeceras, slots ni una tabla de saldos mutables. Una reserva sólo
de concurrencia tiene cero hijas; no representa cuota desconocida como cero.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `reservation_id` | TEXT | NOT NULL | PK compuesta; FK a §4.1, misma cohorte, ON DELETE RESTRICT. |
| `window_id` | TEXT | NOT NULL | PK compuesta; ventana exacta de §3.3, comprobada por referencia tipada al corte. |
| `metric` | TEXT | NOT NULL | PK compuesta; dominio de §3.2. |
| `unit` | TEXT | NOT NULL | PK compuesta; dominio y CHECK de combinación de §3.2. |
| `reserved_quantity` | INTEGER | NOT NULL | `CHECK >= 0`; cota admitida en esta dimensión, en la unidad de la fila. |
| `source_observation_id` | TEXT | NOT NULL | Observación numérica exacta que ancló la admisión; junto con metric/unit identifica su fila de §3.2. |
| `source_account_events_sequence` | INTEGER | NOT NULL | `CHECK > 0`; secuencia de esa observación. |
| `source_account_events_sha256` | TEXT | NOT NULL | SHA de la fila del sidecar en esa secuencia; no se usa una secuencia desnuda. |
| `quota_debit_state` | TEXT | NOT NULL | `CHECK IN ('OPEN','NO_DISPATCH','OBSERVATION_COVERED')`. |
| `covered_by_observation_id` | TEXT | NULL | `NOT NULL` exactamente en OBSERVATION_COVERED; mismo account/window/metric/unit. |
| `coverage_receipt_reference_id` | TEXT | NULL | Igual nulidad que covered_by_observation_id; recibo autorizado de reconciliación. |
| `coverage_receipt_sha256` | TEXT | NULL | Igual nulidad; digest validado del recibo. |
| `sequence` | INTEGER | NOT NULL | Último evento de débito/reconciliación en control_plane_events. |

PK(reservation_id,window_id,metric,unit).
`ix_account_reservation_quota_read_model__window_metric`:
INDEX(window_id,metric,unit,quota_debit_state). Las referencias a observaciones,
ventanas y recibos cruzan cohortes: comprobación tipada con digest/vector, no FK
física a una proyección de otro stream. Todo digest usa el CHECK común.
OPEN→NO_DISPATCH/OBSERVATION_COVERED; ambos destinos son terminales. Un débito
NO_DISPATCH no necesita ni fabrica observación. Un grant/lock liberado después
de ejecutar **puede y debe** conservar OPEN mientras su consumo no esté cubierto.
Un intento incierto nunca se marca NO_DISPATCH.

### 4.3 Predicado de admisión, transacción y reconciliación

La solicitud enumera **todas** las dimensiones exigidas por la política de la
cuenta/ruta: (window_id,metric,unit,reserved_quantity). No las elige el adapter
para omitir una ventana. Tokens y requests no se convierten entre sí. Si una
dimensión obligatoria no tiene ventana o margen utilizable, se rechaza esa
reserva con RESOURCE_EXHAUSTED y razón QUOTA_UNKNOWN, cuenta y dimensión; una
política explícita que no solicita cuota numérica puede reservar sólo el slot,
sin anunciar un límite numérico.

Dentro de un único BEGIN IMMEDIATE del **ledger**, antes de crear la intención:

1. Resolver identidad/autorización de cuenta y política vigentes y el vector de
   cabezas verificado; rechazar una fuente histórica elegida por el solicitante
   para evitar una observación más reciente. Para cada dimensión usar la fila
   vigente de §3.4 y su observación completa. La época de cuota es
   (window_id,metric,unit): no cambia al rotar cuenta de una tarea, hacer replay,
   liberar un slot o restaurar una cache. Otra ventana es otra época; no traslada
   débitos ni libera efectos pendientes de la anterior.
2. El margen R es remaining_value. Si es UNKNOWN, sólo se puede derivar
   max(0,limit_value-observed_value) cuando ambos pertenecen a la **misma**
   observación y tienen estado KNOWN; su fórmula y fuente quedan en el evento.
   Si hay remaining_value y también diferencia conocida, usar el menor.
   ESTIMATED sólo es utilizable cuando la política admitida lo permite, conserva
   esa clasificación y nunca satisface una garantía dura. Caducidad se comprueba
   contra el instante admitido y el deadline de política/ventana; no se inventa
   una observación ni se amplía window_end.
3. D es la suma exacta de reserved_quantity de **todos** los débitos OPEN de
   esa época, incluyendo reservas INTENDED y reservas RELEASED cuyo uso sigue
   sin reconciliar. NO_DISPATCH no contribuye. OBSERVATION_COVERED no contribuye
   sólo si su observación de cobertura es del mismo scope/ventana/métrica y no
   posterior al origen del margen usado; una fuente anterior a esa cobertura
   se rechaza como obsoleta, no se usa para recuperar saldo. El orden de
   observaciones es (observed_at, account_events.sequence), el mismo del fold.
4. Admisible sii q <= max(0,R-D) en **cada** dimensión. Sumas/restas usan enteros
   exactos con comprobación de rango antes de persistir; overflow rechaza, no
   envuelve. Si una falla, RESOURCE_EXHAUSTED sin intención parcial.
5. Append de intención + comando de saga + cabecera INTENDED + todas las hijas
   OPEN + cabezas/watermarks en la misma transacción. Sólo después COMMIT y CAS
   del slot en el arbiter. Dos intentantes no leen el mismo saldo libre: la
   segunda transacción incluye el débito pendiente de la primera.

Antes del dispatch se revalidan política, época y observación vigente; se vuelve
a calcular D **incluyendo la reserva propia** y exigir D <= R en cada dimensión;
no se vuelve a cobrar q como una reserva nueva. Si la fuente empeoró, no empieza trabajo nuevo; se
reconcilia/cancela la intención por la saga. Un grant incierto no libera débito.

`ACCOUNT_RESERVATION_NO_DISPATCH` sólo despeja OPEN cuando hay prueba de que
ningún efecto amparado empezó ni puede empezar (command/fence revocado o
reconciliado); no basta un lock liberado, deadline o HTTP abortado.
`ACCOUNT_RESERVATION_QUOTA_RECONCILED` lleva las claves de hijas cubiertas, el
pin de observación y el recibo por referencia/digest. Marca OBSERVATION_COVERED
sólo después de que sus efectos estén terminales y en quiescencia, y una consulta
de cuota **iniciada después** de esa barrera entregue una observación KNOWN
del mismo scope/época. El perfil del adapter debe probar que esa consulta cubre
el consumo hasta la barrera; observación estimada, snapshot cacheado o reporte
tardío sin esa garantía no liberan débito. El recibo fija la barrera de eventos,
inicio de consulta, observación y claves cubiertas; no contiene credenciales.
El recibo usa schema strict quota_coverage_version=1: accountId, windowId,
metric, unit, reservationIds (conjunto ordenado sin duplicados),
quiescenceControlPlaneHead (sequence,sha256), probeStartedAt,
observationId, observationAccountEventsSequence y observationAccountEventsSha256.
Cada reservationId debe identificar una hija OPEN de esa dimensión; la barrera
prueba sus efectos terminales y quiescentes, y probeStartedAt es posterior a
ella. La referencia de artefacto y su hash se validan antes de consumir el recibo.
La validación de esas fuentes y el append de reconciliación con todas las hijas
son atómicos en el ledger. Hasta ese append puede haber doble descuento
**conservador**, visible; después el consumo está en R y no otra vez en D.
No se descuenta un uso dos veces por sumar además la liquidación de economy:
ese uso sólo prueba cobertura o exposición, no es un tercer débito.

Observaciones atrasadas se conservan como evidencia, pero no reemplazan la
métrica vigente si observed_at es anterior al de su fuente actual. Empate por
observed_at: mayor account_events.sequence; fuente sin frescura probada no
satisface la reconciliación anterior. El fold copia una fila completa, nunca
mezcla columnas de dos observaciones. Rebuild reproduce este orden y todas
las marcas de cobertura al mismo vector; no consulta proveedor ni arbiter.

Este protocolo impide reutilizar **margen de snapshot dentro de ACP**. No evita
que un consumidor externo gaste en la misma cuenta ni convierte telemetría
ESTIMATED/UNKNOWN en un hard cap del proveedor. Una garantía dura exige el
enforcement de cuentas/economy contratado; sin prueba suficiente, se rechaza la
garantía solicitada, no se la degrada silenciosamente.

Negativos: dos solicitudes de 700 con R=1000 producen una sola intención
admitida; grant sin ACK sigue descontando; RELEASE después de dispatch no
recupera saldo; no-despacho probado sí; snapshot fresco que cubre el débito no
lo descuenta otra vez; snapshot antiguo, UNKNOWN o cacheado no lo despeja;
todas las dimensiones de una reserva se admiten o rechazan juntas.

---

## 5. `account_handoff_read_model` (renombra `account_switch_read_model`)

**Nuevo.** Renombrado a "handoff" para usar el mismo vocabulario que el resto del
sistema (§ownership del índice canónico dice "handoffs de cuenta", no "switches").
`SUCCEEDED` sólo si existe un segmento de ruta posterior en la cuenta destino, con
sesión abierta y checkpoint rehidratado (invariante 6 canónica).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `handoff_id` | TEXT | NOT NULL | PK. |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `attempt_number` | INTEGER | NOT NULL | `CHECK >= 1`. |
| `from_account_id` | TEXT | NOT NULL | — |
| `to_account_id` | TEXT | NOT NULL | — |
| `trigger_kind` | TEXT | NOT NULL | `CHECK IN ('QUOTA_EXHAUSTED','RATE_LIMIT','AUTH_REQUIRED','OPERATOR')`. |
| `checkpoint_sha256` | TEXT | NOT NULL | Ver [execution](../execution/index.md) `checkpoint_read_model`. |
| `started_at` | TEXT | NOT NULL | — |
| `completed_at` | TEXT | NULL | `NULL` sii `outcome <> 'SUCCEEDED'`; un éxito exige segmento posterior real y timestamp de continuación confirmada. |
| `outcome` | TEXT | NOT NULL | `CHECK IN ('SUCCEEDED','ESCALATED','FAILED')`. Default de fila nueva: no aplica — se escribe ya con un `outcome` conocido cuando el handoff se resuelve; el estado "en curso" se representa por ausencia de fila hasta la resolución, o por una fila separada de intento si el caso de uso lo exige (fuera de esta migración). |
| `resulting_route_segment_id` | TEXT | NULL | `fk_account_handoff_read_model__execution_route_segment_read_model`, misma cohorte (`control_plane_events`). `NOT NULL` sii `outcome = 'SUCCEEDED'`. |
| `sequence` | INTEGER | NOT NULL | — |

`ck_account_handoff_read_model__succeeded_pair`: `CHECK (((outcome = 'SUCCEEDED') = (resulting_route_segment_id IS NOT NULL)) AND ((outcome = 'SUCCEEDED') = (completed_at IS NOT NULL)))`.

La admisión de SUCCEEDED exige que el segmento destino, sesión rehidratada y
continuación estén registrados antes de ese hecho o en el mismo appendBatch,
con los eventos de segmento/continuación antes del éxito. El fold proyecta ese
orden dentro de la misma transacción. Un éxito sin esas fuentes rechaza como
PRECONDITION_FAILED todo el lote: no se guarda una fila parcial ni se ignora un
evento para esperar que un rebuild futuro lo haga válido. Antes de la resolución
hay ausencia de fila; FAILED/ESCALATED exigen ambos campos de éxito NULL.
Negativos: éxito sin segmento rechaza; éxito completo acepta; cada par parcial,
incluso con outcome FAILED, rechaza.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ix_account_handoff_read_model__task` | `INDEX (task_id, revision_number, attempt_number)` |
| `ix_account_handoff_read_model__accounts` | `INDEX (from_account_id, to_account_id, started_at)` |
| Rebuild | Determinista desde `control_plane_events`. |

---

## 6. `model_version_read_model` (+ hijas), movido desde `economy`

**Nuevo.** Registry único de versiones de modelo — consolidado acá por decisión del
contexto dueño, para que exista un solo registry de
capacidades en vez de uno de facto en `accounts` (política/elegibilidad) y otro en
`economy` (versión/lifecycle). Fuente: `registry_events`,
`document_kind = 'MODEL_VERSION'` (ver [streams](../streams/index.md) §4).

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `model_version_id` | TEXT | NOT NULL | PK. Id exacto, nunca alias. |
| `provider` | TEXT | NOT NULL | — |
| `model` | TEXT | NOT NULL | Alias de familia (no identidad). |
| `release` | TEXT | NOT NULL | — |
| `status` | TEXT | NOT NULL | `CHECK IN ('ACTIVE','DEPRECATED','RETIRED')`. |
| `context_tokens` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `latest_performance_window` | TEXT | NULL | Referencia (`window`) al snapshot vigente en `model_performance_read_model` ([economy](../economy/index.md)) para `(model_version_id, role)` — **no** un `quality_score` libre duplicado acá; el número vive una sola vez, en `economy`. `NULL` hasta el primer cómputo de desempeño. |
| `policy_version` | TEXT | NOT NULL | — |
| `deprecated_at` | TEXT | NULL | `NULL` sii `status = 'ACTIVE'`. |
| `document_version` | INTEGER | NOT NULL | Última versión de `registry_events` proyectada para este `model_version_id`. |
| `sequence` | INTEGER | NOT NULL | — |

`ck_model_version_read_model__deprecated_pair`: `CHECK ((status = 'ACTIVE') = (deprecated_at IS NULL))`.

### 6.1 `model_version_eligible_role` / `model_version_transport` (reemplazan `eligible_roles_json` / `transports_json`)

| Tabla | PK | Columna propia | Único adicional |
| --- | --- | --- | --- |
| `model_version_eligible_role` | `(model_version_id, ordinal)` | `role TEXT NOT NULL` | `ux_model_version_eligible_role__role`: `UNIQUE (model_version_id, role)` — un rol no se declara dos veces con distinto `ordinal`. |
| `model_version_transport` | `(model_version_id, ordinal)` | `transport_kind TEXT NOT NULL` | `ux_model_version_transport__transport`: `UNIQUE (model_version_id, transport_kind)` — mismo criterio. |

Ambas con `ordinal INTEGER NOT NULL CHECK >= 0` y `fk_*__model_version_read_model`.

Invariante 4 canónica: una asignación de routing ([planning](../planning/index.md) §6)
referencia un `model_version_id` `ACTIVE`; uno `RETIRED` bloquea y propone migración —
verificado en planning en el momento de escritura, no acá.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `ix_model_version_read_model__status` | `INDEX (status, provider, model)` |
| `pk_model_version_eligible_role` / `pk_model_version_transport` | `PRIMARY KEY (model_version_id, ordinal)` cada una, más los `UNIQUE` de la tabla de arriba. |
| Rebuild | Determinista desde `registry_events`. |

---

## 7. Mapeo legado → destino

| Objeto legado | Estado hoy | Destino | Nota |
| --- | --- | --- | --- |
| `account_read_model` (propuesto en el modelo anterior, `effective_state` con `READY`) | No existe | `account_read_model`, enum corregido a `AVAILABLE`. | §1, corrige alias inventado |
| `quota_observation_read_model` | No existe (propuesto en el modelo anterior) | Observación con scope/ventana + `quota_observation_metric_read_model`; ventana y métricas vigentes referencian esa evidencia. | §3 |
| `account_reservation_read_model` | No existe (propuesto en el modelo anterior) | Mismo nombre, proyectado desde eventos, `operation_id` ligado a `effect_id`. | §4 |
| `account_switch_read_model` | No existe (propuesto en el modelo anterior) | Renombrado `account_handoff_read_model`. | §5 |
| `owner_accounts_file` | Hoy (coordination store, ver [coordination](../coordination/index.md)) | No vive en esta hoja; referenciado por `owner_file_sha256`. | §1 |
| `model_version_read_model` (con `eligible_roles_json`/`transports_json`) | No existe (propuesto en el modelo anterior) | **Vive en esta hoja**: es el registry único, propiedad de `accounts`. Las columnas JSON pasan a filas hijas. | §6 |

**Nota de completitud:** `quota_observation_read_model`
del modelo anterior no distinguía `AUTH`/`RESET` de observaciones numéricas; esta hoja
separa observación y métricas históricas (§3.1–3.2) de ventana y métricas vigentes (§3.3–3.4).
