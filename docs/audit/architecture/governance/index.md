# Gobernanza: identidad, permisos, protección de datos y auditoría

Dueño único del concepto **gobernanza del trabajo mediado**: quién es cada actor,
qué puede hacer cada uno sobre qué recurso, qué se evalúa antes de que un
contenido protegido salga de ACP, qué se registra, quién lo revisa y qué no se
promete.

[Índice](../../README.md) · [Arquitectura](../index.md) · [Contratos](../contracts/index.md) · [Datos](../database/index.md) · [Integraciones](../integrations/index.md) · [Requisitos](../../requirements/index.md) · [Tests](../../quality/testing/index.md) · [Roadmap](../../roadmap/index.md)

Estado: **extensión GOV planificada**. Ningún corte es `DESIGN_READY` ni
`SCOPE_FROZEN`; nada de esta página está implementado ni aceptado. No autoriza
implementación, migraciones, gasto, UI ni P9. La secuencia pertenece al
[roadmap](../../roadmap/index.md); los cortes y sus dueños, al
[registro de extensiones](../../roadmap/index.md#22-extensiones-de-producto-planificadas). El inventario de
[packets](../../implementation/packets/index.md) conserva sus 39 unidades baseline.

---

## 0. Observación histórica y propuesta vigente

La tabla conserva la observación anterior sobre `HEAD a804f2f`, con cambios de
otro workflow; no es una verificación de la instalación ni del HEAD actual.
Integración documental autorizada el 2026-09-26: no se ejecutó una migración ni
un test de seguridad. Las citas de código son localizadores históricos; cada
corte debe re-resolver fuente, schema, estado aplicado y comportamiento contra
su prestate. Leer una declaración de migración no prueba que se haya aplicado.

| Afirmación | Clase | Fuente |
| --- | --- | --- |
| Las escrituras del gateway y una única lectura privada (`taskEffectResult`) se protegen con un bearer único; no existe identidad de persona ni mínimo privilegio | observado históricamente en fuente | `packages/entrypoints/gateway/src/bearer/index.ts:5-35` (decisión 150) |
| `CredentialResolverPort` resuelve credenciales de **cuentas de proveedor**; una implementación `file://` | observado históricamente en fuente | `packages/domains/runtime/src/contracts/index.ts:219-229` |
| `OperatorIdentityPort` y `AuthorizationPort` | especificados; disponibilidad histórica pendiente | [integraciones](../integrations/index.md) fila 11 |
| La referencia de artefacto tiene `classification` (`PUBLIC_SAFE`, `INTERNAL`, `SENSITIVE`, `SECRET_BEARING`), `scope_kind`, `access_policy_id` y `retention_class`; existen las clases `POLICY_DOCUMENT`, `EVIDENCE` y `EXPORT` | declaración de schema observada históricamente; aplicación no probada | `packages/persistence/ledger/src/migrations/index.ts:2104-2162` |
| La identidad de un artefacto es `(artifact_reference_id, content_sha256, blob_generation)`: el mismo contenido publicado, reclamado y publicado otra vez son dos generaciones | declaración de schema observada históricamente; aplicación no probada | mismo archivo, `:2018-2029`, `:2175-2176` |
| La tabla de tombstones existe, con razón cerrada (`POLICY_EXPIRY`, `OWNER_REQUEST`, `LEGAL_HOLD_RELEASE`, `CORRUPTION`); el evento que la alimenta se rechaza por nombre en la puerta | observado históricamente en fuente | mismo archivo, `:2150-2155`, `:2217-2250` |
| `owner_approval_read_model` exige `initiative_id` y tipa `requested_by`/`decider_identity` como TEXT libre; `notification_read_model` particiona por `owner_stream` sin partición de `registry_events` | especificado | [planning §8](../database/planning/index.md), [avisos §1](../database/execution/notifications/index.md) |
| `initiative_events`, `registry_events` y `routing_assignment_read_model` existen | observado históricamente en fuente | mismo archivo, `:182`, `:609`, `:873` |
| `owner_approval_read_model`, `approval_wait_read_model` y `notification_read_model` | especificados; ausencia observada históricamente, a revalidar | [planning §8](../database/planning/index.md), [avisos](../database/execution/notifications/index.md) |
| Gate de capacidad y garantía `SUPPORTED`/`UNSUPPORTED`/`UNKNOWN` | especificado (P-23/garantías) | [contratos §2.0](../contracts/index.md) |
| Perfil `TRUSTED_PROCESS` y ausencia de sandbox | especificado; mecanismo pendiente de P-25 | [contratos §6.1](../contracts/index.md), integraciones fila 16 |
| Sinks protegidos y lecturas privadas autorizadas | especificado; inventario parcial probado por P-15/F | [tests §8.1](../../quality/testing/index.md) |

Todo lo demás de esta página es **propuesta de diseño**. Un documento no
convierte un requisito en aceptado.

---

## 1. Decisión del owner y propósito

El owner pidió agregar gobernanza y seguridad a la planificación del backend y a
las instrucciones del mock. Esta extensión se registra **separada** del baseline
de 121 filas, de los packets aceptados y de P9 diferido.

**Propósito.** Una organización puede dar autonomía a personas y a sus agentes
dentro de límites explícitos de datos, acciones y presupuesto; entender qué
pasó; y exigir aprobación humana para las acciones con consecuencias.

**No es** vigilancia encubierta de empleados, un puntaje de intención o lealtad,
un producto general de vigilancia del endpoint, ni una garantía de que todo mal
uso se pueda impedir. Los hallazgos describen **contenido y acciones**, nunca
califican a una persona. Quien inicia una acción retenida o bloqueada ve que lo
fue y por qué categoría.

**Invariantes de producto.**

- El producto sigue siendo local y usable por **un único operador** sin
  servicios de equipo. La colaboración de equipo es opcional.
- Sin tenancy obligatoria, sin `tenant_id` y sin base compartida de la
  organización ([datos §4](../database/index.md)). Usuarios o permisos de otro
  sistema de la organización sólo pueden entrar como **adapter opcional** detrás
  de los puertos neutrales de §4, nunca como tipos importados ni servicio
  requerido.
- La autenticación no es autorización.

---

## 2. Modelo de amenazas y fronteras de confianza

### 2.1 Activos

Contenido protegido (instrucción, contexto, argumentos y resultados de
herramientas, respuestas, exportaciones); credenciales; autoridad (grants,
políticas, aprobaciones, excepciones); evidencia y rastro de auditoría;
presupuesto.

### 2.2 Fronteras

| Frontera | Entre | Qué la cruza | Dónde se decide |
| --- | --- | --- | --- |
| B1 | persona → puertas (CLI, API, consola) en loopback | pedidos y decisiones con un principal autenticado | entrypoint, por `OperatorIdentityPort` y `AuthorizationPort` |
| B2 | plane → proceso o cliente del modelo | contexto enviado a un destino | punto EP1 de §6 |
| B3 | carga de trabajo → herramienta | llamada con argumentos | EP2 |
| B4 | plane → destino externo (exportación, receptor, aviso, red de herramienta) | bytes que salen de la máquina o del plane | EP4 |
| B5 | plane → almacenamiento (ledger, artefactos) | hechos y bytes privados | sinks protegidos, [tests §8.1](../../quality/testing/index.md) |
| B6 | plane → adapters opcionales (proveedor de identidad, clasificador) | aserciones y contenido a inspeccionar | §4; un clasificador externo es también egress (EP4) |

### 2.3 Amenazas en alcance

| ID | Amenaza | Defensa principal |
| --- | --- | --- |
| T1 | una carga de trabajo intenta exfiltrar contexto protegido por herramienta o red | EP2/EP4 con cobertura `ENFORCED` (§7) |
| T2 | una inyección de instrucciones lleva al agente a pedir más autoridad o a aprobarse | el modelo nunca decide aprobaciones (§11); la delegación no amplía (§5) |
| T3 | una persona amplía sus propios permisos o se autoaprueba | separación de funciones (§11) y política (§12) |
| T4 | aprobación vencida, repetida o sobre evidencia distinta | digest exacto del sujeto y CAS ([planning §8](../database/planning/index.md)) |
| T5 | un cambio de ruta o un fallback pagado envía contenido a un destino nuevo | re-evaluación de EP1 por destino (§8.3) |
| T6 | contenido sensible aparece en ledger, stream, logs, telemetría o DOM | payload público por allowlist (§10.2) |
| T7 | lectura o exportación no autorizada de evidencia | EP3 con acceso registrado (§9) |
| T8 | modificación parcial del ledger o borrado no autorizado de la auditoría | cadena de hash y verificación de integridad (§10.4) |

### 2.4 Fuera de alcance, declarado

- El administrador del host o el propio owner con acceso total a la máquina:
  puede reescribir ledger, cadena y cabezas de forma consistente.
- Tráfico fuera de ACP: otras aplicaciones, navegador, un CLI usado
  directamente fuera del plane. **Esta capacidad no lo observa ni lo controla.**
- Un proveedor comprometido que reutiliza lo que recibió.
- Malware con privilegios del sistema operativo.
- Separación de funciones entre personas que comparten la misma cuenta del
  sistema operativo: allí protege contra el agente y contra errores, no contra
  quien controla esa cuenta (§11.4).

---

## 3. Principales, cargas de trabajo, cuentas y perfiles AI

Cuatro identidades distintas que nunca se sustituyen entre sí:

| Identidad | Qué es | Identificador | Dueño |
| --- | --- | --- | --- |
| Principal humano | una persona o el operador local | `principal_id` opaco; `LOCAL_OPERATOR` o `PERSON` | `governance` (§4.3) |
| Carga de trabajo | un worker que ejecuta un paso | `worker_instance_id` y `worker_run_id` emitidos por el supervisor ([contratos §5](../contracts/index.md)) | `runtime` |
| Cuenta de proveedor | un login o credencial de un proveedor | `account_id` | `accounts` |
| Perfil AI | descripción privada reutilizable y revisionada, no principal ni worker | identidad estable y revisión exacta de perfil | `planning`, [extensión de perfiles](../database/planning/index.md#extensión-planificada-perfiles-equipos-e-historia) |

Reglas:

1. **Un login de proveedor no identifica a la persona que pide el trabajo.** Un
   `account_id` o un identificador de worker nunca ocupa un campo de principal,
   ni al revés. La forma del identificador no lo prueba: un campo de principal
   es una **referencia validada** (§3.1). Un perfil, nombre o retrato tampoco
   puede ocuparlo ni conceder permisos.
2. **Atribución de cada hecho gobernado**: *iniciador* (principal que pidió),
   *actor* (carga de trabajo que actúa por delegación), *ejecutor* (adapter o
   herramienta con versión y pin de schema) y *aprobador* (principal que
   decidió, si hubo). Un campo desconocido es `UNKNOWN` explícito, nunca se
   rellena con `LOCAL_OPERATOR`.
3. **Modo de un solo operador.** Al habilitar GOV-1, el bearer local o un
   desbloqueo local se asocia a un único principal `LOCAL_OPERATOR`. Sin política de gobernanza
   publicada, el comportamiento del producto base no cambia.
4. **Una carga de trabajo nunca tiene autoridad humana.** Actúa bajo una
   delegación implícita del iniciador, intersectada con la política del paso,
   limitada a la tarea y a su duración. No aprueba, no publica política y no
   delega fuera de lo que la política permite.

### 3.1 Referencia validada de principal

**Transición E1(b) adoptada.** Se conserva el schema y los actores del baseline.
GOV-1/GOV-6/GOV-8 poseen la futura transición explícita de productor,
migración/rebuild y validación antes de habilitar sujetos o avisos gobernados;
no se reserva un número de migración. P-28/P-30 baseline no esperan esta
transición. Las reglas siguientes describen el estado gobernado futuro, no
columnas ni seguridad ya instaladas. Un CHECK sintáctico no valida una persona.

Un campo que nombra a una persona (`initiator_principal_id`,
`issued_by_principal_id`, `requested_by` de una aprobación de gobernanza,
`decider_identity`, `recipient_operator_id`) contiene un `principal_id` y se
valida así:

1. **Forma canónica.** `principal_id` es hex de 64 minúsculas, acuñado por
   `governance` al registrar el principal y **nunca derivado** de un
   `account_id`, un `worker_instance_id` ni del sujeto de un proveedor de
   identidad. Un `ck_` impone la forma. La forma sola no prueba nada.
2. **Validación en la frontera y al despachar.** Al registrar el hecho y otra
   vez al consumir o despachar, el principal existe en `principal_read_model`
   a la cabeza vigente, su `principal_kind` es admisible para ese campo, su
   estado es `ACTIVE`, su vínculo de identidad (emisor y método de §4.1) sigue
   vigente y tiene la autoridad que el campo exige (por ejemplo `APPROVE` en el
   scope). Un identificador de cuenta o de worker reescrito con la forma de un
   principal falla porque no hay principal registrado con ese valor.
3. **FK sólo en la misma cohorte.** Dentro de la cohorte de `registry_events`
   (grants de scope `SYSTEM`, incidentes `SYSTEM`) la referencia es FK a
   `principal_read_model`. Entre streams, el evento lleva la referencia causal
   tipada existente (`causation_stream`, `causation_sequence`,
   `causation_sha256`) al hecho de `registry_events` que fijó el estado vigente
   del principal; un digest que no coincide es referencia inválida
   ([datos](../database/index.md)).
4. **Actores no humanos existentes.** Los tipos de evento que hoy registran un
   worker o el sistema como actor lo conservan. Las aprobaciones separan el tipo
   del actor en `requested_by_kind` (§11.1) en lugar de reetiquetarlo. Un actor
   histórico desconocido sigue `UNKNOWN`; nada se rellena hacia atrás.
5. **Operador local.** GOV-1 registra un único principal `LOCAL_OPERATOR` con
   identificador estable. Los avisos del producto base siguen llegando a ese
   principal; activar gobernanza no corta los avisos del operador legítimo.

---

## 4. Puertos y capacidades neutrales

### 4.1 Tabla

| Puerto o capacidad | Estado | Qué responde | Por qué hace falta | Qué **no** garantiza |
| --- | --- | --- | --- | --- |
| `CredentialResolverPort` | observado en fuente histórica (§0); revalidar | la credencial de una **cuenta de proveedor**, dentro de la frontera | ya separa credencial de dominio | no identifica personas ni autoriza nada |
| `OperatorIdentityPort` | especificado; esta página lo precisa | a qué `principal_id` corresponde una presentación local o una aserción externa, y con qué método (`LOCAL_UNLOCK`, `LOCAL_BEARER`, `EXTERNAL_ASSERTION`) | distinguir personas y atribuir | no autoriza; no prueba quién está frente al teclado; el proveedor externo es opcional |
| `AuthorizationPort` | especificado; esta página lo precisa | `ALLOW`, `DENY`, `REQUIRE_APPROVAL` o `INDETERMINATE` para una solicitud canónica (§6.2) | un único punto de decisión para todos los puntos de enforcement | no aísla procesos ni hace cumplir nada por sí solo: necesita mediación (§7) |
| `ContentInspectionPort` | **nuevo**; amplía la responsabilidad de clasificación de la familia 9 | hallazgos sobre contenido inspeccionado dentro de la frontera | detectores deterministas y adapters reemplazables sin cambiar la política | no detecta todo; no autoriza; no puede bajar una clasificación; un hallazgo falible no fija por sí solo una clasificación (§8.1) |
| Gate de garantías de P-23 | especificado | `SUPPORTED`, `UNSUPPORTED`, `UNKNOWN` por garantía de protección (§7.2) | reutiliza el evaluador existente; no crea otro | no convierte una declaración del adapter en prueba |
| `ExecutionEnvironmentPort` | especificado (fila 16, P-25) | confinamiento de filesystem, red e hijos | sin él un CLI con shell y red no es protegible | su ausencia se declara; no protege contra el host |
| Puerto de avisos | especificado (fila 18) | entrega de un aviso | avisar retenciones e incidentes | un aviso nunca concede autoridad |

No se crea otro registry de modelos, otro evaluador de capacidades ni otra
outbox.

### 4.2 Ubicación

- **Vocabulario compartido** (resultado de decisión, cobertura, acciones y
  puntos de enforcement) en `kernel/contracts`: lo consumen `runtime`,
  `planning`, `observation` y las puertas.
- **Cada contexto consumidor declara su `AuthorizationPort`** en sus `ports/`,
  como manda [arquitectura §4](../index.md); la composición de cada entrypoint lo
  adapta al caso de uso de `governance`. Un dominio no importa otro dominio.
- `OperatorIdentityPort` se declara en `governance`, su consumidor.
  `CredentialResolverPort` sigue en `accounts`/`runtime`. La fila de arquitectura
  que juntaba «credenciales e identidad» se separa: mezclarlas es exactamente la
  confusión persona/cuenta que el owner prohíbe.

### 4.3 Contexto nuevo `governance`

**Recomendación adoptada en este diseño.** Principales humanos, grants,
políticas de protección, hallazgos e incidentes son conceptos nuevos: no existen
en ningún contexto actual. Ubicarlos en `planning`, `runtime` u `observation`
obligaría a los otros dos a depender de él.

`governance` posee: semántica de principales y grants, documentos de política de
gobernanza, la función pura de decisión, hallazgos, incidentes y excepciones.
**No** posee: aprobaciones (siguen en `planning`, §11), artefactos (siguen en su
dueño, §9), cuentas, presupuesto ni ruteo. No es un servicio aparte ni otra base:
persiste por los streams existentes.

---

## 5. Recursos, acciones, permisos y delegación

### 5.1 Vocabularios cerrados

| Vocabulario | Valores |
| --- | --- |
| `governed_resource_kind` | `INITIATIVE`, `STEP`, `TASK`, `ARTIFACT`, `TOOL`, `DESTINATION`, `ACCOUNT`, `POLICY`, `GRANT`, `INCIDENT` |
| `governed_action` | `TASK_SUBMIT`, `PLAN_EDIT`, `CONTEXT_SEND`, `TOOL_EXECUTE`, `CONTENT_READ`, `EXPORT`, `EGRESS`, `SPEND_AUTHORIZE`, `APPROVE`, `GRANT_ISSUE`, `GRANT_DELEGATE`, `POLICY_PUBLISH`, `EXCEPTION_REQUEST`, `EVIDENCE_VIEW`, `EVIDENCE_EXPORT`, `INCIDENT_TRIAGE`, `RETENTION_DELETE` |
| `governance_scope_kind` | `SYSTEM`, `INITIATIVE`, `STEP` |

Una acción nueva es una versión del vocabulario, no un string libre.
`SPEND_AUTHORIZE` compone con la admisión de presupuesto de P-34; no la
reemplaza.

### 5.2 Grants

Un grant concede a un principal una **plantilla de rol** de una versión
publicada de política, sobre un scope, con vencimiento opcional. Las plantillas
(por ejemplo lector, contribuyente, aprobador, administrador de política,
auditor) son **contenido de política**, no enums cableados ni arquitectura de
tenant.

- Precedencia y techos como en la admisión: instalación → iniciativa → paso →
  override autorizado; **un override no ensancha un techo**
  ([contratos §5](../contracts/index.md)).
- Una denegación prevalece sobre un permiso del mismo nivel.
- Con una política de gobernanza activa, una acción protegida sin grant
  aplicable se deniega.

### 5.3 Delegación acotada

- Persona → carga de trabajo: implícita por tarea (§3 regla 4).
- Persona → persona: exige `GRANT_DELEGATE` sobre esa acción. Lo delegado es
  subconjunto del delegante en acciones, scope, techo de clasificación, destinos
  y vencimiento. Profundidad máxima por defecto: **1**.
- Revocar el grant padre invalida a sus hijos **en la evaluación**; no se
  reescriben filas.

### 5.4 Vencimiento y revocación

Un grant vencido deja de autorizar comparando `expires_at` contra el instante de
evaluación, sin evento de reloj. La revocación es un hecho con autoridad. Su
efecto sobre trabajo en curso está en §6.4.

---

## 6. Decisión de política y ciclo de una acción protegida

### 6.1 Puntos de enforcement obligatorios

| Punto | Antes de | Incluye |
| --- | --- | --- |
| EP1 `CONTEXT_SEND` | enviar contexto protegido a un modelo | **cada envío**, no una vez por tarea ni por segmento: la instrucción inicial, cada turno que devuelve resultados de herramienta al modelo y todo contexto de archivo, herramienta o sistema que entra después; cada segmento de ruta, también tras un handoff de cuenta o proveedor |
| EP2 `TOOL_EXECUTE` | ejecutar una herramienta | cada llamada, bajo su pin de schema (P-24) |
| EP3 `CONTENT_READ` | leer un resultado, artefacto, evidencia o fuente de recuperación, o armar una exportación | lecturas privadas por CLI y API |
| EP4 `EGRESS` | que bytes salgan del plane | exportación, clasificador externo, red de herramienta mediada |
| EP5 `GOVERNANCE_MUTATION` | emitir o revocar un grant, publicar política, decidir una aprobación de gobernanza | todas las puertas |

### 6.2 Solicitud canónica

Cada decisión evalúa una solicitud con preimagen declarada, digerida en
`request_sha256`: punto, acción, recurso (tipo, identificador, clasificación
efectiva), **identidad del contenido gobernado** (§6.5), digest de los
argumentos exactos de la herramienta, destino, cadena de atribución (§3),
coordenada tarea/efecto, revisión del plan, versión de política fijada y versión
cabeza, digest de composición, cobertura del punto, `finding_set_sha256` y
vector de watermarks. El reloj no entra en la preimagen; el instante de
evaluación se registra aparte.

Dos digests distintos, sin ambigüedad: `content_sha256` identifica **los bytes
gobernados**; `finding_set_sha256` resume el conjunto ordenado de hallazgos
sobre esos bytes. Ninguno sustituye al otro, y ningún texto dice «digest de
evidencia» sin decir cuál.

### 6.3 Resultados

| Resultado | Efecto | Estado de la tarea |
| --- | --- | --- |
| `ALLOW` | la operación sigue, con sus obligaciones (registrar evidencia, redactar, avisar) | sin cambio |
| `DENY` | la operación no ocurre; rechazo `AUTHORITY_REFUSED` o `CAPABILITY_UNSUPPORTED` con `at` | una llamada a herramienta devuelve error tipado al agente, nunca éxito (P-11); un envío de contexto denegado termina la tarea `FAILED` con causa cerrada, salvo que la política lo mapee a aprobación |
| `REQUIRE_APPROVAL` | la operación queda retenida hasta una aprobación exacta (§11) | `RUNNING → WAITING_APPROVAL` |
| `INDETERMINATE` | nunca permite una acción protegida; queda retenida | `RUNNING → WAITING_APPROVAL` con causa `GOVERNANCE_INDETERMINATE` |

**Enmienda propuesta a [contratos §2.1](../contracts/index.md)**, a integrar al
congelar GOV-3: la salida `WAITING_APPROVAL → RUNNING` admite, además de una
aprobación vigente con digest coincidente, una **nueva decisión `ALLOW`** que
referencia la retenida (causa del `INDETERMINATE` resuelta). No se agrega un
estado de tarea. Una aprobación no puede convertir un `INDETERMINATE` en permiso
salvo que la política marque ese punto como dispensable.

**La retención es por efecto.** Los demás pasos, tareas e iniciativas siguen.

### 6.4 Ciclo

```
solicitada → evaluada ─ ALLOW ─────────────→ revalidada al despachar → despachada → liquidada
                     ├ REQUIRE_APPROVAL → retenida → aprobación vigente → revalidada …
                     ├ INDETERMINATE ──→ retenida → nueva evaluación ALLOW → revalidada …
                     └ DENY ───────────→ rechazada
```

- **Revalidar al despachar**: versión cabeza de la política, grants, aprobación,
  cobertura, digest de composición, referencias de principal (§3.1) y la
  identidad exacta del contenido y de los argumentos (§6.5). «Una decisión
  verde no es un lock», igual
  que en [composición §4](../integrations/composition/index.md). Si cambió algo
  relevante, se evalúa de nuevo y la decisión nueva referencia a la anterior.
- **Asimetría deliberada.** Se evalúa contra la versión fijada en la admisión y
  contra la cabeza; **gana el resultado más restrictivo**. Un endurecimiento
  aplica en el siguiente punto de enforcement; una ampliación, sólo a decisiones
  nuevas.
- **Revocación.** Toda decisión posterior la ve. Un efecto ya despachado no se
  puede retirar: queda registrado. Un hijo con acceso no mediado se detiene y se
  reapea, o se confina, como exige [contratos §6.1](../contracts/index.md); si no
  se puede, la cobertura de ese perfil nunca fue `ENFORCED`.
- **Aprobación de un aprobador revocado.** El consumo revalida la autoridad
  ([planning §8](../database/planning/index.md)): si el grant que respaldó la
  decisión fue revocado antes del consumo, la aprobación no se consume.

### 6.5 Vinculación a bytes exactos

Una decisión o una aprobación de `ACTION` vale para **unos bytes**, no para una
ruta ni un nombre.

- **Contenido de artefacto.** Se vincula a la identidad existente
  `(artifact_reference_id, content_sha256, blob_generation)` (§0). Otra
  generación del mismo contenido es otra identidad.
- **Archivo vivo o contenido armado al vuelo** (un archivo del workspace, un
  paquete de exportación). Antes de inspeccionar, el plane lo captura como
  artefacto privado por el camino de publicación existente y se vincula a esa
  captura. No se crea otro almacén de contenido ni se copia contenido a la
  auditoría.
- **Argumentos y acción.** El digest de los argumentos exactos de la
  herramienta, el `destination_id` y la acción entran en la preimagen.
- **Último envío mediado.** El despacho envía **los bytes de la captura
  vinculada**, no vuelve a leer la ruta, y verifica `content_sha256`,
  `blob_generation`, argumentos y destino contra la decisión inmediatamente
  antes de que salgan. Si cambió cualquiera, incluidos bytes nuevos en la misma
  ruta, la aprobación anterior no se consume y se abre una solicitud nueva.
- Un tombstone de la captura antes del despacho vuelve inconsumible la
  aprobación (GONE).

---

## 7. Mediación completa y cobertura de protección

### 7.1 Tres niveles, por punto y por perfil

| Cobertura | Significa | Se muestra como |
| --- | --- | --- |
| `ENFORCED` | ACP media la operación y puede impedirla antes de que ocurra, con conformidad probada para ese adapter y perfil | protegido |
| `OBSERVE_ONLY` | ACP sólo ve después, o el adapter informa sin dejar bloquear | observado, no protegido |
| `UNSUPPORTED` | ni media ni observa | sin protección |

La evaluación `UNKNOWN` del gate no es `ENFORCED`. Inspeccionar la salida
después **es `OBSERVE_ONLY`** y nunca se etiqueta como protección.

### 7.2 Garantías nuevas en el gate existente

Se agregan al gate de P-23/garantías, junto a `HARD_COST_BOUND`, sin otro
evaluador: `MEDIATED_CONTEXT_SEND`, `MEDIATED_TOOL_EXECUTION`,
`MEDIATED_EGRESS`, `WORKSPACE_CONFINEMENT` y `PRE_SEND_INSPECTION`.
`SUPPORTED` exige evidencia de conformidad del perfil; una declaración sin
prueba queda `UNKNOWN`. `MEDIATED_CONTEXT_SEND` exige probar que **todo**
contexto que llega al modelo pasa por EP1 (§6.1), no sólo el primero.

La cobertura de EP1 de un perfil se declara en dos celdas: instrucción inicial
y contexto posterior (archivos, resultados de herramienta, contexto de sistema).
La cobertura de EP1 del perfil es **la menor** de las dos; nunca se informa
EP1 como `ENFORCED` si una celda no lo es.

### 7.3 Regla de perfil protegido

Un paso cuya política marca una acción como protegida exige `ENFORCED` en cada
punto que esa acción puede atravesar. Si falta, el preflight de composición
rechaza **antes de cualquier efecto** con `CAPABILITY_UNSUPPORTED`. Elegir un
perfil no protegido es una decisión explícita que la política puede prohibir, y
queda rotulada.

### 7.4 CLI no soportado

Un CLI local de proveedor ejecuta sus propias herramientas, shell y red. ACP
construye la instrucción inicial (EP1 mediable), pero **no media** lo que el CLI
hace después: lee archivos del workspace, corre herramientas y manda ese
contexto al proveedor sin pasar por EP1. Por eso:

- En un CLI, EP1 es `ENFORCED` **sólo para la instrucción inicial**. El
  contexto posterior es `UNSUPPORTED` hasta que se prueben mediación de
  herramientas y confinamiento (punto siguiente); la cobertura de EP1 del
  perfil es entonces `UNSUPPORTED` (§7.2), y se rotula «protegido sólo para la
  instrucción inicial». Nunca se informa protección completa del contexto.
- `TOOL_EXECUTE` y `EGRESS` de un CLI son `UNSUPPORTED` salvo que se prueben
  **las dos cosas**: todas sus herramientas pasan por el `ToolProtocolPort` de
  ACP, y el `ExecutionEnvironmentPort` confina red y filesystem al perfil.
  Hoy la fila 16 declara «sin sandbox» y P-25 no eligió mecanismo.
- **Las opciones de omisión de permisos del CLI no cambian la política de ACP.**
  ACP nunca se apoyó en el sistema de permisos propio del CLI; ese sistema sólo
  cuenta como garantía con evidencia de conformidad. Sin mediación real, el
  perfil protegido se rechaza.
- `TRUSTED_PROCESS` nunca satisface una garantía de protección.
- Los transportes API y local que devuelven las llamadas a herramienta al plane
  pueden alcanzar `ENFORCED` en EP2 cuando ACP ejecuta la herramienta, y en EP1
  sólo si **cada turno** que devuelve resultados al modelo pasa por EP1 y por
  las inspecciones que la política exige.

---

## 8. Protección de datos y egress

### 8.1 Clasificación

Se reutiliza el vocabulario documentado de `classification`. La clasificación
efectiva es el máximo entre la **declarada** (por el productor, la política o
un principal autorizado que confirma un hallazgo) y la que producen **reglas
deterministas** con autoridad (hallazgos `DETERMINISTIC_RULE`: rutas,
etiquetas de recurso, reglas de repositorio, destino).

Un hallazgo `PATTERN` o `CLASSIFIER_ADAPTER` es **falible**: nunca cambia la
clasificación efectiva por sí solo. Produce lo que la política defina para esa
categoría y banda: registrar, o `REQUIRE_APPROVAL` con revisión independiente
de esos bytes exactos (§6.5, §11.1). Nunca produce un `DENY` como única causa,
sea o no dispensable. Una autorización determinista independiente o una
clasificación declarada sí puede denegar. El triage no autoriza: hacen falta
aprobación exacta y evaluación fresca satisfactoria. **Ningún detector baja
una clasificación.**

Recuperación de un falso positivo, sin atajos:

1. Resolver el hallazgo como `FALSE_POSITIVE` (§10.5) registra evidencia de la
   revisión; no cambia decisiones pasadas ni la política.
2. Liberar la acción retenida exige una **autorización nueva y acotada**: una
   aprobación `ACTION` vinculada a la misma `decision_id`, los mismos bytes,
   argumentos, destino y `finding_set_sha256`, decidida por un principal con
   autoridad que no sea el iniciador (§11.2), y luego una evaluación nueva que
   da `ALLOW` sólo si pasan todas las reglas deterministas.
3. Eso libera **exactamente** esos bytes y esa acción. No concede un permiso
   más amplio, no vale para otra captura ni otro destino y no relaja la
   política.

Confirmar el hallazgo, en cambio, es una clasificación declarada con autoridad:
si confirma `SECRET_BEARING`, rige la regla no dispensable de §8.2.

### 8.2 Destinos aprobados

Todo egress apunta a un `destination_id` de la política:

- rutas de modelo: proveedor, versión de modelo, transporte y eje de consumo
  (suscripción, API, local), que **siguen siendo ejes distintos**;
- destinos de red de herramientas, aplicados por egress mediado;
- destinos de exportación;
- receptores de avisos y telemetría, que por ley de sinks protegidos nunca
  reciben contenido.

`CONTEXT_SEND` se permite sólo si el destino admite la clasificación efectiva.
Un contenido cuya clasificación **efectiva** (declarada o determinista, §8.1)
es `SECRET_BEARING` no sale nunca, y esa regla **no es dispensable**: ni una
excepción, ni una aprobación, ni una resolución de falso positivo la levantan.

### 8.3 Composición con presupuesto

Un handoff o un fallback de API autorizado por P-34 es un **destino nuevo** y
exige una decisión EP1 nueva. Autorizar gasto no autoriza datos, herramientas ni
destinos, y al revés. Un efecto en `OUTCOME_UNKNOWN` sigue bloqueando el
reintento ([contratos §7](../contracts/index.md)); ninguna autorización de
gobernanza lo evita.

### 8.4 Detectores

- Deterministas (`DETERMINISTIC_RULE`): reglas de política, etiquetas y rutas
  declaradas, centinelas de prueba. **Son la autoridad** junto con la
  clasificación declarada.
- Patrones de secreto o de datos personales (`PATTERN`): incluidos y útiles,
  pero **falibles**, con banda de confianza; siguen §8.1.
- Adapters opcionales (clasificador, DLP, `CLASSIFIER_ADAPTER`): señales
  falibles con categoría y banda de confianza. No son prueba de mala conducta
  ni única fuente de autorización.
  Un adapter externo es un destino más y pasa por EP4; el valor por defecto es
  local.
- **La inspección ocurre dentro de la frontera protegida** (memoria del proceso
  del plane). El hallazgo persiste categoría, confianza, detector y ubicación
  por referencia (`artifact_reference_id`, ordinal de bloque, digest del tramo),
  **nunca un extracto**. Ledger, stream, telemetría y DOM no reciben contenido
  para explicar un hallazgo.
- No se promete un detector universal. Lo que se prueba es la allowlist por
  frontera (§15).

### 8.5 Retención de contenido

GOV no copia prompts ni transcripciones. La política puede **acortar** la
retención de `PROMPT`, `TOOL_ARGUMENT` y `TOOL_RESULT`; su valor recomendado en
perfil protegido es `EPHEMERAL`. `RESPONSE` conserva la clase que exige la
lectura de resultado.

---

## 9. Artefactos protegidos, evidencia y retención

- **Acceso.** Toda lectura de `PROMPT`, `RESPONSE`, `TOOL_*`, `EVIDENCE` y
  `EXPORT` pasa por EP3. El `access_policy_id` de la referencia, identificado
  como valor cerrado en la observación histórica (decisión 59), pasa a nombrar un documento de
  política de gobernanza. Esto reemplaza el bearer único de la lectura privada
  por mínimo privilegio, dentro del perfil completo de lectura privada de P-36.
- **Registro de acceso.** Cada lectura, concedida o denegada, es una decisión
  registrada (`EVIDENCE_VIEW`, `CONTENT_READ`). No se crea otra tabla de accesos.
- **Evidencia.** Por defecto un hallazgo apunta al artefacto original; no se
  copia. Si la política exige capturar evidencia, se publica un artefacto
  `EVIDENCE`, `SENSITIVE`, con scope de iniciativa o tarea.
- **Exportación.** Artefacto `EXPORT` que contiene sólo evidencia autorizada y
  redactada; salir del plane es EP4.
- **Retención y borrado.** La política fija `retention_class` por clase. Vencer
  habilita reconciliación; el borrado es un tombstone con autoridad e
  irreversible por referencia; leer devuelve GONE. Se usan sólo las razones
  cerradas existentes: `POLICY_EXPIRY` para el vencimiento que fija la
  política, y `OWNER_REQUEST` **sólo** cuando lo emite el principal
  `LOCAL_OPERATOR` con `RETENTION_DELETE`. Otro principal no borra a pedido:
  puede proponer un cambio de retención (§12). No se agrega una razón nueva. Un pin `LEGAL_HOLD` impide la recolección. El hecho de auditoría
  saneado sobrevive al tombstone. **En la observación histórica el evento de tombstone se rechazaba en la
  puerta**; GOV-7 con P-36 debe revalidar y, si falta, habilitar ese camino.
- **Datos personales mínimos.** Los eventos llevan `principal_id` opaco. El
  nombre visible vive en una entrada de directorio publicada como documento de
  configuración privado; retirar a una persona es tombstone de esa entrada, y
  sus hechos quedan atribuidos a un principal retirado.
- **Sin otra autoridad.** Avisos, telemetría y stream llevan identificadores
  opacos y códigos cerrados.

---

## 10. Auditoría e incidentes

### 10.1 La auditoría son los streams

No hay store de auditoría aparte. Los hechos de gobernanza viven en el stream
del sujeto de vida más larga ([datos §4](../database/index.md)):

| Hecho | Stream |
| --- | --- |
| decisión y hallazgo sobre una tarea | `control_plane_events` |
| decisión sobre iniciativa, grant o política de scope `INITIATIVE`/`STEP`, incidente `INITIATIVE`, aprobación de scope `INITIATIVE`/`STEP` | `initiative_events` |
| principal, grant o política de scope `SYSTEM`, decisión `GOVERNANCE_MUTATION` sobre ellos, incidente `SYSTEM`, aprobación de scope `SYSTEM` | `registry_events` |

No se abre un quinto stream ni se inventa una iniciativa sintética. Un hecho
`SYSTEM` (por ejemplo, un intento no autorizado de emitir un grant global o
publicar una política global) abre su incidente en `registry_events`, sin
`initiative_id`.

### 10.2 Payload saneado

Allowlist versionada: identificadores opacos, digests, códigos cerrados, la
cuádrupla de política (`policy_document_id`, `policy_version`, `policy_sha256`,
`policy_artifact_reference_id`, el patrón ya especificado en
[planning §8.1](../database/planning/index.md)), resultado, cobertura, categoría,
banda de confianza y referencia autorizada de evidencia. **Nunca** extractos,
rutas crudas, URLs con credenciales, nombres de personas ni texto libre. Una
nota humana es un artefacto privado referido por `note_sha256`.

### 10.3 Procedencia

Un hecho anterior a la activación de gobernanza, o de un adapter sin atribución,
lleva procedencia `UNKNOWN` explícita. No se rellena hacia atrás.

### 10.4 Evidencia de manipulación, no inviolabilidad

La cadena de hash y `verifyIntegrity` sobre los cuatro streams detectan una
modificación que no recalcula cadena y cabezas, y un restore formal cambia el
`restore_id`. **No** impiden que el administrador del host reescriba todo de
forma consistente (§2.4). Se dice «evidente de manipulación dentro del modelo
declarado», nunca «a prueba de manipulación». Un anclaje externo de cabezas es
posible más adelante y no se promete aquí.

### 10.5 Ciclo del incidente

```
OPEN → TRIAGED → RESOLVED (CONFIRMED | FALSE_POSITIVE | ACCEPTED_RISK | DUPLICATE)
  ↑                   │
  └──── reapertura ───┘
```

- Se abre por una regla de política o por un principal con `INCIDENT_TRIAGE`.
  Agrupa decisiones y hallazgos de un mismo scope: una iniciativa, o `SYSTEM`.
  Un incidente `SYSTEM` sólo lo ve quien tiene `INCIDENT_TRIAGE` en scope
  `SYSTEM`; los lectores de una iniciativa no lo ven ni lo cuentan.
- Toda corrección es un evento nuevo que referencia al anterior; nada se edita.
- **Falso positivo, de primera clase.** Marca el hallazgo, puede proponer un
  cambio de política (que sigue §12) y puede alimentar el corpus de evaluación
  del detector sólo por referencia saneada. **Nunca relaja la política
  automáticamente.**
- Resolver un incidente no cambia una decisión pasada. Una acción retenida sólo
  se libera por la autorización nueva y acotada de §8.1, con una decisión
  nueva que referencia la retenida.
- Ver incidentes exige `INCIDENT_TRIAGE`; ver su evidencia, `EVIDENCE_VIEW`.

---

## 11. Aprobación humana y colaboración opcional

### 11.1 Una sola autoridad de aprobación

Se reutiliza `owner_approval_read_model` y su espera durable
([planning §8 y §8.1](../database/planning/index.md),
[interacción §3](../contracts/interaction/index.md)). No se crea otra tabla ni
otro protocolo. Se mantiene el nombre de la tabla para no reabrir documentos;
su semántica es «aprobación con autoridad», decida el owner u otra persona.

**E1(b): baseline retenido, transición futura de GOV-1/GOV-6.** P-28 puede
crear o conservar su tabla baseline sin estos campos. Antes de habilitar los
sujetos gobernados, GOV-1/GOV-6 congelan productor, diccionario físico,
migración/rebuild y principal local estable con validación real. No se
reetiquetan actores históricos ni se bloquea indefinidamente P-28. Lo siguiente
es el contrato objetivo de esa transición, no una orden de DDL anticipado:

1. `subject_kind` suma `ACTION`, `POLICY`, `EXCEPTION` y `GRANT` a los cuatro
   actuales.
2. **Partición por `owner_stream`**, con el idiom de
   [avisos](../database/execution/notifications/index.md):
   `initiative_events` para scope `INITIATIVE`/`STEP` y `registry_events` para
   scope `SYSTEM`. `ck_owner_approval_read_model__owner`: `initiative_id NOT NULL`
   sii `owner_stream = 'initiative_events'`; los cuatro sujetos actuales sólo en
   esa partición. El OCC de planning §8 compara la cabeza del stream de la
   partición (la iniciativa, o `registry_events`). No se inventa una iniciativa.
3. **Actores.** `requested_by_kind` NOT NULL, `ck_` (`PRINCIPAL`, `WORKLOAD`,
   `SYSTEM`); para los cuatro sujetos actuales conserva el actor que su tipo de
   evento ya registra, y para los sujetos de gobernanza es `PRINCIPAL`.
   Cuando es `PRINCIPAL`, `requested_by` es una referencia validada de §3.1.
   En la transición gobernada, `decider_identity` es una referencia validada de §3.1 de un
   principal `LOCAL_OPERATOR` o `PERSON`, con el `ck_` de forma; la validación
   se repite al consumir.
4. **Sujeto de `ACTION`.** `subject_id` es la `decision_id` retenida.

| Sujeto | `subject_id` | `subject_revision_sha256` |
| --- | --- | --- |
| `ACTION` | `decision_id` retenida | `request_sha256` de esa decisión: acción, recurso, `content_sha256` y `blob_generation` de los bytes vinculados (§6.5), digest de argumentos, destino, revisión de plan, `finding_set_sha256`, versión de política, scope y vencimiento |
| `POLICY` | documento de política | digest de la versión de política candidata |
| `EXCEPTION` | descriptor de excepción | digest del descriptor de excepción |
| `GRANT` | descriptor de grant | digest del descriptor de grant |

Las aprobaciones del producto base (plan, paso, commit, tarea) siguen iguales y
el operador local las sigue decidiendo.

### 11.2 Separación de funciones

Por defecto activa para `GRANT`, ampliaciones de `POLICY`, `EXCEPTION` y
`ACTION` protegida; la política puede exigirla en más casos.

- Quien decide no es el iniciador ni el beneficiario.
- Para `POLICY`, quien decide no es autor del borrador.
- Quien decide es un principal `PERSON` o `LOCAL_OPERATOR`. **Nunca** una carga
  de trabajo, un adapter, un decisor delegado o un modelo.
- La autoridad de quien decide cubre el scope con `APPROVE` y no deriva del grant
  que se está aprobando.

### 11.3 Reglas de la decisión

- Un mensaje de chat o una nota **no aprueba**. Sólo la operación de decidir con
  versión esperada.
- Si cambia cualquier campo de la preimagen, la aprobación no se consume; la
  solicitud vieja se cancela con causa `SUPERSEDED` y se abre otra.
- Reasignar: cancela con causa `REASSIGNED` y abre una nueva con el mismo digest.
- Concurrencia y repetición: el CAS y la idempotencia de planning §8.
- Vencimiento explícito con `expires_at`.

### 11.4 Modo de un solo operador y equipos

- **Último aprobador elegible perdido (E2).** Suspensión, retiro o vencimiento
  deja las acciones afectadas retenidas con `NO_ELIGIBLE_APPROVER`. Se conserva
  evidencia y se avisa a administradores autorizados sólo por canales
  soportados. La recuperación usa un principal independiente **ya autorizado**,
  bajo grants y separación vigentes, seguido de evaluación fresca. Si no
  existe, se requiere provisión de identidad/administración autorizada por
  separado; no hay fallback al bearer local, modelo, persona de demostración,
  autoaprobación ni capacidad nueva de emergencia. Trabajo no afectado y
  lecturas ya autorizadas continúan.

- Una regla que exige una segunda persona no se satisface con un solo principal:
  la acción queda retenida con «requiere otra persona». Publicar una política
  cuya aprobación no tiene aprobador posible se rechaza en la previsualización
  (§12).
- Los proveedores de identidad son adapters opcionales. Si uno falla, las
  sesiones nuevas de sus principales fallan cerradas y `LOCAL_OPERATOR` no
  hereda su autoridad. «La lectura local sigue» significa **sólo** lo que la
  política autoriza al principal `LOCAL_OPERATOR`: una caída no expone
  incidentes ni evidencia privados del equipo, no permite decidir en nombre de
  un revisor y no desactiva la gobernanza.
- **Cambio de modo.** Con una política de gobernanza activa, ningún interruptor
  ordinario vuelve al modo de un solo operador ni retira un perfil gobernado.
  Desactivar la gobernanza o quitarle alcance es una publicación de política
  que cuenta como ampliación (§12.2), con previsualización de impacto y
  aprobación. Un reinicio de demostración del mock usa fixtures separados y
  rotulados; no es un cambio de modo del producto.
- **Alcance de red.** El plane sigue en loopback (requisito H2). Esta extensión
  no abre un listener ni define acceso remoto; el acceso multiusuario o entre
  máquinas es una release posterior ([roadmap §7](../../roadmap/index.md)). En
  un solo host, la separación de funciones protege contra el agente y contra
  errores, no contra quien controla la cuenta del sistema operativo.
- **Avisos.** Opcionales. E1(b) conserva el baseline de P-30. La transición
  futura GOV-1/GOV-8, después de validación real de principales, propone que
  `kind` de `notification_read_model` sume `GOVERNANCE_HOLD` e `INCIDENT_OPENED`, y
  `recipient_operator_id` es una referencia validada de §3.1 (el aviso base al
  operador local va a su principal `LOCAL_OPERATOR`). Esta extensión **no**
  agrega una partición `registry_events` a avisos: una retención o un incidente
  `SYSTEM` se ve en Actividad y en solicitudes, sin aviso. La entrega nunca
  concede autoridad, y su fallo nunca bloquea ni evade una decisión.

---

## 12. Cambios de política y excepciones

### 12.1 Documento de política

Documento de configuración versionado con identidad estable
([datos §7](../database/index.md) regla 8), publicado como artefacto
`POLICY_DOCUMENT`. Scope `SYSTEM` en `registry_events`; `INITIATIVE` y `STEP`
en `initiative_events`, como las asignaciones de ruteo. Contiene reglas
(acciones protegidas, destinos por clasificación, detectores requeridos,
aprobaciones y separación de funciones, retención, plantillas de rol). **Quién
tiene qué** no está en el documento: son grants.

### 12.2 Ciclo

| Etapa | Qué pasa | Efecto |
| --- | --- | --- |
| Borrador | artefacto privado, no efectivo | ninguno |
| Prueba | se evalúa contra un corpus sintético versionado, sin llamar modelos | resultados registrados por digest |
| Previsualización | diff contra la versión efectiva sobre solicitudes registradas (sin contenido), acciones retenidas y grants que cambian | conteos por transición de resultado |
| Publicación | append de versión con CAS sobre la cabeza del documento | efectiva según §6.4 |

**Ampliar** exige una aprobación `POLICY` de un principal con `POLICY_PUBLISH`
en el scope que no sea el autor. Una casilla de confirmación no alcanza. Se
considera ampliación todo cambio en que alguna solicitud pasa a un resultado más
permisivo, aparece un destino o techo nuevo, se quita una aprobación o una
separación, se extiende retención, o se desactiva la gobernanza o se le quita
alcance (§11.4). Si la clasificación del cambio es incierta, **se trata como
ampliación**. Restringir puede publicarlo directamente un
principal autorizado. Volver atrás es una versión nueva.

### 12.3 Excepciones

Grant de tipo `EXCEPTION`: scope acotado, acciones, destino, techo de
clasificación, motivo con código cerrado y nota privada, **vencimiento
obligatorio** con máximo fijado por política, y aprobador distinto del
solicitante con autoridad que la contiene. No se pueden exceptuar reglas no
dispensables: egress de contenido con clasificación efectiva `SECRET_BEARING`
(§8.1), cobertura `UNSUPPORTED` en un perfil
protegido, y separación de funciones sobre grants. Cada decisión que usa una
excepción la referencia.

---

## 13. Entidades, claves y relaciones propuestas

Reglas: [datos §3](../database/index.md) sin excepción (`STRICT`,
`lower_snake_case`, `*_id`, `*_sha256`, `*_at`, `ck_`/`ux_`/`ix_`/`fk_`), sin
`tenant_id`, sin JSON para relaciones consultadas, FK sólo dentro de una cohorte
y referencias entre streams tipadas con digest. **Sin número de migración**: lo
asigna serialmente el packet que la aterrice. El diccionario físico definitivo
se escribe en una hoja de datos al declarar `DESIGN_READY` cada corte.

### 13.1 Lo que se reutiliza

| Objeto | Cambio |
| --- | --- |
| `registry_events`, `initiative_events`, `control_plane_events` | tipos de evento nuevos, sin stream nuevo (§10.1) |
| `artifact_reference_read_model` | ninguno de forma; `access_policy_id` nombra política de gobernanza; se reutilizan `POLICY_DOCUMENT`, `EVIDENCE` y `EXPORT` |
| `artifact_tombstone_read_model`, pin `LEGAL_HOLD` | habilitar el camino de tombstone (§9) |
| `owner_approval_read_model` (baseline conservado) | transición futura GOV-1/GOV-6: `subject_kind`, `owner_stream`, `requested_by_kind` y principales validados; migración/rebuild explícitos antes de habilitar gobernanza, no antes de P-28 (§11.1) |
| `approval_wait_read_model` (especificado) | sin cambio |
| `notification_read_model` (baseline conservado) | transición futura GOV-1/GOV-8: `kind` y destinatario validado; migración/rebuild explícitos antes de avisos gobernados, no antes de P-30 (§11.4) |

La entrada de directorio de personas usa `POLICY_DOCUMENT`: ampliar el enum de
clases de una tabla existente puede exigir reconstruirla, y la clase describe
«documento de configuración», no su tipo.

### 13.2 Proyecciones nuevas

Seis tablas, todas derivadas y reconstruibles: `principal_read_model`,
`access_grant_read_model`, `governance_decision_read_model`,
`content_finding_read_model`, `incident_read_model` e
`incident_decision_read_model`.

**`principal_read_model`** — fuente `registry_events`.

| Columna | Nulidad | Semántica |
| --- | --- | --- |
| `principal_id` | NOT NULL | PK; forma y validación de §3.1; nunca derivado de un `account_id` ni de un worker |
| `principal_kind` | NOT NULL | `ck_`: `LOCAL_OPERATOR`, `PERSON` |
| `principal_state` | NOT NULL | `ck_`: `ACTIVE`, `SUSPENDED`, `REMOVED` |
| `identity_binding_sha256` | NULL | digest de adapter de identidad y sujeto externo; `NULL` sii `LOCAL_OPERATOR`; nunca el sujeto crudo |
| `directory_reference_id` | NULL | referencia a la entrada de directorio; `NULL` si no se registró nombre o fue retirada |
| `registered_sequence`, `applied_sequence` | NOT NULL | — |

`ux_principal_read_model__principal_kind__local_operator` (parcial: un único
`LOCAL_OPERATOR`); `ux_principal_read_model__identity_binding_sha256__active`
(parcial, no `NULL` y no `REMOVED`).

**`access_grant_read_model`** — particionada por `owner_stream`
(`registry_events` para `SYSTEM`, `initiative_events` para `INITIATIVE`/`STEP`),
con cohorte declarada como la de [avisos](../database/execution/notifications/index.md).

| Columna | Nulidad | Semántica |
| --- | --- | --- |
| `grant_id` | NOT NULL | PK |
| `owner_stream` | NOT NULL | `ck_` de dos valores |
| `grant_kind` | NOT NULL | `ck_`: `ROLE`, `DELEGATION`, `EXCEPTION` |
| `principal_id` | NOT NULL | referencia validada (§3.1); FK sólo en la partición `registry_events` |
| `scope_kind` | NOT NULL | `ck_`: `SYSTEM`, `INITIATIVE`, `STEP` |
| `initiative_id` | NULL | `NULL` sii `SYSTEM` |
| `step_id` | NULL | `NOT NULL` sii `STEP`; identificador estable entre versiones de roadmap |
| cuádrupla de política | NOT NULL | versión publicada que define la plantilla o regla |
| `role_template_id` | NULL | `NOT NULL` sii `ROLE` o `DELEGATION` |
| `exception_document_id`, `exception_document_version`, `exception_document_sha256` | NULL | los tres `NOT NULL` sii `EXCEPTION` |
| `parent_grant_id` | NULL | `NOT NULL` sii `DELEGATION` |
| `issued_by_principal_id`, `authority_sha256` | NOT NULL | quién emitió y bajo qué autoridad |
| `approval_id` | NULL | cuando la política exigió aprobación |
| `grant_state` | NOT NULL | `ck_`: `ACTIVE`, `REVOKED`. El vencimiento **no** es estado: se compara al evaluar |
| `expires_at` | NULL | `NOT NULL` para `EXCEPTION` y `DELEGATION` |
| `revoked_at`, `revoked_reason_code` | NULL | par, `NOT NULL` sii `REVOKED` |
| `issued_sequence`, `applied_sequence` | NOT NULL | — |

`ix_access_grant_read_model__principal_id_grant_state`,
`ix_access_grant_read_model__scope_kind_initiative_id_step_id`. Las acciones y
destinos de una plantilla o excepción viven en su documento versionado, que el
evaluador lee entero; no se consultan por SQL.

**`governance_decision_read_model`** — particionada por `owner_stream` (tres
valores, §10.1).

| Columna | Nulidad | Semántica |
| --- | --- | --- |
| `decision_id` | NOT NULL | PK; hex de 64, determinista desde la preimagen de idempotencia (§14) |
| `owner_stream`, `recorded_sequence`, `applied_sequence` | NOT NULL | — |
| `enforcement_point`, `governed_action` | NOT NULL | vocabularios de §5.1 y §6.1 |
| `is_protected` | NOT NULL | `IN (0, 1)` |
| `initiative_id`, `task_id`, `effect_id` | NULL | `task_id` y `effect_id` `NOT NULL` para EP1 y EP2 |
| `request_sha256` | NOT NULL | §6.2 |
| `content_reference_id`, `content_sha256`, `blob_generation` | NULL | bytes vinculados (§6.5); los tres `NULL` o los tres `NOT NULL`, este último obligatorio si la acción lleva contenido; referencia tipada al artefacto, sin FK entre cohortes |
| `arguments_sha256` | NULL | `NOT NULL` para EP2 |
| `finding_set_sha256` | NULL | `NULL` sii no hubo hallazgos; distinto de `content_sha256` |
| cuádrupla de política | NOT NULL | versión decisiva |
| `pinned_policy_version` | NOT NULL | versión fijada en la admisión |
| `decision_outcome` | NOT NULL | `ck_`: los cuatro de §6.3 |
| `reason_code` | NOT NULL | cerrado |
| `coverage` | NOT NULL | `ck_`: `ENFORCED`, `OBSERVE_ONLY`, `UNSUPPORTED`, `UNKNOWN` |
| `composition_sha256` | NULL | `NULL` sólo fuera de una tarea |
| `provenance_status` | NOT NULL | `ck_`: `ATTRIBUTED`, `UNKNOWN` |
| `initiator_principal_id` | NULL | `NULL` sii `UNKNOWN` |
| `actor_worker_instance_id`, `executor_sha256`, `destination_id` | NULL | según el punto |
| `approval_id`, `exception_grant_id`, `supersedes_decision_id` | NULL | referencias tipadas |
| `decided_at` | NOT NULL | instante registrado, no del lector |

`ck_governance_decision_read_model__protected_allow_enforced`:
`CHECK ((is_protected = 0 OR decision_outcome <> 'ALLOW' OR coverage = 'ENFORCED') IS TRUE)`.
`ck_governance_decision_read_model__content_trio`: los tres campos de contenido
son todos `NULL` o todos `NOT NULL`.
`ix_governance_decision_read_model__task_id_effect_id`,
`ix_governance_decision_read_model__initiative_id_decision_outcome`.

**`content_finding_read_model`** — misma partición que su decisión.

| Columna | Nulidad | Semántica |
| --- | --- | --- |
| `finding_id` | NOT NULL | PK; determinista desde decisión, detector y ordinal |
| `decision_id` | NOT NULL | FK a la decisión, misma cohorte |
| `finding_ordinal` | NOT NULL | `>= 1` |
| `finding_category` | NOT NULL | `ck_`: `SECRET`, `PERSONAL_DATA`, `CLASSIFICATION_MARKER`, `PROTECTED_SOURCE`, `CUSTOM_RULE` |
| `detector_kind` | NOT NULL | `ck_`: `DETERMINISTIC_RULE`, `PATTERN`, `CLASSIFIER_ADAPTER` |
| `detector_id`, `detector_version` | NOT NULL | — |
| `confidence_band` | NOT NULL | `ck_`: `NOT_APPLICABLE` sii `DETERMINISTIC_RULE`; si no, `LOW`, `MEDIUM`, `HIGH` |
| `inspected_reference_id` | NOT NULL | referencia privada del contenido inspeccionado |
| `block_ordinal`, `span_sha256` | NULL | par |
| `evidence_reference_id` | NULL | sólo si la política capturó evidencia |

**`incident_read_model`** e **`incident_decision_read_model`** — particionadas
por `owner_stream` (`registry_events` para scope `SYSTEM`, `initiative_events`
para scope `INITIATIVE`), con el idiom de partición y cohorte de
[avisos](../database/execution/notifications/index.md) (§10.1).

| Columna | Nulidad | Semántica |
| --- | --- | --- |
| `incident_id` | NOT NULL | PK |
| `owner_stream` | NOT NULL | `ck_` de dos valores |
| `incident_scope_kind` | NOT NULL | `ck_`: `SYSTEM`, `INITIATIVE` |
| `initiative_id` | NULL | `NULL` sii `SYSTEM`; nunca una iniciativa sintética |
| `incident_state` | NOT NULL | `ck_`: `OPEN`, `TRIAGED`, `RESOLVED` |
| `severity` | NULL | `NOT NULL` desde `TRIAGED` |
| `resolution` | NULL | `NOT NULL` sii `RESOLVED`; `ck_` de §10.5 |
| `duplicate_of_incident_id` | NULL | `NOT NULL` sii `DUPLICATE` |
| `opened_by_kind` | NOT NULL | `ck_`: `POLICY_RULE`, `PRINCIPAL` |
| `opened_by_principal_id` | NULL | `NULL` sii `POLICY_RULE` |
| `assignee_principal_id` | NULL | — |
| `resolved_by_principal_id`, `resolved_at`, `authority_sha256` | NULL | trío `NOT NULL` sii `RESOLVED` |
| `reopen_count` | NOT NULL | `>= 0` |
| `note_sha256` | NULL | — |
| `opened_sequence`, `sequence`, `applied_sequence` | NOT NULL | — |

`ck_incident_read_model__owner`:
`CHECK (((owner_stream = 'registry_events' AND incident_scope_kind = 'SYSTEM' AND initiative_id IS NULL) OR (owner_stream = 'initiative_events' AND incident_scope_kind = 'INITIATIVE' AND initiative_id IS NOT NULL)) IS TRUE)`.

`incident_decision_read_model` (relación incidente–decisión, nombre según
[datos §3.1](../database/index.md)): PK `(incident_id, decision_id)`;
`owner_stream` igual al de su incidente, con FK a `incident_read_model` en la
misma cohorte; referencia causal tipada `causation_stream`,
`causation_sequence`, `causation_sha256` a la decisión, sin FK porque la
decisión puede estar en otro stream. Los hallazgos se alcanzan por
`content_finding_read_model.decision_id`; no se duplican.

### 13.3 Invariantes

1. Ninguna fila de gobernanza contiene bytes de contenido, nombres de personas
   ni credenciales.
2. Un `account_id` o un identificador de worker nunca aparece en un campo de
   principal: lo impide la validación de §3.1, no sólo la forma.
3. Quien decide una aprobación de gobernanza nunca es una carga de trabajo.
4. Para una acción protegida, la decisión precede a la intención del efecto en
   el mismo stream, y `ALLOW` exige `ENFORCED`.
5. Un grant vencido o revocado no autoriza aunque la proyección lo muestre
   activo.
6. Una reconstrucción al mismo vector de cabezas produce filas canónicas
   idénticas, sin reloj ni reevaluación de política.
7. Una aprobación de `ACTION` se consume sólo para los bytes, argumentos y
   destino de su decisión (§6.5).
8. Un hecho de scope `SYSTEM` nunca lleva `initiative_id`.

---

## 14. Fallos, recuperación e idempotencia

Clave de idempotencia de una decisión: `(effect_id o sujeto, enforcement_point,
request_sha256, policy_sha256)` con namespace de versión. Mismo contenido:
replay. Misma clave con otro resultado: conflicto tipado.

| Fallo | Acción protegida | Resto del trabajo | Recuperación |
| --- | --- | --- | --- |
| política ilegible o versión fijada ausente | `INDETERMINATE`, retenida | sigue | publicar o restaurar versión; nueva evaluación |
| excepción interna del evaluador | `INDETERMINATE`, nunca `ALLOW` | sigue | corregir; nueva evaluación |
| detector requerido caído | `INDETERMINATE`, retenida | sigue | restaurar; opcional caído: reglas deterministas y ausencia registrada |
| proveedor de identidad caído | sesiones nuevas de esos principales fallan cerradas; nadie decide en su nombre | `LOCAL_OPERATOR` lee sólo lo que la política le autoriza; la gobernanza sigue activa | restaurar; sin herencia hacia `LOCAL_OPERATOR` (§11.4) |
| intento de volver a un solo operador con política activa | rechazado salvo publicación aprobada (§11.4, §12.2) | sigue | ciclo de política |
| crash entre decisión e intención del efecto | replay: misma `decision_id`; revalidación al despachar | — | ledger |
| crash tras despacho, desenlace desconocido | `OUTCOME_UNKNOWN`; si era protegida, se abre incidente de egress incierto | sigue | reconciliar; sin reintento ciego |
| último aprobador elegible suspendido, retirado o vencido | `NO_ELIGIBLE_APPROVER`; evidencia retenida y avisos autorizados por canales soportados | trabajo no afectado y lecturas autorizadas siguen | principal independiente ya autorizado + evaluación fresca; si no existe, provisión separadamente autorizada; ningún self-bypass (§11.4) |
| aprobación concedida y evidencia cambiada | no consumible | sigue | nueva solicitud |
| bytes nuevos en la misma ruta, u otros argumentos, tras la aprobación | no consumible; se envían sólo los bytes de la captura vinculada o nada (§6.5) | sigue | nueva captura y solicitud |
| dos decisiones concurrentes sobre una aprobación | un ganador por CAS | — | la otra recibe conflicto |
| grant revocado durante la ejecución | la próxima decisión deniega; hijo no mediado detenido o confinado | sigue | — |
| publicación concurrente de política | CAS de cabeza; el perdedor vuelve a previsualizar | — | — |
| falla la publicación de evidencia exigida | `INDETERMINATE` (no hay `ALLOW` con obligación incumplida); un `DENY` sigue siendo `DENY` | sigue | reintentar publicación |
| aviso o telemetría caídos | sin efecto sobre la decisión | sigue | descartes contados |
| reloj que retrocede | vencimientos contra cota durable, como `WAIT_CLOCK_UNTRUSTED`; si no, `INDETERMINATE` | sigue | — |
| restore formal desde backup | `restore_id` nuevo; las revocaciones posteriores al backup se pierden, así que las acciones protegidas quedan **retenidas** hasta que un principal autorizado reconfirme grants y política con un evento propio | lectura sigue | reconfirmación registrada |
| reinspección del mismo contenido | mismo `finding_id` | — | replay |
| tombstone concurrente con lectura | exclusión efectiva de P-36; tras el tombstone, GONE | — | — |

---

## 15. Pruebas y aceptación medida

Siguen las clases y oráculos de [tests](../../quality/testing/index.md). Un mock
desarrolla un contrato; no prueba compatibilidad.

### 15.1 Negativos obligatorios

| ID | Hecho que debe falsar |
| --- | --- |
| N-GOV-01 | un `account_id` usado como principal es rechazado en la frontera (§3.1), no sólo por la forma |
| N-GOV-02 | un hecho sin iniciador conocido queda `UNKNOWN`, no `LOCAL_OPERATOR` |
| N-GOV-03 | una delegación que excede al delegante en acción, scope, techo o vencimiento se rechaza |
| N-GOV-04 | revocar el grant padre deniega la siguiente decisión del hijo |
| N-GOV-05 | un grant vencido no autoriza aunque la proyección diga `ACTIVE` |
| N-GOV-06 | una autoaprobación de ampliación de permisos se rechaza |
| N-GOV-07 | EP1 sin grant, con política activa, deniega antes de abrir proceso o gastar |
| N-GOV-08 | un handoff a otro proveedor o un fallback de API sin destino permitido deniega aunque el presupuesto lo autorice |
| N-GOV-09 | una llamada a herramienta denegada llega al agente como error, nunca como éxito |
| N-GOV-10 | una lectura de evidencia sin `EVIDENCE_VIEW` deniega y queda registrada |
| N-GOV-11 | un perfil protegido con un CLI no confinado se rechaza en el preflight, sin efectos |
| N-GOV-12 | una opción de omisión de permisos del CLI no cambia el resultado de N-GOV-11 |
| N-GOV-13 | una inspección posterior a la salida no produce cobertura `ENFORCED` |
| N-GOV-14 | un contenido `SECRET_BEARING` no sale por ningún destino, con excepción o sin ella |
| N-GOV-15 | un detector no puede bajar la clasificación efectiva |
| N-GOV-16 | un clasificador externo no configurado como destino no recibe contenido |
| N-GOV-17 | un mensaje de chat «sí» no cambia el estado de una aprobación |
| N-GOV-18 | cambiar evidencia, destino o versión de política vuelve inconsumible una aprobación |
| N-GOV-19 | una carga de trabajo o un decisor delegado no puede decidir una aprobación |
| N-GOV-20 | cancelación contra decisión, vencimiento contra decisión y decisión repetida: replay o conflicto tipado |
| N-GOV-21 | centinelas de contenido inspeccionado no aparecen en ningún sink protegido de tests §8.1, incluidos los eventos de gobernanza |
| N-GOV-22 | modificar una fila de un stream sin recalcular la cadena es detectado por la verificación de integridad |
| N-GOV-23 | un tombstone devuelve GONE y conserva el hecho de auditoría saneado |
| N-GOV-24 | marcar falso positivo no altera la política ni decisiones pasadas |
| N-GOV-25 | una ampliación publicada sin aprobación de otro principal se rechaza; una clasificación incierta cuenta como ampliación |
| N-GOV-26 | una excepción sin vencimiento, o sobre una regla no dispensable, se rechaza |
| N-GOV-27 | una acción retenida no detiene pasos independientes de la misma iniciativa ni otras iniciativas |
| N-GOV-28 | con evaluador, detector requerido o política caídos, ninguna acción protegida resulta `ALLOW` |
| N-GOV-29 | tras un restore formal, una acción protegida queda retenida hasta la reconfirmación |
| N-GOV-30 | sin servicios de equipo ni política, el operador local lee, ejecuta y aprueba planes y pasos como en el producto base, y sigue recibiendo sus avisos |
| N-GOV-31 | un perfil de CLI nunca informa EP1 como `ENFORCED` completo: la instrucción inicial puede ser `ENFORCED`, el contexto posterior es `UNSUPPORTED` y la cobertura de EP1 del perfil es `UNSUPPORTED` |
| N-GOV-32 | en transporte API o local, un turno que devuelve resultados de herramienta al modelo sin decisión EP1 propia no se envía; una decisión de un turno anterior no lo cubre |
| N-GOV-33 | un hallazgo `PATTERN` o `CLASSIFIER_ADAPTER` solo, en cualquier banda, no cambia la clasificación efectiva ni causa por sí solo ningún `DENY`: sólo registro o `REQUIRE_APPROVAL`; una causa determinista independiente sí puede denegar |
| N-GOV-34 | tras `FALSE_POSITIVE` y una aprobación `ACTION` nueva de otro principal autorizado, se liberan exactamente los bytes retenidos; otra captura, otro destino, otros argumentos o una acción más amplia siguen retenidos o denegados, y la política no cambia |
| N-GOV-35 | un contenido `SECRET_BEARING` declarado o determinista sigue denegado tras una resolución `FALSE_POSITIVE`, una aprobación o una excepción; confirmar un hallazgo como secreto lo vuelve no dispensable |
| N-GOV-36 | un identificador de cuenta o de worker con forma de principal, o un principal `SUSPENDED`, `REMOVED` o sin autoridad, es rechazado como `requested_by`, `decider_identity` o `recipient_operator_id` al registrar y otra vez al consumir o despachar |
| N-GOV-37 | los tipos de evento no humanos existentes conservan su actor worker o sistema; un actor histórico `UNKNOWN` no se reetiqueta |
| N-GOV-38 | con bytes nuevos en la misma ruta, otra `blob_generation` u otros argumentos tras la aprobación, ésta no se consume y el despacho no envía nada distinto de la captura vinculada; una aprobación `ACTION` de otra `decision_id` no se consume |
| N-GOV-39 | con el proveedor de identidad caído, el principal local no lee incidentes ni evidencia privados del equipo, no decide como revisor y la gobernanza sigue activa |
| N-GOV-40 | con política activa, pasar a un solo operador o a «sin política» por un interruptor ordinario no retira un perfil gobernado; sólo lo hace una publicación aprobada |
| N-GOV-41 | un intento no autorizado de grant o política global abre un incidente `SYSTEM` en `registry_events` sin `initiative_id`, invisible y sin contar para los lectores de una iniciativa |
| N-GOV-42 | un tombstone `OWNER_REQUEST` pedido por un principal distinto de `LOCAL_OPERATOR` se rechaza sin cambiar la referencia |
| N-GOV-43 | perder el último aprobador por suspensión, retiro o vencimiento retiene con `NO_ELIGIBLE_APPROVER`; evidencia conservada, aviso sólo autorizado/soportado, trabajo independiente y lecturas autorizadas siguen |
| N-GOV-44 | un principal independiente ya autorizado puede recuperar con grants/separación vigentes y evaluación fresca; sin él no recuperan un modelo, bearer local, demo, autoaprobación ni grant beneficiario; la provisión separada no se simula |
| N-GOV-45 | sin transición GOV-1/GOV-6/GOV-8, sujetos y avisos gobernados no están disponibles, pero P-28/P-30 baseline funcionan; forma de ID o columna preparatoria no valida principal ni cambia actores históricos |

### 15.2 Contrato, integración y extremo a extremo

- **Contrato**: una suite por puerto (`OperatorIdentityPort`,
  `AuthorizationPort`, `ContentInspectionPort`) ejecutada contra cada
  implementación real; el fallo nombra la implementación.
- **Unitaria de política**: el evaluador es una función pura, sin reloj
  implícito; propiedad con semilla: la decisión no depende del orden de grants
  ni de reglas.
- **Integración**: preflight de composición con las garantías de §7.2;
  admisión de P-34 más EP1 en un fallback; avisos caídos; reconstrucción
  multi-stream de las seis proyecciones al mismo vector.
- **Extremo a extremo**, por CLI y por API con expectativas independientes y
  fixtures sintéticos: configurar una política de equipo; exportación sensible
  bloqueada antes del egress; excepción acotada aprobada por otra persona;
  aprobación desactualizada que exige nueva revisión; triage de falso positivo;
  perfil de CLI no soportado que rechaza el enforcement; operación local de
  solo lectura sin servicios de equipo.

### 15.3 Aceptación medida

Objetivos `DESIGN_TARGET`, publicados antes de medir en el perfil de referencia
de [tests §9.1](../../quality/testing/index.md). El DT puede fijarlos distinto
**antes** de medir, nunca después.

| Medida | Objetivo |
| --- | --- |
| centinelas en sinks protegidos | 0 (duro) |
| celdas punto × perfil de adapter con cobertura respaldada por conformidad | todas declaradas; `UNKNOWN` se cuenta y se informa, no vale cero |
| latencia p95 de una decisión con 500 grants y 50 reglas | ≤ 10 ms |
| aislamiento de una retención | con un paso retenido, el throughput de los demás varía ≤ 5 % bajo la carga fija de tests §9.2 |
| consumo doble de una aprobación en 50 corridas con procesos concurrentes | 0 |
| calidad de detectores | precisión y exhaustividad por categoría sobre un corpus sintético fijado antes; se informan, **no** se prometen como garantía de detección |

---

## 16. Alcance backend por cortes, dependencias y paralelización

Los cortes `GOV-n` son de esta extensión; **no son IDs nuevos del inventario de
39** ni suman al avance del baseline. Cada uno necesita `DESIGN_READY` y
`SCOPE_FROZEN` propios.

| Corte | Contenido | Obligación que gana un packet existente | Desarrollo depende de | Habilitación depende de |
| --- | --- | --- | --- | --- |
| GOV-0 | vocabularios, hoja de datos, contratos, negativos, fixtures sintéticos, revisión del modelo de amenazas | — | esta página integrada y revisada | — |
| GOV-1 | principales, referencia validada de §3.1, `OperatorIdentityPort` local, `LOCAL_OPERATOR`, atribución y procedencia; **admisión del paquete nuevo `domains/governance`** en la tabla de estratos del fence y su clasificación pública/interna según ADR 0014, dentro del propio corte | composición del gateway: el bearer se asocia a `LOCAL_OPERATOR` | GOV-0, P-09/log, cierre de P-15 | — |
| GOV-2 | documentos de política, grants, delegación, evaluador puro y `AuthorizationPort` en consumidores | registry de P-15/R y scopes de paso de P-26 | GOV-1 | — |
| GOV-3 | EP1–EP5, registro de decisiones, cobertura vía el gate | P-23 (garantías de §7.2), P-24 punto (d) de permisos, P-36 (lectura privada con mínimo privilegio) | GOV-2, P-23/garantías, P-18/protocolo | P-18/recuperación |
| GOV-4 | confinamiento y egress mediado del perfil protegido; rechazo de CLI no mediado | P-25 (mecanismo elegido por el owner) | GOV-3, P-21 | P-25 cerrado |
| GOV-5 | `ContentInspectionPort`, detectores deterministas, hallazgos | P-36 (clasificación, familia 9) | GOV-3, P-36/local | — |
| GOV-6 | sujetos de aprobación de gobernanza, separación de funciones, reasignación, liberación acotada de falso positivo (§8.1) | P-28 baseline conservado; transición futura GOV-1/GOV-6 con migración/rebuild de sujetos, partición y actores validados (§11.1) | GOV-2, P-28 | P-34/admisión si hay equipos activos |
| GOV-7 | evidencia, retención, tombstone, registro de acceso | P-36 (camino de tombstone) | GOV-3, GOV-5 | cierre M12 de P-36 |
| GOV-8 | incidentes `SYSTEM` e `INITIATIVE`, falsos positivos | P-30 baseline conservado; transición futura GOV-1/GOV-8 con migración/rebuild de `kind` y destinatario validado (§11.4) | GOV-5, GOV-7 | — |
| GOV-9 | ciclo de política y excepciones | — | GOV-2, GOV-6 | — |
| GOV-10 | composición con presupuesto y ruteo | P-34, P-20 | GOV-3, P-34/admisión | — |
| GOV-11 | verbos de CLI y API, paridad, extremo a extremo, filas de perfil | P-39 si el perfil anuncia gobernanza protegida | todos los anteriores | G-GOBERNANZA |

**Orden crítico:** GOV-0 → GOV-1 → GOV-2 → GOV-3 → {GOV-5, GOV-6, GOV-10} →
GOV-7 → {GOV-8, GOV-9} → GOV-11. GOV-4 es una rama propia tras P-25; sin ella
ningún perfil de CLI se anuncia protegido.

**Paralelización**, dentro de [paralelismo](../../roadmap/parallelism/index.md):

- Ahora y sin writer: preparación de solo lectura de GOV-0 (oráculos, fixtures
  sintéticos, revisión de amenazas) sobre snapshots fijados, sin restar
  recursos a la cola activa.
- Mientras P-16/P-19/P-23 avanzan: preparar contratos y negativos de GOV-1 y
  GOV-2.
- Hiperaristas: contratos y schemas, migraciones, composición del runtime,
  CLI/API. Conflictúa con P-19, P-23, P-24, P-28, P-30 y P-36: se integra entre
  esos packets, no intercalado.
- **E1(b) fija dos transiciones futuras sin bloquear el baseline**: GOV-1/GOV-6
  posee la migración/rebuild de aprobaciones (§11.1); GOV-1/GOV-8 posee la de
  avisos (§11.4). P-28/P-30 conservan su contrato y actores. No se habilita
  gobernanza hasta tener identidad estable, productor y validación real;
  ambos diseños físicos se congelan antes de su propio código.
- Un solo writer en `main`. Ningún corte habilita efectos operativos antes de
  P-18/recuperación ni autoriza UI o P9.

**Dependencias de readiness.** Ningún corte declara `DESIGN_READY` sin:

| Corte | Exige además |
| --- | --- |
| GOV-0 | hoja de datos de las seis proyecciones y de los cambios de §13.1; negativos N-GOV-01…N-GOV-45 con oráculo; revisión del modelo de amenazas |
| GOV-1 | forma y validación de §3.1 congeladas; plan de admisión de `domains/governance` al fence y ADR 0014 dentro del corte |
| GOV-3 | celdas de cobertura de EP1 por instrucción inicial y contexto posterior (§7.2); vinculación a bytes de §6.5 contra la identidad de artefacto revalidada contra el prestate |
| GOV-4 | mecanismo de P-25 cerrado con evidencia de conformidad; sin él, el corte no se declara y ningún CLI se anuncia protegido |
| GOV-5 | separación determinista/falible de §8.1 en el contrato de `ContentInspectionPort` |
| GOV-6 | transición E1(b) §11.1 con GOV-1, productor, migración/rebuild y validación congelados; P-28 baseline no bloqueado |
| GOV-8 | transición E1(b) §11.4 con GOV-1, productor, migración/rebuild y validación congelados; P-30 baseline no bloqueado; incidentes `SYSTEM` sin nueva partición de avisos |

**Estado de las pruebas.** Todos los negativos de §15.1 son requisitos de
diseño. Ninguna prueba de seguridad ejecutable se corrió para esta extensión.

---

## 17. Qué no promete esta especificación

- Impedir todo mal uso, ni detectar todo secreto o dato personal.
- Controlar tráfico, procesos o herramientas fuera de ACP.
- Proteger contra el administrador del host o contra quien controla la cuenta
  del sistema operativo.
- Inviolabilidad del registro: sólo evidencia de manipulación dentro del modelo
  declarado.
- Que la salida inspeccionada después sea protección.
- Que inspeccionar la instrucción inicial de un CLI proteja el contexto que el
  CLI lee después.
- Que un patrón o un clasificador acierte: sus hallazgos son señales falibles.
- Acceso remoto o multiusuario entre máquinas.
- Que un proveedor de identidad, un clasificador o un aviso sean necesarios para
  el uso individual.
- Que un requisito GOV esté aceptado por estar escrito aquí.
