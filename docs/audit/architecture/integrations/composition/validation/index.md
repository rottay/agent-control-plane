# validación y ejecución

Especificación adjudicada del diseño de composición. No acredita soporte de adapters,
implementación, certificación de producto ni autorización operativa.

[Composición](../index.md) · [Schemas §3](../contracts/index.md) · [Diccionario §6](../../../database/execution/composition/index.md)

Las referencias §3.x remiten al contrato de composición, y §6.1–3 a su diccionario. Identidad lógica y continuidad mínimas son [execution §6](../../../database/execution/index.md), obligatorias desde P-18, no reglas nuevas de P-23.

## 4. Algoritmo determinista y códigos exhaustivos V1

Puro: no LLM, socket, spawn, exploración de disco, reloj ni aleatoriedad. Lee los
inputs inmutables que el caso de uso reunió; schema inválido devuelve rechazo
REQUEST_INVALID antes de registrar un resultado que no se pueda reconstruir.
La evaluación conserva la procedencia de capacidad y las pruebas según
[contratos de composición §3.0](../contracts/index.md); no normaliza estados
nativos de proveedor/driver ni convierte evidencia PROTOCOL en REAL.

1. Validar versiones, límites, referencias autorizadas, digests y vector de
   cabezas. Resolver únicamente pins explícitos y defaults registrados del plan.
   Los defaults de la precedencia existente se resuelven antes de formar este
   plan concreto y quedan registrados como selección de dependencia. Nunca elegir
   otro adapter/modelo por orden lexicográfico. Dependencia sin proveedor concreto
   seleccionado, con cero/múltiples candidatos, rechaza; no se inventa un campo
   adicional de defaults en el manifiesto. Después de resolver cada perfil,
   pertenencia por pin COMPLETO a deniedProfiles produce PROFILE_DENIED / ERROR /
   AUTHORITY_REFUSED / SELECT_PERMITTED_PROFILE antes de evaluar certificados;
   no omitir silenciosamente un nodo seleccionado para eludir la denegación.
2. Validar el árbol de scopes y el DAG de dependencias PIPELINE. Topological sort
   de Kahn, empate por LocalKey. Aristas OBSERVATION no crean dependencias de
   ejecución: sin feedback al productor, colas/egress limitados por su perfil.
   Ciclo de scopes/delegación o pipeline bloquea. No probar compatibilidad sobre
   un grafo mal formado: omitir diagnósticos derivados engañosos.
3. Instanciar todas las claims del perfil efectivo para cada nodo presente. Una
   claim SELF cubre ese scope; SUBTREE cubre el conjunto finito de descendientes
   declarados. Recurso = identidad canónica resuelta, no alias del plan. Claims
   de ledger/journal/memoria/índice compiten también si apuntan al mismo recurso
   desde scopes diferentes: el scope no disfraza dos escritores del mismo estado.
4. La raíz RUN tiene exactamente un propietario para SCHEDULING y RECOVERY,
   y ambos deben ser el mismo nodo/driver. La raíz no se delega en V1. Estas
   responsabilidades sí pueden delegarse en scopes SUBWORK descendientes: la
   recuperación local de un harness ocupa sólo ese scope y su propio
   ENGINE_JOURNAL/CHECKPOINT, nunca la raíz. Nodos ACP que
   poseen ledger, gasto y enforcement se incluyen como perfiles efectivos reales,
   no se excluyen de la detección porque sean internos.
5. Delegación válida: padre/child distintos, scope hijo descendiente estricto
   del scope cubierto por la claim paterna, misma responsabilidad/recurso, padre
   OWNER delegable, child OWNER de ese scope, edge KEYED_SUBWORK, evidencia PASS.
   Sin cadena padre real no existe delegación. El algoritmo resta al padre sólo
   la región delegada, la entrega al hijo y repite en orden de profundidad.
   Delegaciones superpuestas sin relación ancestro-hijo rechazan. Autoridad de
   veto, techo de gasto y cancelación superior permanece en ACP; no es otro OWNER
   activo de retry/ejecución. Delegar no desactiva enforcement.
6. Formar celdas finitas `(responsibility, executionScope, resourceIdentity)` tras
   las restas. Para cada responsabilidad requerida hay exactamente un OWNER.
   Cero = ausente; más de uno = conflicto. El conjunto requerido se deriva de
   operationSelections mediante §3.4 y TaskEnvelope, no todas las ofertas:
   RUN y cada SUBWORK exigen SCHEDULING/RECOVERY/CHECKPOINT; RUN además
   BUSINESS_LEDGER; cada recurso declarado exige su clase. El resto procede
   exclusivamente del catálogo de operaciones seleccionadas.
   Observadores tienen cero autoridad y no satisfacen un owner faltante. Fanout
   sólo con aristas OBSERVATION explícitas y flag de política; no crea uso/costo.
7. Comprobar límites: deadline hijo <= padre <= deadline autorizado; conteo máximo
   de efectos hijo <= padre; maxDispatchAttempts limita cada efecto en la frontera
   declarada. Datos/egress/autoridad se validan por políticas referenciadas y el
   enforcement existente, sea por invocación aislada/fenced o mediación de efectos.
   No exigir instrumentar llamadas LLM para probar un control externo que ya tiene
   evidencia válida. La ejecución ACP carga los efectos observables al mismo techo,
   sin multiplicar grants. Consumo agregado/transaccional se define sólo en §5.1;
   hijo<=padre no lo sustituye. Uso/costo interno desconocido no se fabrica: cuota y
   costo quedan UNKNOWN conforme a accounts/economy; no permiten anunciar un
   límite duro. Si el envelope exige ese límite, su garantía es obligatoria.
8. Un único EFFECT_RETRY por celda en la frontera ACP declarada. La invocación CLI
   opaca puede tener retry interno OPAQUE_INTERNAL sin crear un segundo propietario
   de retry de la invocación ACP. No autoriza a su padre a relanzarla ciegamente.
   Para control anidado MEDIATED se exige frontera NESTED_EFFECTS, ALL_DISPATCHES,
   KEYED_SUBWORK y ACP_MEDIATED: cada retry mediado se registra antes del despacho.
   Una delegación de doble autoridad o una promesa de no-duplicación interna que
   depende de pasos opacos no supera esa garantía. El padre consulta/reentrega el
   MISMO subwork key y no recrea el cuerpo tras perder el acuse. Fallback interno
   sólo puede permanecer dentro del proveedor/cuenta/transporte autorizado; jamás
   autoriza pasar silenciosamente de suscripción a gasto API ni falsear modelo
   resuelto. Desconocer el modelo real usa los estados existentes, no un alias
   inventado como resolución exacta.
9. Validar contratos/cancelación/checkpoint y evidencia por garantía. Evaluar toda
   la matriz de capacidades para reportarla, pero bloquear sólo la unión de
   garantías requeridas de §3.2 y las interacciones de autoridad efectivamente
   seleccionadas. Para una garantía requerida, UNSUPPORTED o FAIL conocido =>
   ERROR; ausencia de evidencia, expiración, revocación o declaración UNKNOWN =>
   UNKNOWN. Las mismas situaciones en una garantía no requerida producen sólo
   INFO y conservan su support por garantía. BASE_INVOCATION no certifica uso,
   presupuesto duro ni no-duplicación interna. Requiere PASS aplicable al contrato
   base y a cada componente de delegación seleccionado, incluida cascada; declarar
   controles no demuestra cumplimiento. Un mock no certifica una familia nueva.
10. Emitir todos los diagnósticos independientes. ERROR domina UNKNOWN para
    support global; sólo INFO o ninguno => SUPPORTED y snapshot. Una garantía
    requerida UNKNOWN nunca se vuelve warning permitido al despachar. Persistir
    las limitaciones no requeridas junto con el corte,
    no llamadas del preflight ni reservas ficticias.

| ruleCode | severity / refusalClass | remedyCode |
| --- | --- | --- |
| INPUT_INVALID | ERROR / REQUEST_INVALID | FIX_INPUT |
| VERSION_UNSUPPORTED | ERROR / CAPABILITY_UNSUPPORTED | SELECT_SUPPORTED_VERSION |
| REFERENCE_INVALID | ERROR / PRECONDITION_FAILED | REPAIR_REFERENCE |
| DEPENDENCY_MISSING | ERROR / CAPABILITY_UNSUPPORTED | SELECT_DEPENDENCY |
| DEPENDENCY_AMBIGUOUS | ERROR / REQUEST_INVALID | SELECT_DEPENDENCY |
| GRAPH_CYCLE | ERROR / REQUEST_INVALID | REMOVE_CYCLE |
| PROFILE_DENIED | ERROR / AUTHORITY_REFUSED | SELECT_PERMITTED_PROFILE |
| OPERATION_NOT_SELECTED | ERROR / AUTHORITY_REFUSED | SELECT_OPERATION_EXPLICITLY |
| OWNER_MISSING | ERROR / CAPABILITY_UNSUPPORTED | SELECT_OWNER |
| OWNER_CONFLICT | ERROR / CONFLICT | SELECT_SINGLE_OWNER |
| DELEGATION_INVALID | ERROR / AUTHORITY_REFUSED | FIX_DELEGATION |
| LIMIT_EXCEEDED | ERROR / AUTHORITY_REFUSED | REDUCE_SCOPE |
| AUTHORITY_UNMEDIATED | ERROR / AUTHORITY_REFUSED | SELECT_MEDIATED_PROFILE |
| HIDDEN_RETRY | ERROR / CAPABILITY_UNSUPPORTED | DISABLE_OR_MEDIATE_RETRY |
| FALLBACK_UNMEDIATED | ERROR / AUTHORITY_REFUSED | DISABLE_OR_MEDIATE_FALLBACK |
| CONTRACT_INCOMPATIBLE | ERROR / CAPABILITY_UNSUPPORTED | SELECT_COMPATIBLE_PROFILE |
| EVIDENCE_FAILED | ERROR / CAPABILITY_UNSUPPORTED | SELECT_PROVEN_PROFILE |
| EVIDENCE_MISSING | UNKNOWN / CAPABILITY_UNSUPPORTED | CERTIFY_EXACT_PROFILE |
| EVIDENCE_EXPIRED | UNKNOWN / CAPABILITY_UNSUPPORTED | CERTIFY_EXACT_PROFILE |
| EVIDENCE_REVOKED | UNKNOWN / CAPABILITY_UNSUPPORTED | CERTIFY_EXACT_PROFILE |
| GUARANTEE_UNSUPPORTED | ERROR / CAPABILITY_UNSUPPORTED | SELECT_PROVEN_PROFILE |
| GUARANTEE_LIMITATION | INFO / null | ACKNOWLEDGE_LIMITATION |
| OPTIONAL_OMITTED | INFO / null | NONE |
| SNAPSHOT_STALE | ERROR / PRECONDITION_FAILED | REPEAT_PREFLIGHT |
| DRIVER_PINNED | ERROR / PRECONDITION_FAILED | KEEP_RUN_DRIVER |

`HIDDEN_RETRY` exige que el retry conocido contradiga la garantía de control
solicitada o la frontera de delegación, no sólo que haya opacidad interna. Si no
se conoce una garantía requerida, EVIDENCE_MISSING. Si no fue requerida,
GUARANTEE_LIMITATION identifica el código de garantía en `at` y la matriz registra
UNSUPPORTED/UNKNOWN sin bloquear ejecución básica. No falsear incompatibilidad
para ocultar falta de prueba, ni ocultar limitaciones detrás de un SUPPORTED global.

## 5. Hechos, binding y revalidación

Hechos de tarea nuevos en `control_plane_events`, namespace de payload
`compositionContractVersion:1`, sobre la coordenada V2 y la asignación legacy
existente. Son observaciones/transiciones internas con `from_state = to_state`;
no abren un estado de tarea nuevo ni afirman dispatch:

- `COMPOSITION_PREFLIGHT_RECORDED`: petición y resultado tipados completos,
  incluyendo snapshot si fue SUPPORTED. Transición estable
  `composition.preflight:<preflightId>`.
- `COMPOSITION_RUN_BOUND`: invocationId y coordenada V2, preflightId inicial,
  driverNodeKey. Transición `composition.run:<invocationId>`.
- `COMPOSITION_SEGMENT_BOUND`: routeSegmentId, preflightId, predecessorSegmentId
  cuando corresponda. Transición `composition.segment:<routeSegmentId>`.
- `COMPOSITION_EFFECT_BOUND`: effectId, initialExecutorNodeKey, operationKey.
  Se apendea con la intención inicial cuando composición está habilitada;
  transición `composition.effect:<effectId>`. No posee identidad lógica.
- `COMPOSITION_DISPATCH_BOUND`: dispatchAttemptId, executorNodeKey,
  retryOwnerNodeKey. Se apendea con la intención del despacho antes de enviar;
  transición `composition.dispatch:<dispatchAttemptId>`; segmento se deriva del
  despacho base, no se copia.

Las claves exteriores conservan exactamente el namespace/idempotencia V2 de
streams §1.1; lo nuevo son transition_id y payloads. Mismo idempotency key con
bytes canónicos iguales = replay, diferentes = CONFLICT. Nunca cambia la clave de
idempotencia del efecto ni el envelope para incluir la composición.

Registrar evaluación: `BEGIN IMMEDIATE`, revalidar que revisión/envelope/intento
existen y coinciden, comprobar cabezas esperadas para el append, validar referencias
causales al corte y guardar evento/hash/cabeza/todas sus filas/watermarks en una
transacción. Un evento grande se rechaza por límite contractual, no se corta en
eventos que aparenten un snapshot parcialmente admisible. Referencias a blobs se
publican y pinnean antes según artifacts; el snapshot estructural no se esconde
en un blob para evitar el límite de evento.

Binding no es reserva ni permiso permanente. Dentro del append de binding y de
la intención de cada efecto se vuelve a comprobar:

1. preflight SUPPORTED, digest y esquema; revisión/envelope y grafo relevantes;
2. mismos perfiles cargados/settings/recursos y documentos relevantes; política y
   autorización siguen vigentes; modelo no retirado, evidencia no revocada;
3. runtime propietario, segmento y fences actuales conforme a saga existente.

Revalidación de relevancia: comparar los pins concretos leídos para ese snapshot
y su estado vigente, no igualdad de la cabeza GLOBAL de registry. Para el
manifiesto, comparar sólo los miembros seleccionados y recursos utilizados
(memberKey, profile pin, isEnabled, resourceKind, resourceIdentitySha256);
cambiar otra entrada no invalida. Para policy comparar algorithmVersion, los
límites/flags consumidos y la pertenencia a deniedProfiles de los perfiles
seleccionados; añadir evidencia de otra interacción no invalida. Se vuelven a
consultar estado/vigencia de las evidencias utilizadas y las aplicables al mismo
subjectSha256, de modo que una revocación posterior sí bloquea. Los documentos
originales completos siguen pineados para reconstruir la decisión histórica.
Cambiar un perfil/settings/permiso o alguna de estas proyecciones relevantes
requiere nuevo preflight; elegir una versión vieja revocada no evade esa regla.
No existe `UPDATE snapshot SET valid=false` como autoridad:
la evaluación anterior conserva el hecho histórico, la nueva lectura rechaza.

Los cambios locales de código/configuración se detectan por digest del perfil
cargado en cada dispatch; el proceso no sustituye settings en caliente después
del check. Una instalación distinta exige reconstruir/rebindear el proceso en
frontera segura. Revocaciones de autoridad o cuota posteriores al check se
aplican por los fences/enforcement vivos existentes; no se promete una transacción
atómica entre DB, disco de instalación y proveedor.

OCC: expected task head + expected existing binding (ausente o fila exacta),
consulta de fuentes relevantes en la misma lectura consistente del ledger, luego
append. Dos contendientes para una fila inexistente: sólo uno gana su UNIQUE;
el perdedor es replay si coincide, CONFLICT si difiere. No `INSERT OR REPLACE`.
Reservas/leases ocurren después por saga; dos preflights verdes no conceden dos
reservas incompatibles. Revalidar otra vez antes de iniciar cada efecto.

### 5.1 Consumo conservador agregado

Árbol semántico y máximos se fijan al binding inicial del run. Snapshots posteriores
conservan scopeKey/parent/kind y no amplían máximos ni reinician consumo. Techo
efectivo = mínimo del valor inicial y el del snapshot usado para esta admisión.

Dentro del MISMO BEGIN IMMEDIATE del lookup/append del efecto nuevo en scope s,
para cada ancestro a de s, incluido s:

```
usedEffects(a) = COUNT(DISTINCT effect.logical_operation_sha256)
                del mismo invocation/attempt,
                con semantic_scope_key dentro de subtree(a)
admitir sólo si usedEffects(a) + 1 <= effectiveMaxEffectsCount(a)
```

Contar TODAS las intenciones registradas, en todos los segmentos/snapshots y
cualquier outcome, incluidas fallidas/canceladas/abandonadas; no devolver plazas.
Replay no crea intención ni consume otra plaza. Lectura, decisión, intención,
índice lógico, hash/cabeza/fold son atómicos. Dos escritores del último cupo no
ganan simultáneamente. No contador mutable ni tabla nueva de cupos.

Para cada dispatch nuevo, su BEGIN IMMEDIATE resuelve el efecto original, valida
ejecutor/selección/owners y cuenta TODAS las filas dispatch_attempt de ese effect_id,
incluidas INTENDED y ABANDONED. count+1 debe ser <= mínimo de maxDispatchAttempts
efectivos de TODOS los ancestros del scope semántico original. Registrar despacho
y binding juntos. Misma clave/id de despacho es replay sin otra plaza ni permiso
de reenviar; un intento real nuevo consume aunque falle. Handoff no reinicia.
Desborde de conteo y LIMIT_EXCEEDED rechazan antes de append.

Son límites de efectos/despachos ACP observables. No instrumentan llamadas LLM
opacas ni prueban HARD_COST_BOUND de un CLI; esa garantía conserva su contrato.

## 7. Continuidad, engines y retries anidados

Ratificado para el diseño V1: `invocationId` neutral y coordenada completa
task/revision/attempt son biyectivos. Los retries de entrega y route handoffs
conservan ambos. Wrappers padre de varias tareas no son este run y no se modelan
aquí.
La migración a la coordenada V2 usa legacy_attempt_number existente; no reutiliza
el número plano como identidad nueva. El identificador interno de Restate,
Temporal u otro engine sigue siendo referencia opaca privada de su edge.

Un workflow replay o una reentrega al padre no ejecuta de nuevo un SUBWORK:
resuelve `subwork_key`, consulta su effect_binding/resultado y, ante incertidumbre,
reconcilia. KEY del proveedor permite reentrega con la misma clave según contratos
§7; sólo HANDLE_QUERY no demuestra idempotencia de una segunda ejecución.
Sin prueba de no-despacho o idempotencia, OUTCOME_UNKNOWN bloquea todo retry,
incluido el que un harness quisiera llamar “nuevo intento interno”.

Ejemplo conceptual Temporal: su workflow podría poseer el run, y un subtrabajo
identificado poseer los efectos de su scope. Reintentar la entrega de una activity
que vuelve a ejecutar todo el harness sin deduplicación NO es delegación válida.
Este texto no afirma que exista un adapter Temporal, ni que su perfil haya pasado
un drill. También aplica a los dos drivers actuales sin condición por marca.

Handoff de cuenta/modelo/transporte: quiesce, checkpoint, reconciliar, revocar con
acuse, reservar, rehidratar, adquirir fence, continuar, completar, en ese orden.
Crear preflight y binding del segmento destino con el MISMO driver/run/envelope;
conservar todos los bindings previos. Si cambia objetivo/autoridad, nueva revisión,
no handoff. Fallo de destino no revive el fence anterior.

Cambiar driver o profile/configuration del driver durante el run es DRIVER_PINNED,
incluso si ambos perfiles son SUPPORTED por separado. Un driver nuevo sólo en run
nuevo, o cuando otro packet cierre el protocolo explícito de migración de engine
de contratos §9. H-5 no implementa export/import de journals ni hot swap.
Un snapshot verde nuevo tampoco convierte efectos pendientes del segmento origen
en NOT_DONE ni autoriza un segundo efecto en destino.

Ejemplos de alcance de garantía, no anuncios de soporte existente:

| Selección y garantía solicitada | Decisión |
| --- | --- |
| CLI de suscripción, invocación y autoridad probadas; uso interno UNKNOWN, sin presupuesto duro solicitado | SUPPORTED para la invocación; matriz y economía mantienen uso/costo interno desconocido, sin atribuir mediación total |
| Mismo CLI con HARD_COST_BOUND obligatorio no probado | UNKNOWN o UNSUPPORTED de esa garantía; no iniciar ese pedido ni convertirlo silenciosamente en soft |
| Mismo CLI, se perdió acuse de la sesión y no hay prueba de no-despacho ni idempotencia | No relanzar: OUTCOME_UNKNOWN/reconciliación; el soporte previo de ejecución básica no prueba redelivery segura |
| Dos orquestadores reclaman el mismo run, aunque ninguno mida uso interno | OWNER_CONFLICT; opacidad y conflicto de autoridad son preguntas distintas |

## 8. Pruebas exigibles al packet implementador

No ejecutadas aquí. Deben producir recibos de otro worker en una copia o árbol
sintético autorizado. Esta especificación no autoriza crear ni usar worktrees.

1. Schema: versión desconocida, campo vendor, par nullable parcial, PK duplicada,
   operación desconocida y límite de bytes/nodos fallan antes de cualquier efecto.
2. Mismo input permutado como conjuntos produce mismo digest/diagnóstico. Orden
   semántico modificado sí cambia digest. Input/algoritmo idénticos sobreviven
   restart sin reloj/random; CLI/API fixtures independientes tienen mismo contrato.
3. Dos drivers en raíz rechazan; dos tareas con drivers distintos se admiten.
   Dos journals distintos coexisten; dos aliases del mismo recurso no evaden owner.
4. Delegación sin claim delegable, al mismo scope, cíclica, superpuesta o que
   asciende autoridad falla. Padre conserva veto pero no segundo EFFECT_RETRY.
5. Dependencia ausente/ambigua, ciclo e incompatibilidad tienen códigos distintos.
   Perfil ofrece artifacts READ/PUBLISH; plan sólo selecciona READ: PUBLISH
   rechaza antes de la intención. Validar nodo ejecutor exacto, no oferta ajena.
   Observer no satisface dependencia ejecutora ni ownership.
6. PASS individual sin interacción da UNKNOWN. Cascada triple con sólo recibos
   de parejas da UNKNOWN. FAIL, expiración y revocación se distinguen. Perfil
   requerido cargado y con todos sus PASS, pero pin completo en deniedProfiles:
   UNSUPPORTED/PROFILE_DENIED, sin binding ni efectos desde evaluación inicial.
7. Retry oculto que contradice control anidado solicitado falla; falta de prueba
   de esa garantía requerida da UNKNOWN. CLI de suscripción opaco con invocación
   básica probada y sin garantías internas solicitadas SÍ es admisible, manteniendo
   limitaciones y uso UNKNOWN; el mismo input con HARD_COST_BOUND obligatorio no.
   Tres capas mediadas:
   perder acuse en cada frontera produce un solo efecto lógico, dispatches
   registrados y el mismo subwork key; costo/uso reales no se duplican por replay.
8. Raíz maxEffectsCount=1, dos hijos max=1 y dos escritores: una sola intención
   admitida bajo BEGIN IMMEDIATE. Fallo/cancelación no devuelve plaza y handoff
   no reinicia. Un efecto con dispatches de varios segmentos aplica mínimo
   ancestral y cuenta también INTENDED/ABANDONED. Replay no consume otra plaza.
   CLI opaca no obtiene garantía de presupuesto duro por pasar estos contadores.
9. Preflight→cambio de perfil/permiso/evidencia bloquea dispatch; cambio de documento
   ajeno no bloquea. Perfil cargado diferente al pin bloquea. Dos verdes concurrentes
   siguen contendiendo por reservas/leases existentes, no por nuevo lock falso.
10. Crash después de evento y antes de ack/rebuild: bindings se reconstruyen;
    perdida cache/outbox no repite un efecto incierto; conflicto de bytes bajo key
    existente no se trata como replay. Borrado de sólo proyecciones en entorno
    desechable reproduce todas las filas al mismo vector histórico.
11. Tres handoffs del mismo intento conservan invocation/driver/envelope y linaje
    de segmentos. Driver alternativo durante el run falla; pérdida de confirmación
    en origen no habilita efecto destino. Rollback requiere fence nuevo.
    Negativo específico: perder ack, solicitar handoff y repetir el mismo
    scope/local_operation_key devuelve el effect_id original y exige reconciliar;
    no crea intención ni ejecución nueva aunque el snapshot destino sea verde.
    Si se completa legítimamente la barrera de handoff y se reentrega después,
    la clave sigue devolviendo el mismo efecto. Payload distinto bajo esa clave
    rechaza. Un despacho posterior realmente autorizado conserva el segmento
    inicial del efecto y registra su segmento efectivo y ocurrencias aparte.
12. Optional ausente se omite únicamente si no es requerido transitivamente;
    fanout de observación explícito no duplica uso/costo y receptor caído no crea
    dependencia de ejecución. Datos fuera de egress autorizado se rechazan.

### 8.1 Golden mínimo reproducible de INTERACTION

Fixture sintético de schema/serialización, NO evidencia PASS de adapters. Bytes:
una sola línea UTF-8 del bloque, sin salto final. Claves y colecciones ya canónicas.
SHA-256 calculado localmente con Node crypto (exit 0), sin cargar módulos/producto.

```json
["composition-interaction",1,{"compositionContractVersion":1,"dataFlows":[{"consumerNodeKey":"b","dataPolicySha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","kind":"PIPELINE","operation":{"contractId":"acp.artifacts","contractVersion":1,"operation":"READ"},"producerNodeKey":"a"}],"delegations":[],"nodes":[{"nodeKey":"a","profile":{"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","documentId":"00000000-0000-4000-8000-000000000001","documentVersion":1}},{"nodeKey":"b","profile":{"contentSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","documentId":"00000000-0000-4000-8000-000000000002","documentVersion":1}}],"operationSelections":[{"nodeKey":"a","operation":{"contractId":"acp.artifacts","contractVersion":1,"operation":"READ"},"scopeKey":"run"},{"nodeKey":"b","operation":{"contractId":"acp.artifacts","contractVersion":1,"operation":"READ"},"scopeKey":"run"}],"resourceClasses":[{"bindings":[{"nodeKey":"a","resourceSlot":"memory"},{"nodeKey":"b","resourceSlot":"memory"}],"classOrdinal":0,"resourceKind":"WORKING_MEMORY"}],"scopes":[{"kind":"RUN","parentScopeKey":null,"scopeKey":"run"}]}]
```

SHA-256 esperado: `7487affdddc15748330e965f45165d71b1d45c06ea5bf5f70b730b1b26f3f1ec`.

Negativo de igualdad: conservar todo lo demás y sustituir resourceClasses por
dos clases, ordinal 0 con binding (a,memory) y ordinal 1 con binding (b,memory),
ambas WORKING_MEMORY. SHA esperado: `44224495694dfb748d89e3166b445a0df2cba866161b40059c4ea4b660689656`.
Permutar nodes/operationSelections/bindings y normalizarlos según §3.5 debe
reproducir el primer hash. Son pruebas del contrato, no corridas de proveedores.
