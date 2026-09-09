# Economy: diccionario físico

Dueño: observaciones y liquidación de uso, catálogo de precios, snapshots de costo,
período y asignación de suscripción, desempeño de modelo.
**`model_version_read_model` vive en [accounts](../accounts/index.md)**: hay un único
registry de capacidades de modelo, no uno de facto por hoja
([maestro §4](../index.md)).

Reglas transversales en [../index.md](../index.md) §13 (valuación), no repetidas
acá salvo como columna concreta. Fuentes de eventos: `control_plane_events` (uso, por
efecto), `registry_events` (`document_kind IN ('PRICE_TABLE','MODEL_PERFORMANCE')`,
ver [streams](../streams/index.md) §4 — `MODEL_VERSION` también vive en `registry_events`
pero su proyección física es de [accounts](../accounts/index.md)), `account_events`
(período de suscripción, vía `PLAN_DECLARED`).

---

## 1. Flujos y observaciones de uso

### 1.1 `usage_measurement_stream_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `measurement_stream_id` | TEXT | NOT NULL | PK; identificador interno **no reciclable**, SHA-256 de la preimagen canónica versionada `(source, account_id, route_segment_id, source_epoch)`. No es el id de conexión reutilizable del proveedor. |
| `source` | TEXT | NOT NULL | Identificador del canal normalizado del adapter. |
| `account_id` | TEXT | NOT NULL | Cuenta a la que se atribuye el gasto. |
| `route_segment_id` | TEXT | NOT NULL | Segmento exacto al que se atribuye el gasto. |
| `source_epoch` | INTEGER | NOT NULL | `CHECK >= 0`; generación de contador registrada por el adapter. Reiniciar el contador exige epoch nuevo e id nuevo; nunca muta filas anteriores. |
| `source_class` | TEXT | NOT NULL | `CHECK IN ('PROVIDER_AUTHORITATIVE','WRAPPER_MEASURED','ESTIMATE')`; clasificación de origen registrada, no inferida del importe. |
| `normalization_policy_sha256` | TEXT | NOT NULL | Política/versionado del adapter que declaró la identidad y clases de token. |
| `sequence` | INTEGER | NOT NULL | Secuencia del primer evento fuente que declara este flujo. |

`ux_usage_measurement_stream__identity`:
`UNIQUE(source, account_id, route_segment_id, source_epoch)`.
La admisión comprueba id igual al hash de su preimagen y la estabilidad del resto
de campos al reutilizarlo. Un proveedor sin generación propia recibe del adapter
una generación registrada antes de sus reportes; un reinicio no la inventa de nuevo
para un reporte ya registrado.

### 1.2 `usage_observation_read_model`

DELTA cubre un rango explícito de contador; CUMULATIVE sustituye exactamente el
rango declarado; CORRECTION reemplaza una observación identificada del mismo flujo.
Los extremos son unidades del contador normalizado de cobertura, no timestamps.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `observation_id` | TEXT | NOT NULL | PK. |
| `measurement_stream_id` | TEXT | NOT NULL | FK a §1.1; fija fuente/cuenta/segmento/epoch sin copiarlos en cada observación. |
| `ordinal` | INTEGER | NOT NULL | `CHECK >= 0`; orden estable del reporte dentro del flujo no reciclable. |
| `source_observation_id` | TEXT | NOT NULL | Identificador estable del reporte **dentro de este flujo**. |
| `report_kind` | TEXT | NOT NULL | `CHECK IN ('DELTA','CUMULATIVE','CORRECTION')`. |
| `range_from_counter` | INTEGER | NULL | Inicio incluido, `CHECK (range_from_counter IS NULL OR range_from_counter >= 0)`; sólo DELTA/CUMULATIVE. |
| `range_to_counter` | INTEGER | NULL | Fin excluido; sólo DELTA/CUMULATIVE y estrictamente mayor al inicio. |
| `corrects_observation_id` | TEXT | NULL | FK autorreferencial, sólo CORRECTION; hereda la cobertura de la observación corregida. |
| `effect_id` | TEXT | NOT NULL | FK a `effect_read_model`; efecto al que pertenece esta medición. |
| `is_final` | INTEGER | NOT NULL | `CHECK IN (0,1)`; indicador explícito de cierre de medición recibido en la fuente normalizada, no deducido de que terminó el proceso. |
| `input_tokens` | INTEGER | NOT NULL | `CHECK >= 0`; input no cacheado. |
| `output_tokens` | INTEGER | NOT NULL | `CHECK >= 0`. |
| `cache_write_tokens` | INTEGER | NOT NULL | `CHECK >= 0`; clase separada, no incluida otra vez en input. |
| `cache_read_tokens` | INTEGER | NOT NULL | `CHECK >= 0`; clase separada, no incluida otra vez en input. |
| `total_tokens` | INTEGER | NOT NULL | `CHECK >= 0`; igual a la suma de las cuatro clases mutuamente excluyentes. |
| `occurred_at` | TEXT | NOT NULL | Instante de origen registrado. |
| `recorded_at` | TEXT | NOT NULL | Instante del evento del ledger. |
| `sequence` | INTEGER | NOT NULL | Secuencia fuente en `control_plane_events`. |

`ck_usage_observation__report_shape`:
`CHECK ((report_kind IN ('DELTA','CUMULATIVE') AND corrects_observation_id IS NULL AND range_from_counter IS NOT NULL AND range_to_counter IS NOT NULL AND range_from_counter < range_to_counter) OR (report_kind = 'CORRECTION' AND corrects_observation_id IS NOT NULL AND range_from_counter IS NULL AND range_to_counter IS NULL))`.
La suma de tokens se calcula con BigInt, se comprueba contra int64 y
`total_tokens` antes de publicar; no se permite overflow ni sumar input cacheado
dos veces. No se registra una observación numérica ficticia para ausencia de uso:
la ausencia queda en settlement UNKNOWN.

| Objeto | Forma |
| --- | --- |
| `ux_usage_observation__stream_ordinal` | `UNIQUE(measurement_stream_id, ordinal)`. |
| `ux_usage_observation__source_report` | `UNIQUE(measurement_stream_id, source_observation_id)`. |
| `ix_usage_observation__effect` | `INDEX(effect_id, sequence)`. |
| `ix_usage_observation__corrects` | `INDEX(corrects_observation_id)`. |
| Validación de corrección | Objetivo del mismo flujo y efecto; sin ciclos; su cobertura es la del objetivo. Igual identidad con bytes distintos es conflicto, no replay. |
| Rebuild | Desde eventos de control; flujo, observación y actualización del settlement se escriben con el append y cabeza en la misma transacción. |

### 1.3 Fold de rangos y fuentes

1. Para un corte fijado, seleccionar las observaciones registradas hasta la cabeza
   de control de ese corte. Resolver las correcciones por identidad; una cadena
   de correcciones termina en una única observación efectiva que reemplaza, no
   suma, los valores anteriores.
2. Dentro de un flujo, DELTAs deben ser disjuntos. CUMULATIVE reemplaza la cobertura
   declarada de los reportes anteriores; su rango debe contenerlos enteros o ser
   disjunto. Solape parcial sin desglose de fuente es ambiguo y se rechaza; no
   se inventa una distribución para restarlo. Dos correcciones incompatibles del
   mismo reporte son conflicto, no dos incrementos.
3. La precedencia se congela por `source_policy_sha256` del settlement:
   PROVIDER_AUTHORITATIVE > WRAPPER_MEASURED > ESTIMATE. Reportes del mismo gasto
   desde dos fuentes son alternativas, nunca sumandos. Fuentes de igual prioridad
   que se contradicen y no son comparables producen DISPUTED y conteos NULL.
4. Se agregan por segmento las coberturas efectivas elegidas. FINAL requiere
   cobertura sin huecos y un `is_final = 1` efectivo de cada flujo elegido;
   de lo contrario es PARTIAL. Sin observaciones es UNKNOWN. Una corrección o
   reporte tardío crea una revisión nueva y no altera los conteos de una anterior.
5. `had_late_arrival` se deriva del orden de llegada del ledger: existe una nueva
   observación considerada después del evento que produjo una revisión FINAL
   anterior. No se infiere desde `occurred_at` ni sólo desde ordinal.

---

## 2. Settlement histórico, corte y observaciones exactas

### 2.1 `usage_settlement_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK compuesta; FK al efecto. |
| `settlement_revision` | INTEGER | NOT NULL | PK compuesta; `CHECK >= 1`; sucesor determinista de la revisión anterior a partir del evento disparador. |
| `settlement_status` | TEXT | NOT NULL | `CHECK IN ('FINAL','PARTIAL','UNKNOWN','DISPUTED')`. |
| `input_tokens` | INTEGER | NULL | NULL sii UNKNOWN/DISPUTED; en otro caso entero no negativo. |
| `output_tokens` | INTEGER | NULL | Misma regla. |
| `cache_write_tokens` | INTEGER | NULL | Misma regla. |
| `cache_read_tokens` | INTEGER | NULL | Misma regla. |
| `total_tokens` | INTEGER | NULL | Misma regla; cuando es conocido, suma de las cuatro clases normalizadas. |
| `source_policy_sha256` | TEXT | NOT NULL | Versión exacta de política de precedencia y cobertura usada en este corte. |
| `fold_version` | INTEGER | NOT NULL | `CHECK >= 1`; algoritmo de liquidación, no elección por la versión instalada al reconstruir. |
| `last_observation_id` | TEXT | NULL | FK a la última observación considerada por secuencia; NULL cuando ninguna existe, incluso si el efecto sí existe. |
| `had_late_arrival` | INTEGER | NOT NULL | `CHECK IN (0,1)`; regla §1.3. |
| `computed_at` | TEXT | NOT NULL | Instante del evento disparador registrado, no reloj del rebuild. |
| `sequence` | INTEGER | NOT NULL | Secuencia del evento disparador en control: observación, finalización o exposición del efecto. No necesita inventar una observación para UNKNOWN. |

PK `(effect_id, settlement_revision)`. Para **cada una** de las cinco columnas
de tokens se aplica:
`CHECK ((settlement_status IN ('UNKNOWN','DISPUTED') AND <tokens> IS NULL) OR (settlement_status IN ('FINAL','PARTIAL') AND <tokens> IS NOT NULL AND <tokens> >= 0))`.
La revisión vigente
es el máximo `settlement_revision`: no se actualizan las anteriores para agregar
un puntero `superseded_by_revision`.
Índice `ix_usage_settlement__latest(effect_id, settlement_revision DESC)`.

### 2.2 `usage_settlement_source_head_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK compuesta. |
| `settlement_revision` | INTEGER | NOT NULL | PK compuesta. |
| `source_stream` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('control_plane_events','registry_events')`. |
| `source_sequence` | INTEGER | NOT NULL | `CHECK >= 0`; cabeza fuente fijada. |
| `source_sha256` | TEXT | NOT NULL | Hash de esa cabeza; génesis si secuencia cero. |

PK `(effect_id, settlement_revision, source_stream)`; FK a §2.1.
La fila de control es obligatoria; registry se incluye cuando la política congelada
se obtuvo de ese stream. El vector es parte del corte, no un INTEGER sin stream.

### 2.3 `usage_settlement_observation_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK compuesta. |
| `settlement_revision` | INTEGER | NOT NULL | PK compuesta. |
| `observation_id` | TEXT | NOT NULL | PK compuesta; FK a la observación exacta considerada, también si perdió por precedencia o fue corregida. |

PK `(effect_id, settlement_revision, observation_id)`; FK compuesta al header.
El fold verifica mismo efecto y secuencia no posterior a la cabeza del corte.
La lista comprende **todas** las observaciones consideradas a ese corte; cero
filas sólo cuando ninguna existe. Reconstruir una revisión usa esta selección
determinista y su política, no todas las observaciones actuales del efecto.
Header, vector y lista se escriben en la transacción del evento disparador.
Pruebas: nuevo epoch con ordinal cero; final explícito; corrección tardía; replay;
corte histórico tras nuevas observaciones; UNKNOWN sin reporte; fuentes en disputa.

---

## 3. `price_interval_read_model` (reemplaza `price_read_model`)

**Nuevo**: identidad estable de documento **y** versión en toda
clave y lookup; intervalo semiabierto `[effective_from, effective_to)`.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `catalog_document_id` | TEXT | NOT NULL | PK (compuesta). Identidad estable del catálogo a través de versiones — `= registry_events.document_id` para `document_kind = 'PRICE_TABLE'`. |
| `catalog_version` | INTEGER | NOT NULL | PK (compuesta). `= registry_events.document_version` para ese documento. |
| `provider` | TEXT | NOT NULL | PK (compuesta). |
| `model_version_id` | TEXT | NOT NULL | PK (compuesta). |
| `transport_kind` | TEXT | NOT NULL | PK (compuesta). |
| `token_class` | TEXT | NOT NULL | PK (compuesta). `CHECK IN ('input','output','cache_write','cache_read')`. |
| `currency` | TEXT | NOT NULL | PK (compuesta). |
| `effective_from` | TEXT | NOT NULL | PK (compuesta). Intervalo **semiabierto**: `[effective_from, effective_to)`. |
| `effective_to` | TEXT | NULL | `NULL` = infinito (vigente sin fin declarado). `ck_price_interval_read_model__interval_order`: `CHECK (effective_to IS NULL OR effective_to > effective_from)`. |
| `price_per_million_nanos` | INTEGER | NOT NULL | `CHECK >= 0`. Precio por millón de tokens, nanounidades de `currency`. |
| `recorded_by` | TEXT | NOT NULL | — |
| `sequence` | INTEGER | NOT NULL | — |

**Dentro de una versión de catálogo, los intervalos por `(provider, model_version_id,
transport_kind, token_class, currency)` no se solapan**; el catálogo completo se valida
y se publica **atómicamente como una sola versión** (todas sus filas o ninguna), no fila
por fila. No expresable como `CHECK` declarativo (requiere comparar contra otras filas);
se valida fail-closed antes de admitir la versión, y el negativo ("intervalos solapados
→ rechazo") vive en `../../../quality/testing/index.md`. **No hay tarifa de respaldo `0`**:
sin intervalo vigente aplicable, el estado de valuación es `PRICE_MISSING` (§4), nunca costo
cero. Esto es catálogo de **configuración de precio**; no se confunde con un registry de
mediciones de desempeño (`model_performance_read_model`, §7); el registry único
de capacidades pertenece a accounts.

### Índices / OCC / transacción / rebuild

| Objeto | Forma |
| --- | --- |
| `pk_price_interval_read_model` | `PRIMARY KEY (catalog_document_id, catalog_version, provider, model_version_id, transport_kind, token_class, currency, effective_from)` |
| `ix_price_interval_read_model__lookup` | `INDEX (catalog_document_id, catalog_version, provider, model_version_id, transport_kind, token_class, currency, effective_from)` — resuelve el intervalo vigente al instante autoritativo del despacho **dentro de una versión de catálogo ya fijada**. La búsqueda **nunca cruza versiones**: el documento y la versión son parte de la clave y del índice. |
| Transacción | La versión de catálogo completa se valida y escribe en una sola transacción; nunca queda una versión parcialmente publicada. |
| Rebuild | Determinista desde `registry_events`. Un despacho fija `(catalog_document_id, catalog_version)` **antes del gasto**; un replay posterior nunca selecciona otra versión — reutiliza el pin registrado antes del gasto y referenciado por las líneas de `cost_snapshot_line_read_model` (§4.2). |

---

## 4. Costo: snapshot, líneas exactas y cabezas de origen

El costo es derivado. Un snapshot fija revisión de settlement, política de
valuación, precios admitidos antes del gasto y vector de cabezas. Los importes
enteros del header son salida redondeada; **no** son la fuente para sumar costos
de varios efectos ni para ponderar una suscripción.

### 4.1 `cost_snapshot_header_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK compuesta. |
| `currency` | TEXT | NOT NULL | PK compuesta; moneda explícita, sin conversión implícita. |
| `valuation_revision` | INTEGER | NOT NULL | PK compuesta; `CHECK >= 1`; nueva ante corrección de uso o revaluación explícita, nunca actualización silenciosa de una anterior. |
| `source_settlement_revision` | INTEGER | NOT NULL | FK junto con effect_id a la revisión histórica exacta de §2.1. |
| `valuation_policy_sha256` | TEXT | NOT NULL | Política/algoritmo exactos de valuación, pin y redondeo. |
| `real_cost_status` | TEXT | NOT NULL | `CHECK IN ('VALUED','PRICE_MISSING','USAGE_UNKNOWN','EXTERNAL')`; sólo gasto real. |
| `equivalent_cost_status` | TEXT | NOT NULL | Mismo dominio; estado independiente del valor equivalente. |
| `real_cost_nanos` | INTEGER | NULL | NOT NULL sii real_cost_status VALUED; resultado de sumar sus racionales y redondear una vez. |
| `equivalent_api_cost_nanos` | INTEGER | NULL | NOT NULL sii equivalent_cost_status VALUED; no se suma al gasto real. |
| `computed_at` | TEXT | NOT NULL | Instante del evento de cálculo registrado; no reloj del rebuild. |
| `sequence` | INTEGER | NOT NULL | Secuencia del evento disparador en control. |

PK `(effect_id, currency, valuation_revision)`; FK compuesta
`(effect_id, source_settlement_revision)` a settlement.
Checks independientes
`CHECK ((real_cost_status = 'VALUED') = (real_cost_nanos IS NOT NULL))` y
`CHECK ((equivalent_cost_status = 'VALUED') = (equivalent_api_cost_nanos IS NOT NULL))`.
Las líneas valoradas normales no producen importes negativos; una corrección
reemplaza la revisión y no se suma como nuevo gasto. Comprobación int64 antes de
persistir cada importe; ningún paso intermedio usa floating point.

### 4.2 `cost_snapshot_line_read_model`

Una fila por snapshot, segmento, clase de token y medida. Las dos medidas pueden
usar tarifas diferentes o una quedar EXTERNAL mientras la otra es VALUED.
Los pines se copian del despacho registrado de ese segmento **anterior al gasto**;
no se eligen cuando llega la observación tardía.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK compuesta y FK al header. |
| `currency` | TEXT | NOT NULL | PK compuesta; misma moneda del header y del intervalo si existe. |
| `valuation_revision` | INTEGER | NOT NULL | PK compuesta. |
| `route_segment_id` | TEXT | NOT NULL | PK compuesta; segmento al que las observaciones del settlement atribuyen esta parte. |
| `token_class` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('input','output','cache_write','cache_read')`. |
| `measure_kind` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('REAL','EQUIVALENT')`. |
| `valuation_status` | TEXT | NOT NULL | `CHECK IN ('VALUED','PRICE_MISSING','USAGE_UNKNOWN','EXTERNAL')`. |
| `quantity_tokens` | INTEGER | NULL | NULL cuando el uso de esta línea es desconocido; si está poblado, `CHECK >= 0`. Proviene del settlement a nivel de segmento, no del total copiado a cada segmento. |
| `catalog_document_id` | TEXT | NULL | Documento admitido antes del despacho; NULL si no se obtuvo pin aplicable o la medida es EXTERNAL. |
| `catalog_version` | INTEGER | NULL | Presente junto con document_id; `CHECK (catalog_version IS NULL OR catalog_version >= 1)`. |
| `provider` | TEXT | NULL | Parte de la clave exacta del intervalo; presente junto con el resto de su referencia. |
| `model_version_id` | TEXT | NULL | Parte de la clave exacta del intervalo; nunca alias inventado para modelo no observable. |
| `transport_kind` | TEXT | NULL | Parte de la clave exacta del intervalo. |
| `price_effective_from` | TEXT | NULL | Parte final de la clave del intervalo elegido; no un único instante compartido por todas las clases. |
| `exact_numerator` | TEXT | NULL | Numerador no negativo en decimal canónico `0\|[1-9][0-9]*`; NOT NULL sii VALUED. Valor BigInt persistido, **sin redondear**. |
| `exact_denominator` | INTEGER | NULL | NOT NULL sii VALUED; `CHECK > 0` cuando presente. Para tokens × precio por millón: 1.000.000, antes de cualquier reducción exacta común. |

PK `(effect_id, currency, valuation_revision, route_segment_id, token_class, measure_kind)`.
FK `(effect_id, currency, valuation_revision)` al header.
Referencia compuesta completa al precio:
`(catalog_document_id, catalog_version, provider, model_version_id, transport_kind, token_class, currency, price_effective_from)`
→ `price_interval_read_model(catalog_document_id, catalog_version, provider, model_version_id, transport_kind, token_class, currency, effective_from)`.
Como cruza cohortes fuente, se comprueba tipadamente contra el vector fijado,
con índice de búsqueda completo, no con una FK que obligue reconstrucción
simultánea de todos los streams.

Checks: documento/versión ambos NULL o ambos presentes; proveedor/modelo/transporte/
effective_from todos NULL o todos presentes. VALUED exige quantity no negativa,
pin e intervalo completos, numerador canónico y denominador positivo.
USAGE_UNKNOWN exige quantity NULL; PRICE_MISSING/EXTERNAL pueden conservar una
cantidad conocida, pero no un importe inventado. Toda línea no VALUED tiene ambos
componentes racionales NULL. Un pin de catálogo conocido sin intervalo aplicable
conserva documento/versión, deja vacía la referencia de intervalo y marca
PRICE_MISSING.

El numerador exacto es `BigInt(quantity_tokens) * BigInt(price_per_million_nanos)`.
Se comprueba la preimagen contra el intervalo fijado al producir la fila. La
representación TEXT se valida por parser decimal canónico antes del INSERT y por
`CHECK (exact_numerator IS NULL OR (typeof(exact_numerator) = 'text' AND length(exact_numerator) > 0 AND exact_numerator NOT GLOB '*[^0-9]*' AND (exact_numerator = '0' OR substr(exact_numerator,1,1) <> '0')))`.
Los valores desconocidos se conservan NULL; no aparecen como racional cero.

### 4.3 `cost_snapshot_source_head_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `effect_id` | TEXT | NOT NULL | PK compuesta. |
| `currency` | TEXT | NOT NULL | PK compuesta. |
| `valuation_revision` | INTEGER | NOT NULL | PK compuesta. |
| `source_stream` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('control_plane_events','registry_events')`. |
| `source_sequence` | INTEGER | NOT NULL | `CHECK >= 0`; cabeza fijada. |
| `source_sha256` | TEXT | NOT NULL | Hash de esa cabeza. |

PK `(effect_id, currency, valuation_revision, source_stream)`; FK al header.

### Agregación, transacción y rebuild

- Header, líneas y vector se publican juntos en la transacción del evento
  disparador. Un replay reconstruye esas filas y pines, no consulta otra versión
  de catálogo. Índice `ix_cost_snapshot__latest(effect_id, currency, valuation_revision DESC)`.
- Los conteos por segmento se obtienen de las observaciones exactas del settlement
  seleccionado y del mismo algoritmo de §1.3. Una ruta con uso desconocido conserva
  líneas USAGE_UNKNOWN; no se elimina para que el total parezca completo.
- Cada medida del header se deriva sólo de sus líneas. Prioridad de incompletitud:
  USAGE_UNKNOWN, después PRICE_MISSING, después EXTERNAL; VALUED sólo cuando todas
  sus líneas son valorables. Gasto real y equivalente se resuelven independientemente.
- Para cada medida VALUED, sumar racionales con BigInt y aplicar HALF_TO_EVEN
  **una sola vez al cierre del agregado**. Para sumar varios efectos, volver a sus
  racionales persistidos; nunca sumar importes por efecto ya redondeados. El
  chequeo de rango int64 es posterior al redondeo, antes del INSERT.
- Un catálogo retroactivo no cambia una revisión anterior. Revaluación solicitada
  explícitamente crea revisión nueva con su origen y política; nunca reemplaza
  por defecto los pines de despachos ya ejecutados.

---

## 5. `subscription_period_read_model`

Términos fácticos del período, reconstruidos desde declaraciones registradas en
`account_events`. Uso, equivalente y asignaciones son cortes de §6, **no columnas
mutables mezcladas con los hechos del período**.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `account_id` | TEXT | NOT NULL | PK compuesta. |
| `period_start` | TEXT | NOT NULL | PK compuesta; inicio incluido. |
| `period_end` | TEXT | NOT NULL | Fin excluido; `CHECK (period_start < period_end)`. |
| `plan_fee_nanos` | INTEGER | NOT NULL | `CHECK >= 0`; costo registrado de este período, no gasto API por efecto. |
| `currency` | TEXT | NOT NULL | Moneda del costo registrado. |
| `plan_terms_sha256` | TEXT | NOT NULL | Versión exacta de los términos registrada para este período. |
| `sequence` | INTEGER | NOT NULL | Evento fuente que fija los términos en account_events. |

PK `(account_id, period_start)`. Ninguna reasignación cambia fee, moneda o
términos de esta fila. Rebuild desde la declaración del período a su cabeza
fijada, sin consultar el owner file actual.

---

## 6. Asignación: header, vector, entradas y resultado

### 6.1 `subscription_allocation_header_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `account_id` | TEXT | NOT NULL | PK compuesta. |
| `period_start` | TEXT | NOT NULL | PK compuesta; referencia al período. |
| `allocation_revision` | INTEGER | NOT NULL | PK compuesta; `CHECK >= 1`. Reabrir crea revisión nueva. |
| `currency` | TEXT | NOT NULL | Moneda fijada del período; nunca se agregan entradas de otra moneda. |
| `period_fee_nanos` | INTEGER | NOT NULL | `CHECK >= 0`; copia verificada del hecho de costo del período. |
| `allocation_policy_sha256` | TEXT | NOT NULL | Versión del algoritmo, scope de destinatarios y reglas de cierre. |
| `state` | TEXT | NOT NULL | `CHECK IN ('OPEN','CLOSED')`. |
| `has_unknown_weight` | INTEGER | NOT NULL | `CHECK IN (0,1)`; existe una entrada de peso desconocido. |
| `computed_at` | TEXT | NOT NULL | Instante del evento registrado que produjo este corte, no reloj del rebuild. |
| `closed_at` | TEXT | NULL | NOT NULL sii state CLOSED; instante del evento de cierre. |
| `sequence` | INTEGER | NOT NULL | Secuencia del evento de control de este corte en account_events. |

PK `(account_id, period_start, allocation_revision)`; FK
`(account_id, period_start)` al período.
`CHECK ((state = 'CLOSED') = (closed_at IS NOT NULL))`.
Cerrar un corte cambia su estado derivado por evento; no cambia las entradas ni
la asignación que ese corte fijó. Reabrir no borra ni reescribe el corte cerrado.

### 6.2 `subscription_allocation_source_head_read_model`

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `account_id` | TEXT | NOT NULL | PK compuesta. |
| `period_start` | TEXT | NOT NULL | PK compuesta. |
| `allocation_revision` | INTEGER | NOT NULL | PK compuesta. |
| `source_stream` | TEXT | NOT NULL | PK compuesta; `CHECK IN ('account_events','control_plane_events','registry_events')`. |
| `source_sequence` | INTEGER | NOT NULL | `CHECK >= 0`; cabeza fuente fijada. |
| `source_sha256` | TEXT | NOT NULL | Hash de la cabeza fuente. |

PK `(account_id, period_start, allocation_revision, source_stream)`; FK al header.
Account fija términos y corte; control fija efectos/uso; registry fija los precios
y política referenciados. Las tres cabezas se conservan por revisión, no sólo
`as_of_sequence` sin stream.

### 6.3 `subscription_allocation_input_read_model`

Una fila por efecto seleccionado y revisión de costo utilizada. También se
conservan las entradas de equivalente desconocido: no desaparecen del corte.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `account_id` | TEXT | NOT NULL | PK compuesta. |
| `period_start` | TEXT | NOT NULL | PK compuesta. |
| `allocation_revision` | INTEGER | NOT NULL | PK compuesta. |
| `effect_id` | TEXT | NOT NULL | PK compuesta; identificador estable usado para desempatar. |
| `currency` | TEXT | NOT NULL | Igual a la moneda del header y del snapshot de costo referenciado. |
| `source_valuation_revision` | INTEGER | NOT NULL | Con effect_id/currency identifica la revisión exacta de costo. |
| `recipient_kind` | TEXT | NOT NULL | `CHECK IN ('INITIATIVE','STEP','UNALLOCATED')`; un solo destinatario por efecto en este corte. |
| `recipient_id` | TEXT | NULL | NULL sii recipient_kind UNALLOCATED; identificador canónico del destinatario del scope fijado. |
| `weight_status` | TEXT | NOT NULL | `CHECK IN ('KNOWN','UNKNOWN')`; independiente del gasto real. |
| `weight_numerator` | TEXT | NULL | NOT NULL sii KNOWN; decimal canónico no negativo, BigInt exacto. |
| `weight_denominator` | INTEGER | NULL | NOT NULL sii KNOWN; positivo. |

PK `(account_id, period_start, allocation_revision, effect_id)`: no permite
ponderar dos revisiones del mismo gasto dentro del corte.
FK al header; referencia completa
`(effect_id, currency, source_valuation_revision)` a costo histórico, comprobada
tipadamente contra la cabeza de control/registry del corte por ser otra cohorte.
Checks de destinatario, nulidad de ambos componentes por weight_status, denominador
positivo y decimal canónico iguales a §4.2.
El peso es la suma **racional exacta** de las líneas EQUIVALENT del snapshot
referenciado correspondientes a la cuenta y al período; la selección de segmentos
se verifica desde el flujo de origen, no desde el account actual del efecto.
No procede de `equivalent_api_cost_nanos` redondeado.
Si alguna parte seleccionada es desconocida, weight_status UNKNOWN y ambos
componentes NULL. Nunca se fuerza a cero para cerrar el período.

### 6.4 `subscription_allocation_read_model` (salida por destinatario)

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `allocation_item_id` | TEXT | NOT NULL | PK; SHA-256 de la tupla canónica versionada (account_id, period_start, allocation_revision, recipient_kind, recipient_id). |
| `account_id` | TEXT | NOT NULL | Parte de la referencia al header. |
| `period_start` | TEXT | NOT NULL | Parte de la referencia al header. |
| `allocation_revision` | INTEGER | NOT NULL | Parte de la referencia al header. |
| `recipient_kind` | TEXT | NOT NULL | Dominio de §6.3. |
| `recipient_id` | TEXT | NULL | NULL sólo para UNALLOCATED; no integra una PK nullable. |
| `allocated_cost_nanos` | INTEGER | NOT NULL | `CHECK >= 0`; resultado entero de resto mayor. |

PK `(allocation_item_id)`; FK `(account_id, period_start, allocation_revision)` al header.
La admisión comprueba que allocation_item_id corresponde a su tupla; no se usa un
sentinel para el destinatario ausente. `CHECK ((recipient_kind = 'UNALLOCATED') = (recipient_id IS NULL))`.
Índice parcial `ux_subscription_allocation__unallocated`:
`UNIQUE(account_id, period_start, allocation_revision) WHERE recipient_kind = 'UNALLOCATED'`.
Índice parcial complementario `ux_subscription_allocation__recipient`:
`UNIQUE(account_id, period_start, allocation_revision, recipient_kind, recipient_id) WHERE recipient_kind <> 'UNALLOCATED'`.
Índice `ix_subscription_allocation_header__latest(account_id, period_start, allocation_revision DESC)`.
La moneda es la del único header padre; no se duplica una medida sin unidad.

### 6.5 Algoritmo exacto, cierre y rebuild

- Seleccionar una revisión de costo por efecto a las cabezas fijadas; persistir
  entradas con sus referencias y pesos. No seleccionar “la última” al reconstruir
  un corte anterior. Header, cabezas, entradas y salidas se escriben juntos con
  el evento de control del corte.
- Si existe peso UNKNOWN, no se conoce la proporción de asignación: conservar
  `has_unknown_weight = 1` y todo el fee en UNALLOCATED para este corte. No
  inventar un peso cero ni una proporción para esa exposición. Con cero pesos
  positivos conocidos, el fee también queda íntegro en UNALLOCATED.
- En un corte completamente conocido con suma de pesos positivos W, calcular por
  efecto `fee * weight / W` con racionales BigInt; asignar el piso entero y
  distribuir el resto por parte fraccionaria descendente. Empates por effect_id
  en orden lexicográfico de puntos de código. Luego sumar las porciones por
  destinatario. Es **resto mayor**, no redondeo previo de pesos ni HALF_TO_EVEN
  por cada porción.
- Aun con pesos conocidos, una entrada sin destinatario admisible va a UNALLOCATED.
  Cada efecto contribuye una sola vez: el corte no asigna simultáneamente a una
  iniciativa y a su paso para contar dos veces.
- Validar antes del cierre, con BigInt, que asignado + UNALLOCATED es exactamente
  `period_fee_nanos`; comprobar rango int64 al escribir cada salida.
- Rebuild conserva referencias, cabezas, racionales, eventos de cierre y el
  instante registrado. Correcciones tardías/reapertura producen corte nuevo;
  nunca editan retrospectivamente salidas cerradas.

---

## 7. `model_performance_read_model`

El diccionario completo de `model_performance_read_model` y sus hijas vive una
sola vez en [performance/index.md](performance/index.md). Es una proyección
de registry_events / MODEL_PERFORMANCE; el modelo sigue referenciado al
registry único de accounts.

`performance_id` identifica el snapshot; `request_sha256 UNIQUE` incluye el
vector de fuentes. La tupla descriptiva de cohorte/asOf/policy es un índice no
único: una corrección a otro corte no sobreescribe el reporte anterior.
Las medidas monetarias son exclusivamente EQUIVALENT (§4), no gasto REAL ni
asignación de suscripción. Estados de muestra/frescura son distintos de los
cuatro estados de valuación; UNKNOWN nunca obliga a cero.

Política, fuentes y DTO: [estimación](../../contracts/estimation/index.md).
Algoritmo de desempeño, muestra e intervalo Wilson:
[algoritmos](../../contracts/estimation/algorithms/index.md#6-e9-desempeño-observacional-reproducible).
Publicación/OCC/rebuild: [streams §4.1](../streams/index.md#41-publicación-de-reportes-derivados).

---

## 8. Mapeo legado → destino

| Objeto legado | Estado hoy | Destino | Nota |
| --- | --- | --- | --- |
| `usage_read_model` (PK `sequence` simple) | No existe (propuesto en el modelo anterior) | `usage_observation_read_model`, flujo de medición con rangos DELTA/CUMULATIVE/CORRECTION explícitos. | §1, corrige defecto |
| — (no existía) | — | `usage_measurement_stream_read_model`; settlement versionado con `usage_settlement_source_head_read_model` y `usage_settlement_observation_read_model`. | §1–2 |
| `model_version_read_model` (con `eligible_roles_json`/`transports_json`) | No existe (propuesto en el modelo anterior) | **Vive en [accounts](../accounts/index.md)** §6: el registry es uno solo. | — |
| `price_read_model` (PK `(price_version, model_version_id, token_kind)`) | No existe (propuesto en el modelo anterior) | `price_interval_read_model`, PK con `catalog_document_id`+`catalog_version`, intervalo semiabierto no solapado. | §3 |
| `cost_read_model` (PK `usage_sequence`, "sin evento de costo, función de dos hechos") | No existe (propuesto en el modelo anterior) | Header + `cost_snapshot_line_read_model` con racionales exactos + `cost_snapshot_source_head_read_model`. | §4, corrige defecto |
| `subscription_period_read_model` (con `allocated_cost_minor_units` mutable en la misma fila) | No existe (propuesto en el modelo anterior) | Período factual + allocation header, source heads, input refs/pesos racionales y filas de resultado por corte. | §5, §6, corrige defecto |
| `model_performance_read_model` | No existe (propuesto en el modelo anterior) | Familia completa en [performance](performance/index.md): PK `performance_id`, UNIQUE `request_sha256`, cohorte como índice no único, métricas nullable según muestra/valuación. | §7 |
