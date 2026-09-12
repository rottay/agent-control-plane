# Estructura: árbol objetivo, seams y duplicación

Dueño único del concepto **organización del código**: qué paquetes hay, qué
carpeta gana qué responsabilidad, qué se mueve de dónde a dónde, y qué duplicación
es un defecto y cuál no.

[Índice](../../README.md) · [Arquitectura](../index.md) · [Contratos](../contracts/index.md) · [Datos](../database/index.md) · [Tests](../../quality/testing/index.md) · [Packets](../../implementation/packets/index.md)

Estado: **especificación**. Medido en `a92756b`.

---

## 1. Punto de partida medido

Catorce paquetes en cinco estratos. Archivos `src` y carpetas de primer nivel:

| Paquete | Archivos `src` | Carpetas de primer nivel | Líneas `src` |
| --- | --- | --- | --- |
| `kernel/contracts` | 19 | 1 | 2.836 |
| `kernel/protocol` | 6 | 5 | 3.710 |
| `persistence/ledger` | 12 | 11 | 6.438 |
| `domains/runtime` | 27 | 22 | 10.456 |
| `domains/accounts` | 9 | 8 | 3.721 |
| `domains/observation` | 11 | 7 | 2.483 |
| `edges/providers` | 16 | 14 | 4.156 |
| `edges/durability` | 7 | 4 | 3.332 |
| `edges/tools` | 10 | 9 | 2.370 |
| `edges/telemetry` | 6 | 5 | 897 |
| `entrypoints/daemon` | 20 | 17 | 7.315 |
| `entrypoints/gateway` | 20 | 19 | 5.182 |
| `entrypoints/cli` | 6 | 5 | 3.828 |
| `entrypoints/console` | 42 | 8 | 8.090 |

**Hotspots, no umbral mágico.** Un archivo grande no es un defecto por su tamaño;
lo es cuando esconde una responsabilidad que debería tener nombre. Estos seis lo
hacen:

| Archivo | Líneas | Qué esconde |
| --- | --- | --- |
| `persistence/ledger/src/ledger/index.ts` | 2.741 | log, append por stream, integridad, proyecciones y consultas en un módulo |
| `kernel/protocol/src/schemas/index.ts` | 2.301 | todos los schemas de todos los recursos |
| `entrypoints/daemon/src/index.ts` | ~~1.981~~ 66 | E1/E2 **aplicados en P-13** (`f832590`, `a9d5429`, ADR 0071): el barrel quedó con las tres funciones y los tipos; el composition root vive en `composition/` (1.181) con una sola construcción de walk en `composition/walk/` (184) |
| `entrypoints/cli/src/cli/index.ts` | 1.947 | dispatch, formato, mapeo de errores y elección de ruta |
| `edges/durability/src/drivers/restate-driver/index.ts` | 1.153 | correcto por tamaño; es un driver completo |
| `entrypoints/gateway/src/routes/index.ts` | 1.175 | diecinueve recursos en un archivo |

`scripts/check-architecture.mjs` está en 22.984 líneas. Su dieta se especifica en
[migración](../../implementation/migration/index.md), no acá.

---

## 2. Árbol objetivo

Se conservan los catorce paquetes. Se agregan tres, cada uno con un caso real:

| Paquete nuevo | Por qué existe ahora | Sin él |
| --- | --- | --- |
| `domains/planning` | pasos, DAG, asignaciones con scope, aprobaciones durables: veinte operaciones sin dueño | vuelven a caer en el daemon y en el gateway |
| `domains/economy` | uso liquidado, precios versionados, costo derivado, prorrateo | `accounts` cambia por dos razones distintas |
| `kernel/testkit` | PRNG determinista compartido por dos árboles de test (§5) | la duplicación queda invisible al gate, que sólo escanea `src` |

```
packages/
  kernel/
    contracts/src/
      index.ts
      schemas/<concepto>/index.ts
      topology/index.ts                  puertos y hosts de despliegue; hoy en runtime/constants
      errors/base/index.ts
    protocol/src/
      index.ts
      routes/index.ts
      schemas/{task,worker,event,integrity,stream,accounts,initiatives,planning,economy}/index.ts
      parity/index.ts
      surface-map/index.ts
      version/index.ts
    testkit/src/
      index.ts
      random/index.ts                    mecánica determinista, nunca un oráculo de dominio
      doubles/index.ts
  persistence/
    ledger/src/
      index.ts
      log/{open,append,integrity,canonical-json,migrations}/index.ts
      identity/index.ts                  instancia y restore: única fuente de la identidad
      projections/<read-model>/index.ts
      stores/{artifact,lease,tool-claim,account-reservation,checkpoint,outbox}/index.ts
      errors/index.ts
  domains/
    planning/src/{index.ts, model/<concepto>/{vocabulary,types,schema,policy}, ports/<capacidad>, usecases/{mutations,queries}/<nombre>, errors}
    runtime/src/
      index.ts
      model/{coordinates,events,plan,states,revision,attempt}/{vocabulary,types,schema,policy}
      ports/{ledger,effect,orchestration,tools,checkpoint,vcs,artifacts}/index.ts
      usecases/{mutations,queries}/<nombre>/index.ts
      errors/index.ts
      scenarios/<escenario>/index.ts     subpath propio, fuera del barrel principal
    accounts/src/{index.ts, model/{account,action,quota,reservation,handoff,registry}, ports/{actions,quota,reservations,credentials}, usecases/{mutations,queries}, errors}
    economy/src/{index.ts, model/{usage,price,cost,subscription,performance}, ports/{prices,usage}, usecases/{mutations,queries}, errors}
    observation/src/{index.ts, model/{lineage,telemetry,baseline,read-model}, ports/{telemetry,artifact-reader}, usecases/queries/{lineage,timeline,payload-keys,task-view,worker-view}, errors}
  edges/
    providers/src/{index.ts, adapters/{claude,codex,kimi,api-key,local}, session/{harness,events,execution-port}, process/{spawn,handle}, admission/{config-root,redact}, vocabulary, errors}
    durability/src/{index.ts, restate/{driver,endpoint,child,gate,ingress}, sqlite/{supervisor,child}, server-handle, vocabulary}
    tools/src/{index.ts, transport/{stdio,http-loopback,jsonrpc,client}, policy/{admission,operation,receipt}, vocabulary}
    telemetry/src/{index.ts, otlp/{http,encode}, admission, vocabulary}
  entrypoints/
    daemon/src/
      index.ts                           barrel: startDaemon, stopDaemon, terminateDaemon y tipos
      composition/{walk,ports,usecases}/index.ts
      process/{bin,child,signals,singleton,lifecycle,launchd}/index.ts
      supervision/{arbiter,scheduler,git-observer,identity-probe}/index.ts
      modes/{restate,sqlite}/index.ts
      observability/{log,status}/index.ts
      shared/{paths,errors}/index.ts
    gateway/src/
      index.ts
      composition/index.ts
      http/{bin,server,bootstrap,routes,stream,bearer}/index.ts
      resources/<contexto>/index.ts
      read-model/{ledger-source,query-schemas}/index.ts
      shared/errors/index.ts
    cli/src/{index.ts, composition, dispatch, verbs/<contexto>, format, errors}
    console/src/{api,app,components,format,hooks,routing,styles,views}
```

`entrypoints/console` ya tiene árbol de familia y no se toca. `domains/accounts`
conserva sus carpetas actuales; lo que cambia en ella es la separación interna de
`model/` según [arquitectura §7](../index.md).

`domains/observation` **gana** el read model compartido y las consultas que hoy
están duplicadas en dos puertas (§4.1); el gateway pierde `mappers`, `aggregates`
y `database-identity` por el mismo motivo. La identidad de la instancia la emite
`persistence/ledger/src/identity`, y el resumen de portafolio va a
`planning/usecases/queries/portfolio`, porque es una consulta de planificación y no
de trazabilidad.

---

## 3. Movimientos por seam

Cada fila es un cambio concreto con dueño, no un renombre de carpeta. Ninguno
mezcla movimiento con cambio semántico.

| # | Origen | Destino | Qué cambia además de la ruta |
| --- | --- | --- | --- |
| E1 | `daemon/src/index.ts:122–1981` | `daemon/src/composition/` | el barrel queda con las tres funciones y los tipos; ningún símbolo se renombra. **Aplicado en P-13/1 (`f832590`, ADR 0071)** |
| E2 | `daemon/src/index.ts:857` y `:1219` | `daemon/src/composition/walk/index.ts` | una sola construcción de walk con dependencias explícitas; fixture de equivalencia entre walk único, agendado y de un ítem. **Aplicado en P-13/2 (`a9d5429`, ADR 0071)** |
| E3 | `domains/runtime/src/actions` | `domains/accounts/{model/action,ports/actions,usecases}` + `persistence/ledger` (OCC) + composición en el entrypoint | deja de abrir el ledger desde un dominio |
| E4 | `persistence/ledger/src/roadmap-version:98` (reglas) | `domains/planning/model/roadmap-version/policy` | el ledger conserva `append` con OCC y nada más |
| E5 | `gateway/src/roadmap-write:134` (orquestación) | caso de uso en `domains/planning` | el recurso HTTP sólo invoca y traduce errores |
| E6 | `runtime/src/constants`: `RESTATE_OBJECT_NAME`, handlers, `RESTATE_SDK_VERSION`, `RESTATE_SERVER_VERSION`, `RESTATE_SERVER_SHA256_PIN_PATH`, `RESTATE_SERVER_INSTALL_DIR`, `RESTATE_*_PORT`, `RESTATE_*_URL`, `RESTATE_STATE_KEY_CACHE` | `edges/durability/vocabulary` | todo el vocabulario del motor, **incluidos los pins y los puertos del vendor**, sale del dominio y va al edge; ninguno pasa por el kernel |
| E7 | `runtime/src/constants`: `LOOPBACK_HOST`, `RESERVED_LOOPBACK_PORTS`, `OBSERVATION_API_PORT`, `UI_PORT` | `kernel/contracts/topology` | sólo la topología **neutral** de despliegue; una sola declaración compartida por gateway y daemon |
| E8 | `runtime/src/toy/repository` | `runtime/src/scenarios/`, subpath `@acp/runtime/scenarios` | sale del barrel de producción; los dos hijos de drill importan el subpath |
| E9 | `runtime/src/drivers/{sqlite-supervisor,sqlite-supervisor-child}` | `edges/durability/sqlite/{supervisor,child}` | un driver y su hijo de proceso son infraestructura; retirar ambos exports del dominio con sus callers y tests espejo |
| E10 | `edges/tools/src/port` (`ToolProtocolPort`) | `domains/runtime/ports/tools` | el puerto al dominio; la implementación se queda en el edge |
| E11 | `edges/telemetry/src/port` (`TelemetryExporterPort`) | `domains/observation/ports/telemetry` | igual, con caller productivo en la composición |
| E12 | `edges/providers/src/contract` | se **divide**: el vocabulario del proveedor a `providers/vocabulary`; `ProviderAdapter` y el handshake concreto **se quedan privados dentro del edge** | el dominio consume `ModelExecutionPort`, que ya vive en el kernel; no se declara un puerto de proveedor nuevo |
| E13 | `observation/src/telemetry/langfuse` | retirada, tras inventario de callers | hoy sigue exportado en `observation/src/index.ts:105` |
| E14 | proyecciones dentro de `ledger/src/ledger/index.ts` | `ledger/src/projections/<read-model>/index.ts` | una carpeta por read model; el fold sigue siendo uno solo para path vivo y replay |
| E15 | `kernel/protocol/src/schemas/index.ts` | `protocol/src/schemas/<recurso>/{vocabulary,types,schema}/index.ts` | corte por recurso, **y dentro de cada recurso los alias de tipo salen a su hoja de tipos**; ningún schema cambia |
| E16 | `gateway/src/routes/index.ts` | `gateway/src/http/routes` + `gateway/src/resources/<contexto>` | un recurso por contexto |
| E17 | `cli/src/cli/index.ts` | `cli/src/{composition,dispatch,verbs/<contexto>,format}` | dispatch separado de verbos y de formato; **las interfaces de dependencia que declara la composición salen a su propia hoja de tipos** |
| E18 | `gateway/src/mappers`, `gateway/src/aggregates`, `gateway/src/database-identity` | `domains/observation/{model/read-model,usecases/queries}` para la proyección; la **identidad de instancia** pasa a emitirla `persistence` en el restore | las puertas dejan de calcular su propio hash de ruta; `observation` proyecta una identidad segura y las dos puertas la consumen |
| E19 | `edges/*/src/<adapter>` con tipos intercalados | `edges/*/src/<adapter>/{vocabulary,types}` junto a su implementación | la separación de declaraciones también rige en drivers y transportes |
| E20 | `observation/src/shadow-ledger` | caso de uso de baseline en `observation/usecases`, puerto propio `observation/ports/baseline`, implementación de apertura/append/rebuild en `persistence/ledger` e inyección desde el entrypoint | no trasladar todo a una proyección: hay I/O de escritura y una política de medición distintos. Preservar la operación de baseline, inventariar export público, README, tests y excepción del fence; retirar el import concreto del dominio |

Inventario mínimo de **aperturas** directas hoy: `runtime/src/actions:259`,
`runtime/src/drivers/sqlite-supervisor-child:455` y
`observation/src/shadow-ledger:188`. P-37 también inventaría todos los imports
`@acp/ledger` bajo `packages/domains/**/src`: tipos y utilidades puras también
son dependencias concretas, aunque no abran archivos. La sonda de imports es un
inventario de fronteras, no un sustituto de pruebas semánticas ni permiso para
borrar consumidores. Este listado no se copia en cada packet.

Renombres sin movimiento, por la regla de no repetir el paquete:
`cli/cli → cli/dispatch`, `ledger/ledger → ledger/log`,
`daemon/daemon-child → daemon/process/child`,
`durability/submit → durability/restate/ingress` (colisiona hoy con
`runtime/submission`).

---

## 4. Duplicación: cuatro categorías

No toda repetición es un defecto, y no todo parecido textual es duplicación.
La regla: **se comparte semántica con un dueño; no se extrae por similitud de
texto.**

### 4.1 Duplicación con divergencia — defecto real

Tres implementaciones del mismo concepto que **no coinciden**, y por eso el
producto responde distinto según la puerta:

| Sitio | Comportamiento |
| --- | --- |
| `gateway/src/mappers/index.ts:111` | `Object.keys(event.payload)`: orden de inserción, sin tope |
| `cli/src/observation/index.ts:67` | orden alfabético, tope de 64 |
| `kernel/protocol/src/schemas/index.ts:400` | el contrato acepta como máximo 64 |

Corrección: **una sola proyección de `payloadKeys`, propiedad de `observation`**,
en `domains/observation/model/read-model` y expuesta por
`usecases/queries`, consumida por las dos puertas. Fixtures obligatorios: claves
desordenadas, más de 64 claves, y claves con caracteres que cambian el orden entre
locales. El oráculo esperado se escribe a mano, no se deriva de la implementación,
y **cada puerta tiene su fixture independiente**: comparar dos llamadas al mismo
helper no prueba nada.

Mismo patrón, mismo remedio, y un destino por familia:

| Familia duplicada | Destino |
| --- | --- |
| DTO de tarea y de worker | `domains/observation/model/read-model`, consumido por las dos puertas |
| cola de eventos | `domains/observation/usecases/queries/timeline` |
| resumen de portafolio | `domains/planning/usecases/queries/portfolio` |
| identidad de base de datos | **la emite `persistence` en el restore**; `observation` proyecta la identidad segura; **ninguna puerta calcula un hash de ruta propio** |

### 4.2 Constantes: tres clases distintas que no se unen

| Clase | Ejemplo | Dónde vive | Regla |
| --- | --- | --- | --- |
| Política | tope de conexiones, tamaño de página de replay | dominio o kernel según el consumidor | una declaración, un dueño semántico |
| Vendor | `RESTATE_*`, versiones y pins de binarios, puertos del motor | **el edge del vendor** | nunca en `kernel` ni en `domains`, en ninguna dirección |
| Despliegue neutral | `LOOPBACK_HOST`, inventario de puertos reservados de ACP | `kernel/contracts/topology` | la regla de bind y el inventario se comparten; el binding concreto lo resuelve la composición |

Hoy `gateway/src/constants` repite la topología de despliegue que ya declara
`runtime/src/constants`. Se comparte la **regla** (bind sólo a loopback) y el
**inventario** de puertos; los pins de Restate se van al edge.

**No se unen dos números iguales con nombres parecidos.** El tope de 1.000 de una
consulta del ledger y el tope de 200 de una página de respuesta son dos políticas
distintas que hoy coinciden; unificarlos por nombre crearía un acoplamiento falso.
Lo mismo con `TOOL_CALL_BOUND_MS` y `TOOL_CALL_TIMEOUT_MS`: son dos límites en dos
capas y la corrección es **asertar su relación**, no fusionar los nombres.

### 4.3 Mapeos compartidos CLI/API

La paridad deja de ser intención y pasa a ser estructura: un mapa total de verbo
de CLI por ruta de API, con una excepción escrita por cada `null`. El conjunto de
`resources/<contexto>` del gateway, `verbs/<contexto>` de la CLI y
`views/<contexto>` de la consola es el mismo conjunto de contextos con puerta.

La pata de UI de la paridad **no puede comparar dos llamadas al mismo helper**.
Una expectativa independiente, escrita a mano o derivada de lo que una vista
realmente renderiza, o la pata se retira y se documenta.

### 4.4 Andamiaje de test compartido

`makeRandom`, `intBetween`, `pick` y `forAll` están byte a byte en
`persistence/ledger/test/canonical-json/helpers/index.ts:18` y
`kernel/protocol/test/routes/helpers/index.ts:23`. La duplicación está declarada
en ambos archivos y es invisible al gate, que filtra `src`.

Se comparte **la mecánica determinista** en `kernel/testkit`: PRNG sembrado,
generación estructural, ejecución de propiedades. **No se comparte un oráculo de
dominio.** Un helper de test compartido no puede contener el algoritmo de
producción contra el que se compara, y no puede tener privilegios ni I/O ocultos:
si abre un archivo o una base, lo recibe como argumento explícito.

### 4.5 Duplicación correcta que se preserva

Re-exportar en lugar de copiar: `deriveInvocation`, `DaemonSubmission`,
`TOKENS_USED_MAX`, `EXIT_OK`/`EXIT_USAGE`. Dieciocho arrays `*_REFUSALS` son
dieciocho vocabularios acotados y no quieren una taxonomía común. Dos códigos de
salida por proceso son correctos porque son por proceso.

---

## 5. Barrels, ciclos y tests espejo

- Barrel explícito y pequeño; cero `export *`; ninguna declaración en el barrel.
  No hay máximo de líneas: hay prohibición de declarar y obligación de que cada
  export tenga consumidor.
- **Cero ciclos** entre paquetes; **cero deep imports** entre paquetes.
- El árbol de `test` es espejo exacto de `src`: `src/<ruta>/index.ts` tiene
  `test/<ruta>/index.test.ts`. Los tests no viven bajo `src`. En el baseline
  inspeccionado hay 211 archivos TypeScript/TSX bajo `packages/**/src`, todos
  `index.ts` o `index.tsx`, y ningún archivo de test bajo esos directorios.
  Este conteo demuestra anatomía, no cobertura conductual ni un espejo completo.
- Un solo sustantivo para el andamiaje. Hoy conviven `pilots`, `drills`, `testing`
  y `helpers` para el mismo concepto; se elige `drills` para escenarios con
  procesos reales y `fixtures` para datos, y nada más.
- Cada extracción deja el árbol **desplegable**. Ningún movimiento se parte en dos
  commits que dejan el repositorio roto en el medio.

---

## 6. Cómo se aplica

La reorganización **no** es un prerequisito de producto y **no** se hace como una
mudanza atómica masiva. Se aplica en tres situaciones y sólo en esas:

1. Toda funcionalidad nueva nace con la anatomía completa.
2. Toda extracción necesaria para un cambio seguro se hace en el packet de ese
   cambio, con su write-set exacto.
3. Los movimientos de §3 se adjudican como packets propios, cada uno con mapa de
   paths, imports, exports, docs y tests, y con el árbol desplegable al final.

Cada uno de esos packets declara sus rutas exactas en
[packets](../../implementation/packets/index.md); ninguno se ejecuta mientras el
write-set siga abierto.
