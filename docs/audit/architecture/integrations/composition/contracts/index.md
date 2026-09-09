# contratos de composición

Especificación adjudicada del diseño de composición. No acredita soporte de adapters,
implementación, certificación de producto ni autorización operativa.

[Composición](../index.md) · [Validación](../validation/index.md) · [Contratos canónicos](../../../contracts/index.md)

## 3. Formas wire V1, estrictas

Esta sección es notación de schema, no implementación TypeScript. Objetos strict:
campos desconocidos se rechazan. Los nombres wire se muestran en camelCase; el DDL
usa snake_case. `Id`, `Sha256`, `Timestamp`, `TaskState`, rechazo y versiones de
operación reutilizan sus schemas de contratos existentes. IDs de adapter/provider/
perfil siguen abiertos; no hay valores con nombres de marcas en los vocabularios.
Todos los objetos raíz llevan `compositionContractVersion: 1`.

Primitivas adicionales exactas:

- `LocalKey`: string ASCII `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. No es una ruta ni
  un selector/glob; comparación ordinal de bytes, sensible a mayúsculas.
- `DocumentPin`: `{documentId: Id, documentVersion: integer >= 1,
  contentSha256: Sha256}`. Su `documentKind` lo fija el campo que lo contiene.
- `SourceHead`: `{stream: uno de los cuatro streams, sequence: integer >= 0,
  eventSha256: Sha256}`; cero usa el digest de cabeza vacía del contrato existente.
- `OperationKey`: `{contractId: Id, contractVersion: integer >= 1,
  operation: string}`: unión strict de las claves exactas de §3.4. Claves no
  listadas rechazan. No semver abierto, latest ni resolución por red.
- Colecciones de conjuntos se ordenan por sus claves declaradas y rechazan
  duplicados. Las listas realmente ordenadas llevan ordinal explícito desde cero.
  Se rechazan bytes fuera de los límites comunes del contrato; los topes de nodos,
  scopes y aristas de la política son límites adicionales, nunca ampliaciones.

### 3.0 Procedencia de capacidad: no coerción de vocabularios

Aplicar [contratos canónicos §2.0](../../../contracts/index.md): capability_support
es una evaluación de perfil/composición. NO sustituye el estado nativo de
capacidad del proveedor CONFIRMED/UNKNOWN/REFUSED, su evidencia PROTOCOL/REAL,
ni la capacidad del driver SUPPORTED/UNSUPPORTED (que nunca gana un tercer estado).
Conservar origen, sujeto, versión, razón y referencia a TODA la evidencia en los
hechos/recibos de sus dueños, enlazados por los pins/cortes del preflight; no copiar
ni reescribir esos vocabularios como otra autoridad.

Un proveedor CONFIRMED por protocolo no acredita un drill REAL; un fake no lo
sustituye. Driver SUPPORTED describe su verbo, no prueba una composición con otro
adapter. El algoritmo puede dar composition support UNKNOWN por evidencia de
interacción ausente sin alterar ese estado binario del driver. Los diagnósticos
nombran la fuente y la garantía faltante, nunca inventan driver UNKNOWN.
No toca la lectura discriminada LEGACY/TASK_V2 ni transforma estados históricos.

### 3.1 Documentos de entrada: configuración, no otro registry

Ampliación aditiva y explícita del catálogo `registry_events.document_kind`:
`INTEGRATION_PROFILE`, `INTEGRATION_INSTALLATION`, `COMPOSITION_POLICY`,
`COMPOSITION_EVIDENCE`. Sus sujetos son documentos reales, no tareas ficticias.
Almacenamiento en el registry existente; semántica propiedad de planning.
No ampliar `CAPABILITY_POLICY` para esconder aquí conceptos diferentes.

Se reutiliza el envelope de documento versionado con autor, versión, padre,
vigencia, referencia autorizada de contenido y hash ya definido. Sus contenidos
son JSON canónico versionado permitido por datos §3.5. Se leen por pin completo;
no se crean queries SQL sobre arrays internos. Lo que sí se consulta —composición
resuelta, ownership, participantes, bindings, diagnóstico— se proyecta en §6.
Si se añade después una consulta SQL de capacidades de perfiles instalados,
necesita sus tablas hijas en su propio packet; no un `json_extract` permanente.

`IntegrationProfileV1` extiende el descriptor neutral, no lo sustituye:

```
profileId: Id
descriptorSha256, effectiveConfigurationSha256: Sha256
baseDescriptor: AdapterDescriptor del contrato vigente
requires: {requirementKey: LocalKey, operation: OperationKey, isOptional: boolean}[]
claims: {
  claimKey: LocalKey,
  responsibility: Responsibility,
  extent: SELF | SUBTREE,
  role: OWNER | OBSERVER,
  isDelegable: boolean,
  resourceSlot: LocalKey | null
}[]
controls: {
  effectBoundary: ACP_INVOCATION | NESTED_EFFECTS,
  retryMode: NONE | OPAQUE_INTERNAL | MEDIATED,
  fallbackMode: NONE | OPAQUE_INTERNAL | MEDIATED,
  delegationMode: NONE | KEYED_SUBWORK,
  cancellationSupport: reutiliza NONE | REQUEST | TERMINATE,
  continuityKind: reutiliza NONE | CHECKPOINT | LIVE_MIGRATION,
  effectAccounting: UNKNOWN | AGGREGATE | ALL_DISPATCHES,
  enforcement: NONE | INVOCATION_FENCED | ACP_MEDIATED
}
guarantees: {guarantee: Guarantee,
             support: SUPPORTED | UNSUPPORTED | UNKNOWN}[]
```

`baseDescriptor` es la única declaración de adapterId/adapterVersion y de las
operaciones ofrecidas con sus límites; cada oferta identifica exactamente su
OperationKey. No hay otra lista `provides` que pueda divergir. descriptorSha256
hashea sólo baseDescriptor, no el perfil que contiene ese hash. Los parámetros
efectivos que deshabilitan
retry/fallback se fijan en `effectiveConfigurationSha256`. Una declaración no
demuestra que el SDK la cumpla: exige evidencia del perfil exacto ([validación §4](../validation/index.md)).
`isDelegable` sólo vale para OWNER; OBSERVER nunca puede ejecutar o delegar.
Los namespaces de extensión del descriptor permanecen sujetos a sus schemas
existentes y no pueden añadir responsabilidades/verbos que el core ignore.
guarantees contiene exactamente una fila por valor de Guarantee, incluso UNKNOWN.
Garantías cerradas V1: `BASE_INVOCATION`, `AUTHORITY_ENFORCEMENT`,
`OBSERVABLE_DELIVERY_IDEMPOTENCY`, `NESTED_RETRY_CONTROL`,
`INTERNAL_DUPLICATE_SUPPRESSION`, `HARD_COST_BOUND`, `USAGE_MEASUREMENT`.
La conformidad base sólo demuestra entrega/resultados/cancelación declarada en la
frontera elegida, no los demás atributos. INVOCATION_FENCED describe ownership y
el enforcement probado para la invocación local; no significa instrumentar cada
llamada interna. ALL_DISPATCHES sólo puede anunciarse con frontera NESTED_EFFECTS.
OPAQUE_INTERNAL reconoce comportamiento interno no observable; no atribuye una
segunda autoridad ACP de scheduling/retry a cada llamada del proveedor.

`IntegrationInstallationV1`:

```
installationId: Id
members: {memberKey: LocalKey, profile: DocumentPin, isEnabled: boolean}[]
resources: {resourceKey: LocalKey, resourceKind: ResourceKind,
            resourceIdentitySha256: Sha256}[]
```

La identidad de recurso la emite el composition root después de resolver la
configuración real; no la elige libremente el adapter. Dos aliases del mismo
ledger/backend/namespace tienen el mismo digest. No contiene rutas secretas ni
credenciales. Perfiles cargados deben coincidir con los pins, configuración y
recursos declarados; una instalación sólo descargada no satisface este hecho.

`CompositionPolicyV1`:

```
algorithmVersion: 1
maxNodes: integer >= 1
maxScopes: integer >= 1
maxEdges: integer >= 0
allowExplicitObservationFanout: boolean
evidence: DocumentPin[]
deniedProfiles: DocumentPin[]
```

No mini lenguaje de reglas ejecutables, expresiones arbitrarias ni excepciones
por marca. Los predicados de [validación §4](../validation/index.md) son código puro versionado; cambiar su semántica
exige algorithmVersion nuevo. No hay `allowUnknown`. No expirar un pin por reloj
durante replay: vigencias se evalúan contra `evaluatedAt` registrado.

`CompositionEvidenceV1`:

```
evidenceKey: LocalKey
subjectKind: PROFILE | INTERACTION
subjectSha256: Sha256
guarantee: Guarantee | COMPOSITION
result: PASS | FAIL | REVOKED
validFrom: Timestamp
validUntil: Timestamp | null
receiptArtifactReferenceId: Id
receiptSha256: Sha256
```

`validUntil > validFrom` cuando existe; intervalo [from,until). `PROFILE` hashea
el pin completo de perfil. `INTERACTION` hashea el grafo canónico de participantes
y aristas involucrados con pins completos y settings efectivos: dirección,
responsabilidad, operación/versiones y modo de delegación. Requiere recibo de una
corrida de conformidad autorizado; no basta el autoinforme del adapter. Se
comprueban tanto el perfil individual como el componente conectado completo de
delegación; dos PASS de parejas no certifican automáticamente una cascada triple.
Una corrección/revocación publica versión nueva; jamás edita evidencia histórica.
La evidencia se resuelve por (subjectKind,subjectSha256,guarantee). Al corte dado,
tomar la versión máxima vigente de cada documentId, nunca una versión antigua
elegida para eludir revocación. Entre documentos aplicables: FAIL domina; después
REVOKED; después PASS; ausencia/expiración queda UNKNOWN. Entre varios PASS
equivalentes seleccionar documentId/documentVersion por orden canónico para el
pin de prueba; registrar las fuentes leídas. Sólo se usan documentos autorizados
por la política. Un PASS de BASE_INVOCATION no responde HARD_COST_BOUND.
Las preimágenes strict se definen únicamente en §3.5. Los límites del descriptor
certificado siguen siendo techos; un PASS no permite excederlos.

### 3.2 Plan neutral

`CompositionPlanV1` es contenido de una revisión del plan existente de planning,
no un campo nuevo de TaskEnvelope. Su pin es `(planId, planRevisionSha256)` y su
referencia autorizada de artefacto debe poder recuperarse al corte registrado.
Los hechos del plan conservan su stream de iniciativas. Un override explícito
autorizado se registra en el plan/corte consumido, no se pierde en parámetros CLI.
El pin es metadata del contenedor: planRevisionSha256 corresponde al plan_sha256
ya existente en coordinator_plan_read_model. Se usa un plan_id nuevo para un
plan cambiado; no se sobreescribe una fila histórica. Los dos campos del pin NO
se incrustan dentro del contenido que hashea plan_sha256. Se reutiliza
artifact_class=PLAN_DOCUMENT y la aprobación PLAN/id/digest existente.

```
scopes: {scopeKey: LocalKey, parentScopeKey: LocalKey | null,
         kind: RUN | SUBWORK | OPERATION,
         maxEffectsCount: integer >= 0, maxDispatchAttempts: integer >= 1,
         deadlineAt: Timestamp}[]
nodes: {nodeKey: LocalKey, scopeKey: LocalKey,
        installationMemberKey: LocalKey,
        isRequired: boolean,
        resourceBindings: {resourceSlot: LocalKey, resourceKey: LocalKey}[]}[]
operationSelections: {nodeKey: LocalKey, scopeKey: LocalKey, operation: OperationKey}[]
dependencies: {consumerNodeKey: LocalKey, requirementKey: LocalKey,
               supplierNodeKey: LocalKey}[]
delegations: {delegationKey: LocalKey, parentNodeKey: LocalKey,
              childNodeKey: LocalKey, childScopeKey: LocalKey,
              responsibility: Responsibility,
              resourceKey: LocalKey | null}[]
dataFlows: {producerNodeKey: LocalKey, consumerNodeKey: LocalKey,
            operation: OperationKey,
            kind: PIPELINE | OBSERVATION,
            dataPolicyReferenceId: Id, dataPolicySha256: Sha256}[]
requiredGuarantees: {nodeKey: LocalKey, guarantee: Guarantee}[]
```

Exactamente una raíz RUN de scopeKey `run`; SUBWORK tiene padre RUN/SUBWORK; OPERATION tiene padre
RUN/SUBWORK y no hijos. Todos los nodos tienen scope. Las listas sólo declaran
subtrabajos identificados, no ejecutan. `isRequired=false` no autoriza omisión si
alguna dependencia requerida o el envelope necesita ese nodo. Un nodo omitido no
produce claims; se informa con diagnóstico `OPTIONAL_OMITTED`.
El plan no declara libremente claims/controles: se instancian del perfil validado.
operationSelections es un conjunto por (nodeKey,scopeKey,contractId,contractVersion,
operation); scope debe estar dentro del subárbol del nodo y la oferta existir en
su perfil exacto. Seleccionar un nodo NO habilita el resto de sus ofertas. Esta
colección incluye las operaciones principales, aunque no haya dependencies/dataFlows.

`Responsibility` V1, cerrado:
`SCHEDULING`, `RECOVERY`, `EFFECT_RETRY`, `ROUTE_SELECTION`,
`SPEND_AUTHORIZATION`, `CANCELLATION`, `TOOL_EXECUTION`, `PUBLICATION`,
`BUSINESS_LEDGER`, `ENGINE_JOURNAL`, `WORKING_MEMORY`, `PERSISTENT_MEMORY`,
`RETRIEVAL_INDEX`, `CHECKPOINT`.
`ResourceKind`: `BUSINESS_LEDGER`, `ENGINE_JOURNAL`, `WORKING_MEMORY`,
`PERSISTENT_MEMORY`, `RETRIEVAL_INDEX`. Sus claims exigen resourceSlot; otros
claims lo prohíben. No confundir dos formas de estado porque ambas persistan.

Para V1, autoridad de todos los scopes = autoridad exacta de la revisión admitida;
las restricciones y permisos del perfil sólo pueden reducirla. Todo efecto se
valida con el enforcement existente de esa revisión y la política de datos
referenciada. No se inventa un comparador genérico de políticas por sus hashes.
Una delegación que necesite otra autoridad o un DSL de permisos no interpretable
por enforcement existente es UNSUPPORTED en este packet. Presupuesto: todos los
scopes consumen el mismo techo/reserva autorizado; los límites de scopes son
subtechos de conteo/deadline, nunca bolsas de dinero independientes.
requiredGuarantees se une con lo obligatorio del envelope/política: BASE_INVOCATION
y AUTHORITY_ENFORCEMENT siempre; un límite monetario obligatorio exige HARD_COST_BOUND;
una solicitud de uso exacto exige USAGE_MEASUREMENT; control de retries de efectos
anidados exige NESTED_RETRY_CONTROL, y no-duplicación interna exige
INTERNAL_DUPLICATE_SUPPRESSION. La reentrega automática de una invocación sin
prueba previa de no-despacho exige OBSERVABLE_DELIVERY_IDEMPOTENCY. El usuario no
elimina una exigencia del envelope omitiendo su fila. Para una invocación opaca,
maxEffectsCount/maxDispatchAttempts cuentan efectos/despachos ACP observables,
no llamadas internas del proveedor; un límite solicitado de llamadas internas
requiere visibilidad/control de ese nivel y no se vende como cumplido por el externo.

### 3.3 Petición y resultado

`PreflightCompositionV1`:

```
taskId: Id
revisionNumber, attemptNumber: integer >= 1
invocationId: Id                 # existente DurableInvocation, no ID de vendor
envelopeSha256: Sha256
planId: Id
planArtifactReferenceId: Id
planRevisionSha256: Sha256
installation: DocumentPin
policy: DocumentPin
sourceHeads: SourceHead[]        # cuatro filas, un corte por stream
evaluatedAt: Timestamp           # entrada fijada antes de evaluar
```

El servicio obtiene el envelope por referencia autorizada de su revisión y
modelo/asignación por sus dueños al vector fijado. Reutiliza errores de cuentas,
cuota y routing; no los convierte en conflictos de composición. No copia modelos,
ratings, precios o credenciales en perfiles. Campos internos de engine, prompts y
cuenta resuelta no se agregan a la preimagen `envelope_sha256`.

Resultado cerrado: `{compositionContractVersion:1, preflightId:Sha256,
support:SUPPORTED|UNSUPPORTED|UNKNOWN, compositionSha256:Sha256|null,
diagnostics:Diagnostic[], guarantees:GuaranteeResult[],
snapshot:CompositionSnapshotV1|null}`. GuaranteeResult es
`{nodeKey:LocalKey, guarantee:Guarantee, isRequired:boolean,
support:SUPPORTED|UNSUPPORTED|UNKNOWN, evidence:DocumentPin|null}`; exactamente una
fila por garantía/nodo considerado. evidence NULL cuando no hay documento
aplicable, nunca un recibo inventado. Se conserva la matriz también en rechazo.
Snapshot/digest presentes sii SUPPORTED. Forma exacta y preimágenes únicas en
§3.5; no hashear objetos abiertos ni prosa descriptiva.

`Diagnostic`:

```
diagnosticId: Sha256
ruleCode: código cerrado de validación §4
severity: ERROR | UNKNOWN | INFO
refusalClass: RefusalClass | null
scopeKey: LocalKey | null
at: JSON Pointer canónico de petición/plan/perfil
participants: {nodeKey: LocalKey, profile: DocumentPin | null}[]
remedyCode: código cerrado de validación §4
```

Participante con perfil NULL significa referencia no resoluble; no perfil
inventado. `refusalClass` NULL sólo en INFO. El id hashea code/scope/at/participantes
canónicos. La prosa localizada se renderiza desde códigos; no integra el digest,
no se almacena salida de vendors. Mismo input/versión produce mismos bytes en CLI
y API; orden: severity ERROR, UNKNOWN, INFO, luego scope nulo primero, ruleCode,
at, participantes por byte ordinal. Deduplicar sólo diagnósticos idénticos por id.

### 3.4 Catálogo cerrado de operación → responsabilidades

Identificadores del descriptor V1, no renombramientos de métodos ni anuncios de
soporte. contractVersion es exactamente 1 en todas las filas; cualquier otra
clave rechaza VERSION_UNSUPPORTED. La correspondencia real se prueba en el edge.

| contractId / operation | Puerto/verbo o protocolo dueño | Owners adicionales del scope seleccionado |
| --- | --- | --- |
| acp.execution / START | ModelExecutionPort.start | EFFECT_RETRY, CANCELLATION, ROUTE_SELECTION, SPEND_AUTHORIZATION |
| acp.orchestration / ADVANCE | OrchestrationDriver.advance | SCHEDULING, RECOVERY, CHECKPOINT |
| acp.orchestration / STATUS | OrchestrationDriver.status | ninguno; sólo lectura |
| acp.orchestration / RECONCILE | OrchestrationDriver.reconcile | RECOVERY |
| acp.orchestration / CANCEL | OrchestrationDriver.cancel | EFFECT_RETRY, CANCELLATION |
| acp.orchestration / REATTACH | OrchestrationDriver.reattach | RECOVERY |
| acp.orchestration / SIGNAL | OrchestrationDriver.signal | EFFECT_RETRY, SCHEDULING |
| acp.orchestration / TIMER | OrchestrationDriver.timer | EFFECT_RETRY, SCHEDULING |
| acp.tools / LIST | ToolProtocolPort.listTools | ninguno; sólo consulta |
| acp.tools / CALL | ToolProtocolPort.callTool | EFFECT_RETRY, CANCELLATION, TOOL_EXECUTION |
| acp.checkpoint / READ | CheckpointPort.read | CHECKPOINT |
| acp.checkpoint / PERSIST | CheckpointPort.persist | EFFECT_RETRY, CHECKPOINT |
| acp.artifacts / READ | resolución autorizada de referencia, artifacts §2 | ninguno; sólo lectura autorizada |
| acp.artifacts / PUBLISH | protocolo de publicación, artifacts §3 | EFFECT_RETRY, PUBLICATION |
| acp.telemetry / EXPORT | TelemetryExporterPort.export | ninguno sobre el trabajo observado; egress/entrega limitados del exporter |

Única función OperationKey→responsabilidades; se suman obligaciones estructurales
del paso 6 de validación §4, no heurísticas por verbo. Consultas no crean efectos ficticios. Telemetría
conserva su outbox, no crea ejecución de modelo ni duplica costo de las fuentes.
Cada admisión/dispatch identifica executorNodeKey y valida su selección EXACTA
(nodeKey,scopeKey,OperationKey), no sólo la oferta del adapter. Operación ofrecida
pero no seleccionada => OPERATION_NOT_SELECTED antes de crear intención.

### 3.5 DTO strict y preimágenes únicas

Todos los objetos siguientes son strict: todas las propiedades son obligatorias,
sin otras claves. null sólo donde aparece "|null"; [] es colección vacía.
PosInt = entero seguro >=1; Count = entero seguro >=0. LocalKey, Id, Sha256 y
Timestamp son §3; nombres de enums son los vocabularios cerrados ya declarados.
OperationName es la unión de los verbos de §3.4, con refinamiento obligatorio de
la tupla contractId/contractVersion/operation. RegistryDocumentKind reutiliza el
catálogo canónico de documentos versionados más las cuatro extensiones §3.1.

```
CompositionSnapshotV1 = strict {
 compositionContractVersion: 1,
 request: PreflightCompositionV1,
 sourceDocuments: SnapshotSourceDocumentV1[],
 scopes: SnapshotScopeV1[],
 nodes: SnapshotNodeV1[],
 resources: SnapshotResourceV1[],
 nodeResources: SnapshotNodeResourceV1[],
 operationSelections: SnapshotOperationSelectionV1[],
 dependencies: SnapshotDependencyV1[],
 claims: SnapshotClaimV1[],
 delegations: SnapshotDelegationV1[],
 owners: SnapshotOwnerV1[],
 dataFlows: SnapshotDataFlowV1[],
 guarantees: GuaranteeResult[]
}
SnapshotSourceDocumentV1 = strict {
 documentId:Id, documentVersion:PosInt, documentKind:RegistryDocumentKind,
 contentSha256:Sha256, registrySequence:PosInt, registryEventSha256:Sha256
}
SnapshotScopeV1 = strict {
 scopeKey:LocalKey, parentScopeKey:LocalKey|null, scopeKind:RUN|SUBWORK|OPERATION,
 maxEffectsCount:Count, maxDispatchAttempts:PosInt, deadlineAt:Timestamp
}
SnapshotNodeV1 = strict {
 nodeKey:LocalKey, scopeKey:LocalKey, installationMemberKey:LocalKey,
 profileDocumentId:Id, profileDocumentVersion:PosInt,
 effectBoundary:ACP_INVOCATION|NESTED_EFFECTS,
 retryMode:NONE|OPAQUE_INTERNAL|MEDIATED,
 fallbackMode:NONE|OPAQUE_INTERNAL|MEDIATED,
 delegationMode:NONE|KEYED_SUBWORK,
 cancellationSupport:NONE|REQUEST|TERMINATE,
 continuityKind:NONE|CHECKPOINT|LIVE_MIGRATION,
 effectAccounting:UNKNOWN|AGGREGATE|ALL_DISPATCHES,
 enforcement:NONE|INVOCATION_FENCED|ACP_MEDIATED
}
SnapshotResourceV1 = strict {
 resourceKey:LocalKey, resourceKind:ResourceKind, resourceIdentitySha256:Sha256
}
SnapshotNodeResourceV1 = strict {
 nodeKey:LocalKey, resourceSlot:LocalKey, resourceKey:LocalKey
}
SnapshotOperationSelectionV1 = strict {
 nodeKey:LocalKey, scopeKey:LocalKey,
 contractId:Id, contractVersion:1, operation:OperationName
}
SnapshotDependencyV1 = strict {
 consumerNodeKey:LocalKey, requirementKey:LocalKey, supplierNodeKey:LocalKey,
 contractId:Id, contractVersion:1, operation:OperationName
}
SnapshotClaimV1 = strict {
 nodeKey:LocalKey, claimKey:LocalKey, responsibility:Responsibility,
 extent:SELF|SUBTREE, claimRole:OWNER|OBSERVER, isDelegable:boolean,
 resourceKey:LocalKey|null
}
SnapshotDelegationV1 = strict {
 delegationKey:LocalKey, parentNodeKey:LocalKey, childNodeKey:LocalKey,
 childScopeKey:LocalKey, responsibility:Responsibility,
 resourceKey:LocalKey|null, subworkKey:Sha256
}
SnapshotOwnerV1 = strict {
 scopeKey:LocalKey, responsibility:Responsibility,
 resourceIdentityKey:Sha256|"NO_RESOURCE", nodeKey:LocalKey, claimKey:LocalKey
}
SnapshotDataFlowV1 = strict {
 producerNodeKey:LocalKey, consumerNodeKey:LocalKey,
 contractId:Id, contractVersion:1, operation:OperationName,
 flowKind:PIPELINE|OBSERVATION, dataPolicyReferenceId:Id, dataPolicySha256:Sha256
}
```

Mapeo exacto DTO→SQL: cada campo camelCase anterior corresponde al snake_case de
la tabla homóloga del diccionario; la lista de campos está congelada arriba, no
se infiere de columnas futuras. true→1, false→0; no otra conversión. preflight_id
y sequence del fold son metadatos, NO campos de esas filas wire. request va al
encabezado y sourceHeads a source_head; guarantees va a guarantee, descomponiendo
su pin en document_id/version y verificando contentSha256 contra source_document.
No introducirlo como segunda autoridad. Comprobar además todas las FK/nulidades/
invariantes del diccionario y la derivación exacta desde las fuentes.

Orden de arrays (comparación lexicográfica de tuplas, strings por bytes UTF-8,
enteros numéricamente); duplicados de clave rechazan:

| Array | Clave de orden/unicidad |
| --- | --- |
| sourceDocuments | documentId, documentVersion |
| scopes | scopeKey |
| nodes | nodeKey |
| resources | resourceKey |
| nodeResources | nodeKey, resourceSlot |
| operationSelections | nodeKey, scopeKey, contractId, contractVersion, operation |
| dependencies | consumerNodeKey, requirementKey |
| claims | nodeKey, claimKey |
| delegations | delegationKey |
| owners | scopeKey, responsibility, resourceIdentityKey |
| dataFlows | producerNodeKey, consumerNodeKey, contractId, contractVersion, operation, flowKind |
| guarantees | nodeKey, guarantee |
| request.sourceHeads | stream |

DocumentPin[] se ordena por (documentId,documentVersion,contentSha256); los demás
conjuntos de entrada por las claves §3.2. canonicalJson: UTF-8 sin BOM/salto final,
claves de objeto por bytes UTF-8, arrays normalizados, sin espacios; enteros
decimales seguros, null literal, sin undefined/NaN/-0/floats ni normalización
Unicode implícita. Reutilizar serializador del ledger si cumple este perfil.

CompositionInteractionV1 strict, todas las propiedades obligatorias:

```
{
 compositionContractVersion: 1,
 nodes: {nodeKey:LocalKey, profile:DocumentPin}[],
 scopes: {scopeKey:LocalKey,parentScopeKey:LocalKey|null,kind:RUN|SUBWORK|OPERATION}[],
 operationSelections: {nodeKey:LocalKey,scopeKey:LocalKey,operation:OperationKey}[],
 delegations: {delegationKey:LocalKey,parentNodeKey:LocalKey,childNodeKey:LocalKey,
  childScopeKey:LocalKey,responsibility:Responsibility,
  resourceClassOrdinal:integer>=0|null}[],
 dataFlows: {producerNodeKey:LocalKey,consumerNodeKey:LocalKey,operation:OperationKey,
  kind:PIPELINE|OBSERVATION,dataPolicySha256:Sha256}[],
 resourceClasses: {classOrdinal:integer>=0,resourceKind:ResourceKind,
  bindings:{nodeKey:LocalKey,resourceSlot:LocalKey}[]}[]
}
```

Extraer el componente seleccionado con sus scopes/ancestros y slots usados.
Agrupar slots por igualdad de (resourceKind,resourceIdentitySha256); ordenar
bindings por (nodeKey,resourceSlot), ordenar clases por su primer binding y asignar
classOrdinal contiguo desde 0. Cada slot aparece en exactamente una clase; ninguna
clase vacía. resourceClassOrdinal de delegación referencia esa clase, null sii su
responsabilidad no es de recurso. NO serializar direcciones, resourceIdentitySha256,
resourceKey de instalación, taskId, invocationId, cuenta, deadline ni autoridad.
La clase expresa igualdad, no identidad del backend.

Orden: nodes/nodeKey; scopes/scopeKey; operationSelections por
(nodeKey,scopeKey,contractId,contractVersion,operation); delegations/delegationKey;
dataFlows/(producerNodeKey,consumerNodeKey,contractId,contractVersion,operation,kind);
resourceClasses/classOrdinal; bindings/(nodeKey,resourceSlot).
LocalKeys son roles del preset; renombrarlos exige evidencia coincidente en V1,
sin algoritmo general de isomorfismo.

Preimágenes completas:

```
preflightId = SHA256(canonicalJson(["composition-preflight",1,PreflightCompositionV1]))
compositionSha256 = SHA256(canonicalJson(["composition-snapshot",1,CompositionSnapshotV1]))
PROFILE.subjectSha256 = SHA256(canonicalJson(["composition-profile",1,DocumentPin]))
INTERACTION.subjectSha256 = SHA256(canonicalJson(["composition-interaction",1,CompositionInteractionV1]))
diagnosticId = SHA256(canonicalJson(["composition-diagnostic",1,
 {ruleCode,severity,refusalClass,scopeKey,at,participants,remedyCode}]))
```

Los digests resultantes no entran en sus propias preimágenes. request sí contiene
evaluatedAt fijado antes de evaluar; snapshot/INTERACTION no contienen timestamps
de append ni texto localizado. No imponer UNIQUE(compositionSha256). Golden en [validación §8.1](../validation/index.md).


Los campos SQL y constraints se implementan desde el [diccionario de ejecución](../../../database/execution/composition/index.md). Ninguna adición posterior de columnas altera implícitamente estos DTO.
