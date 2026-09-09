# Arquitectura: estratos, contextos, puertos y separación de tipos

Dueño único del concepto **arquitectura**: qué estratos hay, en qué dirección
dependen, qué contexto posee cada concepto, dónde vive un puerto, y la ley de
separación entre declaraciones de tipo y código de implementación.

[Índice](../README.md) · [Estructura](structure/index.md) · [Contratos](contracts/index.md) · [Datos](database/index.md) · [Integraciones](integrations/index.md) · [Calidad](../quality/index.md) · [Roadmap](../roadmap/index.md)

Estado: **especificación**. Base inspeccionada `a92756b`. No autoriza
implementación ni cutover.

---

## 1. La regla en una frase

**La capacidad se comparte; la forma se especializa; el dominio no conoce ningún
motor, SDK ni base de datos concreta.** La política es nuestra; los mecanismos
reemplazables viven detrás de puertos, en edges.

---

## 2. Cinco estratos y un grafo direccional

Una flecha `A → B` significa **A importa a B**. No hay flechas en el otro sentido,
ni ciclos, ni saltos de conveniencia. El grafo es la inversión de dependencias
aplicada literalmente: **el dominio no depende de ninguna implementación, ni
siquiera de la de persistencia.**

```
entrypoints ──→ edges ──→ domains ──→ kernel
     │            │                     ▲
     │            └──→ persistence ─────┘
     │                     ▲
     └─────────────────────┘
```

Leído en palabras:

| Estrato | Puede importar | No puede importar | Qué es |
| --- | --- | --- | --- |
| `kernel` | nada del repositorio | todo lo demás | contratos realmente compartidos, protocolo, testkit |
| `persistence` | `kernel` | `domains`, `edges`, `entrypoints` | el ledger, sus proyecciones y sus stores |
| `domains` | `kernel` y sus propios `ports/` y `model/` | `persistence`, `edges`, `entrypoints` | política y casos de uso |
| `edges` | `kernel`, los `ports/` de un dominio (para implementarlos), `persistence` cuando el edge **es** la implementación de infraestructura | otro edge, `entrypoints` | adapters: proveedores, motores, tools, telemetría, almacenamiento |
| `entrypoints` | todo | — | composición y superficies: daemon, gateway, CLI, consola |

Tres precisiones que hoy no se cumplen y son parte del objetivo:

- **El dominio no importa `@acp/ledger`.** No abre SQLite y tampoco consume
  «operaciones semánticas» del paquete concreto: consume su propio puerto. Es la
  **composición del entrypoint** la que adapta las funciones del ledger a ese
  puerto. El inventario de aperturas e imports concretos está en
  [estructura §3](structure/index.md); incluye runtime y observation, no un único sitio.
- **Un edge no importa otro edge**, y ningún edge importa un entrypoint. Si dos
  adapters necesitan lo mismo, ese algo es kernel o es composición.
- **Las excepciones que hoy existen son deuda, no permiso.** El mapa de
  violaciones vigentes vive en [estructura §3](structure/index.md) como lista de
  movimientos pendientes; ninguna entrada de esa lista autoriza una violación
  nueva.

**Ningún vocabulario de vendor en `kernel` ni en `domains`.** La comprobación no
es un `grep` de la marca: es un inventario de consumidores reales. Las constantes
`RESTATE_*` que hoy viven en `domains/runtime/src/constants` —nombre de objeto,
handlers, versión del SDK, versión y pin del binario, directorio de instalación—
van **al edge de durabilidad**, no al kernel. `kernel/contracts/topology` recibe
únicamente lo que es neutral de verdad: el host de loopback y el inventario de
puertos reservados como regla de despliegue. Un pin de un binario de un vendor en
el kernel sería el mismo defecto con otra dirección.

---

## 3. Bounded contexts

| Contexto | Lazo | Posee | Estado |
| --- | --- | --- | --- |
| `planning` | planificación | iniciativas, revisiones de roadmap, pasos y dependencias, asignaciones de rol con scope, grafo de tareas, planes del coordinador, aprobaciones, adjudicaciones, consultas, recomendaciones, simulaciones, duelos | nuevo |
| `runtime` | ejecución | admisión y ciclo de vida de la tarea, revisiones e intentos, plan de beats y efectos, sesión con instrucción, ocurrencias de prompt y respuesta, tool calls, checkpoints, conformance y cuarentena, verificación, auditoría, autorización y registro de commit, reintento, límites de tiempo | existe; gana anatomía y efectos reales |
| `accounts` | economía | inventario de cuentas y plan declarado, observaciones y estimación de cuota, ventanas de cuota, ranking por margen, presión, reserva y liberación, handoff, acciones del operador, registry de capacidades | existe; gana pool, fold real y handoff real |
| `economy` | economía | uso liquidado, precios versionados, costo derivado, prorrateo de suscripción, retorno, costo por resultado, pronóstico, exportación, anomalías, desempeño por modelo y rol | nuevo |
| `observation` | transversal | linaje completo de una tarea, lectura autorizada de artefactos, telemetría neutral, línea de base, correlación de logs, proyección de timeline | existe; gana el puerto de exportación conectado |

Dos separaciones que no son obvias:

- **`economy` fuera de `accounts`.** Una cuenta es un recurso con estado y reserva;
  el costo es una función del uso y de un documento de precios. Juntos, el paquete
  más grande del repositorio cambiaría por dos razones distintas: señales nuevas
  del proveedor y precios nuevos.
- **`planning` fuera de `runtime`.** Runtime sabe caminar el plan de una tarea;
  planning sabe qué tareas existen y quién las hace. El coordinador es un walk de
  runtime con rol `coordinator`, y su salida se registra por una mutación de
  planning.

**Un concepto, un dueño.** Las seis responsabilidades de la tabla necesitan
reubicación o extracción, no una reescritura general:

| Concepto | Dónde vive hoy | Dueño correcto |
| --- | --- | --- |
| acción sobre una cuenta | `domains/runtime/src/actions` abre el ledger directo | `accounts`: `model/action`, `ports/actions`, casos de uso de consulta y de registro; `persistence` guarda con OCC; el entrypoint compone |
| reglas de una revisión de roadmap | `persistence/ledger/src/roadmap-version:98` decide política | `planning` posee la política; `persistence` sólo hace `append` con OCC |
| orquestación de la escritura de roadmap | `entrypoints/gateway/src/roadmap-write:134` orquesta | el caso de uso vive en `planning`; el recurso HTTP sólo lo invoca |
| proyección de lectura compartida por las puertas | duplicada en `gateway/src/mappers` y en `cli/src/observation` | `observation`: un read model y sus consultas, consumidos por las dos puertas |
| identidad de la instancia de base de datos | `gateway/src/database-identity` la deriva del path | `persistence` la emite en la creación y en el restore; `observation` proyecta la identidad segura; **ninguna puerta calcula un hash propio** |
| resumen de portafolio | duplicado entre gateway y CLI | `planning`, como consulta |

---

## 4. Puertos

**Un puerto vive en el dominio cuando el dominio es su consumidor.** Si sólo un
edge lo usa, es una interfaz privada de ese edge y puede quedarse ahí. No se
inventa un puerto en el dominio para renombrar algo que ya existe.

| Seam | Consumidor | Dónde debe declararse | Hoy |
| --- | --- | --- | --- |
| escritura y lectura del ledger | `runtime`, `accounts`, `planning` | `domains/<contexto>/ports/ledger` | `LedgerPort` y `EffectPort` en `runtime/src/core/step-executor`: existen, hay que agruparlos |
| ejecución de modelo | `runtime` | **`kernel/contracts`, ya existe** | `ModelExecutionPort` ✓. Se **reutiliza**; no se declara un puerto homónimo en `runtime` |
| adapter de proveedor | sólo `edges/providers` | dentro del edge | `ProviderAdapter` en `edges/providers` ✓ correcto: el handshake y el parser concretos son privados del edge; el dominio consume `ModelExecutionPort` |
| harness de agente | `runtime`, cuando exista consumidor | `domains/runtime/ports/harness` | `AgentHarness` en el edge, sin consumidor de dominio: mientras no lo tenga, se queda ahí |
| driver de orquestación | `runtime` | `domains/runtime/ports/orchestration` | `OrchestrationDriver` en `runtime/src/contracts`: renombre de carpeta |
| protocolo de tools | `runtime` | `domains/runtime/ports/tools` | `ToolProtocolPort` en `edges/tools` ✗ el consumidor es el dominio |
| exportación de telemetría | `observation` | `domains/observation/ports/telemetry` | `TelemetryExporterPort` en `edges/telemetry` ✗ ídem |
| lectura de Git | `runtime` | `domains/runtime/ports/vcs` | `GitReadPort` en `runtime/src/enforcement` |
| checkpoint | `runtime` | `domains/runtime/ports/checkpoint` | `CheckpointPort`: `persist` **sí** tiene caller productivo, cableado desde el daemon a los dos modos; `read` es lo que no tiene consumidor y bloquea la rehidratación |
| store de artefactos | `runtime`, `observation` | `domains/<contexto>/ports/artifacts` | no existe |
| credenciales e identidad | `accounts`, entrypoints | `domains/accounts/ports/credentials` | no existe |

La regla que ordena esta tabla es una sola: **un puerto se declara donde está su
consumidor.** Un contrato que ya existe en el kernel y sirve, se reutiliza; no se
duplica con otro nombre en un dominio. Una interfaz que sólo usa un edge se queda
en ese edge y no asciende por dogma.

**Un puerto tiene su propio resultado y su propia unión de error.** No devuelve el
tipo de un SDK, no lanza la excepción de un motor, y su firma no menciona rutas de
almacenamiento ni factories. Una firma genérica puede llevar parámetros de tipo;
lo que no puede es intercalar alias declarados en el propio archivo del puerto.

**Los errores se agrupan por contexto con mapeo exhaustivo**, no por herencia
global obligatoria. Cada contexto declara su unión cerrada y cada frontera declara
la traducción completa hacia la unión del contexto vecino; el compilador comprueba
la exhaustividad.

**El kernel guarda sólo lo realmente compartido.** Un contrato que usa un solo
contexto no es kernel. Hoy `DRIVER_MODES` en el kernel y `DurableStepContext =
Pick<Context, ...>` sobre el SDK de Restate en un barrel público son los dos casos
a corregir.

---

## 5. CQRS pragmático

Una **mutación** apendea y devuelve lo apendeado o el replay idempotente. Una
**consulta** lee proyecciones por un puerto de lectura y no apendea. Es el CQRS que
el ledger ya impone; lo que falta es el nombre y el dueño.

No se impone «un caso de uso, un archivo». Agrupar suboperaciones nombradas bajo
un concepto es válido y a veces mejor que fabricar diez archivos de doce líneas.
Lo que sí se impone es que **lo invocable desde fuera del paquete viva bajo
`usecases/mutations/**` o `usecases/queries/**`**, y que `shared/` no sea
alcanzable desde fuera.

La grafía es **`usecases`**, sin guion, en todo el repositorio y en todos estos
documentos. Las rutas históricas citadas como origen de un movimiento conservan su
forma real.

---

## 6. Inyección y composition root

**Inyección explícita.** Una factory recibe su configuración y sus dependencias
como argumentos. La factory obligatoria de cero argumentos queda **superseded**:
favorece globals ocultos y hace intestable la composición.

El composition root vive en el entrypoint que compone —`daemon/src/composition/`,
`gateway/src/composition/`, `cli/src/composition/`— porque el dominio no puede
importar edges. **El composition root no contiene lógica de negocio**: resuelve
configuración, construye adapters, cablea puertos y devuelve casos de uso.

Hoy `daemon/src/index.ts` tiene 1.981 líneas con `startDaemon` en la 510 y compone
dos walks equivalentes en dos lugares distintos (:857 y :1219). La extracción a
`composition/walk` con dependencias explícitas es la primera corrección
estructural; la prueba de que quedó bien es un fixture de **equivalencia** entre
walk único, walk agendado y walk de un solo ítem.

---

## 7. Separación obligatoria de tipos, schemas y vocabulario

Ley del owner. Se aplica **dentro del concepto y de su dueño**, nunca creando un
depósito global de tipos.

### 7.1 Las hojas

Bajo `model/<concepto>/` y sólo cuando la hoja tiene contenido real:

| Hoja | Contiene | No contiene |
| --- | --- | --- |
| `types/index.ts` | **todas** las declaraciones de tipo del concepto: `interface`, `type`, alias, y las uniones **derivadas** de un vocabulario | valores, funciones, schemas, constantes |
| `schema/index.ts` | validadores canónicos estrictos y sus refinamientos | I/O, acceso a red o disco, lógica de negocio |
| `vocabulary/index.ts` | **sólo valores**: conjuntos y constantes `as const`, con la unidad en el nombre | cualquier `type` o `interface`, incluida la unión derivada |
| `policy/index.ts` | decisiones puras del concepto | declaraciones de `interface`, `type` o `enum` |

La derivación cruza el borde en una sola dirección: `types/index.ts` importa el
valor del vocabulario y declara la unión a partir de él. El vocabulario nunca
declara un tipo, ni siquiera el suyo. Es la traducción exacta de la ley del owner:
las declaraciones de tipo están separadas de los valores de runtime.

```ts
// vocabulary/index.ts — sólo valores
export const ACCOUNT_STATES = ["AVAILABLE", "DRAINING", "EXHAUSTED", "COOLDOWN", "AUTH_REQUIRED"] as const;

// types/index.ts — sólo declaraciones
import type { ACCOUNT_STATES } from "../vocabulary/index.js";
export type AccountState = (typeof ACCOUNT_STATES)[number];
```

Un concepto que no necesita las cuatro hojas declara sólo las que usa. **No se
crean carpetas vacías.** Lo que sí se exige siempre es que las declaraciones con
nombre no queden intercaladas con la implementación.

**La separación aplica a todos los estratos, no sólo a los dominios:**

| Estrato | Dónde aterriza |
| --- | --- |
| `kernel` | schemas por recurso, con sus alias de tipo en la hoja de tipos del recurso |
| `persistence` | los stores: el tipo de fila y el de resultado separados del código que abre la base |
| `edges` | drivers y transportes: el vocabulario del vendor y los tipos del adapter separados de su implementación |
| `entrypoints` | la composición: las interfaces de dependencia que declara el composition root, separadas del cableado |
| `test` | el espejo respeta la misma división; un fixture de compilación negativa vive junto al concepto que protege |

### 7.2 Reglas transversales

- **`policy`, `usecases` e implementación no declaran tipos.** Sus firmas usan
  nombres importados de `types/`. Un objeto local con tipo inferido está bien; una
  firma anónima en línea usada para esquivar esta regla, no.
- **`ports/` contiene contratos neutrales**: interfaces y los tipos con nombre de
  sus entradas y resultados, importados. Nunca una factory, un tipo de SDK ni una
  ruta de almacenamiento.
- **Errores**: los constructores y los type guards viven en la carpeta de errores
  del contexto; los **códigos** viven en `vocabulary`.
- **El `index.ts` raíz de un paquete es sólo exportaciones nombradas y
  `export type`.** Cero declaraciones, cero `export *`.
- **No se introducen `enum` ni `const enum` de TypeScript** (`erasableSyntaxOnly`).
  Un enum conceptual es un array `as const` en `vocabulary` más la unión derivada.
- **Sin ciclo `schema → tipos derivados → schema`.** Cuando el tipo se infiere del
  schema, el schema no importa ese tipo de vuelta. Si hace falta, el tipo base va a
  `types/` y el schema lo satisface. El sentido único de §7.1 —vocabulario a
  tipos, nunca al revés— existe por el mismo motivo.
- **Interfaces privadas también respetan el scope del dueño.** Privado significa
  «no exportado del paquete», no «puede vivir en un bucket global».

### 7.3 Ejemplo aplicado: la acción sobre una cuenta

El vocabulario de acciones y de estados de cuenta, y el schema del evento de
cuenta, **ya existen en el kernel y ya están persistidos**. El dominio los
**importa**; no los redeclara. Lo que `accounts` posee es su política y sus
entradas y rechazos de aplicación.

```
domains/accounts/
  src/
    index.ts
    model/action/types/index.ts        entradas y rechazos propios; importa los
                                       tipos compartidos del kernel
    model/action/policy/index.ts       qué acción es admisible en qué estado
    ports/actions/index.ts             AccountActionAppendPort, AccountActionReadPort
    usecases/mutations/record-action/index.ts
    usecases/queries/effective-state/index.ts
  test/
    model/action/policy/index.test.ts
    ports/actions/index.test.ts
    usecases/mutations/record-action/index.test.ts
    usecases/queries/effective-state/index.test.ts
```

El almacenamiento y el control de concurrencia quedan en `persistence`; la
composición del entrypoint adapta esas funciones al puerto. **Ninguna de las cuatro
capas declara el tipo de otra, y no hay un segundo schema del mismo evento.**

Igual para la revisión de roadmap: `planning` posee la política en
`model/roadmap-version/policy`; `persistence/ledger` sólo ofrece el append con
control de concurrencia optimista.

### 7.4 Nombres

Sin redundancia con el paquete ni guiones innecesarios: `cli/dispatch` en lugar de
`cli/cli`, `ledger/log` en lugar de `ledger/ledger`, `daemon/process/child` en
lugar de `daemon/daemon-child`. Dentro de una carpeta ya acotada por el módulo, el
hijo no repite el módulo: `detail/`, no `user-detail/`.

---

## 8. Barrels e imports

- Un `index.ts` de paquete es **explícito y pequeño**, sin `export *`. No hay un
  máximo mágico de líneas: hay una prohibición de declarar y una obligación de que
  todo nombre exportado tenga un consumidor real.
- **Cero ciclos** entre paquetes y **cero deep imports** entre paquetes: se importa
  del barrel o de un subpath declarado en `exports`.
- Scaffolding de escenarios no es API de producción. `runtime` exporta hoy el
  repositorio `toy`, `SqliteSupervisor` y las constantes de Restate desde su barrel
  raíz; los escenarios se mueven a un subpath propio y el resto, a su edge. La
  retirada de cualquier export se hace con **inventario de callers**, no a ciegas:
  el export público de Langfuse en `observation/src/index.ts:105` sigue vivo y
  necesita ese inventario antes de irse.

---

## 9. Lo que esta arquitectura no adopta

De los módulos `dm-*` de Rottay se toma el vocabulario, no la profundidad:

- **No** `tenant_id`: un plane por máquina, un operador.
- **No** agregados mutables con `created_at`/`updated_at`/`deleted_at`: en un
  stream no hay `UPDATE`, y en una proyección el ciclo de vida lo da la secuencia.
- **No** `adapters/in`, `adapters/out` ni `infrastructure/{...}` dentro del
  dominio: los adapters ya son los edges, y quince capas obligatorias excederían el
  código de un dominio de veinte archivos.
- **No** un segundo sistema de eventos: el ledger es el bus.
- **No** un paquete `core` de utilidades: lo compartido va a `kernel/contracts` si
  es contrato, a `kernel/testkit` si es andamiaje determinista, y a ningún lado si
  es «útil».
- **No** un barrel raíz gigante, ni `export *` para achicarlo.

---

## 10. Cambios de diseño explícitamente superseded

| Idea anterior | Por qué se retira |
| --- | --- |
| Factories obligatorias de cero argumentos | favorecen globals ocultos; se reemplaza por inyección explícita |
| «Un caso de uso, un archivo» como ley | produce archivos gigantes o abstracciones prematuras; la ley real es dónde vive lo invocable |
| Mudanza atómica masiva del árbol como prerequisito | bloquea entregar función útil; la anatomía se aplica por funcionalidad y por extracción necesaria |
| Ratio carpetas/archivos < 0,5 como criterio | mide forma, no responsabilidad; se reemplaza por criterios observables ([calidad](../quality/index.md)) |
| Lista negra universal de nombres de carpeta | se conserva como guía de nombres, no como gate; el gate es ciclos, deep imports, DB en dominio y consumidores reales |
| «Nada sale de la máquina» | falso en un producto que usa LLMs y telemetría externos; se reemplaza por egress explícito y mínimo |
| El journal del motor durable es una cache descartable | retirar su estado sin exportar timers, señales y efectos pierde continuidad |
| Enum cerrado de proveedores como mecanismo de extensibilidad | totalizar un `Record` es higiene; la extensibilidad es un descriptor validado |
| Estado real de una cuenta y prorrateo contable como una sola medida | son dos cosas; ver [cuentas](database/accounts/index.md) y [economía](database/economy/index.md) |
| Congelar la expansión de Restate equivale a resolver la recuperación | son problemas separados: uno es alcance, el otro es corrección del journal |
| Roles de staffing dinámico de producto = staffing de agentes de este repo | son dos vocabularios distintos y no se mezclan |
