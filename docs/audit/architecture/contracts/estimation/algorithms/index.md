# Estimación: algoritmos, replay y pruebas

Los DTOs, parámetros y primitivas §§2–4 tienen un único dueño en [contrato de estimación](../index.md). Esta hoja no redefine cohortes, registro, dinero, cuotas ni estados. Referencias §3/§4/§4.1 abajo apuntan a ese contrato; §5/§6/§8 apuntan a esta hoja.

## 5. Algoritmos A15, D14 y E8

### 5.1 Simulación y calendario

1. Cargar los documentos/revisiones autorizados y verificar cabezas, hashes,
   política y schema en una única lectura consistente. Referencia rota o hash
   conflictivo rechaza SOURCE_INTEGRITY; fuente legítimamente ausente produce
   UNKNOWN. Validar nodos/aristas/targets/capacidades; ciclo, referencia ausente
   o demanda > slots declarados rechaza REQUEST_INVALID, no un plan ejecutable.
2. Por nodo no COMPLETE seleccionar cohorte (§3) y estimar las cuatro clases de
   tokens y trabajo activo. Métricas son independientes: precio faltante no
   elimina una duración conocida. COMPLETE devuelve cero restante demostrado.
   BLOCKED por dependencia fallida sin continuación aprobada deja finalización
   UNKNOWN/DEPENDENCY_BLOCKED, no una tarea terminada con costo cero.
3. Valuar por escenario: para cada clase, qTokens * pricePerMillionNanos / 1000000
   con el PricePin de esa clase. Sumar racionales por nodo y por grafo.
   No sumar importes redondeados de nodos. El costo equivalente de una CLI
   con uso desconocido sigue UNKNOWN; nunca se promete límite monetario duro.
4. Ejecutar tres calendarios no preemptivos independientes usando duración
   LOW/POINT/HIGH. Inicializar disponibilidad de cada slot al offset declarado.
   Para cada nodo listo (predecesores ya calendariados), earliest =
   max(releaseOffset, finishes de predecesores, k-ésima menor disponibilidad
   de slots por cada resourceClass demandada). k es la demanda de esa clase.
   Elegir el nodo con menor earliest, desempatar por nodeKey. Elegir para cada
   clase los k slots con menor (disponibilidad,slotKey), asignar start=earliest,
   finish=start+duración y actualizar esas disponibilidades a finish.
   Nodos sin demanda no consumen slots. COMPLETE tiene finish=0 y no se agenda.
   Antes de agendar, formar la clausura de incertidumbre: desde cada nodo con
   release/duración/capacidad desconocida o BLOCKED, añadir descendientes y
   nodos que comparten cualquier resourceClass; repetir ambas reglas hasta
   punto fijo. Esa clausura tiene calendario UNKNOWN; sólo los componentes
   realmente independientes se agendan. No se saltan trabajos desconocidos
   para atribuir su slot a otro nodo. Esto no contamina tokens/costo conocidos.
5. remainingSeconds de cada escenario es max(finish) de todos los nodos;
   finishAt=asOf+remainingSeconds. Si cualquier nodo necesario es desconocido,
   el agregado y sus fechas son UNKNOWN, aunque haya otros nodos calculables.
   RemainingTokens/Cost requieren que todos sus nodos sean conocidos.
   Las partes conocidas permanecen por nodo; no se etiquetan como total.
6. No suponer monotonicidad del algoritmo de lista al cambiar duraciones:
   LOW/POINT/HIGH son los tres inputs de escenario, pero el mínimo/máximo del
   makespan publicado son min/max de los tres resultados; point es el del
   escenario POINT. Misma regla para fechas. No afirmar percentiles del finish.
   Cambios de orden/contención pueden hacer que los escenarios crucen.
7. Cuota/reachesReset aplican exclusivamente §4.1, sobre las dimensiones y
   fuentes completas del Request; el resultado se proyecta en la hija B5.

Es simulación bajo capacidades declaradas constantes. No ejecuta reservas
reales ni reprograma la cola; no predice futuros trabajos ajenos o aperturas
humanas. Claims de mediación/hard cost de composición siguen sus contratos:
una aproximación no prueba una garantía.

### 5.2 Forecast de trabajo en curso

Usa el mismo cálculo con corte nuevo y progreso derivado de eventos reales.
No subtract(request elapsed wall time) del tiempo activo de una muestra:
reconstruir los intervalos activos del sujeto hasta asOf.

Para cada muestra aceptada con duración D y observado E, conservar D > E;
residual = D-E. Si E=0 se permite D>=0. Tras esa condición vuelve a exigirse
minimumResidualSamples y frescura. Si E excede todas las muestras, UNKNOWN/
RESIDUAL_UNSUPPORTED, nunca cero. La duración proyectada es trabajo restante,
no fecha prometida.

Si el vector de tokens ya consumidos es un piso completo, único y atribuible
por clases a este lifecycle, conservar muestras cuyo vector V >= piso U en las
cuatro componentes y calcular V-U. Un settlement PARTIAL sólo sirve como piso
si sus rangos únicos prueban esa semántica; no basta su etiqueta. Conflicto,
CUMULATIVE ambiguo o fuente ausente hace residual tokens/costo UNKNOWN.
Nunca restar una estimación a otra y presentar el resultado como medición.

La selección residual de tokens y duración se registra por separado y no
infiere una correlación inexistente. El grafo se agenda desde asOf con los
residuales. Cambio futuro de modelo/transporte respecto del lifecycle ya
iniciado impide extrapolar residual de aquella cohorte: UNKNOWN, hasta un
segmento de trabajo independiente explícitamente modelado; no proporcionalidad
inventada entre modelos.

El reporte muestra por separado gasto/tiempo ya observado a su corte mediante
las consultas existentes de economy/execution. No crea un snapshot REAL por
pronosticar. Si una puerta ofrece total-al-terminar, suma observado + restante
sólo con misma medida/moneda y cobertura completa; UNKNOWN se propaga.
El total de tiempo no suma paralelos ni tiempo activo a makespan: fecha de
terminación siempre viene del calendario.

### 5.3 Replay y what-if

ReplayRequest = { version:1, reportSha256:Sha }. Recupera Request, perfil,
cabezas y pines originales y recomputa ese algoritmo; debe dar exactamente el
mismo reportSha256. No usa fuentes/precios actuales. Algoritmo histórico no
disponible responde REPLAY_UNSUPPORTED; jamás lo sustituye en silencio.
Si el reporte efímero nunca se guardó, REPORT_NOT_FOUND, no reconstrucción
adivinada ni guardado implícito al solicitar replay.

WhatIfRequest = {
version:1, baselineReportSha256:Sha,
targets:[{nodeKey:Id,target:Target}],
capacities:Capacity[],
prices:PricePin[]
}. Arrays target son overrides parciales explícitos; capacities/prices son
reemplazos completos y canonizados. No existe override libre de JSON, eventos,
estado real, fecha o sourceHeads. Derivar Request kind WHAT_IF manteniendo
plan/asOf/policy/corte/progreso del baseline, aplicar esos cambios y recalcular.
Reconstruir quotaDimensions de §4.1 para los nuevos targets al mismo corte;
no arrastrar fuentes de la cuenta anterior ni obtener observaciones actuales.
Nodo no existente, duplicado o modelo inválido rechaza. Baseline inmutable.

WhatIfDelta = {
metric:"TOKENS"|"EQUIVALENT_COST_NANOS"|"SECONDS",
status:"COMPARABLE"|"UNKNOWN",
point:Rat|null, low:Rat|null, high:Rat|null, reason:UnknownReason|null
}. Cada métrica aparece una vez, en ese orden. Valores son diferencias
scenario-baseline: point=S.point-B.point;
low=S.low-B.high; high=S.high-B.low.
Tokens/seconds tienen denominador 1; dinero usa racional antes de redondeo.
Sólo misma unidad/medida/moneda; UNKNOWN en cualquiera propaga NULL. No
comparabilidad monetaria entre monedas, FX ni mezclar EQUIVALENT con REAL.
Los deltas son cambio de escenario, no evidencia de ahorro obtenido.

## 6. E9: desempeño observacional reproducible

PerformanceRequest = {
version:1, cohort:CohortV1, currency:Currency,
asOf:Timestamp, policy:Pin, sourceHeads:Head[]
}. Usa la selección ALL_FINAL de §3; no llama evaluadores.
Los resultados son descriptivos por cohorte, no causalidad ni ranking global.

N=selectedCount; K=accepted; R=rejected; decided=K+R.
accepted/rejected provienen sólo del veredicto independiente válido al corte.
La tasa puntual es K/decided. Con decided < qualityMinimumSamples o última
decisión elegible stale, qualityStatus UNKNOWN y tasa/intervalo NULL.
Publicar N/K/R/unjudged=N-K-R siempre; la falta de decisión no cuenta éxito.
Si N=0 todos los resúmenes estadísticos son UNKNOWN/INSUFFICIENT_SAMPLE.

Intervalo Wilson determinista, para n=decided>0, k=K y z=a/b:
C=2*k*b²+a²; D=2*(n*b²+a²);
S=n*(a²*n+4*b²*k*(n-k)).
Extremos exactos = (n*C ± a*sqrt(S))/(n*D).
Para evitar sqrt flotante, t=ceilIntegerSqrt(S), calculado BigInt por búsqueda
binaria con t²>=S y (t-1)²<S. Unidad pública ppm, Q=1000000:
low=max(0,floor(Q*(n*C-a*t)/(n*D)));
high=min(Q,ceil(Q*(n*C+a*t)/(n*D))).
Es una envolvente conservadora del Wilson; floor de números negativos es hacia
menos infinito, no truncamiento JS. Point=HALF_TO_EVEN(Q*k/n).
IntervalKind="WILSON_OUTWARD_PPM"; exponer z y n. Es aproximación binomial
descriptiva condicionada a la comparabilidad de la cohorte; no prueba
independencia de tareas ni significancia de diferencias entre modelos.

Costo por aceptado: suma racional EQUIVALENT de TODAS las revisiones seleccionadas
(incluye rechazadas/fallidas/no decididas) dividida por K. Se publica sólo con
K>0, todas las revisiones monetariamente completas y ventana/muestra frescas.
El mínimo para esos montos es minimumSamples sobre N, con cobertura completa;
el mínimo de calidad sigue siendo qualityMinimumSamples sobre decided.
No promedio sólo de los casos exitosos. valuation_status conserva los cuatro
estados canónicos; estimate_status separado expresa muestra/frescura insuficiente.
No reutilizar PRICE_MISSING para decir «n pequeño».

Rework cost: suma exacta de efectos únicos en intentos que terminan FAILED o
CANCELLED dentro de cada revisión + efectos en revisiones con veredicto REJECT;
un efecto que satisface ambos predicados cuenta una vez. OUTCOME_UNKNOWN
impide atribuir esa parte y vuelve rework UNKNOWN, aunque el monto de uso exista.
Si la clasificación de rework es completa y el conjunto es vacío, el monto es
cero exacto; esto no dispensa mínimo/frescura del resumen de desempeño.
Es una definición operacional, no todo esfuerzo que alguien podría llamar
retrabajo: ACCEPT_WITH_CORRECTIONS no convierte automáticamente todo el costo
del caso en retrabajo. El intento exitoso posterior no borra los fallidos.

Duración: upperRankQuantile de active_work_seconds disponibles, p=1/2,
más extremos de política y n. Tokens/costo por revisión reutilizan §3. Para
cada métrica informar eligibleCount/unknownCount y frescura. Valores descriptivos
observados no se convierten en estimaciones válidas sólo porque n>0.

PerformanceResult = {
version:1, requestSha256:Sha, reportSha256:Sha,
cohort:CohortV1,currency:Currency,measure:"EQUIVALENT",
asOf:Timestamp,policy:Pin,sourceHeads:Head[],
tasksTotal:integer,accepted:integer,rejected:integer,unjudged:integer,
qualityStatus:"ESTIMATED"|"UNKNOWN",qualityReason:UnknownReason|null,
acceptancePpm:Int|null,acceptanceLowPpm:Int|null,acceptanceHighPpm:Int|null,
intervalKind:"WILSON_OUTWARD_PPM",
costPerAccepted:MoneyEstimate,reworkCost:MoneyEstimate,
durationSeconds:Estimate,tokens:Estimate
}. Estos mismos nombres/strictness aplican; hash usa dominio
["ACP_PERFORMANCE_REPORT",1,result sin reportSha256], y Request el dominio
["ACP_PERFORMANCE_REQUEST",1,request]. Los montos conocidos de E9 usan
status ESTIMATED para la inferencia descriptiva y racional exacto calculado;
no se etiquetan KNOWN salvo el cero estructural definido antes. Para
costPerAccepted y reworkCost, lowExact=pointExact=highExact es el estadístico
exacto de ese corte, no tres cuantiles ni un intervalo de incertidumbre de costo;
los tres nanos son su único redondeo. Su intervalo degenerado no afirma certeza
sobre un trabajo futuro. durationSeconds y tokens sí usan los cuantiles de §3.

## 8. Negativos y vectores de aceptación

Verificar en tests puros y fixtures sintéticos autorizados, sin suite del checkout
durante esta revisión. No probes o provider runs para llenar una muestra.

1. Dos muestras o ninguna con minimumSamples mayor: UNKNOWN+NULL, no cero.
   Muestras suficientes pero viejas: STALE_SAMPLE; flags y fechas reconstruibles.
2. CLI tokens UNKNOWN pero duración completa: duración estimable; costo/tokens
   UNKNOWN; sin hard-cost claim, spawn ni rechazo global de CLI funcional.
3. Input/cache_read duplicados, settlement PARTIAL disfrazado de FINAL, corrección
   sumada dos veces o varios dispatches del mismo efecto: rechazar evidencia o
   dejar métrica UNKNOWN; replay/handoff no infla muestra.
4. Un sample con varios modelos o sin versión exacta no se atribuye al último.
   Legacy CHECKPOINTED no se transforma en éxito V2.
5. PRICE_MISSING conserva tokens/tiempo; USD y EUR no se suman; sumar racionales
   antes de HALF_TO_EVEN; catálogo nuevo no modifica replay histórico.
6. Grafo cíclico o resource demand imposible rechaza. Release humano NULL deja
   finishAt NULL; nodos independientes aún se explican. Ningún lock real adquirido.
7. Running elapsed por encima de todos los completados produce UNKNOWN, no 0.
   Floor tokens ambiguo no se resta. Cambio de modelo no usa regla de tres.
8. What-if no muta baseline/plan; no claves libres; puntos/cortes originales;
   deltas UNKNOWN propagan. Fecha distinta exige nueva simulación, no un replay.
9. Aceptados 0 nunca divide por cero. Costo de rechazados/fallos permanece en
   numerador de costo por aceptado; auditor sin independencia no acredita calidad.
10. Calidad con n pequeño devuelve NULL aun si k/n=1; estados de valuación y de
    muestra separados; OUTCOME_UNKNOWN impide asignar rework por adivinación.
11. Reordenar arrays canonicalizados conserva hashes; duplicados rechazan;
    política/price/sourceCut diferente cambia Request hash; Report sin seed/
    reloj/azar es idéntico en replay. Dos guardados concurrentes usan CAS.
12. Denegación de escritura de artefactos/eventos, red y spawn en todos los tests
    de dry-run: cero llamadas, aun en rama de datos faltantes.
13. a con duración UNKNOWN y b=2 comparten un slot, sin aristas: ambos calendarios
    UNKNOWN; c en recurso independiente sigue calculable. No contaminación monetaria.
14. Dos ventanas limitantes, una UNKNOWN: saldo por cuenta UNKNOWN, no elegir
    sólo la favorable. Cruce de reset probado da TRUE aun con otra dimensión
    desconocida; FALSE exige cobertura completa. Sin fuente no hay cero residual.
15. Misma cohorte/asOf/policy con dos sourceHeads tras corrección de uso: dos
    request hashes/performance_id, ambos históricos y ambos replays idénticos.

Vectores numéricos reproducibles mínimos (sin afirmar CI del calendario):

- values=[1,2,3,4]; upperRankQuantile(1/2)=3, (0/1)=1, (1/1)=4.
- Tokens de un escenario: input=2/output=3/cache_write=0/cache_read=5
  -> total=10. Precios por millón nanos 1/2/0/1 respectivamente:
  exact cost=(2+6+0+5)/1000000=13/1000000 nanos; salida redondeada=0.
  Es cero por redondeo de una cantidad conocida, no UNKNOWN ni ausencia de uso.
- Dos costos exactos 1/2 + 1/2 nanos -> cierre 1 nano; no 0+0 por redondear
  cada línea. HALF_TO_EVEN(5/2)=2 y (7/2)=4.
- Un slot s0 disponible0, nodos a=4,b=2 sin deps, c=3 con deps[a,b],
  mismo recurso unidad1: a[0,4),b[4,6),c[6,9). Con dos slots:
  a[0,4),b[0,2),c[4,7). Tie nodeKey, no dependencia de orden de array.
- n=20,k=10,z=196/100: S=95366400, ceilIntegerSqrt(S)=9766;
  Wilson outward ppm da low=299286, point=500000, high=700714.

Vector JSON canónico de aritmética (no reporte de producto):
\`\`\`json
{"combinedHalves":1,"costDenominator":1000000,"costNumerator":13,"roundFiveHalves":2,"roundSevenHalves":4,"roundedCost":0,"upperMedian":3,"wilson":{"highPpm":700714,"k":10,"lowPpm":299286,"n":20,"pointPpm":500000,"zDenominator":100,"zNumerator":196}}
\`\`\`
SHA256 UTF8, sin newline:
\`a54381ce645148460a473c8b9e45390eeff6d7948e296a4cad0b5e6440ff7c5a\`.
El algoritmo outward usa ceil sqrt entero; no sustituir por el intervalo
flotante más estrecho. La comprobación inicial con ese otro esperado falló
(exit 2); el vector publicado aquí corresponde exactamente a la regla escrita.
