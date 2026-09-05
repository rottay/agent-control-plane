# Rúbrica de arquitectura — Agent Control Plane

Fecha de ejecución: 2026-09-04. Solicitante: davila. Autor: Claude Fable 5.1.
Repositorio: `agent-control-plane`, branch `main`.
Snapshot aplicado: HEAD `456947875c453269ab7d105fa5088e947bc3cb90`, el mismo del audit V2 del mismo día.
Insumos: el informe `audit-report.md`, los doce reportes de la flota en `evidence/`, y una lectura directa del árbol de carpetas `src` y `test` de los trece paquetes en el árbol vivo (que además del snapshot contiene el packet `lifecycle-operation` staged, ADR 0029, no auditado).
Modo: sin cambios en el código del repositorio auditado. Este documento vive en `docs/audit/` por decisión del owner del 2026-09-04. Nota histórica: mientras el documento estuvo sin rastrear, el fence lo rechazaba por estar fuera del write-set y `pnpm check` quedaba en rojo; esa ventana cerró cuando el packet de gobernanza sumó los diecinueve paths al write-set exacto del fence.

Propósito: un instrumento reutilizable para evaluar toda la arquitectura del control plane, con una escalera única de madurez por criterio, una columna de lo que la documentación afirma y una de lo que se midió, de modo que la falsa seguridad quede cuantificada y no sólo narrada. Se aplica una primera vez al snapshot para calibrarlo.

---

## Parte 1. ¿Los nombres de la estructura son suficientemente declarativos?

**Veredicto: en el rango de paquetes sí; en el rango de carpetas no todavía.**

Los trece nombres de paquete dicen su estrato y su responsabilidad sin ambigüedad (`contracts`, `protocol`, `ledger`, `runtime`, `accounts`, `observation`, `providers`, `durability`, `tools`, `daemon`, `gateway`, `cli`, `console`), y el fence verifica que cada uno vive en el estrato declarado. Eso es nivel 4.

Dentro de los paquetes, aproximadamente siete de cada diez carpetas dicen su rol (`artifact-store`, `restate-driver`, `execution-port`, `git-observer`, `identity-probe`, `step-executor`, `conflict-graph`, `credential-guards`, `database-identity`). Las tres restantes son buckets, sinónimos o colisiones, y en once de trece paquetes no existe el nivel de familia que agrupa a las hermanas. El resultado es que un lector ubica un archivo pero no lee la arquitectura desde el árbol.

### Defectos de nombre, medidos en el árbol vivo

| Defecto | Casos concretos | Qué dice hoy el nombre | Qué debería decir |
| --- | --- | --- | --- |
| Buckets genéricos | `runtime/core`, `runtime/contracts`, `durability/contracts`, `providers/contract`, `tools/contract`, `ledger/types`, `runtime/constants`, `daemon/constants`, `gateway/constants`, `runtime/toy`, `contracts/schemas/shared-references` | "algo hay adentro" | el rol: `model/`, `ports/`, `vocabulary/`, `topology/`, `scenarios/` |
| Una palabra, cinco significados: `lifecycle` | `contracts/schemas/lifecycle` (vocabulario de estados), `runtime/core/lifecycle` (el plan), `runtime/lifecycle-operation` (la puerta), `daemon/lifecycle` (vida del proceso), `cli/lifecycle` (el verbo) | cinco cosas distintas | `states/`, `plan/`, `operations/lifecycle/`, `process/`, `verbs/lifecycle/` |
| Una palabra, cinco significados: `contract(s)` | `kernel/contracts`, `runtime/contracts`, `durability/contracts`, `providers/contract`, `tools/contract` | schemas, puertos, literales del gate, vocabulario de tools, vocabulario de proveedor | reservar `contracts` para el kernel; `ports/` en runtime; `restate-gate/` en durability; `vocabulary/` en los edges |
| Colisión entre paquetes | `durability/submit` y `runtime/submission` | dos paquetes, un concepto, dos cosas | `runtime/submission` (la sumisión) y `durability/restate/ingress` (cómo entra al engine) |
| Familia sin nivel | `providers`: `claude`, `codex`, `kimi`, `local`, `api-key` como pares de `redact` y `errors`; `tools`: `stdio`, `http-loopback`, `jsonrpc`, `client` como pares de `receipt`; `ledger`: tres `*-store` sueltos; `gateway`: cinco recursos, cuatro piezas de read model y cinco de HTTP como dieciocho pares | lista plana | `adapters/`, `transport/`, `stores/`, `resources/`, `read-model/`, `http/` |
| El nombre repite el paquete | `cli/cli`, `ledger/ledger`, `daemon/daemon-child` | redundancia | `cli/dispatch`, `ledger/log`, `daemon/child` |
| Vendor en estrato neutral | `observation/telemetry/langfuse`; trece constantes `RESTATE_*` en `runtime/constants`; `DRIVER_MODES` en el kernel | nombre de proveedor donde la ley exige neutralidad | al edge correspondiente |
| Verbos como carpeta | `gateway/start`, `gateway/build-server`, `observation/collect`, `durability/submit` | una acción, no una cosa | `http/server`, `http/bootstrap`, `collectors/`, `ingress/` |
| Scaffolding de test con cuatro nombres | `pilots` (runtime, accounts), `drills` (daemon, durability), `testing` (providers, tools), `helpers` (cuatro sitios), más `live-dom`, `fallback`, `concurrent-writer-worker`, `lease-race-worker` como carpetas de primer nivel en test | un concepto, cuatro palabras | un sustantivo (`drills/`) y un `kernel/testkit` compartido |
| Sufijo redundante bajo la familia | `console/views/tasks-list-view`, `accounts-view`, ... diecisiete | el rol dos veces | aceptable; ayuda al import. Sin acción |

Lo que sí está bien y hay que preservar: 195 de 195 archivos `src` se llaman `index.ts`, cero `export *`, cero tests bajo `src`, espejo `src`/`test` verificado por el fence, y `kernel/contracts/schemas/*` y `console/*` como los dos árboles que ya tienen familia.

Regla de nombre que propongo para el repo, en una línea: **cada carpeta se llama por su rol o por su familia, nunca por su historia ni por su forma**. Prohibidos como nombre de carpeta: `core`, `common`, `utils`, `misc`, `types`, `constants`, `contract(s)` fuera del kernel, `toy`, `shared`, y cualquier id de packet o fase.

---

## Parte 2. La rúbrica

### 2.1 Escalera única de madurez (0–4), aplicada a todo criterio

| Nivel | Nombre | Condición observable |
| --- | --- | --- |
| 0 | Ausente | No hay tipo, schema, prosa ni código. |
| 1 | Declarado | Existe en prosa, ADR, tipo o schema, o como constante; ningún código productivo lo realiza. |
| 2 | Implementado aislado | Hay código y tests, pero falta al menos uno: caller productivo, path ensamblado, o test conductual con oráculo externo. |
| 3 | Cableado y probado | Caller productivo sobre el path ensamblado, más un test conductual con control positivo o negativo que lo haría fallar. |
| 4 | Forzado | Una compuerta mecánica (compilador, fence con sonda de fallo sintético, hook, contrato ejecutable) impide la regresión, y la afirmación documental coincide con la medida. |

La escalera es la del propio repositorio: declarado, implementado, cableado, forzado. La mayoría de los defectos del audit son cosas en nivel 2 que los documentos describen como 3 o 4. Por eso cada criterio lleva dos valores.

### 2.2 Columnas por criterio

- **Medido**: nivel 0–4 según la escalera, con evidencia `file:line`, test o sonda.
- **Afirmado**: nivel que README, AGENTS.md, ADRs, runbooks o comentarios dan a entender. Se deja vacío si los documentos callan o son honestos sobre la ausencia.
- **Brecha**: `max(0, Afirmado − Medido)`. Es la falsa seguridad de ese criterio.
- **Medición**: el comando, sonda o test que decide el nivel. Un criterio sin medición no entra en la rúbrica.

### 2.3 Cómo puntuar

- Nota de dimensión = promedio de sus niveles × 2,5 (escala 0–10).
- Nota global = promedio de dimensiones ponderado por peso.
- Índice de falsa seguridad = promedio de las brechas sobre los criterios con afirmación.
- Pesos: 3 para los tres lazos del producto y para lo que los sostiene (contratos y ledger), 2 para seguridad, paridad, observabilidad, evidencia, estratos y estructura, 1 para gobernanza. Los pesos codifican los objetivos del owner: cuentas, equipo por paso, trazabilidad de prompts, Lego.

### 2.4 Dimensiones y criterios

Cada fila: criterio · medición que decide el nivel.

**A. Estratos y dependencias (peso 2)**

| # | Criterio | Medición |
| --- | --- | --- |
| A1 | Estratos declarados una vez y verificados en ambas direcciones | Fence de estratos más una sonda sintética: un import `domains → edges` debe fallar |
| A2 | Cada seam tiene su puerto en el dominio; ningún adapter define su propio puerto | Inventario de `*Port` por estrato; los edges importan el puerto, no lo declaran |
| A3 | Ningún vocabulario de vendor en kernel ni dominio | `grep -rli 'restate\|langfuse\|temporal\|opentelemetry' packages/kernel packages/domains --include=*.ts` = 0 fuera de prosa |
| A4 | Un composition root único, fuera del barrel público | `src/index.ts` de cada paquete sin imports de runtime ni declaraciones; composición en `src/composition/` |
| A5 | Grafo de dependencias congelado, sin install scripts, nativas pineadas | `pnpm install --frozen-lockfile`; fence de `onlyBuiltDependencies`; catálogo exacto |

**B. Nombres y estructura declarativa (peso 2)**

| # | Criterio | Medición |
| --- | --- | --- |
| B1 | El nombre de paquete dice estrato y responsabilidad | Cada paquete en su estrato de `PACKAGE_STRATA`; nombre = sustantivo de responsabilidad |
| B2 | Existe un nivel de familia por paquete | Carpetas de primer nivel / archivos `src` < 0,5 en cada paquete |
| B3 | La carpeta se llama por su rol, no por un bucket | Cero carpetas en la lista negra (`core`, `common`, `utils`, `misc`, `types`, `constants`, `contract(s)` fuera del kernel, `toy`, `shared`) |
| B4 | Sin sinónimos ni colisiones entre paquetes | `find packages -type d -path '*/src/*' \| xargs -n1 basename \| sort \| uniq -d`: cada duplicado significa lo mismo o se renombra |
| B5 | Espejo `src`/`test`, barrels cerrados, un solo vocabulario de scaffolding | Fence de topología espejada; un sustantivo para drills; `export *` = 0 |
| B6 | Sin narración de packets ni fases en el código | `grep -rEn '\b(P[0-9]+[A-Z]?\|V2(-[A-Z0-9]+)?\|G[0-9]+)\b' packages/*/*/src` = 0 |

**C. Contratos y ejes Lego (peso 3)**

| # | Criterio | Medición |
| --- | --- | --- |
| C1 | Eje de transporte forzado por el compilador | `switch` con `never` sobre la unión; agregar un cuarto transporte rompe la compilación en cada consumidor |
| C2 | Eje de proveedor registrado por descriptor tipado | Registro `Record<ProviderName, …>` o descriptor con registro en la composición; agregar `gemini` sin adapter no compila |
| C3 | Eje de durabilidad consumido polimórficamente | `OrchestrationDriver` como tipo de parámetro en `daemon/src`; un driver stub por el puerto pasa el walk; un segundo engine no toca el dominio |
| C4 | Eje de telemetría: puerto en el dominio, exporter en un edge, ningún vendor | `TelemetryExporterPort` en `domains/observation`; import dinámico del edge; `grep opentelemetry packages/domains` = 0 |
| C5 | Eje de tools: puerto en el dominio, transportes en el edge, MCP acotado | Puerto declarado en `domains/`; negativas de MCP remoto y de tool fuera de allowlist aseveradas |
| C6 | Contratos frozen, strict, versionados, con guardias no heurísticas donde la forma es fija | `.strictObject` en todo schema público; schema por tipo de evento; sonda de token embebido rechazada |

**D. Ledger como autoridad (peso 3)**

| # | Criterio | Medición |
| --- | --- | --- |
| D1 | Append-only por trigger, con inventario que detecta remoción | Sonda `UPDATE`/`DELETE` sobre tabla poblada en los tres streams; borrar un trigger rompe el arranque |
| D2 | Cadena de hashes sobre todos los streams y `verifyIntegrity` total | Forjar una fila de `account_events` con triggers apagados → `ok: false` |
| D3 | Read models derivados con rebuild byte-equivalente | Rebuild dos veces y comparar bytes; rebuild sobre cadena rota se rehúsa |
| D4 | Identidad de ledger por instancia, no por path | Mismo path, otro archivo → `database.id` distinto |
| D5 | Escrituras multi-evento atómicas; decisiones fuera del log registradas antes de actuar | `appendBatch` con SIGKILL entre eventos deja cero estados intermedios; `LEASE_ACQUIRED` precede al commit del grant |
| D6 | Concurrencia entre procesos drillada con procesos reales | N procesos reales: un ganador, N−1 replays o conflictos tipados, cero crashes de lock |

**E. Lazo de ejecución (peso 3)**

| # | Criterio | Medición |
| --- | --- | --- |
| E1 | La instrucción llega al modelo | Hijo que ecoa argv y stdin; el test asevera que recibió `TaskEnvelope.objective` |
| E2 | Cada paso del plan tiene un efecto real o no existe | Cero pasos `PLAIN` que afirmen trabajo; cada beat `INTENT` tiene un puerto de efecto |
| E3 | Commit policy leída del envelope; commit y checkpoint producidos por puertos | Envelope `NO_COMMIT` sin `COMMIT_RECORDED`; `Checkpoint` producido y rehidratado en un test |
| E4 | Idempotencia de efectos con exposición registrada en la ventana de crash | SIGKILL entre `execute` y marcador → evento de exposición en el ledger |
| E5 | Recuperación tras SIGKILL en ambas lanes, daemon incluido | Drill SIGKILL del daemon en `RESTATE`; server reapeado; reinicio en el mismo data root |
| E6 | Puerta de sometimiento y daemon residente con cola | `POST /api/v1/tasks` o verbo CLI crea el envelope y lo encola; el daemon lo consume sin reinicio |
| E7 | Cancel, signal, timer y reattach llegan desde una puerta hasta el hijo | Verbo o ruta que interrumpe un hijo real; capability matrix verificada desde una puerta |
| E8 | Drill con sujeto real | Al menos una capacidad de proveedor sale de `UNKNOWN` con un CLI real y una cuenta real |

**F. Lazo económico: cuentas (peso 3)**

| # | Criterio | Medición |
| --- | --- | --- |
| F1 | Pool de cuentas con reserva por walk y tope por cuenta | `bindings` plural; dos walks eligen cuentas distintas; el tope por cuenta se honra |
| F2 | Cuota estimada desde observaciones reales por cuenta | `estimateQuota` alimentada por un fold de `TOKEN_USAGE_RECORDED`; un record con 0,05 nunca publica 1 |
| F3 | Señal de presión de cuota clasificada por adapter | El adapter emite `quotaPressure`; `usageLimitExceeded` de Codex produce un `SwitchTrigger` |
| F4 | Switch ejecutado de verdad | Sesión abierta en B antes de `ACCOUNT_SWITCH_COMPLETED`; los pasos posteriores a `SELECT_ACCOUNT` tienen ejecutor |
| F5 | Estado efectivo del operador plegado en la elección | `DRAIN` por API → la siguiente sumisión no elige esa cuenta |
| F6 | Clase de costo y presupuesto honrados | `costClass` en la policy; regla preferir-suscripción; `envelope.budget` rechaza una ruta sin margen |
| F7 | Calendario de reset con recurrencia | La ventana de cinco horas rueda; `RESET_ALREADY_PASSED` no ocurre en un calendario recurrente |

**G. Lazo de planificación: producto (peso 3)**

| # | Criterio | Medición |
| --- | --- | --- |
| G1 | Roadmap como plan estructurado con equipo por paso | Schemas de paso y composición de equipo; `ROADMAP_STEP_DECLARED`; diff entre versiones |
| G2 | Grafo de tareas con dependencias | El scheduler respeta orden, no sólo compatibilidad de write-sets |
| G3 | Coordinador ejecutable como workflow durable | Un walk con rol `coordinator` produce y registra un plan |
| G4 | Compuerta de aprobación del owner con señal durable | Transición a `WAITING_OWNER` y reanudación por señal |
| G5 | Iniciativas y roadmap versionado con OCC y rollback, con puerta de alta | `POST /api/v1/initiatives` productivo; OCC y rollback probados |
| G6 | Linaje de prompts y respuestas por digest con vault guardado | `PROMPT_RECORDED`/`RESPONSE_RECORDED` con digests; bytes 0600 en el store; `GET` detrás del bearer; escaneo de credenciales antes de publicar |

**H. Seguridad operacional (peso 2)**

| # | Criterio | Medición |
| --- | --- | --- |
| H1 | Entorno del hijo construido clave a clave; un solo spawn authority | `process.env` en dos archivos pineados; sonda con variable plantada que no llega |
| H2 | Superficie de escritura fail-closed, bearer por digest, constant-time | Sin bearer → 403; ausente e incorrecto indistinguibles |
| H3 | Sin secretos, prompts ni tool-args en ledger, SSE ni DOM | Bytes crudos del wire sin un sentinel plantado en el ledger |
| H4 | Guardia de payload por schema y patrones con límite de palabra, claves escaneadas | Sonda: JWT embebido, clave AWS, `ghp_` como nombre de clave → rechazados |
| H5 | Tools unidas por digest de schema; loopback o stdio; allowlist antes del wire | Cambio de `inputSchema` → rechazo; diez negativas de admisión |
| H6 | Loopback como frontera, constante en código | Bind distinto de `127.0.0.1` imposible por tipo o test |

**I. Paridad de puertas (peso 2)**

| # | Criterio | Medición |
| --- | --- | --- |
| I1 | Una operación, no dos implementaciones | Respuestas byte-idénticas por CLI y API con control negativo |
| I2 | Cada ruta tiene verbo CLI o excepción nombrada | Mapa total `CLI_VERB_BY_ROUTE` sobre `API_ROUTES` con `because` en los `null` |
| I3 | Exit codes exhaustivos sobre el enum de errores | `switch` sin `default`; `WRITE_REFUSED` con salida propia |
| I4 | La pata UI de la paridad no es tautológica | El modelo de filas UI se deriva de lo que una vista renderiza, o la pata se retira y se documenta |
| I5 | SSE: secuencia como única identidad, replay sin gaps ni duplicados | Reconexión con filas apendeadas en la ventana; identidad por instancia |

**J. Observabilidad y trazabilidad (peso 2)**

| # | Criterio | Medición |
| --- | --- | --- |
| J1 | Cadena worker → cuenta → modelo → prompt → respuesta → uso → commit → receipt reconstruible desde el ledger | Una consulta reconstruye la cadena completa de una tarea |
| J2 | Telemetría neutral con claves alineadas al emisor y árbol de trazas | Test contra eventos del emisor real, no fixtures planos; `parentSpanId = causationId` |
| J3 | Exporter opcional, no bloqueante, con health independiente | Exporter caído → walk intacto; `/status` reporta `dropped`; `/health` no lo consulta |
| J4 | Logs estructurados con redacción y correlación | `traceId`/`spanId` en cada línea; scrub probado con un secreto sin barra |
| J5 | Consumo y costo por cuenta e iniciativa | Rollups `byAccount`; gasto no ubicable reportado, no escondido |

**K. Testabilidad y evidencia (peso 2)**

| # | Criterio | Medición |
| --- | --- | --- |
| K1 | Aserciones conductuales con oráculo externo y controles negativos | Muestreo clasificado: conductual, pin estructural, texto fuente, tautología |
| K2 | Drills con procesos y señales reales, sin skips silenciosos | Cero `skip` en drills; SIGKILL real; oráculo en filesystem o base |
| K3 | CI ejecuta la misma compuerta y pasa en un runner real | Un run verde del workflow en HEAD, en el log |
| K4 | Receipt de verificador independiente por commit, verificado mecánicamente | Hook `pre-commit` que exige receipt válido; commits sin receipt = 0 |
| K5 | Autoridad del programa commiteada y pineada por digest | El roadmap vigente está en `docs/`, con digest en el fence y estado vivo |
| K6 | La suite pinea su propio conteo | Una corrida truncada falla con un mensaje sobre archivos faltantes, no sólo por exit code |

**L. Gobernanza y costo de cambio (peso 1)**

| # | Criterio | Medición |
| --- | --- | --- |
| L1 | Fence proporcional: leyes como datos, historia fuera del script, AST para imports | Líneas de fence / líneas de `src` < 0,1; write-sets en un archivo de datos; cero regex de import |
| L2 | Sonda de fallo sintético por familia de ley | Cada familia con al menos una sonda que la hace fallar en un árbol sintético |
| L3 | Docs verificadas donde afirman completitud, README raíz incluido | Trece de trece READMEs con superficie verificada; conteos del README raíz pineados |
| L4 | ADR aceptado implica árbol que lo refleja | Cero decisiones aceptadas sin aterrizar ni enmendar |
| L5 | Un segundo writer es posible | Commits que tocan el fence < 50 %; write-sets de dos packets disjuntos no colisionan |

---

## Parte 3. Aplicación al snapshot 4569478

Evidencia: informe V2 (§3 B1–B10, §4 mejoras 1–14) y reportes de la flota (`acp-wiring` W, `acp-product` P, `acp-accounts` F, `acp-durability` D, `acp-ledger` L, `acp-neutrality` N, `acp-structure` S, `acp-security` SEC, `acp-sse` S, `acp-parity` F, `acp-tests` T, `acp-fence` F). Las colisiones de letra se desambiguan con el nombre del reporte.

### A. Estratos y dependencias

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| A1 | 3 | 4 | 1 | Fence de estratos real; sin sonda negativa para imports (acp-fence F6) |
| A2 | 2 | 3 | 1 | `ProviderAdapter` y `AgentHarness` sin puerto en el dominio; `ToolProtocolPort` en el edge (acp-structure S5) |
| A3 | 2 | 4 | 2 | Trece `RESTATE_*` en el dominio, `DRIVER_MODES` en el kernel, `langfuse/` en observation, `DurableStepContext` en un barrel público (acp-durability D3, acp-neutrality N6) |
| A4 | 1 | 4 | 3 | Barrel del daemon de 1.216 líneas con `startDaemon` adentro contra `docs/ROADMAP.md:378` (acp-structure S1) |
| A5 | 4 | 4 | 0 | Install scripts apagados, una nativa, catálogo exacto, todo fence-checked |

Nota A: 6,0.

### B. Nombres y estructura

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| B1 | 4 | 4 | 0 | Trece paquetes en cinco estratos, verificados |
| B2 | 1 | 3 | 2 | Nivel de familia sólo en `contracts` y `console`; gateway 0,95, ledger 0,91 (acp-structure S2) |
| B3 | 2 | — | — | Once buckets en la lista negra (Parte 1) |
| B4 | 1 | — | — | `lifecycle` ×5, `contract(s)` ×5, `submit`/`submission` (Parte 1) |
| B5 | 3 | 4 | 1 | Espejo y barrels forzados; cuatro sustantivos de scaffolding y helpers duplicados byte a byte (acp-structure S6) |
| B6 | 0 | — | — | Narración en 143 de 195 archivos `src` (acp-structure S4) |

Nota B: 4,6.

### C. Contratos y ejes Lego

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| C1 | 4 | 4 | 0 | `switch` con `never`, records union-keyed (acp-neutrality, cuarto transporte) |
| C2 | 1 | 3 | 2 | Enum cerrado más `Record<string,…>`; ruling del descriptor no cumplido ni enmendado (B9, N1, N2) |
| C3 | 2 | 4 | 2 | Puerto correcto; `RestateDriver` nunca construido en producción; un Temporal tocaría el dominio (B7, D2, D5) |
| C4 | 1 | — | — | Diseño neutral sin puerto ni caller; traductor Langfuse muerto (P5, P6, W5) |
| C5 | 3 | 3 | 0 | MCP acotado con negativas probadas; puerto en el edge (SEC-6, S5) |
| C6 | 3 | 4 | 1 | `strictObject` en todo; guardia de payload heurística, JWT embebido aceptado (SEC-1, SEC-2) |

Nota C: 5,8.

### D. Ledger como autoridad

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| D1 | 4 | 4 | 0 | Triggers probados con control positivo; inventario de objetos detecta remoción (acp-ledger) |
| D2 | 2 | 4 | 2 | `account_events` fuera de la cadena; acción forjada pasa con `ok: true` (mejora 1, L1, L2) |
| D3 | 4 | 4 | 0 | Rebuild byte-equivalente, se rehúsa sobre cadena rota |
| D4 | 1 | 3 | 2 | Identidad = digest del path; ADR 0028 cerrado a medias (B6, acp-sse S1) |
| D5 | 1 | 2 | 1 | Sin `appendBatch`; cuarentena en tres transacciones; grant del lease antes del evento (L4, L5, B8) |
| D6 | 4 | 4 | 0 | Cuatro escritores y ocho reclamantes reales |

Nota D: 6,7.

### E. Lazo de ejecución

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| E1 | 0 | 3 | 3 | Sin campo de contenido; stdin abierto y nunca escrito; Kimi y Codex sin frame (B1, W1, P1) |
| E2 | 1 | 3 | 2 | Cinco de once pasos apendean trabajo no hecho (B2, W3) |
| E3 | 1 | 3 | 2 | Policy hardcodeada en tres sitios; `Checkpoint` sin productor (B2, W3). El packet ADR 0029 staged ataca la policy; no auditado |
| E4 | 2 | 2 | 0 | At-least-once con gasto sin registrar, declarado honestamente y aseverado (B8, L3) |
| E5 | 3 | 4 | 1 | Drills reales en ambas lanes; falta SIGKILL del daemon en `RESTATE` y el reap del server (B7, D1) |
| E6 | 1 | 2 | 1 | Runner one-shot por archivo de config; sin `POST` de tareas; runbook sin `acp-daemon` (W2, P3) |
| E7 | 2 | 3 | 1 | Verbos implementados en el edge sin puerta; cancel no llega al hijo (D2, D6, parity F5). ADR 0029 staged agrega la puerta; no auditado |
| E8 | 0 | 0 | 0 | Todo `UNKNOWN`, y el README lo dice |

Nota E: 3,1.

### F. Lazo económico

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| F1 | 1 | 3 | 2 | Un binding por daemon; tope global de cuatro sin tope por cuenta (B3-a, acp-accounts F1) |
| F2 | 1 | 3 | 2 | Observaciones vacías en los tres call sites; el record con 0,05 publica 1 (B3-b, F2) |
| F3 | 1 | — | — | Ningún adapter clasifica cuota; `usageLimitExceeded` sin consumidor (B3-d, F4) |
| F4 | 1 | 3 | 2 | `ACCOUNT_SWITCH_COMPLETED` apendeado sin sesión; `plan.steps` sin ejecutor (B3-c, F3) |
| F5 | 2 | 3 | 1 | Fold correcto en el read model; la elección lee el owner file (B3-e, F5) |
| F6 | 1 | — | — | `costPerMillionTokens` nulo y nunca leído; `budget` sólo en fixtures (F6) |
| F7 | 1 | — | — | Calendario sin recurrencia (feature 7) |

Nota F: 2,9.

### G. Lazo de planificación

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| G1 | 0 | — | — | Roadmap = `content: string` de 1 MiB (P2) |
| G2 | 0 | — | — | `conflict-graph` es compatibilidad, no orden (P2) |
| G3 | 0 | — | — | `coordinator` sólo como palabra del vocabulario (gap table de acp-product) |
| G4 | 1 | — | — | `WAITING_OWNER` existe como estado sin transición ni señal |
| G5 | 2 | 3 | 1 | Versionado, OCC y rollback reales; `INITIATIVE_REGISTERED` sin productor, puerta inalcanzable (P3) |
| G6 | 0 | — | — | Linaje irrepresentable; el trail se pliega en un digest y se descarta (P4) |

Nota G: 1,3.

### H. Seguridad operacional

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| H1 | 4 | 4 | 0 | `process.env` en dos archivos pineados; variable plantada no llega |
| H2 | 4 | 4 | 0 | 403 sin bearer; ausente e incorrecto indistinguibles; digest constant-time |
| H3 | 3 | 4 | 1 | Estructural en cada productor; sentinel probado en el wire; el contrato es la última línea y es heurística |
| H4 | 2 | 3 | 1 | Payload abierto; JWT embebido, clave AWS y `ghp_` como nombre pasan (SEC-1, SEC-2) |
| H5 | 3 | 3 | 0 | Diez negativas de admisión; tools unidas por nombre sin digest (SEC-4) |
| H6 | 4 | 4 | 0 | Bind constante; refusal real en `start` |

Nota H: 8,3.

### I. Paridad de puertas

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| I1 | 4 | 4 | 0 | Tool-call byte-idéntico con control negativo |
| I2 | 1 | 3 | 2 | Ocho de diecinueve rutas con una sola puerta; README de la CLI lista 8 de 11 verbos (parity F3, F4) |
| I3 | 2 | 3 | 1 | `WRITE_REFUSED` cae a exit 2 por el `default:` (parity F2) |
| I4 | 1 | 3 | 2 | `f(x) == f(x)`; `uiRowModel` sin caller en la consola (parity F1) |
| I5 | 3 | 4 | 1 | Secuencia, gaps, duplicados, tormenta correctos; identidad por path (acp-sse S1, S5) |

Nota I: 5,5.

### J. Observabilidad y trazabilidad

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| J1 | 1 | — | — | Ruta y uso en el ledger; sin prompt, sin `resolvedModel`, sin sha de commit real |
| J2 | 1 | 2 | 1 | Seis de nueve atributos leen claves que el emisor no escribe; sin árbol (P5) |
| J3 | 0 | — | — | Planificado en B5, ausente correctamente (P6) |
| J4 | 3 | 3 | 0 | JSON lines, scrub de paths, tres topes; sin ids de traza (SEC-3) |
| J5 | 2 | — | — | Rollups por tarea e iniciativa; no por cuenta (acp-accounts, qué construir 1) |

Nota J: 3,5.

### K. Testabilidad y evidencia

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| K1 | 4 | 4 | 0 | ≈94 % conductual sobre 2.225 aserciones; tautologías ausentes (acp-tests) |
| K2 | 4 | 4 | 0 | SIGKILL real, procesos reales, skips rechazados por diseño |
| K3 | 0 | 4 | 4 | Runner Linux, `plutil`, pin sólo darwin-arm64; README dice "identical check" (B5, T1) |
| K4 | 1 | 4 | 3 | Receipt como valor sin caller; sin `pre-commit`; 18 commits sin verificador (B4, T2, T3) |
| K5 | 1 | 4 | 3 | Autoridad V2 en `.acp-local`, gitignored; `docs/ROADMAP.md` sin V2 (B4) |
| K6 | 1 | — | — | Corrida truncada imprime 69/69 verdes de 111 esperados (acp-tests, integridad de suite) |

Nota K: 4,6.

### L. Gobernanza y costo de cambio

| # | Medido | Afirmado | Brecha | Evidencia |
| --- | --- | --- | --- | --- |
| L1 | 1 | — | — | 16.994 líneas, 39 % comentario, 5.297 de historia, 0,43 líneas por línea de `src` (B10, acp-fence F4) |
| L2 | 2 | 3 | 1 | 26 sondas para ≈123 familias; `requireScope` nunca ejercido (T5, acp-fence F6) |
| L3 | 2 | 4 | 2 | Seis de trece READMEs verificados; README raíz con tres drifts (acp-fence F2, F3) |
| L4 | 2 | 3 | 1 | ADR 0014 con dos moves sin aterrizar; ADR 0015 omite `tools` (acp-structure S3) |
| L5 | 0 | — | — | 143 de 145 commits tocan el fence |

Nota L: 3,5.

### Resumen

| Dimensión | Peso | Nota /10 | Brecha media |
| --- | --- | --- | --- |
| A. Estratos y dependencias | 2 | 6,0 | 1,4 |
| B. Nombres y estructura | 2 | 4,6 | 1,0 |
| C. Contratos y ejes Lego | 3 | 5,8 | 1,0 |
| D. Ledger como autoridad | 3 | 6,7 | 0,8 |
| E. Lazo de ejecución | 3 | 3,1 | 1,3 |
| F. Lazo económico | 3 | 2,9 | 1,8 |
| G. Lazo de planificación | 3 | 1,3 | 1,0 |
| H. Seguridad operacional | 2 | 8,3 | 0,3 |
| I. Paridad de puertas | 2 | 5,5 | 1,2 |
| J. Observabilidad | 2 | 3,5 | 0,5 |
| K. Testabilidad y evidencia | 2 | 4,6 | 2,0 |
| L. Gobernanza | 1 | 3,5 | 1,3 |
| **Global ponderado** | 28 | **4,6** | **1,2** |

Distribución de los 71 criterios por nivel medido: 0 → 10 · 1 → 25 · 2 → 15 · 3 → 9 · 4 → 12. El índice global de falsa seguridad es la suma de brechas sobre los 53 criterios con afirmación.

Lectura:

- La rúbrica da 4,6 donde el audit dio un promedio de 6. La diferencia es de construcción, no de juicio: aquí un módulo completo sin caller productivo vale 2 de 4, y los tres lazos del producto pesan 3. Es la traducción numérica de "≈55 % del V2 escrito, ≈35 % del backend del owner".
- Las cuatro brechas más grandes son K3, K4, K5 y E1: CI, receipts, autoridad y el canal de instrucción. Son exactamente B5, B4 y B1 del informe. La documentación corre más rápido que el código en la dimensión de evidencia, que es la que el producto existe para mecanizar.
- Las dimensiones que ya están en nivel 4 casi todo (H, D1/D3/D6, K1/K2, C1, I1) son las que hay que proteger con el fence, no las que hay que seguir puliendo.
- Para pasar de 4,6 a 7 sin tocar nada de lo que ya funciona: E1, E2, E3, F1, F2, F4, G1, G6, K3, K4, K5. Once criterios. Todos en el orden que el informe ya propone.

---

## Cómo re-aplicar la rúbrica

1. Pinear un snapshot por SHA y copiarlo fuera del árbol vivo. Nunca medir sobre un árbol que un writer está tocando.
2. Correr `pnpm check` en el snapshot y guardar el log; los criterios A1, A5, B5, D1, K1, K2 heredan de ahí.
3. Ejecutar las sondas de la columna Medición para cada criterio con brecha en la aplicación anterior; una sonda que ya no reproduce el defecto sube el nivel, con la evidencia nueva anotada.
4. Actualizar Afirmado sólo leyendo README, AGENTS.md, ADRs y runbooks del snapshot, no la memoria de nadie.
5. Recalcular notas y brechas. Un criterio que sube a 4 debe nombrar la compuerta mecánica que lo sostiene; si no puede nombrarla, es 3.
6. Guardar como `docs/audit/<fecha>-<tema>/rubric.md` en una carpeta nueva, sin sobrescribir la aplicación anterior, y sumar el path al write-set del packet que lo commitea.
