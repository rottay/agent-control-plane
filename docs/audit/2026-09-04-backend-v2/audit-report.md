# Auditoría técnica independiente — Agent Control Plane, backend V2

Fecha de ejecución: 2026-09-04. Solicitante: davila. Auditor: Claude Fable 5.1 (orquestación y síntesis) más doce auditores nombrados (once Opus, un Sonnet), todos read-only.
Repositorio: `agent-control-plane`, branch `main`.
Snapshot auditado: HEAD `456947875c453269ab7d105fa5088e947bc3cb90` (idéntico al SHA del brief), árbol limpio, copiado a un scratchpad aislado antes de leer. Minutos después del pin el árbol vivo empezó a recibir el packet `lifecycle-operation` sin commitear; nada de eso se auditó.
Modo: ningún commit, push, stage, checkout, reset, stash ni cambio de sesión de terminal. Sin tocar ningún repositorio de producto. Ningún archivo del repositorio fue modificado.
Evidencia cruda y los doce reportes completos: `evidence/` (los doce reportes de la flota; el log de la suite, la corrida del fence y el listado de `.acp-local` están resumidos en el README de esta carpeta).

---

## 1. Veredicto general

**ACCEPT_WITH_CHANGES.**

La dirección arquitectónica es correcta: cinco estratos declarados una vez y verificados en ambas direcciones, ledger append-only con cadena de hashes y reconstrucción byte-equivalente, puertos en el dominio con adapters en edges, eje de transporte cerrado y forzado por el compilador, drills de durabilidad con server real, hijos reales y SIGKILL real, superficie de escritura fail-closed, MCP acotado con negativas probadas. Los tests son genuinamente conductuales (≈94 % de 2.225 aserciones muestreadas).

Lo que no converge con los objetivos es de otra naturaleza: el espinazo está cableado pero **lo que transporta está vacío**. Ninguna instrucción llega al modelo; cinco de once pasos del plan de lifecycle graban "verificado, auditado, commiteado, checkpointeado" sin que ningún código lo haga; el daemon liga una sola cuenta y la estimación de cuota productiva siempre dice 100 %; la disciplina de receipts que este producto existe para mecanizar dejó de cumplirse en los últimos 18 commits; y el CI que el README llama "el mismo check que corre un writer local" no puede pasar en este HEAD. Nada de esto exige detener y rehacer la arquitectura. Todo exige reordenar el plan restante y corregir puntualmente antes de certificar.

## 2. Calificaciones (1-10)

| Dimensión | Nota | Base |
| --- | --- | --- |
| Dirección arquitectónica | 8 | Estratos, ledger, puertos y eje de transporte correctos. Resta: vocabulario Restate en kernel y dominio, eje de proveedor cerrado, barrel del daemon como composition root. |
| Durabilidad y recuperación | 7 | Ledger 8, engine 7. Resta: doble ejecución del proveedor en la ventana de crash, server Restate huérfano tras SIGKILL del daemon, cuarentena no atómica, id de invocación sin digest en la lane Restate. |
| Neutralidad de proveedores | 6 | Transporte forzado end-to-end; proveedor = enum cerrado + mapa `Record<string,…>` sin pin ni test. Grok por API key: cero cambios de contrato. Gemini por CLI: doce archivos, tres forzados por el compilador. |
| Seguridad operacional | 8 | Superficies cerradas por construcción (env key a key, receipts de escalares, SSE sin payload, bearer por digest). Resta: payload de evento abierto con guardia heurística, `account_events` fuera de la cadena de hashes, tools MCP unidas por nombre sin digest de schema. |
| Testabilidad | 8 | Tests 9/10 (conductuales, con controles negativos reales). Compuertas 4/10: CI no puede pasar, receipt sin caller, 18 commits sin verificador. Promedio ponderado hacia lo que el brief pregunta: prueban comportamiento. |
| Observabilidad | 3 | Diseño neutral correcto y aislado: sin caller productivo, seis de nueve atributos leen claves que el emisor no escribe, sin árbol de trazas, sin OTel/OpenInference/Phoenix (planificado en B5). |
| Mantenibilidad | 5 | Fence de 16.994 líneas tocado por 143/145 commits, ≈40 % historia congelada; narración de packets en 143/195 archivos; 11/13 paquetes sin nivel de familia; drift del README en la lista de "lo inerte". |
| Preparación como producto | 3 | Sin prompt, sin puerta de sometimiento, sin registro de iniciativa, roadmap = texto opaco, sin equipo por paso, sin coordinador ejecutable, cuentas en modo sombra. |

## 3. Hallazgos bloqueantes (10, ordenados por severidad)

Clase: 1 defecto real bloqueante. Cada uno fue verificado leyendo código y aserciones, y en los casos marcados, ejecutando.

### B1. Ninguna instrucción llega al modelo; el path productivo ejecuta una sesión vacía
- **Evidencia (ejecutada).** `ExecutionRequest = {taskId, attempt, identity, reattach}` (`kernel/contracts/src/schemas/execution-boundary/index.ts:202-216`); `SessionRequest` sin campo de contenido (`edges/providers/src/contract/index.ts:193-203`). El argv de Claude son siete argumentos sin prompt, pineados por igualdad en `providers/test/claude/index.test.ts:121-133` (re-corrido: 29/29 verdes). `grep -rn stdin packages/edges/providers/src/` devuelve nada: stdin se abre como pipe (`process/spawn/index.ts:73-79`) y nunca se escribe ni se cierra. Kimi y Codex arrancan como servidores JSON-RPC (`kimi/index.ts:146-148`, `codex/index.ts:240-242`) que no producen nada sin un frame que el paquete jamás envía; el adapter de Codex lo dice: "P4 sends no thread parameters at all" (`codex/index.ts:473-487`). `TaskEnvelope.objective` existe (`task-envelope/index.ts:42`) y ningún módulo productivo lo lee.
- **Impacto.** Un `claude` real spawneado así bloquea en stdin hasta `limits.timeoutMs` y muere por SIGKILL. Todos los drills verdes usan un binario fake que ignora argv (`daemon/test/drills/execution/index.test.ts:1654-1675`). Toda garantía aguas abajo (durabilidad, SSE, receipts, spend) está probada sobre una sesión a la que nunca se le pidió nada. La trazabilidad de prompts que el owner exige es imposible porque no hay prompt.
- **Corrección mínima.** `ExecutionRequest.instructionsDigest` + `SessionRequest.instructions`, resueltos desde `TaskEnvelope.objective` en el call site del daemon; Claude escribe y cierra stdin (o `-p` posicional), Codex envía `thread/start`, Kimi su frame ACP; un test con un hijo que ecoa lo recibido. Más el linaje de prompts por digest (sección 6).
- **Fase.** Es la mitad faltante de B1, no un packet nuevo. Antes de B5 y de B-E.

### B2. Cinco de once pasos del plan graban trabajo que nadie hizo, y la commit policy está hardcodeada
- **Evidencia.** `LIFECYCLE_PLAN` (`runtime/src/core/lifecycle/index.ts:51-64`): sólo el índice 4 (`INTENT`) tiene efecto; 6-10 (`VERIFICATION_COMPLETED`, `AUDIT_COMPLETED`, `READY_TO_COMMIT`, `COMMIT_RECORDED`, `CHECKPOINT_WRITTEN`) son `PLAIN`: `appendPlanStep` construye y apendea (`core/step-executor/index.ts:264-278`), `payloadFor` les da `{submissionDigest, beat, planIndex}` sin sha de commit, digest de checkpoint ni veredicto (`core/events/index.ts:103-150`). `Checkpoint` no lo produce nadie (`contracts/src/schemas/checkpoint/index.ts:26`). El daemon fija `commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT"` en tres sitios (`daemon/src/index.ts:638, :655, :882`) y nunca lee `envelope.commitPolicy`.
- **Impacto.** Un walk terminado deja un ledger que se lee como verificado, auditado, commiteado y checkpointeado. Consola y proyecciones heredan la ficción. Un packet `NO_COMMIT` camina el plan con commit.
- **Corrección mínima.** Leer la policy del envelope; convertir 6/7/9/10 en beats `INTENT` con puertos de efecto reales (`authorizeCommit`/`recordCommit`/`quarantineWorktree`, hoy islas) o retirarlos del plan hasta que los tengan.
- **Fase.** Antes de B-E.

### B3. La gestión multi-cuenta, el motor económico del owner, es inerte como sistema
- **Evidencia (parcialmente ejecutada).** (a) El daemon liga exactamente una cuenta: `DaemonExecutionConfig` es una ruta y un binding singulares (`daemon/src/daemon-child/index.ts:68-71`); `executionPortFor` construye un mapa de una entrada (`daemon/src/index.ts:1179-1190`); `WALK_CONCURRENCY_MAX = 4` es global sin tope por cuenta. (b) La estimación de cuota productiva siempre devuelve 100 %: los tres call sites pasan `observations: []` (`cli/src/cli/index.ts:968`, `gateway/src/accounts/index.ts:168`); ejecutando el `dist` con un record que declara `remainingRatio: 0.05` devuelve `remainingRatio: 1`, y el gateway publica el 1 (`accounts/index.ts:181`) mientras su comentario en `:163-165` afirma que el dominio rechaza el set vacío. (c) `executeSwitchPlan` itera `plan.events` y apendea `ACCOUNT_SWITCH_COMPLETED` sin leer jamás `plan.steps` (`runtime/src/switch-executor/index.ts:87-161`): los cuatro últimos pasos (`OPEN_FRESH_SESSION`…`CONTINUE`) no tienen ejecutor. (d) Ningún adapter clasifica presión de cuota; Codex parsea `usageLimitExceeded` y lo emite como string de estado sin consumidor (`codex/index.ts:209, :373`); `QUOTA_EXHAUSTED`/`QUOTA_WARNING` sólo aparecen en tests. (e) Un DRAIN del operador es invisible para la elección: `foldEffectiveState` sólo lo consume el read model del gateway; `runSubmission` elige desde el owner file y nunca abre el ledger (`cli/src/cli/index.ts:945-975`, `routing/index.ts:798`).
- **Impacto.** No hay dónde aterrizar un switch, el router mide margen contra una constante, el ledger graba switches falsos como hechos irretractables, nada puede construir un `SwitchTrigger`, y drenar una cuenta agotada no impide que la próxima sumisión la elija.
- **Corrección mínima.** Hoy: el gateway prefiere `record.quotaEstimate.remainingRatio` cuando `observationCount === 0`; partir los eventos del switch en `SELECT_ACCOUNT` (el `COMPLETED` lo apendea quien abre la sesión en B); plegar el estado efectivo en la elección de la CLI. Siguiente: fold de uso por cuenta desde `TOKEN_USAGE_RECORDED` → `QuotaObservation[]`; `bindings` plural por `accountId`; señal `quotaPressure` en el contrato de proveedor, Codex primero.
- **Fase.** Ahora (tres fixes chicos) y antes de Promptfoo/routing adaptativo (el resto).

### B4. La disciplina de evidencia se cortó en el tramo de mayor riesgo, y nada mecánico lo notó
- **Evidencia.** Los 18 commits `fcedb7d..4569478` (2026-09-03 21:28 → 09-04 17:32) no son referenciados por ningún archivo de `.acp-local` (grep de SHA corto y largo sobre 1.135 `.md`); los receipts de autorización de commit terminan el 28-08; la producción de artifacts cae de 324 (28-08) a 6 (04-09). `authorizeCommit`/`recordCommit` sólo tienen callers en tests; no existe hook `pre-commit` (`.githooks/` contiene sólo `pre-push`). `AGENTS.md:45-53` exige un verificador distinto que registre exit codes por commit. Además la autoridad del programa V2 vive sólo en `.acp-local/v2-roadmap-draft.md` (gitignored, "no es ley todavía"): `docs/ROADMAP.md` tiene cero menciones a V2 y su línea de estado termina en `P8_COMPLETE`. El memo Opus del 03-09 ya advertía 17 commits sin receipt.
- **Impacto.** Los 18 commits contienen write-set enforcement, arbitraje de leases y arbitraje cross-process de tools: el código de mayor riesgo del repo se integró sin verificación independiente registrada, mientras el fence certifica el digest de un roadmap que no gobierna el trabajo actual. El sistema reproduce el problema que existe para resolver.
- **Corrección mínima.** Receipts retroactivos para los 18 (o una excepción escrita que los nombre); commitear el roadmap V2 bajo el digest del fence (o `docs/roadmap-v2.md` pineado); un `pre-commit` que verifique mecánicamente un receipt, o reescribir AGENTS.md diciendo que el receipt es convención.
- **Fase.** Ahora.

### B5. El CI no puede pasar en este HEAD, y el README dice que corre el mismo check que un writer local
- **Evidencia.** `.github/workflows/ci.yml:34` corre en `ubuntu-latest` y `:68` ejecuta `pnpm check`. Los drills de launchd llaman a `/usr/bin/plutil` (`daemon/test/launchd/drills/index.test.ts:106`) y asertan exit 0 (`:197, :287`). Los drills de Restate se niegan a saltearse por diseño (`durability/test/drivers/drills/index.test.ts:854-859`: "a drill suite that skipped here would be indistinguishable from one that passed") y `scripts/restate-server.pin.json` sólo declara `darwin-arm64` ("A platform absent from this file is refused"). El workflow no invoca `acquire-restate-server.mjs`. `README.md:181`: "GitHub Actions running the identical check a local writer runs".
- **Impacto.** La compuerta mecánica de cabecera es decorativa; toda afirmación apoyada en "CI corre el mismo check" carece de respaldo. El owner debería mirar los logs reales del workflow desde el 03-09.
- **Corrección mínima.** `macos-14` + paso de adquisición con pin `darwin-arm64`, o un set de proyectos herméticos para CI y la frase del README corregida; añadir `linux-x64` al pin si se quiere Linux.
- **Fase.** Ahora.

### B6. La identidad de ledger en SSE es un digest del path: un restore sobre el mismo archivo pasa por el mismo ledger
- **Evidencia (sonda ejecutada).** `gateway/src/database-identity/index.ts:22-28` hashea `resolve(path)` y nada más; `ledger_meta` no guarda id de instancia (`ledger/src/migrations/index.ts:154-162`). El brazo de "ledger foráneo" del cliente compara `frame.database.id` (`console/src/api/stream/index.ts:513`). Dos archivos distintos en el mismo path producen un id byte-idéntico. Los tests de consola usan dos paths distintos (`console/test/api/stream/index.test.ts:648-690`); ningún test cubre mismo path, otro archivo. `ANCHOR_AHEAD_OF_HEAD` sólo atrapa un reemplazo más corto.
- **Impacto.** Es el escenario motivador del ADR 0028, cerrado sólo a medias: restaurar un backup con el mismo nombre, reiniciar, y una pestaña con secuencia 3 aplica las filas 4..40 del ledger B sobre la vista del ledger A.
- **Corrección mínima.** Uuid de instancia en `ledger_meta` plegado en `id`; interino más barato: que el cliente verifique la cadena `previousSha256`/`eventSha256` que ya recibe y descarta.
- **Fase.** Siguiente packet de streaming.

### B7. Un SIGKILL del daemon en modo Restate deja huérfano al server y bloquea el próximo arranque; el driver nunca se construye en producción
- **Evidencia.** `durability/src/server-handle/index.ts:250-262` spawnea el binario sin `detached` ni grupo propio; el único stop es el recurso de unwind en `daemon/src/mode-restate/index.ts:326-337` (camino graceful). `recoverStaleLock` (`daemon/src/singleton/index.ts:144-181`) borra el pidfile y no señaliza nada aunque el status document conserva el pid del server (`daemon/src/index.ts:322`). El siguiente arranque cae en `assertReservedPortsFree` (`daemon/src/lifecycle/index.ts:165-177`) y se rehúsa. Todos los tests de daemon en `RESTATE` usan SIGTERM; el único SIGKILL al daemon corre en `SQLITE_SUPERVISOR` con el port check apagado (`daemon/test/drills/index.test.ts:752`). Además el único `new RestateDriver` fuera de tests es el hijo de drill (`restate-child/index.ts:480`): `startRestateMode` llama `sendAdvance`/`attachAdvance` directamente y no sostiene ningún driver; `OrchestrationDriver` no aparece como tipo de parámetro en ningún `src`.
- **Impacto.** Un daemon Restate matado a la fuerza deja un server vivo sosteniendo los puertos pinneados sin camino soportado para liberarlos. Las cuatro capacidades declaradas `SUPPORTED` describen un objeto que el plane ensamblado no instancia.
- **Corrección mínima.** En recovery, leer el pid del server del status document, verificar identidad como ya hace `probeIdentity`, y detenerlo; drill `RESTATE` + SIGKILL al daemon que aserte que el reinicio funciona. Dar al daemon una instancia del driver y enrutar los verbos por ella.
- **Fase.** Siguiente (junto con las puertas de lifecycle en curso).

### B8. El proveedor se ejecuta dos veces en la ventana de crash y el ledger registra una; la cuarentena no es atómica
- **Evidencia (aserción existente).** `createExecutionEffects.apply` corre efecto → usage → gate → marcador (`runtime/src/execution-effects/index.ts:363-427`); un SIGKILL entre `execute()` y `writeMarker` deja `NOT_DONE` y el walk re-ejecuta. Lo aserta un test verde: `expect(staged.calls.starts).toBe(2)` con una sola observación (`runtime/test/execution-effects/index.test.ts:450-476`). La cuarentena por violación son tres transacciones separadas (`daemon/src/index.ts:1131-1166`) porque el ledger no tiene append por lote; el propio comentario del daemon (`:1073-1079`) describe el estado que un crash intermedio produce: violación registrada, tarea resumible, proveedor re-ejecutado. El grant del lease store commitea antes del evento `LEASE_ACQUIRED` (`daemon/src/arbiter/index.ts:358-418`) y el "rebuildable" del store (`ledger/src/lease-store/index.ts:27-28`) no tiene implementación ni test.
- **Impacto.** Doble gasto real de tokens con sub-registro en el ledger; con cuentas de suscripción es cuota quemada dos veces. El orden efecto-luego-append es el correcto; lo que falta es registrar la exposición.
- **Corrección mínima.** Marcador de intención pre-ejecución con el digest de operación para que un walk reanudado vea que hubo una ejecución y registre la exposición; `appendBatch` en el ledger para la cuarentena; escribir el rebuilder del lease store o rebajar el comentario.
- **Fase.** Siguiente packet de ledger/runtime; el costo aceptado es decisión del owner.

### B9. El eje de proveedor no es extensible como lo dictó el ruling: enum cerrado más un mapa `Record<string,…>` sin pin ni test
- **Evidencia.** `CLI_ADAPTERS: Readonly<Record<string, ProviderAdapter>>` (`daemon/src/index.ts:1034`); ampliar `CLI_SUBSCRIPTION_PROVIDERS` (`execution-boundary/index.ts:46`) compila limpio, el proveedor nuevo no obtiene binding y el port rechaza `TRANSPORT_UNAVAILABLE` en `route.accountId` (`execution-port/index.ts:617-618`), culpando a la cuenta. `CLI_ADAPTERS` no aparece en ningún test ni ley del fence. `docs/ROADMAP.md:764-765` dictó "`ProviderId` extensible por descriptor validado con registro estático en el composition root"; no existe tipo descriptor ni función de registro, y ningún ADR registra el ruling como cumplido. Sumar Gemini por CLI toca doce archivos, tres forzados por el compilador; el eje de transporte, en cambio, está forzado end-to-end (`switch` con `never`, records unión-keyed).
- **Impacto.** Un cuarto proveedor sale como rechazo mal clasificado. El "Lego" del owner en el eje que más le importa depende de disciplina, no del compilador.
- **Corrección mínima.** `Readonly<Record<ProviderName, ProviderAdapter>>` (una línea, hoy); luego el descriptor con registro en el composition root o un ADR que declare la divergencia.
- **Fase.** Ahora (la línea) / antes de sumar un proveedor (el descriptor).

### B10. La legibilidad para un contribuidor externo la castigan tres cosas que el propio repo prohíbe
- **Evidencia.** (a) `daemon/src/index.ts`: 1.216 líneas con `startDaemon` en 274-1005, contra `docs/ROADMAP.md:378` ("el `src/index.ts` raíz de cada paquete es sólo un barrel público estable"); el barrel del gateway (19 líneas) es el modelo. (b) Narración de packets en 143 de 195 archivos `src` (539 líneas; 1.844 con tests y fence), contra la ley del owner de no narrar cambios; ejemplo: `runtime/src/index.ts:313` "// V2-B4b stage 2: the durable tool-call receipt…". (c) `scripts/check-architecture.mjs`: 16.994 líneas, 39 % comentario, 5.297 líneas de `RETIRED_PATHS` + 138 arrays `*_WRITE_SET` congelados, 143 de 145 commits lo tocan, ≈0,43 líneas de fence por línea de `src` en el rango V2, 1.453 paths literales, 499 nombres de export pineados; una contribución mínima exige editar arrays históricos. (d) `README.md:86-88` afirma que no existe observador Git productivo mientras `daemon/src/git-observer/index.ts` (263 líneas) está cableado a la puerta de conformance; `README.md:108` dice doce paquetes (son trece, falta `edges/tools`); `README.md:68` dice 17 rutas y 2 writes (son 19 y 3).
- **Impacto.** Un contribuidor OSS abre primero el archivo que esconde el cableado, lee historia de build en cada comentario, no puede agregar un archivo sin tocar un script de 17K líneas, y el README lo desinforma justo en la lista de "lo que sigue inerte".
- **Corrección mínima.** Mover 122-1216 del daemon a `src/composition/index.ts` (sin renombrar símbolos); barrido mecánico que borre sólo el token de packet inicial (un commit, diff de prefijos); externalizar write-sets históricos y `RETIRED_PATHS` a un archivo de datos leído una vez (3-4K líneas menos, semántica intacta); corregir las tres líneas del README y añadir una 7.ª claim de superficie para el README raíz.
- **Fase.** Composition y README: ahora. Narración y dieta del fence: packet propio de writer único, antes de abrir un segundo writer.

## 4. Mejoras no bloqueantes (clase 2, selección priorizada)

1. **`account_events` fuera de la cadena de hashes y de `verifyIntegrity`**: una acción forjada pasa con `ok: true` (reproducido en base descartable); su test "is append-only" no emite ningún UPDATE/DELETE (`ledger/test/ledger/index.test.ts:2124`). Encadenar como sus hermanas y copiar la forma del test de `:656`.
2. **Guardia del payload de eventos heurística**: `payload: z.record(…unknown)` (`control-plane-event/index.ts:132`); sonda real acepta un prompt completo bajo `stdout`, un JWT en prosa, una clave AWS; los patrones de valor no corren sobre nombres de clave. Patrones con `\b` y schemas por tipo donde la forma es fija.
3. **Tools MCP unidas por nombre**: `inputSchema` descartado (`tools/src/client/index.ts:232-241`); digest del schema en el primer `tools/list`, rechazar si cambia.
4. **Telemetría mal keyed**: seis de nueve atributos leen claves planas que producción anida bajo `payload.route` (`observation/src/telemetry/index.ts:189-199` vs `runtime/src/core/events/index.ts:130-141`); `correlationId`/`causationId` descartados (sin árbol de trazas); `ERROR_TYPES` nombra dos tipos inexistentes; `computeBaseline` lanza `MISSING_TOKENS_USED` sobre cualquier cadena real. Arreglar antes de B5 o B5 exporta spans vacíos.
5. **Paridad**: la pata UI del test cuatro-vías es `f(x) == f(x)` (`gateway/test/parity/index.test.ts:322-329`); `WRITE_REFUSED` cae a exit 2 por el `default:` mientras la API responde 409 (`cli/src/cli/index.ts:384-400`); nada relaciona verbos CLI con rutas (`CLI_VERB_BY_ROUTE` total sobre `API_ROUTES`), y ya drifteó: README de la CLI lista 8 de 11 verbos.
6. **SSE**: consola "Degraded" tras 30 s en cualquier ledger quieto porque el keep-alive es un comentario SSE que el browser no entrega (`gateway/src/stream/index.ts:77`); `#open()` corre `status()` completo con `COUNT(*)` por proyección para leer un escalar (`:282`); el test de reconexión de cabecera puede pasar sin replay (`test/stream/index.test.ts:566-616`).
7. **Registry de capacidades**: 13 campos por modelo, sólo 5 deciden; preferencia por orden del documento, así que un score de Promptfoo en `quality.score` es una revisión válida que no cambia nada (`accounts/src/policy/index.ts:436-489`); el digest de la policy vive en el fence (`POLICY_VERSION_DIGESTS`, `check-architecture.mjs:11711`), así que editar la policy exige editar un `.mjs`.
8. **Duplicaciones ciegas al scanner de nombres**: `TOOL_CALL_BOUND_MS`/`TOOL_CALL_TIMEOUT_MS` (dos nombres, un número, sin gate); puerto 7517 declarado tres veces, 5178 dos; lista de modos declarada tres veces (`DRIVER_MODES`, `DAEMON_MODES`, literal en `status/index.ts:79`); trece constantes `RESTATE_*` en el dominio (`runtime/src/constants`), que el edge llama "owed work".
9. **Lane Restate**: el id de invocación excluye el digest de sometimiento (`runtime/src/submission/index.ts:137-150`), así que una re-sumisión con otra ruta es respondida por replay de idempotencia sin llegar al guard de continuidad; los drills N4 sólo cubren la lane SQLite.
10. **`DurableStepContext = Pick<Context,…>` del SDK de Restate** sale por el barrel público de durability y sobrevive en `dist/contracts/index.d.ts`.
11. **Estructura**: 11/13 paquetes sin nivel de familia (gateway 18 carpetas/19 archivos; runtime 17/22); cinco cosas llamadas `contract(s)`; `providers` es el único edge sin puerto en el dominio; ADR 0014 ordenó `toy/`→`scenarios/` y `runtime/constants`→`kernel/topology` y ninguno aterrizó; ADR 0015 omite `tools`; helpers de test duplicados byte a byte (`makeRandom`, `forAll`) invisibles al scanner, que filtra sólo `src`.
12. **Fence**: 19 "claims" de SECURITY.md verificadas por `includes(literal)`, dos ancladas a comentarios (cambiar `0o600` por `0o644` mantiene verde); "88 leyes fail-closed con scope vacío" sin ninguna sonda que ejerza esa rama; 26 sondas de fallo sintético para ≈123 familias de ley.
13. **Dos drills de launchd asertan una propiedad global del árbol real desde un test.** El fence rechaza cualquier path untracked no ignorado en todo el árbol (`check-architecture.mjs:7035-7062`; medido con `notes.md`, `scratch.tmp`, `docs/draft.md`, `README.bak`), y eso es política deliberada y documentada (`CONTRIBUTING.md:64-70`), clase 3. El defecto de clase 2 es que `daemon/test/launchd/drills/index.test.ts:569,581` corren el fence contra el árbol vivo: un archivo suelto en cualquier lugar pone dos tests del daemon en rojo con un mensaje sobre write-set, no sobre lo que el test afirma. Fue exactamente lo que provocó los 2 rojos de esta auditoría. Fix: apuntar los dos drills a un árbol sintético como ya hace `scripts/architecture/roots.test.mjs:363`.
14. **Enforcement plane isla**: `authorizeCommit`, `recordCommit`, `quarantineWorktree`, `verifyPrestate` sin caller; la puerta de conformance reproduce la decisión de cuarentena a mano (`daemon/src/index.ts:1140-1166`), segundo productor de una decisión que el repo prohíbe en todos lados.

## 5. Sobreingeniería a eliminar o simplificar

| Qué | Costo hoy | Propuesta | Riesgo |
| --- | --- | --- | --- |
| 138 arrays `*_WRITE_SET` congelados + `RETIRED_PATHS` + move-map (5.297 líneas) | 31 % del fence, un array nuevo por commit | Un archivo de datos (JSON) con la misma semántica de igualdad exacta, leído una vez; git es el historial | Bajo, representacional |
| 9 bloques de pin de exports por igualdad (499 nombres) | Cada export cuesta dos edits | Un helper `assertPinnedSurface(barrel, pinned)` | Bajo |
| Escaneo de imports por regex/substring (164 sitios que leen fuente, 0 parsers AST) | Frágil a renombres, ilegible | dependency-cruiser o eslint-plugin-boundaries para la familia "N fuentes importan sólo lo permitido" (exige decisión de dependencia; el fence se declara "dependency free") | Medio |
| 19 anclas literales de SECURITY.md | Sensación de verificación conductual | Renombrar como checks de frescura de docs, o exigir que cada ancla nombre el test que prueba la claim | Nulo |
| `toy/repository` en el barrel público del dominio | Scaffolding de drills como API pública, consumido por producción | Subpath `@acp/runtime/scenarios` (ADR 0014 ya lo decidió) | Bajo |
| Traductor Langfuse sin caller | Código muerto que sobrevive a la decisión OTel | Borrar al aterrizar `TelemetryExporterPort`; Phoenix es un endpoint OTLP, no un paquete | Nulo |
| Colectores/baseline de observación en sombra (P3) | 64 exports, 4 usados; `computeBaseline` no corre sobre cadenas reales | Cablear al walk (donde ya vive `recordUsage`) o retirar hasta B5 | Bajo |
| Narración de packets en comentarios (539 líneas `src`) | Ruido histórico en cada archivo | Barrido mecánico de prefijos, un commit | Nulo |
| Drills de launchd con `plutil` dentro de `pnpm test` | Rompen CI en Linux; el template es inerte por diseño | Proyecto vitest sólo-macOS con skip honesto, o fuera del gate | Bajo |
| Pin de conteo de tipos de evento (`toHaveLength(24)`, corregido a mano en `1fb0bd1`) | Test que se mueve hacia la implementación | Diferencia de conjuntos contra lista congelada, o borrar | Nulo |

No tocar: la matriz del hook pre-push (13 negaciones + 2 permisos ejecutados), la numeración contigua de ADR, el digest del roadmap, el inventario de objetos de schema que detecta triggers borrados, las ≈90 leyes de forma de dominio. Son bespoke porque el producto lo es.

## 6. Funcionalidades imprescindibles ausentes (para un producto local sólido)

Marcadas [P] cuando el draft V2 ya las planifica y [N] cuando no están planificadas.

1. [N] **Canal de instrucción** en `ExecutionRequest`/`SessionRequest` (B1).
2. [N] **Linaje de prompts y respuestas** sin violar la ley de no-transcript: `PromptRecord` en `kernel/contracts/schemas/prompt-record/`; bytes en el artifact store existente bajo `prompts/` (0700/0600, rename atómico, sin delete), escaneados con `findCredentialViolations` y publicados redactados si hay hit; eventos `PROMPT_RECORDED`/`RESPONSE_RECORDED` con payload de escalares (digests, bytes, step, cuenta, modelo, transporte, `redactionVerdict`); SSE y DOM sólo ven digests; lectura `GET /api/v1/tasks/:taskId/prompts/:digest` detrás del bearer local. Los nombres `promptdigest`/`responsedigest` normalizan fuera de las claves denegadas, así que no hay que ensanchar guardias.
3. [N] **Puerta de sometimiento de tareas y registro de iniciativas**: hoy nada apendea `INITIATIVE_REGISTERED` en `src`, y el POST de roadmap se niega si la iniciativa no existe (`gateway/src/routes/index.ts:850`), así que la única write door es inalcanzable sin sembrar el ledger a mano. `POST /api/v1/initiatives` y `POST /api/v1/tasks` por el registrar guardado existente, con verbo CLI equivalente.
4. [N] **Roadmap como plan, no como texto**: `RoadmapStep` + `TeamComposition` (DT, implementadores × N, investigador, auditor, versión de policy por paso) referenciados por digest desde `RoadmapVersion`; evento `ROADMAP_STEP_DECLARED`.
5. [N] **Descomposición roadmap → grafo de tareas con dependencias** (`conflict-graph` es compatibilidad de write-sets, no orden): `TaskGraph`, `TaskDependency`, `TASK_GRAPH_PLANNED`.
6. [N] **Coordinador ejecutable como workflow durable** (`DT_PLAN_REQUESTED`/`DT_PLAN_RECORDED`) y **compuerta de aprobación del owner** (`WAITING_OWNER` existe como estado sin transición ni señal; usar la señal durable que `@acp/durability` ya expone).
7. [P parcial] **Pool de cuentas con reserva** (`ACCOUNT_RESERVED`/`ACCOUNT_RELEASED`), fold de uso por cuenta, señal de presión de cuota por proveedor, ejecutor de switch real (`OPEN_FRESH_SESSION`→`REHYDRATE_CHECKPOINT`→`CONTINUE`), recurrencia en el calendario de reset (ventana de 5 h de Claude rueda en vez de `RESET_ALREADY_PASSED`), tope de concurrencia por cuenta.
8. [N] **Clase de costo** `SUBSCRIPTION | METERED` en la policy y regla "preferir suscripción"; `costPerMillionTokens` hoy es `null` en los cinco modelos y nunca se lee; `TaskEnvelope.budget` sólo existe en fixtures.
9. [P] **`TelemetryExporterPort`** en `domains/observation` + edge `packages/edges/telemetry` OTLP/HTTP (Phoenix = endpoint), import dinámico sólo si hay config, cola acotada drop-oldest, un request en vuelo, `droppedCount` en `/status`, health independiente; `traceId = correlationId`, `spanId = eventId`, `parentSpanId = causationId`; emitir `acp.prompt.digest` en lugar de `input.value`.
10. [N] **Daemon residente** con cola de sometimiento (hoy runner one-shot que idlea tras el walk) o, más barato, un procedimiento documentado de `acp-daemon` con config de ejemplo (el runbook no menciona `acp-daemon`).
11. [P] **Drill con sujeto real** (un CLI real, una cuenta, packet read-only `NO_COMMIT`) autorizado por el owner: hoy ninguna capacidad de proveedor salió de `UNKNOWN`.
12. [N] **`appendBatch`** en el ledger, uuid de instancia en `ledger_meta`, y `headSequence()` público.

## 7. Orden del plan restante: validación y corrección

Plan del brief: (1) lifecycle op + puerta CLI → (2) puerta API → (3) OTel/OpenInference + Phoenix → (4) transports locales y continuidad entre cuentas → harness/MCP → observabilidad productiva → Promptfoo y routing adaptativo → certificación integral.

Veredicto: **secuencia parcialmente incorrecta.** Los pasos 1-2 son correctos y chicos. El paso 3 está antes de tiempo: sin instrucción en el path (B1), sin claves de telemetría alineadas con el emisor (mejora 4) y sin un sujeto real, B5 exporta spans vacíos de una ejecución vacía. Promptfoo y el routing adaptativo son ciegos mientras el estimador reciba observaciones vacías (B3) y el registry ignore `quality.score` (mejora 7).

Orden propuesto:

1. **Ahora, packet de correcciones puntuales (un writer, días):** B9 (una línea), B3 a/b/c (gateway prefiere el ratio del owner, split del switch, estado efectivo en la elección), paridad `WRITE_REFUSED`, B10 composition + README, B5 CI (runner macOS + adquisición, o set hermético), B4 (receipts retroactivos o excepción escrita; commitear la autoridad V2).
2. **Puertas de lifecycle CLI → API** (en curso), con `CLI_VERB_BY_ROUTE` total aterrizado primero para que la segunda puerta no rezague.
3. **B1-bis: canal de instrucción + `PromptRecord`** (B1, feature 2). Es la precondición de todo lo demás.
4. **Drill con sujeto real**, autorización del owner pedida ya: un Claude real, una cuenta, un prompt read-only. Cierra `UNKNOWN` por primera vez y hace falsables B2 y B8.
5. **B2-bis:** B7 (reap del server + drill SIGKILL en RESTATE, driver instanciado), B8 (marcador de intención, `appendBatch`), mejora 9 (digest en el id de invocación), B6 (uuid de instancia).
6. **Ola de cuentas** (B3 d/e y feature 7-8) antes de cualquier routing adaptativo.
7. **B5 observabilidad:** primero mejora 4 en el dominio (frío, paralelizable), luego el port + edge OTLP tras la respuesta al ask C1 de dependencias. Promptfoo sólo después de que `quality.score` decida algo.
8. **Contratos de producto** (features 3-6): puerta de iniciativas/tareas, `RoadmapStep`/`TeamComposition`, decomposer, coordinador durable, compuerta de owner.
9. **Dieta del fence + árbol objetivo** (un mapa atómico, un writer; el repo ya hizo uno de 302 pares) y barrido de narración. Antes de abrir un segundo writer sostenido.
10. **B-E**: la compuerta computada debe incluir un hijo que ecoe la instrucción recibida, receipt por commit, CI verde en un runner real, cero doble gasto en la ventana de crash, identidad de ledger por instancia.

### Paralelización

- **Writer único obligatorio:** runtime, durability, daemon, contracts, ledger, barrels, numeración de ADR y el fence (hoy el conflicto universal: 143/145 commits). El memo Opus del 03-09 midió que 8 de 21 pares de packets V2 son disjuntos salvo por el fence.
- **Paralelizable en árboles copiados (`git ls-files` + `mktemp -d`, nunca `git worktree add`):** la corrección de claves de telemetría y el port/edge OTLP (`domains/observation` y un edge nuevo, fríos); el barrido de README y docs; la librería de cuentas (fold por cuenta, recurrencia del reset) hasta donde no toque el daemon; verificación independiente de los 18 commits (R1 del memo).
- **Receta para un segundo writer:** el packet de reserva del memo Opus (envelopes por prefijo, arrays de write-set, ADRs stub reservados, líneas de barrel) después de la dieta del fence; sin eso, dos writers no pueden mantener write-sets legales.

## 8. Porcentaje completado del backend V2 (sin UI ni P9)

**≈ 55 % del V2 tal como está escrito; ≈ 35 % del backend que el owner describe.**

Por packet del draft V2: B0 100 %, B1 70 % (plomería completa, contenido ausente), B2 80 % (drills reales; puertas pendientes; B7/B8), B3 85 % (B6), B4 85 % (schema digest, ask de dependencia), B5 5 % (stub sin caller), B6 100 %, B-E 0 %. El draft V2, además, no planifica el canal de instrucción, el linaje de prompts, la puerta de sometimiento, el roadmap como plan, el equipo por paso, el coordinador ejecutable ni el pool real de cuentas; eso es lo que separa el 55 % del 35 %.

## 9. Recomendación ejecutiva

**Continuar con correcciones puntuales y el plan reordenado**, no detener. La arquitectura no está mal: está vacía en el centro y sin verificar en el borde. Tres condiciones para que "continuar" sea honesto: (a) el canal de instrucción y el drill con sujeto real antes de observabilidad y evaluaciones; (b) restaurar la disciplina de receipts y commitear la autoridad V2 antes del próximo packet; (c) que el CI pase de verdad o que el README deje de decir que corre el mismo check.

## 10. Respuestas cortas a las veinte preguntas del brief

| # | Pregunta | Respuesta |
| --- | --- | --- |
| 1 | ¿Conectado o islas? | Espinazo conectado, carga vacía (B1, B2). Islas: enforcement plane, observación/telemetría, cadena de switch, `Checkpoint`, `routeWithPolicy`. |
| 2 | ¿El ledger es la verdad? | Sí para los dos streams encadenados; `account_events` está fuera de la cadena e integridad; lease store y claim store deciden fuera del log (el segundo bien, el primero con grant antes del evento). |
| 3 | ¿Restate encapsulado? | El SDK sí (5 imports, todos en el edge, gate por parser). El vocabulario no: `DRIVER_MODES` en kernel, 13 constantes en el dominio, `mode-restate` en el daemon; un driver Temporal podría implementar el port sin cambiarlo, pero nadie lo consume polimórficamente. |
| 4 | ¿SQLite falla explícito? | Sí: cuatro verbos `UNSUPPORTED` con `CAPABILITY_UNSUPPORTED` tipado, drill con mutante escrito a mano. La ley de correspondencia sólo se llama desde tests. |
| 5 | ¿Semántica real de attach/cancel/…? | Sí en los drills (server real, SIGKILL real). Huecos: cancel nunca llega al hijo proveedor, timer a través de reinicio del daemon no probado, señal duplicada replay como `ok`, SIGKILL del daemon en RESTATE (B7). |
| 6 | ¿Efectos duplicables? | Sí: ejecución del proveedor at-least-once con gasto sin registrar (B8); cuarentena no atómica; claim TTL no pineado al timeout del edge. Tool calls y cancelación: exactamente una vez. |
| 7 | ¿SSE correcto? | Secuencia, LEID, gaps, duplicados, tormenta y hello-antes-de-replay: correctos y aseverados. Identidad de ledger por path (B6); consola Degraded en ledger quieto. |
| 8 | ¿Filtraciones? | Superficies cerradas por construcción; riesgo residual en la guardia heurística del payload y en tools sin digest de schema. `HOME` viaja al hijo (documentado). |
| 9 | ¿CLI y API convergen? | Estructuralmente en tool-call; nada relaciona verbos con rutas (8/19 rutas de una sola puerta), exit codes por `default:`. |
| 10 | ¿Provider-neutral? | Transporte sí; proveedor por disciplina (B9). |
| 11 | ¿Duplicados? | Gate real de nombres (1.450). Ciegos: dos nombres para 30 s, puerto 7517 ×3, modos ×3, constantes Restate en el dominio. |
| 12 | ¿La estructura cuenta la arquitectura? | Rango de paquetes sí; rango de carpetas no (11/13 planos), barrel del daemon no, cinco "contracts". |
| 13 | ¿Tests de comportamiento? | Sí, ≈94 %. Sin mutation ni property testing (correctamente ausentes, planificados). |
| 14 | ¿Falsa seguridad? | Sí en las compuertas: CI, receipt sin caller, 18 commits sin verificar, anclas literales de SECURITY.md, "fail-closed" sin sonda. |
| 15 | ¿Proporcionalidad? | No: fence de 17K líneas, 40 % historia, 0,43 líneas por línea de código. |
| 16 | ¿Capacidad imprescindible ausente? | Sección 6: instrucción, prompts, sometimiento, plan por pasos, cuentas reales, coordinador. |
| 17 | ¿Orden correcto? | Parcialmente; sección 7. |
| 18 | ¿Paralelizar? | Sección 7: telemetría/docs/cuentas-librería en árboles copiados; el resto writer único. |
| 19 | ¿Eliminar? | Sección 5. |
| 20 | ¿Riesgo no visto? | Que la certificación B-E se compute sobre una ejecución que nunca pidió nada a ningún modelo y sobre commits sin verificador: la compuerta sería verde y el producto no existiría. |

## 11. Notas de método

- Suite completa ejecutada en el snapshot aislado: 133 archivos / 3.032 tests; los 2 rojos fueron un archivo untracked del auditor rechazado por el fence (mejora 13); sin él, fence y suite pasan. Coincide con la certificación del brief.
- Los auditores re-corrieron archivos individuales de proyectos herméticos (providers 29/29, gateway parity 34/34, stream 30/30, console stream 54/54, tools 77/77, ledger concurrency 2/2) y ejecutaron sondas contra `dist` para B3-b, B6 y las guardias de payload.
- Una discrepancia de medición corregida: la narración de packets son 539 líneas en `src` bajo regex con límite de palabra (no 1.322); el conteo de archivos (143/195) se sostiene.
- No se abrió una segunda cadena de auditorías; los hallazgos aquí están corroborados por al menos dos fuentes independientes (auditor + orquestador, o dos auditores) cuando son bloqueantes.
