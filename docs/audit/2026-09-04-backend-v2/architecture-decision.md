# Decisión de arquitectura: el macro se queda, la anatomía de los dominios adopta la de Rottay

Fecha: 2026-09-04. Solicitante: davila. Autor: Claude Fable 5.1.
Base: HEAD `4569478`, el audit V2, la rúbrica, `use-cases.md` (98 casos) y `data-model.md` de esta carpeta, y la anatomía de los módulos `dm-*` y `platform/packages/core` del monorepo Rottay.
Estado: decisión del owner para que el DT la adjudique y el writer la promueva a ADR en `docs/architecture/` cuando le toque el número. No es un packet; es la autoridad que los packets de estructura van a citar.

---

## 1. La decisión en una frase

**Se conserva la macroarquitectura de ACP (ledger como autoridad, cinco estratos, puertos en el dominio, adapters en los edges, fence ejecutable) y se adopta de Rottay la anatomía interna de cada dominio: casos de uso como unidad nombrada partidos en mutations y queries, carpeta de puertos, errores por contexto, testkit compartido y espejo de la taxonomía de dominios en las superficies. No se adopta multi-tenancy, ni agregados mutables, ni la ceremonia completa de capas, ni el barrel raíz gigante.**

Además se abren dos bounded contexts nuevos, `planning` y `economy`, y ninguno de los existentes se reescribe.

---

## 2. Contexto

### 2.1 Qué hay hoy

El audit del 2026-09-04 concluyó que la dirección macro es correcta y que el centro está vacío: el espinazo está cableado pero no transporta instrucción, cinco de once pasos del plan apendean trabajo que nadie hizo, la multi-cuenta es inerte y la evidencia se cortó. En estructura, el rango de paquetes es declarativo y el rango de carpetas no: once de trece paquetes son bolsas planas, hay cinco cosas llamadas `contract(s)` y cinco llamadas `lifecycle`, y el composition root del daemon vive dentro del barrel público.

Los dominios de ACP son hoy colecciones de funciones puras correctas y aisladas: `decideSwitch`, `planSwitch`, `estimateQuota`, `authorizeCommit`, `quarantineWorktree`, `verifyPrestate`. Ninguna tiene un lugar que diga "esto es el caso de uso que la orquesta". Ese lugar hoy es `startDaemon`, 730 líneas dentro de `daemon/src/index.ts`.

### 2.2 Qué piden los casos de uso

`use-cases.md` agrega 31 casos propuestos y 8 planificados sobre 22 que existen. Los nuevos no cambian la naturaleza del sistema, la confirman: todos son hechos que hay que registrar y consultar con linaje. Pero multiplican exactamente lo que hoy no tiene dueño:

- Treinta y pico de operaciones nuevas con un verbo claro: registrar iniciativa, declarar pasos, asignar modelo y versión por rol, planificar el grafo, aprobar, reservar cuenta, registrar presión de cuota, versionar precios, simular un plan, exportar uso.
- Veinticinco read models nuevos (ver `data-model.md`).
- Tres puertas que tienen que decir lo mismo para cada operación: CLI, API y consola.

Sin una anatomía que diga dónde vive cada operación, el resultado previsible es un segundo `startDaemon` en el gateway y un tercero en la CLI.

### 2.3 Qué son los módulos de Rottay

Un `dm-*` de Rottay es un módulo hexagonal con DDD y CQRS a nivel de caso de uso:

```
dm-<módulo>/
  domain/{entities, events, errors}
  application/
    ports/interfaces/{repositories, services, controllers, config}
    use-cases/{mutations, queries, shared}/<nombre>/index.ts
  adapters/{in/{controllers,dto,middleware,routes,websocket}, out/persistence/schemas}
  infrastructure/{data, messaging, security, runtime, observability}
  config/di/use-cases/{mutations, queries}/<dominio>/index.ts
  index.ts
```

Sus leyes, tomadas del `CLAUDE.md` del monorepo: casos de uso hoja sólo bajo `mutations/**` o `queries/**`; factories de DI sólo en `config/di/**`; exportar antes de que una app envuelva; nunca consultas cruzadas a tablas de otro módulo; una tabla, un dueño; `tenantId` en toda operación; ciclo de vida por `created_at`, `updated_at`, `deleted_at`; migraciones en la app.

Resuelve otro problema: servicios multi-tenant sobre agregados mutables en Postgres, servidos por apps Next.js. La verdad del sistema es el estado actual de la fila.

---

## 3. Comparación honesta

| Dimensión | Rottay `dm-*` | ACP hoy | Veredicto |
| --- | --- | --- | --- |
| Verdad del sistema | La fila actual del agregado, con soft delete y auditoría | El log append-only encadenado; el estado es un fold | ACP. El producto es el rastro. |
| Unidad de lógica | El caso de uso, partido en mutation y query | Funciones puras sueltas, orquestadas en el composition root | Rottay. Es lo que falta. |
| Persistencia | Postgres, Drizzle, migraciones en la app | SQLite, streams con triggers, proyecciones, migraciones con checksum en el paquete del ledger | ACP. Es más estricto. |
| Puertos | `application/ports/interfaces/` | Dispersos en cuatro carpetas y tres estratos; dos seams sin puerto | Rottay: una carpeta con nombre. |
| Adapters | Dentro del módulo, `adapters/in` y `adapters/out` | En paquetes `edges/*` separados por ley | ACP. Los edges como paquetes son lo que hace reemplazable a Restate o a un proveedor. |
| DI | Factories de cero argumentos en `config/di` del módulo | Composición inline en el barrel del daemon | Rottay en espíritu, adaptado: las factories viven en el entrypoint, porque el dominio no puede importar edges. |
| Tenancy | `tenantId` en toda query y use case | Un operador, una máquina | ACP. Una columna de tenant sería peso muerto y una señal de seguridad falsa. |
| Eventos de dominio | Publicados a sinks por módulo | El ledger es el bus | ACP. Un segundo sistema de eventos sería un segundo registry. |
| Errores | `domain/errors/` por contexto con base compartida | Siete carpetas `errors` inconsistentes, 38 clases | Rottay. |
| Testing | `core/testing/{assertions, doubles, use-case-test-base}` exportado | Cuatro sustantivos y helpers duplicados byte a byte | Rottay: un `testkit`. |
| Superficies | Las apps espejan la taxonomía de `src/actions` por módulo | Gateway con dieciocho carpetas pares | Rottay: recursos por contexto. |
| Gobernanza | Gates de esquema, coverage y arquitectura por app | Fence de 17K líneas, tocado por 143 de 145 commits | Ninguno tal cual: ACP con la dieta que el audit ya ordenó. |
| Profundidad | ~15 capas obligatorias por módulo | Dominios de 8 a 22 archivos | ACP. Tomar el vocabulario, no la profundidad. |

---

## 4. Qué se conserva, y por qué

1. **El ledger como única autoridad.** Cada caso nuevo es un hecho con linaje: qué versión de modelo, qué prompt, qué precio estaba vigente, quién aprobó. Un `routing_assignment` como fila mutable perdería la propiedad de que una edición es una versión y de que un cambio de precio no reescribe la historia. Los read models se borran y se reconstruyen; los agregados mutables no.
2. **Cinco estratos con dirección forzada.** `kernel → persistence → domains → edges → entrypoints`. Es lo que hace que un dominio no pueda importar Restate ni un proveedor, y lo que el compilador y el fence ya verifican.
3. **Edges como paquetes.** Un `dm-*` de Rottay es dueño de sus adapters. En ACP un edge es reemplazable justamente porque no vive dentro del dominio: Restate por Temporal, Claude por Gemini, Langfuse por OTLP. Esa es la propiedad Lego del owner, y meter los adapters dentro del dominio la destruiría.
4. **Documentos versionados por digest en lugar de configuración en tablas.** Política de capacidades, tabla de precios, asignaciones por paso: versiones inmutables registradas en el ledger y bytes en el artifact store. Rottay guarda configuración en filas; acá una configuración es un hecho.
5. **El fence ejecutable**, con la dieta que el audit ya ordenó: leyes como datos, historia fuera del script, AST para imports. Sin la dieta, la anatomía nueva no es pagable: cada carpeta y cada export cuestan dos ediciones en un script de diecisiete mil líneas.
6. **Los tres lazos como modelo mental**: planificación, ejecución, economía, sobre un ledger. Los bounded contexts salen de ahí.

## 5. Qué se adopta de Rottay, y por qué

1. **El caso de uso como unidad nombrada, en `use-cases/mutations/<verbo-sustantivo>/` y `use-cases/queries/<sustantivo>/`.** Es la respuesta a "dónde vive registrar una iniciativa". En ACP mapea sin fricción: una mutation apendea eventos a través de un puerto de ledger y devuelve lo apendeado o el replay; una query lee read models a través de un puerto. Es el CQRS que el ledger ya impone, con nombre y con dueño. Regla de Rottay que se importa textual: casos de uso hoja sólo bajo `mutations/**` o `queries/**`; `shared/` puede tener helpers, nunca orquestación invocable.
2. **`ports/` como carpeta con nombre en cada dominio.** Hoy los trece puertos están en cuatro carpetas de tres estratos y dos seams no tienen puerto. Una carpeta que se llama `ports` es la primera cosa que un contribuidor busca.
3. **Factories de cero argumentos en un composition root**, una por caso de uso, agrupadas `use-cases/{mutations,queries}/<contexto>/`. Con una adaptación obligada por la ley de estratos: en Rottay las factories viven en `config/di` del módulo porque el módulo es dueño de sus adapters; en ACP el dominio no puede importar edges, así que las factories viven en el entrypoint que compone, `daemon/src/composition/`, `gateway/src/composition/`, `cli/src/composition/`. Sin contenedor de DI: funciones.
4. **Errores por contexto con una base compartida en el kernel**, en lugar de siete carpetas inconsistentes.
5. **Un `kernel/testkit` exportado**, como `core/testing` de Rottay: aleatoriedad sembrada, dobles de puertos, base de test de caso de uso. Mata los helpers duplicados byte a byte y los cuatro sustantivos de scaffolding.
6. **La regla de espejo en las superficies.** En Rottay las apps espejan `src/actions` por módulo y está prohibido inventar buckets. Acá: el gateway expone `resources/<contexto>/`, la CLI `verbs/<contexto>/`, la consola `views/<contexto>/`, y un mapa total `CLI_VERB_BY_ROUTE` sobre `API_ROUTES` con una excepción escrita por cada `null`. La paridad deja de ser una intención y pasa a ser estructura: una operación, tres puertas, como ya hace `tool-call`.
7. **Exportar antes de envolver.** Un recurso del gateway o un verbo de la CLI sólo puede llamar a un caso de uso exportado por el barrel del dominio. Ninguna lógica de dominio en un entrypoint.

## 6. Qué no se adopta, y por qué

1. **`tenantId`.** Un plane por máquina, un operador. Una columna de tenant en el ledger sería peso muerto y haría creer que hay aislamiento donde no lo hay.
2. **Agregados mutables con `created_at`, `updated_at`, `deleted_at`.** En un stream no hay `UPDATE`; en un read model el ciclo de vida lo da la secuencia del evento que lo produjo. `deleted_at` no significa nada en un ledger.
3. **`adapters/in` y `adapters/out` dentro del módulo, más `infrastructure/{data, messaging, security, runtime, observability}`.** Los adapters ya son los edges, y la infraestructura ya es `persistence/ledger` y el daemon. Quince capas obligatorias para dominios de veinte archivos excederían el código.
4. **Migraciones en la app.** El ledger es un solo desplegable y sus migraciones con checksum, que se comparan en cada apertura, son más estrictas que las de Rottay.
5. **El barrel raíz de mil líneas.** Los barrels cerrados y explícitos de ACP son mejores; el del daemon se arregla sacando la composición, no agrandando el barrel.
6. **Un sistema de eventos de dominio aparte.** El ledger es el bus. Un segundo sistema sería el "segundo registry" que el V2 prohíbe.
7. **Un paquete `core` de utilidades.** Es el bucket que la regla de nombres prohíbe. Lo compartido va a `kernel/contracts` si es contrato, a `kernel/testkit` si es scaffolding, y a ningún lado si es "útil".

---

## 7. Bounded contexts objetivo

| Contexto | Paquete | Lazo | Qué posee | Estado |
| --- | --- | --- | --- | --- |
| Planificación | `domains/planning` | planificación | Iniciativas, versiones de roadmap, pasos y sus dependencias, asignaciones de modelo por rol y scope, grafo de tareas, planes del DT, aprobaciones del owner, recomendaciones, simulaciones, duelos, adjudicaciones, consultas de hitos | Nuevo |
| Ejecución | `domains/runtime` | ejecución | Sumisión y ciclo de vida de tareas, plan de beats y efectos, sesión con instrucción, prompts, tool calls, checkpoints, conformance y cuarentena, verificación, auditoría, autorización y registro de commit, reintento y escalera, límites de tiempo | Existe; gana la anatomía y los efectos reales |
| Cuentas | `domains/accounts` | economía | Registro de cuentas y plan declarado, observaciones y estimación de cuota, ranking por margen, presión de cuota, reserva y liberación, switch, acciones del operador | Existe; gana pool, fold real y switch real |
| Economía | `domains/economy` | economía | Uso por tipo de token, tabla de precios versionada, costo real y valor equivalente, prorrateo de suscripción, retorno por cuenta, costo por resultado y rework, pronóstico, exportación, anomalías, registry de versiones de modelo y desempeño | Nuevo |
| Observación | `domains/observation` | transversal | Linaje completo de una tarea, lectura guardada del vault, telemetría neutral, línea de base, correlación de logs | Existe; gana el puerto de exportación |

Dos justificaciones que no son obvias:

- **Por qué `economy` separado de `accounts`.** Una cuenta es un recurso con estado y reserva; el costo es una función del uso y de un documento de precios. Si van juntos, el paquete más grande del repo pasa a ser el que más cambia por dos razones distintas: nuevas señales de proveedor y nuevos precios. Separados, `accounts` sigue siendo la librería pura que el audit calificó como la mejor del repo, y `economy` es un conjunto de proyecciones y consultas sin decisiones de routing.
- **Por qué `planning` no va en `runtime`.** Runtime sabe caminar un plan de beats para una tarea. Planning sabe qué tareas existen y quién las hace. El coordinador es un walk de runtime con rol `coordinator`; su salida se registra por una mutation de planning. Si se mezclan, el daemon vuelve a ser el único que sabe cómo se relacionan.

---

## 8. Anatomía objetivo por paquete

### 8.1 Plantilla de un dominio

```
domains/<contexto>/
  package.json                      @acp/<contexto>; exports "." y "./scenarios"
  src/
    index.ts                        barrel cerrado: use cases, puertos, modelo, errores
    ports/<puerto>/index.ts         lo que el contexto necesita y no implementa
    model/<concepto>/index.ts       tipos puros, invariantes, decisiones sin efectos
    use-cases/
      mutations/<verbo-sustantivo>/index.ts
      queries/<sustantivo>/index.ts
      shared/<helper>/index.ts      nunca invocable como orquestación
    errors/index.ts                 familia del contexto sobre la base del kernel
    scenarios/<escenario>/index.ts  fixtures de drills, fuera del barrel principal
  test/                             espejo exacto de src
```

Reglas de tamaño para que la anatomía no se vuelva ceremonia: un caso de uso es un `index.ts` y su test; no existen `services/`, `dto/`, `mappers/` ni `handlers/` dentro de un dominio; un puerto sólo se declara cuando hay dos implementaciones o un doble de test; `shared/` no puede ser importado desde fuera del paquete.

### 8.2 Árbol objetivo

```
packages/
  kernel/
    contracts/src/{schemas/*, topology/, ports/execution/, errors/base/}
    protocol/src/{routes/, schemas/{task,worker,event,integrity,stream,accounts,initiatives,planning,economy}/, parity/, version/}
    testkit/src/{random/, doubles/, use-case/}
  persistence/
    ledger/src/
      log/{ledger, migrations, canonical-json}/
      projections/{task, worker, initiative, roadmap-version, execution-route,
                   roadmap-step, routing-assignment, task-dependency, dt-plan, owner-approval,
                   recommendation, plan-simulation, prompt-record, tool-call, checkpoint,
                   verification, audit-verdict, commit, anomaly, account, quota-observation,
                   account-reservation, account-switch, usage, cost, subscription-period,
                   model-version, price, model-performance, artifact-index}/
      stores/{artifact, lease, tool-claim, account-reservation}/
      errors/
  domains/
    planning/src/{ports, model, use-cases/{mutations,queries}, errors, scenarios}/
    runtime/src/
      ports/{ledger, effect, tool-call, tool-claim, git-read, orchestration-driver, provider, prompt-vault}/
      model/{coordinates, events, plan, states}/
      use-cases/{mutations,queries}/
      errors/
      scenarios/
    accounts/src/{ports, model/{quota, routing, switching}, use-cases/{mutations,queries}, errors, scenarios}/
    economy/src/{ports, model/{cost, prices, performance}, use-cases/{mutations,queries}, errors}/
    observation/src/{ports/{telemetry-exporter, artifact-reader}, model, use-cases/queries, errors}/
  edges/
    durability/src/{restate/{driver, endpoint, child, gate, ingress}, sqlite/{supervisor, child}, server-handle}/
    providers/src/{adapters/{claude, codex, kimi, local, api-key}, runtime/{harness, session, events, execution-port, process/{spawn, handle}}, admission/{config-root, redact}, vocabulary, errors}/
    tools/src/{transport/{stdio, http-loopback, jsonrpc, client}, policy/{admission, operation, receipt}, vocabulary}/
    telemetry/src/{otlp-http/}/
  entrypoints/
    daemon/src/
      index.ts                       barrel: startDaemon, stopDaemon, terminateDaemon, tipos
      composition/{use-cases/{mutations,queries}/<contexto>/, ports/, index.ts}
      process/{bin/*, child, signals, singleton, lifecycle, launchd/*}/
      supervision/{arbiter, scheduler, git-observer, identity-probe}/
      modes/{restate, sqlite}/
      observability/{log, status}/
      shared/{constants, paths, errors}/
    gateway/src/
      composition/
      http/{bin, server, bootstrap, routes, stream, bearer}/
      resources/{initiatives, steps, assignments, approvals, tasks, prompts, accounts, registry, usage}/
      read-model/{ledger-source, database-identity, mappers, aggregates, query-schemas}/
      shared/{constants, errors}/
    cli/src/{composition, dispatch, verbs/<contexto>/, format, errors}/
    console/src/{api/*, app, components/*, views/<contexto>/*, format/*, hooks/*, routing/*, styles}/
```

Cambios respecto del árbol objetivo del reporte de estructura: se agregan `planning`, `economy`, `edges/telemetry` y `kernel/testkit`; `runtime/drivers/sqlite-supervisor` pasa al edge de durabilidad porque un driver es un edge; `runtime/constants` se reparte entre `kernel/contracts/topology` y el edge de Restate; `toy/repository` pasa a `scenarios` con subpath propio; los cinco `contract(s)` se renombran por rol; las proyecciones dejan de ser un archivo de 400 líneas y pasan a una carpeta por read model.

### 8.3 Dónde viven las proyecciones, y por qué no en el dominio

Los folds de los read models viven en `persistence/ledger/src/projections/`, no en los dominios, por dos razones que ya rigen hoy: la ley de estratos impide que el ledger importe un dominio, y una sola implementación sirve el path vivo y el replay, que es lo que hace el rebuild byte-equivalente. Los dominios consultan read models a través de puertos de lectura, nunca abren la base. Es la traducción del "no direct foreign queries" de Rottay: un dominio no lee tablas que no le exportaron.

---

## 9. Mapa de casos de uso a mutations, queries y puertas

Convención: una mutation apendea y devuelve lo apendeado; una query lee y no apendea. La columna Puerta nombra el recurso del gateway, el verbo de la CLI y la vista de la consola; las tres llaman al mismo caso de uso.

### Planificación, `@acp/planning`

| Caso | Tipo | Caso de uso | Eventos | Read model | Puerta |
| --- | --- | --- | --- | --- | --- |
| A1 | mutation | `register-initiative` | `INITIATIVE_REGISTERED` | `initiative` | `POST /initiatives` · `acp initiative register` · portafolio |
| A2 | mutation | `record-roadmap-version` (existe en gateway, se mueve) | `ROADMAP_VERSION_RECORDED` | `roadmap-version` | `POST /initiatives/:id/roadmap` · `acp roadmap write` · editor |
| A3 | mutation | `declare-roadmap-steps` | `ROADMAP_STEP_DECLARED` ×n | `roadmap-step`, `roadmap-step-dependency` | `POST /initiatives/:id/steps` · `acp step declare` · plan |
| A4, A11, A12 | mutation | `record-routing-assignment` con scope `GLOBAL`, `INITIATIVE` o `STEP` | `ROUTING_ASSIGNMENT_RECORDED` | `routing-assignment` | `POST /assignments` · `acp assignment set` · editor de equipo por paso |
| A13 | dentro de A11 | validación por puerto `ModelRegistryPort.lookup` | refusals tipados: `MODEL_UNKNOWN`, `MODEL_RETIRED`, `ROLE_NOT_ELIGIBLE`, `TRANSPORT_NOT_ADMITTED` | | misma puerta, respuesta 409 con razón |
| A12 | query | `resolve-routing-precedence(stepId, role)` | | `routing-assignment` en tres scopes | la usa `elect-route` de runtime; `GET /steps/:id/routing` · `acp step routing` |
| A14 | dentro de A11 | `recommend-independence` | `RECOMMENDATION_RECORDED` | `recommendation` | misma puerta; la consola muestra la recomendación |
| A5 | mutation | `plan-task-graph` | `TASK_GRAPH_PLANNED` | `task-dependency` | la produce el walk del coordinador; `GET /steps/:id/graph` · `acp step graph` · grafo |
| A6 | mutation | `request-dt-plan`, `record-dt-plan` | `DT_PLAN_REQUESTED`, `DT_PLAN_RECORDED` | `dt-plan` | `POST /steps/:id/plan` · `acp step plan` |
| A7 | mutation | `request-owner-approval`, `decide-owner-approval` | `OWNER_APPROVAL_REQUESTED`, `OWNER_APPROVAL_DECIDED` | `owner-approval` | `POST /approvals/:id/decide` · `acp approve` · bandeja; la decisión reanuda por `OrchestrationDriver.signal` |
| A8 | mutation | `change-step-state` | `STEP_STATE_CHANGED`; cancela en cascada por `cancel-task` de runtime | `roadmap-step` | `POST /steps/:id/state` · `acp step pause` · plan |
| A9 | query | `portfolio-overview` (existe en gateway, se mueve) | | `initiative`, `task`, `cost` | `GET /overview` · `acp overview` · portafolio |
| A10 | query | `diff-roadmap-versions` | | `roadmap-version` + artifact store | `GET /initiatives/:id/roadmap/diff` · `acp roadmap diff` |
| A15, D14 | query | `simulate-plan` | opcional `record-plan-simulation` → `PLAN_SIMULATED` | `plan-simulation`; lee `task-dependency`, `model-performance` por puerto de economy y `quota-observation` por puerto de accounts | `POST /steps/:id/simulate` · `acp step simulate` · plan |
| B17 | mutation | `declare-model-duel` | `MODEL_DUEL_DECLARED`; somete dos tareas `NO_COMMIT` con `duel_id` | `task` | `POST /duels` · `acp duel` · comparación |
| B17 | query | `compare-duel` | | `audit-verdict`, `cost`, `task` | `GET /duels/:id` |
| C4 | mutation | `record-adjudication` | `ADJUDICATION_RECORDED` | `dt-plan` | `POST /tasks/:id/adjudicate` · `acp adjudicate` |
| C5 | mutation | `record-consultation` | `CONSULTATION_RECORDED` | `dt-plan` | `POST /initiatives/:id/consultations` |

### Ejecución, `@acp/runtime`

| Caso | Tipo | Caso de uso | Eventos | Read model | Puerta |
| --- | --- | --- | --- | --- | --- |
| B1 | mutation | `submit-task` | `TASK_DISCOVERED` con digest del envelope | `task` | `POST /tasks` · `acp submit` · nueva tarea; el daemon residente consume la cola |
| B2 | query | `elect-route` | | `routing-assignment` por puerto de planning, `rankAccounts` de accounts | interna; la ruta queda en `RUN_STARTED` |
| B4 | efecto | `verify-prestate` (isla → puerto de efecto del beat) | `PRESTATE_VERIFIED` | | interna |
| B5 | efecto | `open-session` construye el prompt con `PromptBuilder`; `record-prompt` | `PROMPT_RECORDED` | `prompt-record`; bytes en el vault | interna; lectura por observation F2 |
| B8 | efecto | `check-write-set-conformance` + `quarantine-worktree` (isla → cableada) | `WRITE_SET_VIOLATION_DETECTED`, `LEASE_REVOKED`, `TASK_STATE_CHANGED` en un `appendBatch` | `task` | interna |
| B9 | mutation | `write-checkpoint` | `CHECKPOINT_WRITTEN` con digest | `checkpoint` | interna; `GET /tasks/:id/checkpoints` |
| B10 | mutation | `cancel-task`, `signal-task`, `schedule-timer`; query `reattach` (packet ADR 0029) | `TASK_CANCELLED`, `SIGNAL_DELIVERED`, `TIMER_SCHEDULED` | `task` | `POST /tasks/:id/cancel` · `acp cancel` · botón; `acp attach` |
| B11 | mutation | `record-execution-exposure` | `EXECUTION_EXPOSURE_RECORDED` | `usage` | interna, en la reanudación |
| B13 | dentro del walk | `commitPolicy` leída del envelope; plan sin beats de commit para `NO_COMMIT` | | | |
| B14, B16 | mutation | `retry-task` con escalera por política de rol | `RETRY_ESCALATED`, nuevo `attempt` | `execution-route` | `POST /tasks/:id/retry` · `acp retry` |
| B15 | efecto | `record-response`, `record-usage` (existe) | `RESPONSE_RECORDED`, `TOKEN_USAGE_RECORDED` con tokens por tipo | `prompt-record`, `usage` | interna |
| B18 | efecto | `enforce-time-limit` | `TIME_LIMIT_REACHED` y `cancel-task` | `task` | interna; el límite viene del envelope |
| C1 | mutation | `record-verification` (la corre el walk del verificador) | `VERIFICATION_COMPLETED` con receipt | `verification` | `POST /tasks/:id/verification` · `acp verify` |
| C2 | mutation | `record-audit-verdict` | `AUDIT_COMPLETED` con veredicto | `audit-verdict` | `POST /tasks/:id/audit` · `acp audit` |
| C3 | mutation | `authorize-commit` (isla → mutation), `record-commit` | `COMMIT_AUTHORIZED`, `COMMIT_RECORDED` con sha | `commit` | `POST /tasks/:id/commit` · `acp commit authorize` |
| C7 | query | `verification-for-commit(head)` | | `verification` | la lee `scripts/pre-commit` |

### Cuentas, `@acp/accounts`

| Caso | Tipo | Caso de uso | Eventos | Read model | Puerta |
| --- | --- | --- | --- | --- | --- |
| D1 | mutation | `declare-account-plan` | `PLAN_DECLARED` en `account_events`, con digest del owner file | `account` | `POST /accounts/:id/plan` · `acp account plan` · cuentas |
| D2 | query | `estimate-account-quota` | | `quota-observation` (fold de uso + señales) | `GET /accounts` · `acp accounts` · cuentas |
| D3 | query | `rank-accounts` (existe, pura) | | alimentada por D2 | interna a `elect-route` |
| D4 | mutation | `record-quota-pressure` (la dispara el adapter) | `QUOTA_PRESSURE_OBSERVED` | `quota-observation` | interna; produce un `SwitchTrigger` |
| D5 | mutation | `start-account-switch`, `complete-account-switch` (sólo tras `open-session` en B) | `ACCOUNT_SWITCH_STARTED`, `ACCOUNT_SWITCH_COMPLETED` | `account-switch` | interna; `GET /tasks/:id/switches` |
| D6 | mutation | `record-account-action` (existe en gateway, se mueve); query `effective-account-state` | `account_events` | `account` | `POST /accounts/:id/actions` · `acp account drain` · cuentas; `elect-route` lee el estado efectivo |
| D7 | mutation | `reserve-account`, `release-account` sobre el arbiter store | `ACCOUNT_RESERVED`, `ACCOUNT_RELEASED` | `account-reservation` | interna al scheduler |
| D10 | query | `account-alerts` | | `account`, `quota-observation`, `subscription-period` | `GET /alerts` · `acp alerts` · consola; puerto de notificación para G5 |

### Economía, `@acp/economy`

| Caso | Tipo | Caso de uso | Eventos | Read model | Puerta |
| --- | --- | --- | --- | --- | --- |
| D11 | proyección | `usage` con tokens por tipo (contrato de uso ampliado) | `TOKEN_USAGE_RECORDED` | `usage` | `GET /usage` |
| D12 | mutation | `record-price-table-version` | `PRICE_TABLE_VERSION_RECORDED` en `registry_events` | `price` | `POST /registry/prices` · `acp prices set` · precios |
| D13 | proyección | `cost` = f(`usage`, `price` vigente al momento del uso). **No hay evento de costo**: precios y uso son hechos, el costo es una función de ambos, y así el rebuild es determinista y un cambio de precio produce filas nuevas sin reescribir | | `cost`, `subscription-period` | `GET /initiatives/:id/cost` · `acp cost` · iniciativa |
| D8 | query | `budget-headroom(taskId \| initiativeId)` | | `cost`, envelope | la consulta `elect-route` y el walk |
| D15 | query | `subscription-return(accountId, period)` | | `subscription-period` | `GET /accounts/:id/return` · `acp account return` |
| D16 | query | `cost-per-outcome`, `rework-cost` | | `cost`, `verification`, `audit-verdict`, `commit` | `GET /initiatives/:id/outcomes` |
| D17 | query | `export-usage-and-cost(period, format)` | | `usage`, `cost` | `GET /usage/export` · `acp usage export` |
| D18 | mutation | `detect-consumption-anomaly` → `record-anomaly` y `signal-task` de runtime | `ANOMALY_DETECTED` | `anomaly` | interna; aviso por G5 |
| E4 | mutation | `record-capability-policy-version` | `CAPABILITY_POLICY_VERSION_RECORDED` en `registry_events` | `model-version` | `POST /registry/policy` · `acp policy publish` |
| E6, E9 | mutation | `record-model-performance-snapshot` | `MODEL_PERFORMANCE_RECORDED` | `model-performance` | la produce el evaluador; `GET /registry/performance` |
| E7 | query | `rank-models-for-role(role)` | | `model-version`, `model-performance` | la consulta `record-routing-assignment` y `elect-route` |
| E8 | query | `replay-routing(policyVersion)` | | `execution-route`, `model-version` | `GET /registry/replay` · `acp policy replay` |

### Observación, `@acp/observation`

| Caso | Tipo | Caso de uso | Eventos | Read model | Puerta |
| --- | --- | --- | --- | --- | --- |
| F1 | query | `task-lineage(taskId)` | | `execution-route`, `prompt-record`, `tool-call`, `usage`, `cost`, `verification`, `audit-verdict`, `commit` | `GET /tasks/:id/lineage` · `acp task lineage` · detalle de tarea |
| F2 | query | `read-prompt(digest)` con escaneo de credenciales | | `prompt-record` + artifact store por puerto | `GET /tasks/:id/prompts/:digest` guardado por bearer · `acp prompt read` |
| F5 | puerto | `TelemetryExporterPort` implementado por `edges/telemetry` | | | configuración del daemon |
| F7 | query | `baseline` (isla → cableada) | | `usage`, `execution-route` | `GET /baseline` · `acp baseline` |

Los casos que hoy son `Hoy` conservan su código; sólo se mueven a la carpeta que la anatomía les asigna.

---

## 10. Leyes ejecutables que sostienen la anatomía

Cada ley va al fence con su sonda de fallo sintético, como exige la rúbrica para nivel 4.

1. **Casos de uso hoja.** Sólo `use-cases/mutations/**/index.ts` y `use-cases/queries/**/index.ts` exportan funciones invocables desde fuera del paquete; `shared/**` no aparece en ningún import externo.
2. **Mutations apendean, queries no.** Una query no importa `appendEvent` ni ningún puerto de escritura; una mutation no lee read models salvo por un puerto declarado.
3. **Puertos en `ports/`.** Todo `interface *Port` de un dominio vive bajo `ports/`; ningún edge declara un puerto; ningún dominio importa un edge.
4. **Composición en el entrypoint.** `new`, `create*` y `make*` sobre edges sólo bajo `entrypoints/*/src/composition/`; el barrel raíz de cada entrypoint no importa runtime.
5. **Espejo de superficies.** El conjunto de `resources/<contexto>` del gateway, `verbs/<contexto>` de la CLI y `views/<contexto>` de la consola es igual al conjunto de contextos con puertas; `CLI_VERB_BY_ROUTE` es total sobre `API_ROUTES`.
6. **Exportar antes de envolver.** Un recurso o un verbo sólo importa nombres del barrel del dominio, nunca paths internos.
7. **Nombres por rol o familia.** Lista negra de carpetas: `core`, `common`, `utils`, `misc`, `types`, `constants`, `contract(s)` fuera del kernel, `toy`, `shared` fuera de `use-cases/`, y cualquier id de packet o fase.
8. **Proyecciones en el ledger.** Ningún dominio abre SQLite; un fold vive bajo `persistence/ledger/src/projections/<read-model>/`.
9. **Un caso de uso, un archivo.** Ninguna carpeta bajo `use-cases/` con más de `index.ts`; la lógica compartida va a `model/` o a `shared/`.

---

## 11. Orden y condiciones

Esta decisión no es el próximo packet. Reordenar carpetas no hace que ninguna instrucción llegue al modelo. El orden:

1. **Antes, y sin discusión:** el canal de instrucción, el drill con sujeto real y la ola de cuentas, en el orden del informe V2. Son las tres cosas que convierten a ACP en un producto; la anatomía sólo lo hace mantenible.
2. **Precondición:** la dieta del fence. Write-sets y paths retirados como datos, imports por AST, receipts en pre-commit. Sin esto, cada carpeta nueva cuesta dos ediciones en un script de diecisiete mil líneas y la reorganización de ciento cincuenta archivos es impagable.
3. **Primero lo nuevo, con la anatomía desde el día uno:** `domains/planning`, `domains/economy`, `edges/telemetry`, `kernel/testkit`. No hay costo de movimiento, y establecen el patrón que los paquetes viejos van a copiar. Por la regla de paralelización del informe, son disjuntos y pueden desarrollarse en árboles copiados, nunca en el árbol vivo.
4. **Después, un solo mapa atómico** que mueva `runtime`, `accounts`, `observation`, los edges y los entrypoints al árbol de la sección 8. Un writer, un commit de moves sin cambios semánticos, con el precedente de los 302 pares de P8-T. Ningún símbolo se renombra en ese commit.
5. **Al final, las leyes de la sección 10** en el fence, cada una con su sonda.

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Ceremonia: carpetas de una función, capas vacías | Reglas de tamaño de 8.1 y ley 9: un caso de uso es un archivo; sin `services`, `dto`, `mappers`, `handlers` en dominios |
| Impuesto del fence multiplicado por 150 archivos | La dieta va antes; el mapa atómico es un solo diff de moves |
| Ancho de banda del writer único | Los paquetes nuevos son disjuntos y se hacen en árboles copiados; el mapa atómico es un solo packet |
| Renombrar rompe referencias en docs, fence y memoria | Codemod con dry-run y un mapa de pares, como en P8-T; docs y fence en el mismo commit |
| Copiar Rottay de más | Sección 6 es la lista cerrada de lo que no entra; cualquier capa fuera de 8.1 necesita una excepción escrita |
| La consola y la CLI se rezagan respecto de la API | Ley 5: el espejo es total o el check falla |

## 13. Qué no cambia para el operador

Los verbos actuales de la CLI, las diecinueve rutas de la API y las vistas de la consola siguen funcionando con los mismos nombres. Los archivos de configuración del daemon, el owner file de cuentas y el formato del ledger no cambian por esta decisión; los cambios de schema los gobierna `data-model.md` y sus migraciones con checksum.
