# Simulación: diccionario físico

Dueño: [planning](../index.md) §11. Contratos, política, cohortes y cuota:
[estimación](../../../contracts/estimation/index.md); calendario, forecast,
what-if y negativos: [algoritmos](../../../contracts/estimation/algorithms/index.md).
Publicación/OCC/rebuild: [streams §4.1](../../streams/index.md#41-publicación-de-reportes-derivados).
Fuente: initiative_events. Este documento posee el header y las entradas/salidas
normalizadas siguientes; [plan_simulation_quota](../index.md#112-plan_simulation_quota-reemplaza-quota_by_account_json)
permanece definido únicamente en la hoja padre.

## 1. plan_simulation_read_model

**Nuevo.** Snapshot inmutable del cálculo guardado explícitamente. Un dry-run no
crea filas. Las estimaciones desconocidas son NULL, nunca DEFAULT 0.

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | PK. |
| `scope_kind` | TEXT | NOT NULL | CHECK IN ('INITIATIVE','STEP'). |
| `scope_id` | TEXT | NOT NULL | — |
| `inputs_sha256` | TEXT | NOT NULL | SHA de Request, incluye sourceHeads. |
| `calculation_kind` | TEXT | NOT NULL | CHECK IN ('SIMULATION','FORECAST','WHAT_IF'). |
| `report_sha256` | TEXT | NOT NULL | UNIQUE; salida completa verificada. |
| `plan_id` | TEXT | NOT NULL | — |
| `plan_sha256` | TEXT | NOT NULL | — |
| `graph_revision_id` | TEXT | NOT NULL | — |
| `as_of` | TEXT | NOT NULL | Instante del corte semántico, no publicación. |
| `policy_document_id` | TEXT | NOT NULL | — |
| `policy_version` | INTEGER | NOT NULL | CHECK >= 1. |
| `policy_sha256` | TEXT | NOT NULL | — |
| `baseline_report_sha256` | TEXT | NULL | Presente sii calculation_kind='WHAT_IF'; reporte histórico. |
| `token_status` | TEXT | NOT NULL | CHECK IN ('KNOWN','ESTIMATED','UNKNOWN'). |
| `token_reason` | TEXT | NULL | UnknownReason del contrato, presente sii status UNKNOWN. |
| `cost_status` | TEXT | NOT NULL | CHECK IN ('KNOWN','ESTIMATED','UNKNOWN'). |
| `cost_reason` | TEXT | NULL | UnknownReason del contrato, presente sii status UNKNOWN. |
| `duration_status` | TEXT | NOT NULL | CHECK IN ('KNOWN','ESTIMATED','UNKNOWN'). |
| `duration_reason` | TEXT | NULL | UnknownReason del contrato, presente sii status UNKNOWN. |
| `estimated_tokens_low` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_tokens` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_tokens_high` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_cost_low_nanos` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_cost_nanos` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_cost_high_nanos` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_seconds_low` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_seconds` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_seconds_high` | INTEGER | NULL | Valor no negativo; NULL sii status de su métrica UNKNOWN. |
| `estimated_currency` | TEXT | NOT NULL | Moneda explícita; medida fija EQUIVALENT, no REAL ni FX. |
| `cost_low_numerator` | TEXT | NULL | Decimal canónico no negativo; presente sii cost_status <> UNKNOWN. |
| `cost_low_denominator` | TEXT | NULL | Decimal canónico positivo; misma nulidad que numerador. |
| `cost_point_numerator` | TEXT | NULL | Decimal canónico no negativo; presente sii cost_status <> UNKNOWN. |
| `cost_point_denominator` | TEXT | NULL | Decimal canónico positivo; misma nulidad que numerador. |
| `cost_high_numerator` | TEXT | NULL | Decimal canónico no negativo; presente sii cost_status <> UNKNOWN. |
| `cost_high_denominator` | TEXT | NULL | Decimal canónico positivo; misma nulidad que numerador. |
| `finish_low_at` | TEXT | NULL | Instante; presente sii duration_status <> UNKNOWN. |
| `finish_point_at` | TEXT | NULL | Instante; presente sii duration_status <> UNKNOWN. |
| `finish_high_at` | TEXT | NULL | Instante; presente sii duration_status <> UNKNOWN. |
| `reset_status` | TEXT | NOT NULL | CHECK IN ('KNOWN','ESTIMATED','UNKNOWN'). |
| `reaches_reset` | INTEGER | NULL | CHECK NULL o IN (0,1); NULL sii reset_status UNKNOWN. |
| `computed_at` | TEXT | NOT NULL | Instante registrado del evento de publicación; nunca reloj del rebuild. |
| `sequence` | INTEGER | NOT NULL | Secuencia fuente en initiative_events. |

PK(simulation_id); UNIQUE(report_sha256).
INDEX ix_plan_simulation_read_model__scope(scope_kind,scope_id,computed_at).

Para cada grupo token/cost/duration, punto corresponde respectivamente a
estimated_tokens/estimated_cost_nanos/estimated_seconds. Los tres valores
low/punto/high están presentes sii status <> UNKNOWN; reason está presente sii
status=UNKNOWN; valores presentes cumplen 0 <= low <= punto <= high.
KNOWN exige low=punto=high=0 estructural; toda inferencia es ESTIMATED.
Cada CHECK de orden condicionado usa IS TRUE para que NULL no pase por lógica
ternaria. Las seis columnas racionales de costo están todas NULL o todas
presentes; presentes sii cost_status <> UNKNOWN, con fracciones reducidas,
denominador positivo y cero 0/1. HALF_TO_EVEN del racional exacto coincide con
cada monto entero; suma y validación int64 se hacen después del cálculo BigInt.

CHECK((calculation_kind='WHAT_IF')=(baseline_report_sha256 IS NOT NULL)).
CHECK((reset_status='UNKNOWN')=(reaches_reset IS NULL)).
Las tres fechas finish son NULL sii duration_status UNKNOWN; de lo contrario
coinciden con los tres makespans del contrato, sin prometer cobertura probabilística.
El pin policy y plan se verifica contra sus documentos/versiones al corte.
No se reinterpretan reportes legacy incompletos como snapshots V1.

## 2. Convenciones de las hijas

Todos los nombres siguientes son completos. Todas las columnas son NOT NULL
salvo las marcadas NULL; ids/hashes/enums/instantes son TEXT, conteos y segundos
son INTEGER int64 no negativos. Enteros ordinales empiezan en 0, versiones/
revisiones en 1. Racionales usan TEXT decimal canónico BigInt, denominador
positivo; cantidades monetarias de estas tablas no admiten signo negativo.

Todas las hijas tienen FK simulation_id al header, misma cohorte física.
Referencias a execution/accounts/registry son tipadas al vector source_head,
sin FK entre cohortes que obligue a reconstruir streams juntos. Los CHECK de
vocabulario/timestamp/hash/decimal reutilizan el schema dueño del contrato.
No hay RequestJSON, nodes_json, prices_json ni tabla duplicada de modelos.

### 2.1 plan_simulation_source_head_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `source_stream` | TEXT | NOT NULL | CHECK IN ('control_plane_events','initiative_events','account_events','registry_events'). |
| `source_sequence` | INTEGER | NOT NULL | CHECK >=0; cabeza fijada. |
| `source_sha256` | TEXT | NOT NULL | Digest en esa secuencia; génesis según maestro. |

PK(simulation_id,source_stream).

### 2.2 plan_simulation_node_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `revision_task_id` | TEXT | NULL | Referencia de revisión; grupo de tres NULL o completo. |
| `revision_number` | INTEGER | NULL | CHECK NULL o >=1. |
| `envelope_sha256` | TEXT | NULL | Mismo grupo de revisión. |
| `target_model_version_id` | TEXT | NULL | Grupo Target de seis columnas NULL o completo; schemas dueños. |
| `target_role` | TEXT | NULL | Grupo Target de seis columnas NULL o completo; schemas dueños. |
| `classification_sha256` | TEXT | NULL | Grupo Target de seis columnas NULL o completo; schemas dueños. |
| `verification_policy_sha256` | TEXT | NULL | Grupo Target de seis columnas NULL o completo; schemas dueños. |
| `account_id` | TEXT | NULL | Grupo Target de seis columnas NULL o completo; schemas dueños. |
| `transport_kind` | TEXT | NULL | Grupo Target de seis columnas NULL o completo; schemas dueños. |
| `progress` | TEXT | NOT NULL | CHECK IN ('PENDING','RUNNING','COMPLETE','BLOCKED'). |
| `release_offset_seconds` | INTEGER | NULL | NULL = liberación desconocida, no cero. |
| `elapsed_work_seconds` | INTEGER | NULL | Duración activa reconstruida; NULL si no se prueba. |
| `observed_input` | INTEGER | NULL | Piso observado; cuatro NULL o completos. |
| `observed_output` | INTEGER | NULL | Piso observado; cuatro NULL o completos. |
| `observed_cache_write` | INTEGER | NULL | Piso observado; cuatro NULL o completos. |
| `observed_cache_read` | INTEGER | NULL | Piso observado; cuatro NULL o completos. |

PK(simulation_id,node_key). Las dos referencias compuestas y el piso de cuatro clases se validan como grupos completos; progress y nulidades siguen Node del contrato. Modelo sin versión observable conserva Target NULL, no un id inventado.

### 2.3 plan_simulation_dependency_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `predecessor_node_key` | TEXT | NOT NULL | — |

PK(simulation_id,node_key,predecessor_node_key); FK(simulation_id,node_key) y FK(simulation_id,predecessor_node_key) a node. CHECK(node_key<>predecessor_node_key); fold prueba aciclicidad.

### 2.4 plan_simulation_demand_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `resource_class` | TEXT | NOT NULL | — |
| `units` | INTEGER | NOT NULL | CHECK>=1. |

PK(simulation_id,node_key,resource_class); FK(simulation_id,node_key) a node; FK(simulation_id,resource_class) a capacity.

### 2.5 plan_simulation_capacity_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `resource_class` | TEXT | NOT NULL | — |

PK(simulation_id,resource_class). La fila existe aun con cero slots; no se infiere capacidad ausente.

### 2.6 plan_simulation_slot_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `resource_class` | TEXT | NOT NULL | — |
| `slot_key` | TEXT | NOT NULL | — |
| `available_offset_seconds` | INTEGER | NULL | NULL significa disponibilidad desconocida. |

PK(simulation_id,resource_class,slot_key); FK(simulation_id,resource_class) a capacity.

### 2.7 plan_simulation_price_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `token_class` | TEXT | NOT NULL | CHECK IN ('input','output','cache_write','cache_read'). |
| `catalog_document_id` | TEXT | NOT NULL | — |
| `catalog_version` | INTEGER | NOT NULL | CHECK>=1. |
| `catalog_sha256` | TEXT | NOT NULL | — |
| `provider` | TEXT | NOT NULL | — |
| `model_version_id` | TEXT | NOT NULL | — |
| `transport_kind` | TEXT | NOT NULL | — |
| `currency` | TEXT | NOT NULL | — |
| `effective_from` | TEXT | NOT NULL | — |

PK(simulation_id,node_key,token_class); FK(simulation_id,node_key) a node. Referencia exacta a [price_interval_read_model](../../economy/index.md): (catalog_document_id,catalog_version,provider,model_version_id,transport_kind,token_class,currency,effective_from). El pin de catálogo incluye digest. Precio ausente no crea una fila cero; deja la métrica monetaria UNKNOWN.

### 2.8 plan_simulation_metric_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `metric` | TEXT | NOT NULL | CHECK IN ('INPUT_TOKENS','OUTPUT_TOKENS','CACHE_WRITE_TOKENS','CACHE_READ_TOKENS','TOTAL_TOKENS','WORK_SECONDS','EQUIVALENT_COST_NANOS'). |
| `status` | TEXT | NOT NULL | CHECK IN ('KNOWN','ESTIMATED','UNKNOWN'). |
| `reason` | TEXT | NULL | UnknownReason; presente sii UNKNOWN. |
| `low_value` | INTEGER | NULL | NULL sii UNKNOWN; no negativo. |
| `point_value` | INTEGER | NULL | NULL sii UNKNOWN; no negativo. |
| `high_value` | INTEGER | NULL | NULL sii UNKNOWN; no negativo. |
| `low_numerator` | TEXT | NULL | Sólo moneda; presente sii valor monetario presente. |
| `low_denominator` | TEXT | NULL | Sólo moneda; positivo, misma nulidad. |
| `point_numerator` | TEXT | NULL | Sólo moneda; presente sii valor monetario presente. |
| `point_denominator` | TEXT | NULL | Sólo moneda; positivo, misma nulidad. |
| `high_numerator` | TEXT | NULL | Sólo moneda; presente sii valor monetario presente. |
| `high_denominator` | TEXT | NULL | Sólo moneda; positivo, misma nulidad. |
| `selected_count` | INTEGER | NOT NULL | CHECK>=0. |
| `eligible_count` | INTEGER | NOT NULL | CHECK>=0. |
| `unknown_count` | INTEGER | NOT NULL | CHECK>=0. |
| `excluded_outcome_count` | INTEGER | NOT NULL | CHECK>=0. |
| `oldest_eligible_at` | TEXT | NULL | NULL sii eligible_count=0. |
| `newest_eligible_at` | TEXT | NULL | Misma nulidad que oldest. |

PK(simulation_id,node_key,metric); FK(simulation_id,node_key) a node. CHECK(selected_count=eligible_count+unknown_count+excluded_outcome_count). Cada valor NULL sii status UNKNOWN; reason presente sii UNKNOWN; valores presentes ordenados. KNOWN exige triple cero estructural. En moneda las seis columnas racionales están completas sii valores presentes; para otras métricas están NULL. Sus nanos son HALF_TO_EVEN al cierre, no fuente para sumar.

### 2.9 plan_simulation_schedule_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `scenario` | TEXT | NOT NULL | CHECK IN ('LOW','POINT','HIGH'). |
| `start_offset_seconds` | INTEGER | NULL | Par completo o NULL. |
| `finish_offset_seconds` | INTEGER | NULL | Presente >=start. |
| `reason` | TEXT | NULL | UnknownReason; presente sii offsets NULL. |

PK(simulation_id,node_key,scenario); FK(simulation_id,node_key) a node. Tres escenarios por nodo; la clausura de incertidumbre incluye descendientes y recursos compartidos, según algoritmo. No reservar un slot real.

### 2.10 plan_simulation_schedule_slot_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `scenario` | TEXT | NOT NULL | — |
| `resource_class` | TEXT | NOT NULL | — |
| `slot_key` | TEXT | NOT NULL | — |

PK(simulation_id,node_key,scenario,resource_class,slot_key); FK(simulation_id,node_key,scenario) a schedule; FK(simulation_id,resource_class,slot_key) a slot.

### 2.11 plan_simulation_sample_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | CHECK>=1. |
| `finalization_sequence` | INTEGER | NOT NULL | CHECK>0; hecho terminal al corte. |
| `envelope_sha256` | TEXT | NOT NULL | — |
| `receipt_sha256` | TEXT | NULL | Recibo exacto si disponible. |
| `audit_id` | TEXT | NULL | Veredicto exacto si disponible. |
| `inclusion` | TEXT | NOT NULL | CHECK IN ('SELECTED','OUTCOME_EXCLUDED'). |

PK(simulation_id,node_key,task_id,revision_number); FK(simulation_id,node_key) a node. Los pines no cambian aunque llegue una decisión/medición posterior.

### 2.12 plan_simulation_sample_effect_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `node_key` | TEXT | NOT NULL | — |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | CHECK>=1. |
| `effect_id` | TEXT | NOT NULL | — |
| `settlement_revision` | INTEGER | NULL | CHECK NULL o >=1; revisión exacta al corte. |
| `valuation_revision` | INTEGER | NULL | CHECK NULL o >=1; moneda del header. |

PK(simulation_id,node_key,task_id,revision_number,effect_id); FK(simulation_id,node_key,task_id,revision_number) a sample. Efecto sin settlement/costo conserva effect_id + NULL: no se elimina para fingir cobertura. La referencia monetaria completa usa (effect_id,estimated_currency,valuation_revision) y su settlement; cantidades siguen en sus dueños.

### 2.13 plan_simulation_diagnostic_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `ordinal` | INTEGER | NOT NULL | CHECK>=0. |
| `node_key` | TEXT | NULL | NULL para diagnóstico global. |
| `code` | TEXT | NOT NULL | UnknownReason cerrado del contrato. |

PK(simulation_id,ordinal); FK(simulation_id,node_key) a node cuando presente. UNIQUE INDEX(simulation_id,code) WHERE node_key IS NULL; UNIQUE INDEX(simulation_id,node_key,code) WHERE node_key IS NOT NULL. Evita la falsa unicidad con NULL.

### 2.14 plan_simulation_quota_dimension_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `simulation_id` | TEXT | NOT NULL | — |
| `account_id` | TEXT | NOT NULL | — |
| `ordinal` | INTEGER | NOT NULL | CHECK>=0; orden canónico de dimensión. |
| `scope` | TEXT | NOT NULL | CHECK IN ('ACCOUNT','MODEL','TRANSPORT'). |
| `scope_ref` | TEXT | NULL | NULL sii scope ACCOUNT. |
| `window_start` | TEXT | NULL | Ventana NULL o par completo. |
| `window_end` | TEXT | NULL | Presente > window_start. |
| `metric` | TEXT | NOT NULL | CHECK IN ('TOKENS','USAGE_LIMIT_TOKENS'). |
| `unit` | TEXT | NOT NULL | CHECK unit='TOKENS'. |
| `remaining_observation_id` | TEXT | NULL | Trío fuente NULL o completo. |
| `remaining_account_sequence` | INTEGER | NULL | CHECK NULL o >0. |
| `remaining_account_sha256` | TEXT | NULL | Digest de account_event_integrity en esa secuencia. |
| `reset_observation_id` | TEXT | NULL | Trío fuente NULL o completo. |
| `reset_account_sequence` | INTEGER | NULL | CHECK NULL o >0. |
| `reset_account_sha256` | TEXT | NULL | Digest de account_event_integrity en esa secuencia. |

PK(simulation_id,account_id,ordinal). CHECK((scope='ACCOUNT')=(scope_ref IS NULL)); ventana NULL o par completo ordenado. Cada trío de fuente es completo o NULL. Cada dimensión aplica a esa cuenta/targets según contrato §4.1. Son entradas históricas; el único resultado por cuenta sigue siendo plan_simulation_quota del padre, sin duplicar saldo.

## 3. Fold, integridad y reconstrucción

Header, hijas y el resultado plan_simulation_quota se materializan del mismo
PLAN_SIMULATION_RECORDED con la transacción de [streams §4.1](../../streams/index.md#41-publicación-de-reportes-derivados).
El fold verifica los agregados del header contra sus nodos, racionales y
calendarios: no son autoridades independientes. Cada pin se comprueba al
vector histórico, no contra latest. Corrección de uso/precio o nuevo corte
produce otro reporte, nunca reescritura histórica.

La política, la selección completa de muestras/dimensiones, sus nulidades y los
negativos están en el [contrato](../../../contracts/estimation/index.md) y los
[algoritmos](../../../contracts/estimation/algorithms/index.md). Estas tablas no
ejecutan SQL sobre objetos JSON del evento. UNKNOWN conserva evidencia y
ausencia; la reconstrucción no llena ceros ni consulta cuotas móviles.
