# Estimación: política, fuentes y contrato V1

Diseño adjudicado de simulación, pronóstico y desempeño. Dueños: planning y economy; registro de modelos único en accounts. Algoritmos en [algorithms](algorithms/index.md); diccionario en [planning](../../database/planning/index.md) §11 y [economy](../../database/economy/index.md) §7. No ejecución, probes ni escrituras por un dry-run.

## 1. Frontera y responsables

Economy posee muestra, cuantiles y valuación; planning consume su estimador por
un puerto e interpreta el DAG. Tipos en types/, validación en schema/, valores
en vocabulary/, algoritmos en policy/; test/ replica el árbol. No se añade paquete,
DSL, registry ni scheduler operativo para calcular una simulación.

El pronóstico V1 es condicional a finalizar el lifecycle aceptado, sin nuevo
alcance ni espera humana desconocida. No garantiza fechas, futuros precios,
calidad, presupuesto duro o revisiones ilimitadas. Los parámetros del perfil
son inputs versionados obligatorios: ausencia no habilita defaults tácitos.
El consumo ya ocurrido y las limitaciones se muestran por separado.

## 2. Política V1: algoritmo elegido, parámetros obligatorios

`EstimationPolicyV1` tiene exactamente:

```text
{
  version: 1,
  algorithm: "EMPIRICAL_SCENARIO_V1",
  minimumSamples: integer,
  maximumSamples: integer,
  windowSeconds: integer,
  freshnessSeconds: integer,
  quotaFreshnessSeconds: integer,
  lowerQuantile: { numerator: integer, denominator: integer },
  pointQuantile: { numerator: integer, denominator: integer },
  upperQuantile: { numerator: integer, denominator: integer },
  minimumResidualSamples: integer,
  workStates: TaskStateV2[],
  qualityMinimumSamples: integer,
  wilsonZ: { numerator: integer, denominator: integer }
}
```

Sin claves extra, valores opcionales ni defaults. Los enteros son seguros
JSON; 1 <= minimumSamples <= maximumSamples <= 1000000;
1 <= minimumResidualSamples <= maximumSamples;
1 <= qualityMinimumSamples <= maximumSamples;
1 <= freshnessSeconds <= windowSeconds <= 315576000.
1 <= quotaFreshnessSeconds <= 315576000; es frescura de observaciones de cuota,
no tamaño de muestra estadística.
Cada cuantíl usa 0 <= numerator <= denominator <= 1000000, denominator > 0;
comparación racional exacta exige lower < point < upper.
Wilson exige 0 < numerator/denominator <= 10 y ambos enteros 1..1000000.
Los límites son de representación/cálculo, no valores de producto recomendados.

workStates es conjunto no vacío ordenado sin duplicados, subconjunto de los
estados de trabajo V2 RUNNING, VERIFYING, AUDITING. Seleccionar esos estados
define tiempo activo y su cobertura; READY/esperas/terminales no son trabajo.
La política no remapea estados LEGACY. Un perfil inválido rechaza POLICY_INVALID;
perfil ausente produce POLICY_MISSING sin estimaciones, no un perfil inventado.

El registro fija documentId/version/documentSha256 y el consumidor verifica
que algorithm/version sean implementados. Las cifras de producto las decide
el perfil autorizado; el implementador no elige un percentil, ventana o z.

## 3. Fuentes, unidad y primitiva compartida con H-9

### 3.1 Corte y cohorte

Head = { stream, sequence, sha256 }, usando el contrato de cabezas del maestro,
con stream en control_plane_events, initiative_events, account_events,
registry_events. Vector ordenado por stream, sin duplicados; secuencia/hash
cero siguen el caso génesis canónico. Deben incluirse los streams efectivamente
leídos. No confundir el vector con la secuencia del evento que publique un reporte.

CohortV1 = {
modelVersionId, role, classificationSha256, verificationPolicySha256,
transportKind
}. Todos son valores del schema dueño, no strings libres para inventar modelos.
classificationSha256 = SHA256(UTF8(JCS(["ACP_ESTIMATION_CLASSIFICATION",1,
envelope.classification]))), sobre la clasificación existente validada por su
schema dueño; no crea clasificación ni modifica la preimagen del envelope.
verificationPolicySha256 es el policy_sha256 de un recibo de verificación
válido de execution §10.2. El candidato debe declarar la política de verificación
que espera usar; si no tiene pin, su cohorte es desconocida. Una moneda se añade
a la identidad de la métrica monetaria, no a tokens/duración/calidad.
No fallback silencioso de modelo, rol, clasificación, política o transporte.

La unidad es una revisión finalizada de tarea: (task_id, revision_number).
Se incluyen sus efectos lógicos únicos a través de todos sus intentos; no una
muestra por retry, stream de usage o dispatch. Handoff/replay no duplican gasto.
Los efectos de otra tarea (p.ej. un auditor independiente) se cuentan en su tarea
y nodo propios del grafo; no otra vez como gasto del productor.

Se usa la revisión, envelope autorizado, estados/eventos V2, recibos de
verificación, veredictos independientes de audit y las revisiones de settlement/
cost ya existentes, a las cabezas fijadas. No eval sintético ni prueba fake
acredita muestra REAL. El sujeto actual se excluye por task_id entero, no sólo
por su revisión, para no entrenar el cálculo con su mismo trabajo restaurado.

Atribución: los segmentos productores de esa revisión deben tener un único
modelo resuelto, rol y transporte coherentes con CohortV1. Un cambio a otro
modelo/transporte o una contribución no atribuible excluye esa revisión de la
cohorte; no adjudica todo el costo/calidad al último modelo. Un modelo
NOT_OBSERVABLE puede ejecutar, pero no llena una fila de una versión inventada.

Primero seleccionar finalizaciones en [asOf - windowSeconds, asOf], a las
cabezas fijadas; excluir sujeto, synthetic, legacy sin evidencia V2 y atribución
ambigua. Orden de recencia: finalizedAt DESC, finalizationSequence DESC,
taskId ASC, revisionNumber ASC. Conservar las primeras maximumSamples.
Después aplicar elegibilidad por métrica: no ampliar la ventana ni buscar
muestras más antiguas para ocultar datos desconocidos. Desempates de cuantiles
por taskId y revisionNumber. No usar publication_at como fecha de muestra.

### 3.2 Elegibilidad y métricas

| Métrica neutral | Fuente y fórmula por revisión |
| --- | --- |
| total_tokens | Suma de input + output + cache_write + cache_read de todos los efectos únicos. Settlement FINAL y fuentes efectivas PROVIDER_AUTHORITATIVE o WRAPPER_MEASURED; ESTIMATE/PARTIAL/UNKNOWN/DISPUTED no constituyen medición completa. Las cuatro clases son excluyentes según economy §1. |
| equivalent_cost_nanos | Suma racional exacta de líneas EQUIVALENT, usando una valuation_revision explícita por efecto/moneda y su source_settlement_revision. Todas VALUED. No REAL, fee de suscripción, FX ni suma de headers redondeados. |
| active_work_seconds | Unión de intervalos [entrada,salida) de los estados V2 seleccionados, en todos los intentos de la revisión. Sumar milisegundos de la unión y convertir una vez con ceil(ms/1000). Intervalo abierto, timestamp inválido/decreciente o transición sin cierre hace desconocida la duración. |
| quality_acceptance | Un veredicto independiente vigente a ese corte por revisión, respaldado por el recibo válido. ACCEPT y ACCEPT_WITH_CORRECTIONS cuentan aceptados; REJECT rechazado. Una cancelación/fallo sin veredicto no se inventa como rechazo. |

Para A15/D14/E8 las distribuciones de trabajo restante usan sólo revisiones
aceptadas: estiman completar el lifecycle bajo el alcance/validación declarados.
Incluyen intentos fallidos/retrabajo dentro de esas revisiones aceptadas.
Se publica el conteo de rechazadas/no decididas excluidas y la condición
«finalización aceptada, sin nuevo alcance, sin espera humana no fijada».
No predicen intentos/revisiones futuras ilimitados ni esconden su riesgo.
Los consumos reales ya ocurridos del sujeto incluyen también sus fallos,
cancelaciones y retries; se presentan separados, no se borran para mostrar
sólo el costo del camino exitoso.

E9 usa todas las revisiones seleccionadas y distingue total, decididas y
aceptadas. H-9 puede reutilizar ALL_FINAL con su filtro de anomalía; es un
consumidor de la misma selección/cuántiles, no otra política estadística.

Cada métrica publica selectedCount, eligibleCount, unknownCount y
excludedOutcomeCount; son una partición de las seleccionadas. Si n < mínimo,
UNKNOWN/INSUFFICIENT_SAMPLE. Si asOf - newestEligibleAt > freshnessSeconds,
UNKNOWN/STALE_SAMPLE. No un número acompañado únicamente por un asterisco.
Cuando n es insuficiente se conservan conteos y fechas, no valores estimados.

### 3.3 Cuantil exacto

`upperRankQuantile(values, p, q)`: ordenar ascendente por valor exacto;
n=0 no da valor; índice zero-based = min(n-1, floor(n*p/q)).
Comparar racionales por multiplicación cruzada BigInt, no por double.
p/q=1/2 da mediana superior. Los parámetros lower/point/upper producen un
rango de escenarios, no una probabilidad conjunta ni cobertura calibrada.

Para tokens restantes se calculan las cuatro clases con esa misma muestra
completa; total de cada escenario = suma de sus cuatro clases. No calcular
un total independiente que contradiga las clases.
Cada monto se reduce a racional canónico numerator/denominator (gcd=1,
denominator positivo; cero = 0/1). Sólo la salida entera se redondea
HALF_TO_EVEN, una vez tras sumar; overflow int64 rechaza RANGE_EXCEEDED.

## 4. Entrada/salida estrictas, sin caja negra Row(tabla)

Notación de contrato, no interfaces intercaladas con implementación.
Todos los objetos son strict, todas las claves enumeradas son obligatorias.
Las uniones se discriminan; no undefined ni extras. Id/Sha/Role/Transport/State
reutilizan su schema dueño. Int = cadena decimal canónica no negativa int64;
SignedInt permite signo sólo para deltas; Rat = { numerator: SignedInt,
denominator: Int positiva }, reducido; los límites intermedios usan BigInt.

```text
Pin = { documentId: Id, version: integer>=1, sha256: Sha }
Revision = { taskId: Id, revisionNumber: integer>=1, envelopeSha256: Sha }
Target = {
  modelVersionId: Id, role: Role, classificationSha256: Sha,
  verificationPolicySha256: Sha, accountId: Id, transportKind: Transport
}
Demand = { resourceClass: Id, units: integer>=1 }
Node = {
  nodeKey: Id, revision: Revision|null, target: Target|null,
  predecessors: Id[], demands: Demand[],
  progress: "PENDING"|"RUNNING"|"COMPLETE"|"BLOCKED",
  releaseOffsetSeconds: Int|null,
  elapsedWorkSeconds: Int|null,
  observedTokenFloor: { input: Int, output: Int,
                       cacheWrite: Int, cacheRead: Int }|null
}
Capacity = { resourceClass: Id, slots: [
  { slotKey: Id, availableOffsetSeconds: Int|null }
] }
PricePin = {
  nodeKey: Id, tokenClass: "input"|"output"|"cache_write"|"cache_read",
  catalog: Pin, provider: Id, modelVersionId: Id,
  transportKind: Transport, currency: Currency, effectiveFrom: Timestamp
}
Request = {
  version: 1, kind: "SIMULATION"|"FORECAST"|"WHAT_IF",
  scope: { kind: "INITIATIVE"|"STEP", id: Id },
  plan: { planId: Id, planSha256: Sha, graphRevisionId: Id },
  asOf: Timestamp, policy: Pin, sourceHeads: Head[],
  currency: Currency, measure: "EQUIVALENT",
  baselineReportSha256: Sha|null,
  nodes: Node[], capacities: Capacity[], prices: PricePin[],
  quotaDimensions: QuotaDimension[]
}
UnknownReason =
  "POLICY_MISSING"|"SOURCE_UNAVAILABLE"|"ATTRIBUTION_UNKNOWN"|
  "INSUFFICIENT_SAMPLE"|"STALE_SAMPLE"|"USAGE_UNKNOWN"|"PRICE_MISSING"|
  "RESIDUAL_UNSUPPORTED"|"RELEASE_UNKNOWN"|"CAPACITY_UNKNOWN"|
  "DEPENDENCY_BLOCKED"|"OUTCOME_NOT_DECIDED"|"QUOTA_STALE"|
  "QUOTA_WINDOW_UNKNOWN"|"QUOTA_WINDOW_CROSSED"
Evidence = {
  selectedCount: integer>=0, eligibleCount: integer>=0,
  unknownCount: integer>=0, excludedOutcomeCount: integer>=0,
  oldestEligibleAt: Timestamp|null, newestEligibleAt: Timestamp|null
}
Estimate = {
  status: "KNOWN"|"ESTIMATED"|"UNKNOWN",
  low: Int|null, point: Int|null, high: Int|null,
  reason: UnknownReason|null, evidence: Evidence
}
MoneyEstimate = {
  status: "KNOWN"|"ESTIMATED"|"UNKNOWN",
  lowExact: Rat|null, pointExact: Rat|null, highExact: Rat|null,
  lowNanos: Int|null, pointNanos: Int|null, highNanos: Int|null,
  reason: UnknownReason|null, evidence: Evidence
}
Schedule = {
  scenario: "LOW"|"POINT"|"HIGH",
  startOffsetSeconds: Int|null, finishOffsetSeconds: Int|null,
  slots: { resourceClass: Id, slotKey: Id }[],
  reason: UnknownReason|null
}
NodeResult = {
  nodeKey: Id,
  tokenClasses: { tokenClass, estimate: Estimate }[],
  tokens: Estimate, workSeconds: Estimate, cost: MoneyEstimate,
  schedules: Schedule[]
}
Report = {
  version: 1, requestSha256: Sha, reportSha256: Sha,
  kind: "SIMULATION"|"FORECAST"|"WHAT_IF",
  evidenceKind: "HYPOTHETICAL", intervalKind: "SCENARIO_ENVELOPE",
  asOf: Timestamp, policy: Pin, sourceHeads: Head[],
  currency: Currency, measure: "EQUIVALENT",
  baselineReportSha256: Sha|null,
  nodes: NodeResult[], remainingTokens: Estimate,
  remainingCost: MoneyEstimate, remainingSeconds: Estimate,
  finishAt: { low: Timestamp|null, point: Timestamp|null,
              high: Timestamp|null, reason: UnknownReason|null },
  reachesReset: boolean|null,
  resetStatus: "KNOWN"|"ESTIMATED"|"UNKNOWN",
  quota: QuotaResult[],
  diagnostics: { nodeKey: Id|null, code: UnknownReason }[]
}
```

TokenClass en tokenClasses es la misma unión cerrada de PricePin; exactamente
cuatro filas, orden input/output/cache_write/cache_read. Report.nodes conserva
el conjunto de Request.nodes ordenado por nodeKey. Schedule son exactamente
LOW/POINT/HIGH en ese orden. Nodes/edges/resourceClasses/slotKeys/price keys
se ordenan lexicográficamente por puntos de código y no admiten duplicados.
Un mismo resourceClass denota igualdad semántica de capacidad, no una ruta,
PID, cuenta secreta o dirección de infraestructura.

UNKNOWN exige todos los valores NULL y reason presente; otro estado exige todos
presentes, reason NULL y low<=point<=high. KNOWN sólo proviene de ausencia
estructural de trabajo demostrada y tiene low=point=high=0; toda inferencia
de historial es ESTIMATED, aunque los cuantiles coincidan.
Evidence fechas ambas NULL sii eligibleCount=0. Para un agregado de nodos se
suman los cuatro conteos (exposiciones nodo/muestra, no tareas únicas globales)
y se toma min(oldest)/max(newest) entre nodos con elegibles. Un nodo COMPLETE
tiene conteos cero y fechas NULL. Cada nodo determina por sí solo suficiencia:
sumar muestras de varias cohortes nunca salva una cohorte insuficiente.
ReachesReset es NULL sii resetStatus UNKNOWN; consume las fuentes de cuota
fijadas por planning §11.2, no crea otra observación o saldo.

COMPLETE exige una revisión existente completada según dependencia/contrato
a ese corte. No basta state legacy terminal. PENDING tiene elapsed/floor NULL;
RUNNING exige elapsedWorkSeconds conocido para duración residual; si no se
reconstruye, se admite NULL y sólo esa métrica es UNKNOWN.
releaseOffsetSeconds=NULL expresa aprobación/espera sin liberación conocida,
no «inmediato». Offsets se miden desde asOf, nunca negativos. Capacity sin
slots es capacidad cero; cualquier slot con disponibilidad NULL hace desconocido
el calendario de los nodos que requieren esa resourceClass (no se adivina su
liberación). Todo demand debe referir una Capacity declarada.
Se valida Target frente al registry/capabilities al corte, preservando
CONFIRMED/UNKNOWN/REFUSED y SUPPORTED/UNSUPPORTED de sus dueños: este DTO no
inventa una tercera capacidad del driver. Capacidad faltante genera diagnóstico;
no se invoca el adapter para averiguarla.

PricePin referencia la PK completa del intervalo de economy §3, incluyendo
tokenClass/currency. Su catálogo es fijo, no «vigente cuando corra».
Precios por clase faltantes dejan el costo UNKNOWN/PRICE_MISSING; no impiden
tokens/duración. Son supuestos hipotéticos al instante fijado de la solicitud,
no pines de un gasto todavía inexistente ni garantía sobre precios futuros.
Validar effectiveFrom <= asOf < effectiveTo del intervalo fijado; un catálogo
no contiene por eso solo precios válidos para cualquier fecha futura.

Diagnostics se deduplica y ordena por (nodeKey NULL primero, code) en puntos de
código. Si hay varias razones para una métrica, reason es la primera según el
orden de UnknownReason enumerado arriba; diagnostics conserva todas. Las
validaciones de integridad/schema rechazan antes de calcular, no se esconden
como incertidumbre estadística.

Hash de Request = SHA256(UTF8(JCS(["ACP_ESTIMATE_REQUEST",1,Request]))).
Hash de Report = SHA256(UTF8(JCS(["ACP_ESTIMATE_REPORT",1,Report sin reportSha256]))).
JCS es la serialización canónica ya dueña del contrato, no otro serializador.
Report incluye requestSha256, por lo que no repite el Request entero. El reporte
no cambia preimágenes de envelope, effect_id ni invocation. La entrada se
obtiene de una revisión del plan y overrides explícitos, no del estado mutable.

### 4.1 Cuota V1: dimensión explícita, resta y reset

ObservationPin = { observationId:Id, accountSequence:integer>0,
accountSha256:Sha }. QuotaDimension = {
accountId:Id, scope:"ACCOUNT"|"MODEL"|"TRANSPORT", scopeRef:Id|null,
windowStart:Timestamp|null, windowEnd:Timestamp|null,
metric:"TOKENS"|"USAGE_LIMIT_TOKENS", unit:"TOKENS",
remainingSource:ObservationPin|null, resetSource:ObservationPin|null
}. ScopeRef NULL sii ACCOUNT; ventana ambos NULL o par ordenado completo.
QuotaResult = { accountId:Id, estimatedTokensRemaining:Int|null,
status:"KNOWN"|"ESTIMATED"|"UNKNOWN", reason:UnknownReason|null,
sourceMetric:"TOKENS"|"USAGE_LIMIT_TOKENS"|null,
source:ObservationPin|null }. Array una fila por cuenta demandada, ordenada.
El sourceMetric/source son ambos NULL o ambos presentes y mapean directamente
al quartet B5, no otra autoridad. UNKNOWN exige valor NULL; fuente ausente
exige UNKNOWN. Conservar fuente UNKNOWN cuando existe.

Construcción de quotaDimensions: al corte de account_events, enumerar para
cada cuenta demandada todas las ventanas que contienen asOf y las señales con
ventana desconocida aplicables a ACCOUNT, MODEL usado o TRANSPORT usado.
Dentro de cada (cuenta,scope,scopeRef,ventana,metric,unit), seleccionar la fila
completa de mayor (observed_at,sequence), igual que accounts §3, nunca la última
KNOWN saltando una UNKNOWN reciente. Para cada dimensión elegir también la
última observación RESET de esa misma cuenta/scope/scopeRef/ventana a ese corte;
no inferir reset_at de windowEnd. Request registra ambos pines, no sus valores
copiados. Si no hay ninguna dimensión token aplicable a una cuenta, registrar
un placeholder ACCOUNT/NULL/ventanaNULL/metricTOKENS con fuentes NULL.
Ventanas fuera de asOf se excluyen; una señal sin ventana permanece UNKNOWN.
Validar que el array coincida con esa enumeración; omitir una dimensión
limitante, añadir duplicados o apuntar a otra cuenta es REQUEST_INVALID.

Para cada dimensión, leer remaining_value/remaining_status de su fila
quota_observation_metric exacta, no derivar de limit-observed ni de requests.
Si falta fuente/valor, UNKNOWN; si asOf-observedAt > quotaFreshnessSeconds,
QUOTA_STALE; si ventana es NULL, QUOTA_WINDOW_UNKNOWN. Seleccionar nodos cuyo
target cuenta/scope coincide; demanda D es suma de remainingTokens.point.
Si cualquier demanda es UNKNOWN, el residual es UNKNOWN. Si sus calendarios
POINT no prueban que terminan antes de windowEnd, residual UNKNOWN:
QUOTA_WINDOW_CROSSED si se conoce el cruce, otra razón de calendario si no.
No repartir tokens de un nodo entre dos ventanas ni acreditar recargas futuras.
En otro caso residual=max(0,remaining_value-D); ESTIMATED cuando D proviene de
estimación, o cuando fuente es ESTIMATED; KNOWN sólo si D=0 estructural y
fuente KNOWN. Nunca es autorización de cuota ni hard cap de gasto.

Reducir a una fila B5 por cuenta: si alguna dimensión es UNKNOWN, cuenta
UNKNOWN; elegir su fuente por menor clave lexicográfica canónica de dimensión.
Si todas son conocidas/estimadas, elegir mínimo residual (no sumarlas), empate
por esa misma clave. El resultado/status y quartet conservan la dimensión
elegida; el evento también conserva todas las dimensiones usadas. Sus status
no se cambian con observaciones nuevas al reconstruir.

Para reachesReset considerar cada dimensión aplicable a los nodos pendientes:
un cruce probado existe si resetSource conocida/estimada, fresca, con reset_at
>asOf y el finish POINT de esos nodos >=reset_at. TRUE si existe ese testigo,
aun si otra dimensión es UNKNOWN. FALSE sólo si para todas las dimensiones
hay reset y calendario conocido que prueban no cruce. Si no hay testigo y
falta cobertura, UNKNOWN/NULL. TRUE/FALSE es ESTIMATED cuando tiempos/reset lo
son; KNOWN sólo para grafo vacío (FALSE) o evidencia totalmente estructural.
No extrapolar periodicidad de un único reset pasado ni usar reloj del rebuild.
