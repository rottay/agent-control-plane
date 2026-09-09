# Desempeño: diccionario físico

Dueño: [economy](../index.md) §7. **Nuevo.** Fuente registry_events,
document_kind MODEL_PERFORMANCE. Política/cohorte/DTO:
[estimación](../../../contracts/estimation/index.md); algoritmo E9 y Wilson:
[algoritmos §6](../../../contracts/estimation/algorithms/index.md#6-e9-desempeño-observacional-reproducible).
Publicación/OCC/rebuild común: [streams §4.1](../../streams/index.md#41-publicación-de-reportes-derivados).

**Medida fija: EQUIVALENT.** Costo por aceptado y retrabajo usan los racionales
de [economy §4](../index.md#4-costo-snapshot-líneas-exactas-y-cabezas-de-origen),
no gasto REAL, caja, cargos de suscripción o suma de headers ya redondeados.
Datos de cuentas/modelos/precios/uso siguen en sus dueños; no otro registry.

## 1. model_performance_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `performance_id` | TEXT | NOT NULL | PK opaca asignada una sola vez por request_sha256. |
| `request_sha256` | TEXT | NOT NULL | UNIQUE; preimagen incluye sourceHeads. |
| `report_sha256` | TEXT | NOT NULL | UNIQUE; salida completa verificada. |
| `model_version_id` | TEXT | NOT NULL | Referencia al registry único de accounts. |
| `role` | TEXT | NOT NULL | Vocabulario Role dueño; no columna de PK repetida en hijos. |
| `classification_sha256` | TEXT | NOT NULL | — |
| `verification_policy_sha256` | TEXT | NOT NULL | — |
| `transport_kind` | TEXT | NOT NULL | — |
| `currency` | TEXT | NOT NULL | — |
| `as_of` | TEXT | NOT NULL | Corte semántico explícito. |
| `window_start_at` | TEXT | NOT NULL | as_of-policy.windowSeconds. |
| `window_end_at` | TEXT | NOT NULL | Igual a as_of; ventana histórica. |
| `policy_document_id` | TEXT | NOT NULL | — |
| `policy_version` | INTEGER | NOT NULL | CHECK>=1. |
| `policy_sha256` | TEXT | NOT NULL | — |
| `tasks_total` | INTEGER | NOT NULL | CHECK>=0. |
| `accepted` | INTEGER | NOT NULL | CHECK>=0. |
| `rejected` | INTEGER | NOT NULL | CHECK>=0. |
| `unjudged` | INTEGER | NOT NULL | CHECK>=0. |
| `quality_status` | TEXT | NOT NULL | CHECK IN ('ESTIMATED','UNKNOWN'). |
| `quality_reason` | TEXT | NULL | UnknownReason; presente sii quality_status UNKNOWN. |
| `acceptance_ppm` | INTEGER | NULL | CHECK NULL o entre 0 y 1000000; NULL sii quality_status UNKNOWN. |
| `acceptance_low_ppm` | INTEGER | NULL | CHECK NULL o entre 0 y 1000000; NULL sii quality_status UNKNOWN. |
| `acceptance_high_ppm` | INTEGER | NULL | CHECK NULL o entre 0 y 1000000; NULL sii quality_status UNKNOWN. |
| `valuation_status` | TEXT | NOT NULL | CHECK IN ('VALUED','PRICE_MISSING','USAGE_UNKNOWN','EXTERNAL'); sólo EQUIVALENT y precedencia de economy §4. |
| `cost_estimate_status` | TEXT | NOT NULL | CHECK IN ('ESTIMATED','UNKNOWN'). |
| `cost_estimate_reason` | TEXT | NULL | UnknownReason; presente sii el status correspondiente es UNKNOWN. |
| `rework_status` | TEXT | NOT NULL | CHECK IN ('ESTIMATED','UNKNOWN'). |
| `rework_reason` | TEXT | NULL | UnknownReason; presente sii el status correspondiente es UNKNOWN. |
| `duration_status` | TEXT | NOT NULL | CHECK IN ('ESTIMATED','UNKNOWN'). |
| `duration_reason` | TEXT | NULL | UnknownReason; presente sii el status correspondiente es UNKNOWN. |
| `cost_per_accepted_nanos` | INTEGER | NULL | No negativo; presente sii accepted>0 AND valuation_status VALUED AND cost_estimate_status ESTIMATED. |
| `rework_cost_nanos` | INTEGER | NULL | No negativo; presente sii valuation_status VALUED AND rework_status ESTIMATED. |
| `duration_sample_count` | INTEGER | NOT NULL | CHECK>=0; duraciones completas seleccionadas. |
| `median_seconds` | INTEGER | NULL | No negativo; presente sii duration_status ESTIMATED, no sólo porque n>0. |
| `publication_sequence` | INTEGER | NOT NULL | CHECK>0; evento MODEL_PERFORMANCE en registry_events, no vector. |

PK(performance_id); UNIQUE(request_sha256); UNIQUE(report_sha256).
INDEX ix_model_performance_read_model__cohort(model_version_id,role,classification_sha256,
verification_policy_sha256,transport_kind,currency,as_of,policy_sha256), **no único**.
Dos sourceHeads diferentes con la misma cohorte/asOf/policy son dos requests y
snapshots distintos; request_sha256 es su identidad idempotente.

CHECK(tasks_total=accepted+rejected+unjudged).
CHECK(window_start_at<window_end_at AND window_end_at=as_of).
Para cada status/reason: reason está presente sii status UNKNOWN.
Las tres cifras de calidad son NULL sii quality_status UNKNOWN; presentes
cumplen acceptance_low_ppm<=acceptance_ppm<=acceptance_high_ppm.
CHECK(((accepted>0 AND valuation_status='VALUED' AND cost_estimate_status='ESTIMATED')
  = (cost_per_accepted_nanos IS NOT NULL)) IS TRUE).
CHECK(((valuation_status='VALUED' AND rework_status='ESTIMATED')
  = (rework_cost_nanos IS NOT NULL)) IS TRUE).
CHECK((duration_status='ESTIMATED')=(median_seconds IS NOT NULL)).
Los valores estadísticos exigen muestra y frescura del contrato, no sólo
duration_sample_count>0. Estado de muestra y estado de valuación son distintos:
SAMPLE_SMALL no es un precio ni otro estado de valoración.

El header materializa filas de métricas del mismo evento; el fold comprueba
igualdad, no crea una segunda autoridad. Ratios monetarios usan suma racional
de todos los efectos seleccionados, incluidos fallos/rechazos, dividida por
accepted según contrato; cero aceptados no produce división ni importe.

## 2. Hijas

Las columnas no marcadas NULL son NOT NULL. Todos los hijos referencian
performance_id: la identidad descriptiva de cohorte no se repite.
Tipos/decimal/NULL y CHECK cerrados siguen el contrato strict; INTEGER es int64
y los racionales TEXT BigInt reducidos con denominador positivo.
Referencias de otras cohortes se validan tipadamente contra sourceHeads.

### 2.1 model_performance_source_head_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `performance_id` | TEXT | NOT NULL | — |
| `source_stream` | TEXT | NOT NULL | CHECK IN ('control_plane_events','account_events','registry_events'). |
| `source_sequence` | INTEGER | NOT NULL | CHECK>=0; cabeza incluida. |
| `source_sha256` | TEXT | NOT NULL | Hash de esa cabeza, génesis según maestro. |

PK(performance_id,source_stream); FK(performance_id) al header.
El vector precede a publication_sequence; su propia publicación no es fuente.
No computed_through_sequence escalar presentado como vector.

### 2.2 performance_metric_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `performance_id` | TEXT | NOT NULL | — |
| `metric` | TEXT | NOT NULL | CHECK IN ('TOTAL_TOKENS','WORK_SECONDS','EQUIVALENT_COST_NANOS','COST_PER_ACCEPTED','REWORK_COST','QUALITY'). |
| `status` | TEXT | NOT NULL | CHECK IN ('KNOWN','ESTIMATED','UNKNOWN'); KNOWN sólo el cero estructural permitido por contrato, no inferencia. |
| `reason` | TEXT | NULL | UnknownReason; presente sii UNKNOWN. |
| `low_value` | INTEGER | NULL | NULL sii UNKNOWN; no negativo, QUALITY usa ppm 0..1000000. |
| `point_value` | INTEGER | NULL | NULL sii UNKNOWN; no negativo, QUALITY usa ppm 0..1000000. |
| `high_value` | INTEGER | NULL | NULL sii UNKNOWN; no negativo, QUALITY usa ppm 0..1000000. |
| `low_numerator` | TEXT | NULL | Sólo métricas monetarias; decimal canónico no negativo. |
| `low_denominator` | TEXT | NULL | Decimal canónico positivo, misma nulidad. |
| `point_numerator` | TEXT | NULL | Sólo métricas monetarias; decimal canónico no negativo. |
| `point_denominator` | TEXT | NULL | Decimal canónico positivo, misma nulidad. |
| `high_numerator` | TEXT | NULL | Sólo métricas monetarias; decimal canónico no negativo. |
| `high_denominator` | TEXT | NULL | Decimal canónico positivo, misma nulidad. |
| `selected_count` | INTEGER | NOT NULL | CHECK>=0. |
| `eligible_count` | INTEGER | NOT NULL | CHECK>=0. |
| `unknown_count` | INTEGER | NOT NULL | CHECK>=0. |
| `excluded_outcome_count` | INTEGER | NOT NULL | CHECK>=0. |
| `oldest_eligible_at` | TEXT | NULL | NULL sii eligible_count=0. |
| `newest_eligible_at` | TEXT | NULL | Misma nulidad que oldest. |

PK(performance_id,metric); FK(performance_id) al header.
CHECK(selected_count=eligible_count+unknown_count+excluded_outcome_count).
Valores presentes ordenados low<=point<=high; sus tres nulidades coinciden con
UNKNOWN y reason. En las tres métricas monetarias las seis columnas racionales
están presentes sii valores presentes; otras métricas tienen seis NULL.
Montos enteros = HALF_TO_EVEN del racional una vez, no input de una suma.
QUALITY es el Wilson outward ppm del contrato, nunca costo ni unidades mixtas.
COST_PER_ACCEPTED y REWORK_COST tienen racionales low=point=high del estadístico
exacto histórico; ese intervalo degenerado no garantiza gasto futuro.

### 2.3 performance_sample_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `performance_id` | TEXT | NOT NULL | — |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | CHECK>=1. |
| `finalization_sequence` | INTEGER | NOT NULL | CHECK>0; hecho terminal exacto al corte. |
| `envelope_sha256` | TEXT | NOT NULL | — |
| `receipt_sha256` | TEXT | NULL | Recibo exacto si disponible. |
| `audit_id` | TEXT | NULL | Veredicto exacto si disponible. |

PK(performance_id,task_id,revision_number); FK(performance_id) al header.
ALL_FINAL del contrato: sin node_key ni inclusion. Muestra incompleta para una
métrica permanece representada, no se elimina para aparentar cobertura.

### 2.4 performance_sample_effect_read_model

| Columna | Tipo | Nullable | Semántica |
| --- | --- | --- | --- |
| `performance_id` | TEXT | NOT NULL | — |
| `task_id` | TEXT | NOT NULL | — |
| `revision_number` | INTEGER | NOT NULL | CHECK>=1. |
| `effect_id` | TEXT | NOT NULL | — |
| `settlement_revision` | INTEGER | NULL | CHECK NULL o >=1; revisión exacta al corte. |
| `valuation_revision` | INTEGER | NULL | CHECK NULL o >=1; currency del header. |

PK(performance_id,task_id,revision_number,effect_id);
FK(performance_id,task_id,revision_number) a performance_sample_read_model.
Referencia settlement=(effect_id,settlement_revision);
costo=(effect_id,currency,valuation_revision) del mismo corte.
Sin fuente se conserva effect_id y revisión NULL; no se duplica el efecto por
dispatch/handoff. Valores, observaciones y pines de precio permanecen en economy
§§1–4. La revisión de costo fija sus líneas y source_settlement_revision.

## 3. Fuente y reconstrucción

MODEL_PERFORMANCE registra el request/result strict, política, vector y pines de
muestras/efectos; sourceHeads no cambia tras publicación. El protocolo común de
[streams §4.1](../../streams/index.md#41-publicación-de-reportes-derivados) publica
header, hijas y watermark juntos y conserva cortes anteriores.
El rebuild no consulta latest, asigna modelos no observables ni recalcula
intervalos con defaults distintos. Una corrección tardía produce request hash
nuevo, otro performance_id y otro evento, preservando ambos replays.
