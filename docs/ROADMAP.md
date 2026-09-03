# Rottay Agent Control Plane — roadmap canónico

Estado: `P0_COMPLETE / P1_COMPLETE / P2_COMPLETE / P3_COMPLETE / P4_COMPLETE / P5_COMPLETE / P6_COMPLETE / P7_COMPLETE / P7I_COMPLETE / P8_COMPLETE / NO_PRODUCT_CUTOVER`

Fecha: 2026-08-27

Este documento es la autoridad durable para implementar el repositorio separado
`/Users/daniel/Developer/Rottay/agent-control-plane`. No autoriza tocar, pausar ni
tomar control de Modern Rescue o de ningún worktree de producto. El repositorio
se crea únicamente cuando el owner dé el kickoff explícito de implementación.

## Evidencia de diseño y revisión

Este roadmap incorpora y supersede operativamente el plan consolidado efímero:

- plan consolidado: `/private/tmp/agent-control-plane-final-consolidated-plan-2026-08-27.md`;
- brief común: `/private/tmp/agent-control-plane-independent-review-brief.md`, SHA-256
  `f6e816c927d8a2ed22145582ffae1b1e0da531953b6cdbd39ab5e658379a309a`;
- revisión Fable: `/private/tmp/agent-control-plane-review-fable.json`, SHA-256
  `023b8ea4a372649ceb38b67897372f9529178496f6cfc997ea47a54e6738831f`;
- revisión Kimi K3: `/private/tmp/agent-control-plane-review-kimi-k3.normalized.json`,
  SHA-256 `a0681ace29d8cdd7ec494b5caffdef2b2211ba4518d54ec5b4839a1b8120642f`;
- addendum del owner: `/private/tmp/agent-control-plane-owner-addendum-2026-08-27.md`,
  SHA-256 `e37e2c94dc01c33effda13edc7615c31481c1a4facb48c38793e64aff7b5406b`.
- ruling del owner para P8 (transport-agnostic):
  `.acp-local/p8-transport-agnostic-owner-ruling.md`, SHA-256
  `11c7a81a759034405e652eb8af11cf9aa9bca567cbca64ac16de8c4b0cab1ab4`.

Los dos revisores dieron `ACCEPT_WITH_CHANGES`. Sus correcciones quedan
integradas aquí. No se abre una cadena adicional de reauditorías antes del
kickoff.

## Objetivo

Construir un control plane local, neutral respecto del proveedor, que coordine
Claude, Kimi y Codex y que pueda:

- asignar dinámicamente modelo, rol, cuenta y presupuesto por tarea;
- paralelizar read-only y writers aislados sin corromper repositorios;
- preservar contexto mediante checkpoints neutrales;
- cambiar de cuenta o proveedor al agotarse una cuota;
- separar coordinación, implementación, validación y auditoría;
- controlar write-sets, Git, commits locales y evidencia;
- recuperar trabajo después de cierres, fallos o reinicios;
- mostrar toda la ejecución desde una UI local unificada;
- medir calidad, tokens, tiempo, rework y fallos para adaptar el routing.

No es un segundo DT. Ejecuta reglas admitidas por el DT activo y nunca decide
producto, arquitectura o aceptación visual por su cuenta.

## Iniciativas concurrentes de primera clase

El control plane soporta dos o más **Initiatives** de primera clase en
concurrente, no una lista plana de tareas. Es un producto local reutilizable,
no un dashboard específico de Modern Rescue: una iniciativa de Modern Rescue
puede correr al lado de un módulo nuevo de Rottay o de una iniciativa de
frontend ajena, sin contaminación cruzada. Toda tarea, versión de roadmap,
objetivo, asignación de agente, worktree, lease, write-set, log, gate,
auditoría, checkpoint, commit, aprobación y atribución de tokens es
initiative-scoped. La cuota de proveedor/cuenta sigue siendo global, pero el
uso y las reservas se agregan por iniciativa y por tarea. Las iniciativas
corren en paralelo sin contaminación cruzada.

La UI ofrece un portfolio global y workspaces por iniciativa con switcher
limpio, mostrando por iniciativa: objetivo, roadmap versionado y editable,
hitos y progreso, grafo de tareas, agentes activos y su acción actual, logs,
tokens consumidos/reservados/restantes, confianza de cuota y
reset/renovación, errores, bloqueos e historia.

La edición del roadmap es versionada y auditada: `RoadmapVersion` inmutable
con digest, concurrencia optimista, evento/receipt de cambio append-only,
rollback e historia. El roadmap del propio ACP no es un documento UI mutable
sin tracking.

Los contratos de Initiative y de roadmap versionado son una fase propia,
preauditada, anterior a cualquier implementación de UI (ver P7I).

La autoridad persistente local es SQLite WAL y la API es Fastify en loopback.
La CLI y el daemon son completamente operables con la UI detenida: la UI es
opcional como proceso, pero completa como producto antes del cutover.

## Ley de coexistencia y cutover

La operatoria actual de Modern Rescue y el Kimi que coordina la refactorización
del UI Design System continúan sin ninguna interrupción. Mientras se construye
este repositorio:

- el control plane no envía mensajes, señales, prompts ni comandos a sus sesiones;
- no toma leases ni observa mediante mecanismos que alteren su ejecución;
- no reemplaza parcialmente tmux, el DT, los workers o los auditores actuales;
- no se usa productivamente por fases aunque un subsistema aislado ya funcione;
- sólo se prueban writes en repositorios de juguete y worktrees descartables.

El producto nuevo debe llegar completo a una certificación pre-cutover. Recién
después de aprobar funcionalidad, recuperación, adapters, routing, cuentas,
cuotas, UI, accesibilidad, rendimiento, auditoría y documentación, el owner podrá
autorizar un cutover explícito. Hasta entonces, el sistema vigente sigue siendo
la única operatoria real.

No se descarta tmux ni ninguna herramienta existente durante el desarrollo. La
migración final debe tener un plan de reversión probado y nunca depender de una
transición parcial para completar el producto nuevo.

## Ownership y organización de agentes

Identidad uniforme: `<provider>/<model>/<role>/<instance>`.

### Owner técnico / DT — Kimi K3

Worker canónico: `kimi/k3/coordinator/01`.

Responsabilidades:

- mantener este roadmap y clasificar los packets;
- emitir el brief y el write-set exacto de cada packet;
- adjudicar desacuerdos entre writer y auditor;
- aceptar o rechazar cada hito contra criterios medibles;
- decidir routing usando métricas, no preferencias permanentes;
- escalar al owner decisiones de producto, costo o autoridad.

Kimi K3 no será el writer rutinario del repositorio mientras sea DT. Puede
prototipar o investigar en scratch read-only, pero no autoaprobar código propio.

### Architecture integrator y writer principal — Claude Opus

Worker canónico: `claude/opus/implementer/01`.

Responsabilidades:

- ownership de arquitectura y coherencia transversal;
- ledger, Restate, recuperación, leases, seguridad operacional y adapters;
- integrar los paquetes de Sonnet en el worktree canónico;
- realizar cambios semánticos o de riesgo medio/alto;
- mantener una única implementación coherente de los contratos.

Sólo Opus integra en el worktree canónico. Nunca hay dos writers simultáneos en
el mismo worktree.

### Implementadores mecánicos paralelos — Claude Sonnet

Workers: `claude/sonnet/implementer/NN`.

Responsabilidades:

- scaffolding, schemas, fixtures, tests, UI mecánica y adapters acotados;
- paquetes repetitivos con brief y write-set exactos;
- trabajo paralelo únicamente en git worktrees aislados y disjuntos;
- entregar diff, checks y receipt a Opus; no integrar ni ampliar alcance.

Sonnet no decide arquitectura ni reancla tests para hacerlos pasar.

### Auditor estricto — Claude Fable

Worker: `claude/fable/reviewer/01`, estructuralmente read-only.

Responsabilidades:

- auditar autoridad, write-set, leases, recuperación y evidencia;
- comprobar que los tests fueron ejecutados por un verificador independiente;
- emitir un único `ACCEPT`, `ACCEPT_WITH_CORRECTIONS` o `REJECT` estructurado;
- nunca editar, ejecutar commits ni iniciar implementadores.

### Consultor y auditor de checkpoint — Codex

Worker: `codex/<resolved-model>/consultant/01`.

Responsabilidades:

- comunicación concisa con el owner, especialmente por voz;
- auditoría independiente en límites de fase, no por cada microcambio;
- contraste rápido de roadmap, métricas y riesgos;
- detectar desvíos o burocracia sin convertirse en segundo DT.

El objetivo explícito es minimizar tokens de coordinación de Codex.

## Ley de supervisión y presupuesto de auditoría

Todo código tiene implementador y controlador distintos. No se permiten ciclos
indefinidos de informes:

- packet mecánico y reversible: Sonnet implementa; verificador automático y un
  postaudit Fable. Sin preaudit salvo que cambie autoridad;
- packet semántico: Opus implementa; un preaudit Fable del brief y un postaudit;
- arquitectura, leases, credenciales, Git o recuperación: Opus implementa,
  Fable pre/post audita y Codex revisa una sola vez en el checkpoint de fase;
- tras un `REJECT`, Kimi adjudica una corrección concreta. No se pide al auditor
  que redacte versiones sucesivas del mismo contrato sin nuevo código;
- los tests y receipts son evidencia primaria; la prosa del writer no lo es.

## Arquitectura base

- TypeScript sobre Node.js 22.
- `ControlPlaneEvent` append-only en SQLite WAL como única autoridad de estado.
- Restate como runtime durable si pasa los drills de idempotencia y
  reconciliación; fallback predeterminado a supervisor SQLite monoproceso.
- Read model reconstruible para CLI y UI.
- Daemon/supervisor local, arrancable por `launchd`.
- Adapters oficiales: Claude headless CLI, Kimi ACP/Server API y Codex App Server.
- PTY supervisado sólo cuando un CLI realmente lo necesite.
- MCP únicamente para herramientas externas; no es autoridad de workflow.
- UI local de observabilidad primero; controles mutantes después de validarla.

Tmux puede sobrevivir como fallback durante el rollout, pero deja de ser memoria,
autoridad y coordinador. El ledger, Restate y los adapters asumen esas funciones.

## Contratos obligatorios

### `TaskEnvelope`

Incluye objetivo, autoridad por path+SHA, read-set, write-set, conflictos,
comandos permitidos, acciones prohibidas, output, validación, rol/modelo elegible,
presupuesto, necesidad visual, política de commit y checkpoint.

### `WorkerSlot`

Incluye proveedor, modelo resuelto, versión de CLI, rol, capacidades, cuenta,
permisos, cuota, reserva, lease y health probe.

### `Checkpoint`

Es compacto y neutral: último paso atómico, HEAD, hashes de autoridad/read/write,
receipts, trabajo pendiente, siguiente acción segura y referencias por digest.
Nunca depende de transcribir toda la conversación ni contiene credenciales.

### Lifecycle

`DISCOVERED → DT_CLASSIFIED → READY → RESERVED → RUNNING → VERIFYING → AUDITING → READY_TO_COMMIT → COMMITTED → CHECKPOINTED`

Estados excepcionales: `WAITING_OWNER`, `DRAINING`, `QUOTA_BLOCKED`,
`AUTH_REQUIRED`, `REJECTED`, `FAILED`, `SUSPECT_WORKTREE`, `CANCELLED`.

Un paquete `NO_COMMIT` cierra desde `AUDITING` directamente en `CHECKPOINTED`,
sin pasar por `READY_TO_COMMIT` ni `COMMITTED`. El camino con commit no cambia.

## Cuentas, cuotas y cambio automático

Se incorpora como requisito de v1, inicialmente en shadow mode y luego activo por
adapter.

### Registro local

El archivo local previsto es:

`/Users/daniel/.rottay-agent-control-plane/accounts.local.json`

Queda fuera de todo repositorio. Al crearlo debe tener permisos `0600`. El owner
puede completar allí credenciales, perfiles o referencias locales. Ningún secreto
puede entrar en SQLite, Restate, logs, checkpoints, prompts, artifacts o commits.

Cada cuenta registra como mínimo:

- `accountId`, `provider`, `authMode` y `authProfile`;
- opcionalmente una referencia a credencial local cuando el adapter la necesite;
- plan/suscripción, modelos habilitados y límites conocidos;
- reset/renovación observada o declarada, timezone y nivel de confianza;
- cuota estimada, último health probe y último error clasificado;
- estado `AVAILABLE | DRAINING | EXHAUSTED | COOLDOWN | AUTH_REQUIRED`;
- raíz de configuración aislada y costo estimado de cambiar contexto.

Se prefieren perfiles oficiales preautenticados por cuenta. El login automático
con credencial local es un fallback de adapter, no una suposición universal:
OAuth, 2FA o CAPTCHA mueven la cuenta a `AUTH_REQUIRED`.

### Routing consciente de cuotas

Antes de reservar una tarea, el router pondera:

- capacidad/modelo y tasa histórica de aceptación;
- tokens y duración estimados;
- cuota restante y proximidad del reset;
- contexto/cache ya disponible en esa cuenta;
- penalidad y riesgo de cambio de cuenta;
- reserva mínima para checkpoint, verificación y auditoría.

No inicia un packet largo en una cuenta que no tenga margen estimado para llegar
al siguiente paso atómico más checkpoint.

### Cambio de cuenta

`quota warning/error → DRAINING/QUOTA_BLOCKED → terminar paso atómico → checkpoint → liberar lease → seleccionar cuenta → health probe read-only → sesión fresca → verificar autoridad/prestate → hidratar checkpoint → continuar`.

El adapter debe tener una taxonomía fail-closed de errores. Un error desconocido
no se interpreta como cuota y nunca habilita escrituras en otra sesión sin
revalidar el estado. Cada proveedor debe pasar al menos un drill de cambio de
cuenta antes de recibir permisos de escritura.

### UI de cuentas

La UI muestra por cuenta: alias, proveedor/modelos, estado, cuota estimada,
reset/renovación, confianza, tarea actual, checkpoint y recomendación de routing.
Acciones: `drain`, `account-ready`, `reauth-required` y override del owner.

## Git, leases y recuperación

- un writer por worktree;
- writers paralelos sólo en worktrees aislados y con conflict graph compatible;
- comparar tras cada paso atómico tracked diff y paths untracked contra write-set;
- cualquier violación revoca lease y entra en `SUSPECT_WORKTREE` sin limpiar;
- negar `git restore`, checkout destructivo, resets destructivos, stash, auto-clean
  y cualquier push;
- commits locales requieren `CommitAuthorizationReceipt`; no hay push automático;
- recuperación revalida autoridad y prestate; nunca fuerza el árbol a una foto vieja.

## Fases y responsables

### P0 — Bootstrap y autoridad

Owner: Kimi K3. Writer: Opus. Auditor: Fable.

- crear el repositorio separado sólo tras kickoff explícito;
- congelar contratos, naming, deny-list, métricas y criterios de rollout;
- configurar CI, lint, tests, commits locales y no-push;
- checkpoint Codex al finalizar.

### P1 — Ledger, read model, CLI y UI read-only

Integrator: Opus. Sonnet puede dividir ledger tests, CLI y UI en worktrees
aislados. Auditor: Fable.

- SQLite WAL append-only e idempotency keys;
- read model reconstruible;
- CLI mínima y UI local de observación;
- identidad y lifecycle visibles de punta a punta.

### P2 — Durabilidad y supervisor

Writer: Opus. Auditor: Fable. Checkpoint: Codex.

- Restate event-first y reconciliación con ledger;
- kill/restart `3/3` en toy repo;
- fallback SQLite supervisor probado;
- daemon local y arranque controlado por `launchd`.

### P3 — Shadow mode y baseline

Integrator: Opus. Sonnet implementa colectores pasivos. Fable audita privacidad de
write-sets y ausencia de señales mutantes.

- observar únicamente artifacts pasivos ya emitidos o escenarios sintéticos;
  nunca adjuntarse, inspeccionar credenciales, señalizar ni escribir en sesiones
  existentes de Modern Rescue;
- medir routing DT, tokens, tiempo, rework y aceptación;
- validar que la UI coincide exactamente con el ledger.

### P4 — Adapters read-only

Writer principal: Opus. Sonnet toma fixtures/probes disjuntos. Auditor: Fable.

Orden: Claude headless → Kimi ACP/Server API → Codex App Server.

- spawn, stream, interrupt, health probe y errores;
- config roots y sesiones aisladas;
- Fable estructuralmente read-only;
- ningún adapter escribe producto todavía.

### P5 — Cuentas, cuotas y continuidad

Writer: Opus. Sonnet implementa registry/UI/fixtures. Auditor: Fable. Kimi
adjudica políticas; Codex revisa el checkpoint.

- schema y loader de `accounts.local.json` sin persistir secretos;
- calendario de resets y estimación de cuotas;
- router consciente de reserva/contexto;
- perfiles preautenticados y fallback de reautenticación;
- cambio automático/manual y drills por proveedor.

### P5N — Normalización estructural (checkpoint obligatorio)

DT: Kimi. Inventario y refactors por cohortes: Sonnet en worktrees aislados.
Integrator: Opus. Auditor por cohorte: Fable. Kimi adjudica cada agrupación.

Topología obligatoria exacta (ley del owner, repository-wide):

- código de producto: `packages/<pkg>/src/<domain>/<subdomain>/index.ts[x]`;
- tests: `packages/<pkg>/test/<domain>/<subdomain>/index.test.ts[x]` — un
  árbol espejo separado; **cero** `*.test.*` o `*.spec.*` bajo `src`;
- fixtures y helpers viven bajo el dominio de test espejo correspondiente;
- el `src/index.ts` raíz de cada paquete es sólo un barrel público estable;
- el architecture gate aserta estos invariantes exactos, árbol por árbol,
  repo-wide.

Censo medido con clasificador disjunto (no `grep -v`), reconciliado
explícitamente entre baseline commiteado y P5C congelado:

- **tracked HEAD: 177** fuentes TS/TSX bajo `packages/*/src/` = 60
  tests/spec + 16 index de producto + 101 producto no-index;
- **live: 179** = 61 tests + 17 index + 101 producto no-index (los dos
  archivos P5C untracked congelados añaden un test y un index);
- los 101 paths de producto no-index son los candidatos a adjudicación
  semántica (no movimientos ciegos); los 60 tests commiteados bajo `src/` se
  relocan al árbol espejo `test/`. Los conteos por paquete los produce el
  inventario P5N-INV con el clasificador disjunto; ninguna cifra por paquete
  se afirma sin esa medición.

Las relocations son mecánicas; ningún cambio semántico viaja en un cohorte;
el gate expande la ley árbol por árbol, sólo cuando cada cohorte queda
compliant; **P6 no comienza hasta compliance total**.

**P5N completo** (2026-08-28, HEAD `94849d7a`): los diez árboles —
contracts, ledger, api-contracts, observation, cli, adapters, daemon,
runtime, ui, server — cumplen la topología folder/index con el árbol
espejo de tests separado; cada cohorte (C1–C10) cerró con validación
independiente y receipt local, incluidos el incidente C8-1 (No-Checkout
Law), la adjudicación C7-R1 (los child executables de drill son
producción cuando el build real los emite), el par C9-F y la regla de
scope C10-R1. La línea de estado no se mueve aquí: P5 sigue abierto
hasta P5E.

### P6 — Enforcement de writers

Writer: Opus. Auditor: Fable. Checkpoint independiente: Codex.

- leases, write-set/untracked conformance, scoped prestate;
- conflict graph completo;
- verificador independiente, commits autorizados y quarantine;
- fixtures con violaciones plantadas que deben fallar cerradamente.

### P7 — Pilotos aislados

DT: Kimi. Writer inicial: Sonnet en repo de juguete/worktree no productivo.
Integrator: Opus. Auditor: Fable.

- packet read-only completo;
- kill/restart y cambio de cuenta;
- un packet mecánico writer con commit local y sin push;
- cero participación de Modern Rescue durante todo P7 y P8.

**P7 completo** (2026-08-30, HEAD `34d7680a`): los cuatro packets cerraron
cada uno con verificación independiente, ACCEPT de Fable, receipt del DT y
commit local — P7P (`6f2c0a85`), que hace el plan de lifecycle consciente
de la commit policy y le da cierre lícito a un packet `NO_COMMIT`; P7A
(`514b4953`), el piloto del packet read-only sobre la maquinaria real; P7B
(`1ef4a91b`), kill/restart 3/3 con SIGKILL sobre un proceso hijo real más
el cambio de cuenta ejecutado como valores sobre un ledger real; y P7C
(`34d7680a`), el packet mecánico writer, con un commit local real en un
repositorio de juguete bajo receipt y sin push jamás. Cero participación de
Modern Rescue durante toda la fase. Nada de esto queda adoptado: la
adopción ocurre una sola vez, tras la certificación P8 y bajo una
autorización P9 separada.

### P7I — Contratos de iniciativa y roadmap versionado

DT: Kimi. Writer: Opus. Auditor: Fable (preauditoría obligatoria de los
contratos antes de cualquier implementación de UI).

- contrato `Initiative` y scoping de toda entidad por iniciativa;
- contrato `RoadmapVersion` inmutable con digest, concurrencia optimista,
  evento/receipt append-only por cambio, rollback e historia;
- rollups de uso/reserva de tokens por iniciativa y por tarea sobre cuota
  global;
- cero UI en esta fase: sólo contratos, ledger mappings y pruebas.

**P7I completo** (2026-08-30): el diseño se preauditó una vez
(`DESIGN_ACCEPT_WITH_RULINGS`, siete rulings) y el DT adjudicó dos veces;
los cuatro packets cerraron cada uno con verificación independiente,
ACCEPT de Fable, receipt del DT y commit local — P7I-0 (`1e030369`), el
salto de `CONTRACT_VERSION` a 2.0.0 con las fixtures des-hardcodeadas para
que el próximo salto sea mecánico; P7I-1 (`586aed3c`), los contratos:
`Initiative`, `RoadmapVersion`, el stream hermano `InitiativeEvent`, el
vocabulario de uso/reserva de tokens en el stream de tareas y el
`initiativeId` requerido en `TaskEnvelope`; P7I-2 (`110706c5`), los ledger
mappings: la migración aditiva, el stream hermano bajo las mismas leyes
append-only con su propia cadena y cabeza, y la decisión pura de
`RoadmapVersion` junto al fold que consume; y P7I-3 (`0bdd223b`), los
rollups de tokens por tarea y por iniciativa. Dos STOP se honraron sin
ampliar ningún write-set: el radio de impacto del salto de versión en
P7I-1 y el décimo path de P7I-2, ambos adjudicados antes de continuar.
Cero UI, cero adopción y cero participación de Modern Rescue en toda la
fase. Nada de esto queda adoptado: la adopción ocurre una sola vez, tras
la certificación P8 y bajo una autorización P9 separada.

### P8 — Producto completo y certificación pre-cutover

Kimi adjudica; Fable audita evidencia; Codex comunica una evaluación concisa al
owner.

- routing coincide con DT en al menos 95%, sin desacuerdos de seguridad;
- tokens de coordinación bajan al menos 30%; total no sube más de 10% a igual o
  mejor calidad;
- tiempo mediano no empeora más de 10%; objetivo posterior: mejora neta;
- cero writers concurrentes por worktree y cero writes fuera de scope;
- cada packet tiene checkpoint o receipt terminal;
- UI completa: portfolio global y workspaces por iniciativa (objetivo,
  roadmap versionado y editable, hitos y progreso, task graph, agentes
  activos y acción actual, logs, tokens consumidos/reservados/restantes,
  confianza de cuota y reset/renovación, errores/bloqueos e historia),
  overview, task graph, timeline, workers/sessions, routing, cuentas,
  cuotas, worktrees, leases, write-sets, logs, diffs, gates, auditorías,
  checkpoints, commits, approvals, errores y recuperación;
- stack visual vinculante: React+Vite se mantiene; se adoptan Radix UI
  primitives, TanStack Query, TanStack Table, TanStack Virtual,
  `@xyflow/react`, Recharts, Lucide y dnd-kit para el ordenamiento del
  roadmap; lenguaje visual bespoke tokenizado con CSS custom properties; sin
  Next.js, sin shadcn copy-paste, sin tema monolítico estilo MUI;
- experiencia responsive desktop/mobile, navegación por teclado, WCAG AA,
  estados loading/empty/degraded/error, búsqueda/filtros y evidencia visual
  desktop/mobile;
- tests unitarios, integración, contratos, E2E y sighted QA sobre los
  workflows principales — incluyendo portfolio, cambio de iniciativa,
  edición de roadmap, logs, cuotas y recuperación — sin defectos críticos o
  mayores abiertos;
- documentación operativa, troubleshooting, backup/restore, cambio de cuenta,
  actualización y rollback reproducibles por una sesión fresca;
- owner acepta explícitamente el producto completo. Esta aceptación certifica el
  candidato, pero todavía no toca Modern Rescue.
- ruling del owner sobre ejecución y UI transport-agnostic:
  `.acp-local/p8-transport-agnostic-owner-ruling.md`
  (`11c7a81a759034405e652eb8af11cf9aa9bca567cbca64ac16de8c4b0cab1ab4`),
  incorporado a la planificación de P8; su incorporación completa es su
  propio packet de diseño, no este cierre.

#### P8-8E2 — los productores de causación (checkpoint de Codex, 2026-08-31)

P8-8E dejó el grafo correcto y vacío: la superficie existe end-to-end y
ningún productor escribía `causationId`. P8-8E2 cierra eso antes de P8-9 —
`buildEvent` hila la cadena del walk (`correlationId` = el `invocationId` de
la invocación; `causationId` = el evento del paso anterior del mismo intento,
derivado y no recordado, de modo que la ley de resume se cumple por
construcción); el módulo de usage y el switch-executor hilan igual, con la
causa explícita del llamador donde existe de verdad. El hilo intra-attempt
alimenta el **timeline**; las aristas del grafo salen sólo de causas
genuinamente cross-task, que es lo que el flujo de switch produce. La
causación es **advisory**: el ledger verifica cadenas de hash, no causación —
la garantía son dos guardas, el productor que se niega a apendar un enlace
cuyo predecesor no está durablemente presente, y el consumidor que se niega a
dibujar una arista que no puede resolver.

#### P8-8F — cuentas, confianza de cuota/reset, logs y la vista de documento (2026-08-31)

La vista de documento del roadmap aterriza por nombre como el segundo
consumidor del content-read: read-only por construcción (cero affordances
de escritura), con selector de versión nativo, deep link `?version=` y
estados nombrados (versión desconocida distinguida del 404 por id). La
superficie de cuentas nace del primer endpoint no-ledger del plano
(`GET /api/v1/accounts`, contrato 0.6.0): la unión cerrada
`READY | UNAVAILABLE` responde 200 en ambos brazos — un owner file ausente
es el estado honesto de una máquina fresca, no un 500 — con el vocabulario
de cinco razones congelado sobre un mapa total por compilación (14 → 5; la
coarsening es el argumento de seguridad), la omisión de `credentialRef` y
`authProfileRef` forzada por strictness y taladrada hasta el substring, y
el reloj inyectado en el handler (`estimatedAt`). La confianza de
cuota/reset se muestra por cuenta (ratio restante, confianza compuesta,
calendario de reset) y por iniciativa (la fila diferida del workspace desde
P8-8D C1: el fold HIGH/LOW y el gasto no ubicable, con la ley de
degradación). Los logs scoped (`#/i/<id>/logs`) renderizan el mismo
endpoint del timeline en densidad de depuración: ids copiables, timestamps
absolutos, filtros puros en memoria con round-trip por la URL. Blueprint v2
adjudicado una vez (C1–C5 de Fable incorporados, N1–N2 adoptados). La
evidencia renderizada crece la lista de P8-9 por nombre: el bridge del
navegador sigue sin conectar (resultado standing de la fase).

#### P8-8G — la superficie de escritura armada y las acciones de cuenta (2026-08-31)

La superficie de escritura queda armada de punta a punta. El bearer local
guarda la superficie entera: token en archivo fuera del repo
(`writeBearerPath`, fail-closed — sin configurar responde 403
`WRITE_BEARER_UNCONFIGURED`; ausente o wrong responden el mismo 401
`AUTH_REQUIRED`, indistinguibles por diseño), guardia dentro del registrar
de escritura (heredada por dónde se registra la ruta, no por memoria de
nadie), comparación hash-then-`timingSafeEqual` sobre digests, y el token
en ninguna superficie serializada (drill plantado). El ceiling de 1 MiB
tiene declaración única en `@acp/contracts` con la ley de unidad
UTF-8-bytes vía `TextEncoder` (nunca `Buffer` en api-contracts), ambos
límites movidos (request y documento), prueba de igualdad del server con
`Buffer.byteLength`, y el transporte derivando `bodyLimit` de la única
autoridad más el allowance nombrado. La carrera deja de ser un 500: catch
estrecho de exactamente `LEDGER_IDEMPOTENCY_CONFLICT` /
`LEDGER_EVENT_ID_CONFLICT` → 409 `WRITE_REFUSED` (`WRITE_CONFLICT`), y
cualquier otro error sigue clasificando 500 (drill discriminante).

Las acciones de cuenta nacen como stream append-only propio (migración 5,
`account_events` STRICT con sus triggers deny que el inventario de esquema
exigió por enumeración): drain/ready/reauth/owner-override con refusals
nombrados (`UNKNOWN_ACCOUNT`, `ALREADY_IN_STATE` — el no-op se rehúsa, no
se concede en silencio —, `ACCOUNTS_UNAVAILABLE`, `WRITE_CONFLICT`), la
nota bajo las guardias de contenido universales, y la ley de autoridad del
estado en una sola función (`foldEffectiveState`) compartida por read y
write: el owner file gobierna sólo hasta la primera acción registrada; de
ahí en adelante el ledger manda, la más nueva gana, y una edición
posterior del archivo no pisa una acción grabada (drill explícito). La
corrección es siempre un acto explícito con receipt. Segunda write door
`POST /api/v1/accounts/:accountId/actions` (`API_WRITE_ROUTES` crece
visiblemente a dos) y entry del operador `acp-server` con argv parseado a
mano, exits clasificados al idioma del daemon y cero dependencias nuevas.
Contrato 2.2.0 / API 0.8.0. La UI lo vuelve operable: bearer session-only
en la raíz (nunca persistido, URL ni localStorage; unarmed es postura, no
falla), controles por fila con confirmación deliberada (owner-override con
selector de estado y nota), el receipt anunciado con su sequence en live
region, y la columna de estado renderizando `effectiveState` con la marca
"operator-set". Blueprint v2 adjudicado una vez (C1–C6 de Fable
incorporados, N1–N2 adoptados); dos STOPs de Opus adjudicados por path
exacto; un incidente de proceso huérfano del drill D2 terminado acotado
por el DT y asentado con causa (el teardown del drill debe matar lo que
spawnea — queda para la batería P8-9).

**Enmienda de lenguaje (exigencia C2):** donde el roadmap decía "una única
write door", la ley correcta es **"the write surface"**: una superficie de
escritura singular guardada por un único registrar armado, que puede
albergar más de una ruta. Queda enmendado por este record.

#### Addendum vinculante del owner (2026-08-30): ejecución y UI agnósticas de transporte

El owner ruling `.acp-local/p8-transport-agnostic-owner-ruling.md`
(SHA-256 `11c7a81a759034405e652eb8af11cf9aa9bca567cbca64ac16de8c4b0cab1ab4`)
es ley de producto para P8. Proveedor, modelo, cuenta, transporte,
librería de UI, exportador de observabilidad e integraciones de runtime
durable permanecen reemplazables detrás de contratos propios. La
certificación pre-cutover ahora exige,
además de los criterios ya listados:

**Arquitectura vinculante.**

1. El control plane es dueño de routing, selección de rol, política de
   cuenta/cuota, leases de writer, detección de conflictos, checkpoints y
   evidencia. Ningún registry de SDK ni gateway se vuelve autoridad de
   estas decisiones.
2. Un puerto de ejecución propio (`ModelExecutionPort`) retorna eventos
   de ejecución normalizados y admite como mínimo: `CLI_SUBSCRIPTION`
   (transports oficiales/headless de Claude, Kimi y Codex), `API_KEY`
   (llamadas API de proveedor, opcionalmente vía Vercel AI SDK) y
   `LOCAL_OR_SELF_HOSTED` (transports locales o compatibles
   OpenAI, futuros).
3. La ruta resuelta identifica proveedor, modelo, cuenta, tipo de
   transporte y versión de la política de capacidad evaluada. Los
   adapters ejecutan esa ruta exacta; no seleccionan otro modelo ni caen
   en silencio a uno distinto.
4. Un registro versionado de capacidad/política vive fuera del código de
   aplicación: release del modelo, roles elegibles, calidad medida,
   latencia, contexto, soporte de modalidad/herramientas, disponibilidad
   de transporte, confianza de cuota/reset por cuenta, costo cuando
   aplique, fecha de evaluación y fallbacks permitidos. Actualizar las
   preferencias de modelo nunca requiere cambiar código de orquestación.
5. Restate sigue siendo un adapter de runtime durable reemplazable; el
   ledger append-only sigue canónico. Restate aporta llamadas durables,
   reintentos, reattachment y concurrencia de sesión sólo tras los drills
   de reconciliación/idempotencia; el fallback documentado del supervisor
   SQLite sigue válido.
6. Vercel AI SDK Core es opcional y restringido a adapters API-backed. La
   operación por CLI de suscripción no depende de API key, de AI Gateway
   ni de una cuenta API paga.
7. AI SDK UI sólo en el borde de presentación (estado de chat, partes de
   mensaje tipadas, streaming, render de herramientas/estado), conectado
   por un transport propio a la API/ingress del control plane. El estado
   de AI SDK UI nunca es estado de ejecución canónico.
8. Las operaciones largas usan invocación durable fire-and-forget,
   idempotency keys, invocation IDs, reattachment y actualizaciones
   SSE/pubsub. Cerrar o reabrir la UI no cancela ni duplica una
   ejecución.
9. La observabilidad emite primero eventos neutrales compatibles con
   OpenTelemetry/OpenInference. Langfuse puede ser el primer exportador
   opcional; ningún vendor de observabilidad se vuelve requerido para
   routing, recuperación o evidencia.
10. El cambio de cuenta queda dentro de los adapters de
    cuenta/transporte. Cambiar entre cuentas de suscripción o mover una
    ruta de CLI a API preserva la misma identidad de tarea/checkpoint y
    nunca expone credenciales en eventos, prompts, logs ni UI.

**Criterios de aceptación añadidos.**

- El mismo fixture de conformidad ejecuta a través de al menos un adapter
  `CLI_SUBSCRIPTION` y un adapter `API_KEY` (fake o real), produciendo el
  mismo contrato de eventos/lifecycle normalizado.
- Retirar o deshabilitar AI SDK, Restate y el exportador de
  observabilidad, independientemente, deja operativos los caminos de
  fallback documentados.
- Una actualización de la política de routing cambia el modelo elegible
  elegido sin cambios de código fuente y registra la versión de política
  usada.
- La reconexión de la UI prueba que no hay invocación duplicada y que la
  recuperación tras un reinicio del frontend es correcta.
- Las credenciales API y de suscripción aparecen redactadas en eventos,
  checkpoints, logs, trazas y UI.
- No hay cutover ni participación de Modern Rescue antes de que pasen
  todos los criterios P8 originales más estas adiciones y el owner
  autorice P9 explícitamente.

#### Tranche bloqueante de topología estructural (ruling del owner, 2026-08-31; enmendada tras la auditoría conjunta)

La auditoría conjunta cerró: tres memos (Kimi/Opus/Fable), la síntesis
aceptada (`3cd869f1…`), la revisión de Fable (ACCEPT con BC1–BC3,
`a5c86006…`), el delta-debrief de Opus y Fable sobre las 10 leyes del
owner, y la adjudicación consolidada del DT
(`.acp-local/p8-oss-delta-kimi-adjudication.md`). La tranche queda así
(emendada; binding):

**Secuencia (ley del owner 9):** primero todo el P8 funcional hasta
P8-10 (la batería live-DOM/axe aterriza en P8-9, lado funcional);
después P8-T; P8-E y cualquier pedido de P9 quedan aguas abajo. P9
permanece imposible hasta que esta compuerta y todos los criterios de
P8 pasen.

**Topología objetivo (cinco estratos, fence-verificables):** `kernel/`
(contracts, protocol); `persistence/` (ledger); `domains/`
(runtime, accounts, observation); `edges/` (providers, durability);
`entrypoints/` (daemon, gateway, cli, console). Nombre de carpeta =
nombre de paquete; máximo dos niveles. Reglas de capa: kernel sin imports
internos salvo `protocol → contracts`; persistence → kernel; domains →
persistence+kernel con `runtime → accounts` como única arista
dominio-dominio; edges → domains+persistence+kernel, con
`durability → runtime` implementando el port y `edges →
runtime/scenarios` declarado; entrypoints → cualquier estrato inferior;
nada importa un entrypoint desde `src/`; console → kernel/protocol
solamente. Nombres npm `@acp/*` invariantes salvo la única excepción
registrada `@acp/durability`.

**Leyes de lectura (adjudicadas una vez):** los tipos/interfaces/enums
pertenecen a su contexto acotado y se exponen por su entrypoint
folder/index; la co-ubicación de los tipos de un módulo con su
implementación es conforme; la prohibición es sobre bolsas globales de
tipos y tipos sueltos fuera de todo entrypoint. Pre-release, "consumidor"
significa consumidores in-repo, y la prueba de compatibilidad es la
actualización atómica del consumidor en el mismo commit más los gates
en verde; tras cualquier release pública, la ley 8 se endurece a
compatibilidad externa real.

**Los paquetes (G-packets, cada uno verde y commiteado localmente, sin
push):** G0 — portabilidad del fence, bloqueante: un único resolver de
raíces de paquete, los 291 prefijos literales retirados, toda ley
path-scoped falla cerrada con scope vacío, el inventario de superficies
path-shaped con su ley, las sondas de fallo deliberado, el epoch del
fence (arrays históricos congelados; el move-map bidireccional gobierna;
los paths viejos entran en RETIRED_PATHS; el epoch se prueba fallando
ante un archivo pre-epoch genuinamente borrado), y `RUNTIME_PUBLIC_EXPORTS`
pineado contra el barrel intacto. G1' — el movimiento atómico único del
árbol (todos los paquetes en un commit; cada referencia
tsconfig/vitest/glob reescrita exactamente una vez; el move-map como
obligación de prueba; la compuerta es un `tsc --build` limpio desde
`.tsbuildinfo` vacío más la suite completa y el fence). G5 — el split
runtime/durability (el único de alto riesgo; pre-audit obligatorio), con
el test de conformidad del port dentro de `edges/durability` y la
compuerta de cero referencias `@restatedev/restate-sdk` por especificador
de import, nunca por substring. G6 — subdivisión de contracts in place,
barrel byte-estable. G7 — naming + dedup (incluida la democión de la
arista accounts→ledger a devDependency con su evidencia grep en el memo,
moviendo manifest + fence + comentario juntos). G8 — higiene de
superficies (las referencias de parity fuera del tsconfig de producción;
fixtures dorados compartidos; dietas de barrel bajo la compuerta de
cero-importadores). G9 — las clases de test faltantes (residuo
estructural únicamente), cada una con su prueba de fixture falliente.
G10 — la tranche de documentación con la docs-gate viva. Compuerta de
fase: `STRUCTURAL_TOPOLOGY_CERTIFIED`. Rollback = el move-map invertido,
nunca un force.

**Leyes transversales:** una verificadora pesada serial en todo momento
(el pool file-locked es ley local; CI la hereda si P9 la crea); toda
clase de test nueva aterriza con su prueba de fixture falliente y los
memos reportan qué discriminan los tests, nunca cuántos hay; los
cohortes llevan cero commits en su branch; la referencia de la API se
fence-checks contra la fuente (la tabla de parity es la autoridad), y
una referencia TypeScript tipo typedoc es el único lugar donde
"generada" es apropiada; el README de cada paquete se verifica contra
los pins de exports del fence y el threat model cita hechos grepeables.
**ADR 0013** (`docs/architecture/0013-repository-topology.md`) queda
comisionado para registrar las adjudicaciones (incluida la arista
scenarios y el movimiento de las constantes de topología al kernel).

**Delta de elevación OSS (2026-08-31, adjudicada una vez):** ADR de
topología renumerado a **0014** (0013 quedó ocupado por la primera write
route) + regla del fence de numeración ADR única y contigua. Cada paquete
se clasifica **público** (contracts, protocol, ledger, runtime, accounts,
observation, providers, durability) o **interno** (daemon, gateway, cli,
console) en la ley de estratos, y el fence lo aserta contra cada
manifest. La extensibilidad queda así: la unión de transports cerrada;
`ProviderId` extensible por descriptor validado con registro estático en
el composition root; los providers first-party se distribuyen con el
producto; **no** hay carga de plugins en runtime, ni código remoto, ni
marketplace. `STRUCTURAL_TOPOLOGY_CERTIFIED` es una computación del fence
(la tabla de capas en verde, cero paths obsoletos, el move-map aplicado
completo, ningún path literal en ninguna ley, toda ley path-scoped con
scope no vacío) — `P8_COMPLETE` igual. G0 ensaya el resolver sobre un
layout sintético de dos niveles antes de mover el árbol real. La ley de
dedup: un valor que dos contextos deben acordar tiene exactamente una
declaración y una compuerta de duplicación; un predicado de cuatro líneas
que dos contextos comparten por casualidad, no. El corpus ADR gana
`index.md` + plantilla (status + supersedes/superseded-by) bajo la docs
gate. La threat model nombra la frontera loopback como titular y la
write surface gana un bearer local antes de cualquier release
(funcional, en P8-8G, antes de P8-E). Nada publica ni se des-privatiza hasta que
LICENSE + SECURITY.md + CONTRIBUTING.md aterricen juntos en G10. G0 lleva
un fixture falliente por familia de leyes del fence. La falsa-roja
intra-run se cierra antes de P8-9: un pool vitest serializado para toda
suite de puertos/procesos reservados y aserciones de procesos por
proveniencia. La vista de documento del roadmap (el segundo consumidor
del content-read) aterriza en P8-8F por nombre. Mutation testing sólo en
los tres módulos de decisión; thresholds sólo ahí.
R1 aterriza en P8-8G — el techo de 1 MiB pineado a una sola autoridad,
con el test de igualdad del server y la ley unitaria de caracteres contra
bytes, cerrando el hallazgo de registro de P8-8D-pre — y los cuatro
objetivos de property de R2 aterrizan en G9: el round-trip de la gramática
de rutas, canonical-json, la derivación de digest/path del artifact store y
los invariantes de `decideRoadmapVersion`.

**Restatement de nomenclatura (P8-E, el acto que G7 difirió):** la tabla
de topología y la clasificación público/interno de esta tranche se leen
arriba con los nombres aterrizados. La auditoría de 2026-08-31 las
escribió como `api-contracts`, `adapters`, `server` y `ui`; G7
(`446673f`) renombró esos cuatro paquetes — y sus especificadores
`@acp/*` — a `protocol`, `providers`, `gateway` y `console`, y difirió a
P8-E el restatement de esta sección; P8-E lo ejecuta aquí, con ADR 0015
enmendando la nomenclatura de ADR 0014 sin tocar ese registro. La
narrativa de los G-packets queda como se escribió: describe lo que cada
packet aterrizó con los nombres que tenían entonces.

#### Ruling del owner (2026-08-31): debrief final acotado y P9 sin prioridad actual

Antes de la certificación P8-E y de cualquier publicación open-source o
afirmación de readiness, se programa **un único debrief final acotado**:
Kimi K3 como DT, Fable como auditor estricto read-only y Codex como
consultor independiente conciso. El debrief certifica: topología
declarativa del repositorio; estructura de carpetas/index y tests espejo;
fronteras público/interno; completitud y exactitud de la documentación
OSS; onboarding de contribuidores; modelo de seguridad/amenazas; higiene
de licencia y release; tests y evidencia; y ausencia de paths obsoletos o
duplicados. Un debrief, una adjudicación, sin bucle recursivo de
auditoría.

P9 queda deliberadamente diferida: sin prioridad ni ETA actuales, sin
esfuerzo de diseño o implementación ahora, y siempre tras autorización
separada y explícita del owner.

### P9 — Cutover explícito y reversible

Owner: decisión exclusiva del owner. DT: Kimi. Integrator: Opus. Auditor: Fable.
Checkpoint independiente: Codex.

- congelar un checkpoint seguro de la operatoria vigente;
- probar una vez más recuperación, cuentas, permisos y rollback con las mismas
  versiones que irán a producción;
- ejecutar un cutover único, no una adopción parcial por subsistemas;
- mantener tmux disponible como rollback hasta completar el período de aceptación;
- ante cualquier falsa evidencia, pérdida de checkpoint, write fuera de scope o
  fallo de continuidad, volver a la operatoria anterior sin limpiar worktrees.
- P9 está deliberadamente diferida y sin prioridad ni ETA actuales (ruling
  del owner, 2026-08-31): ningún esfuerzo de diseño o implementación hasta
  nueva autorización explícita del owner.

#### Ruling del owner (2026-09-03): publicación del repositorio, sin cutover

Autorización recibida textualmente: *"Autorizo retirar la fence de no-push de
Agent Control Plane y publicar main"*.

Alcance exacto de lo autorizado:

- publicar la rama `main` **ya committeada** en un único remote canónico,
  `origin` en `https://github.com/rottay/agent-control-plane.git` (privado);
- retirar la fence de no-push **incondicional** y reemplazarla por una fence de
  publicación explícita que **deniega por defecto**.

Alcance exacto de lo **no** autorizado, y que ninguna publicación concede:

- P9 ni cutover operativo, que siguen diferidos y sin prioridad ni ETA (ruling
  del owner, 2026-08-31, intacto);
- releases o publicación de paquetes automáticos: los paquetes siguen
  `private: true` y el non-goal "no push ni release automáticos" sigue vigente,
  porque la publicación autorizada es manual, de un solo uso y de una sola rama;
- otras ramas, tags, borrados, force-push, otros remotes, ni URLs con
  credenciales;
- ninguna intervención sobre Modern Rescue.

Forma mecánica: `.githooks/pre-push` deniega salvo que se cumplan todas las
condiciones — `ACP_OWNER_PUBLISH=1` en esa única invocación, remote `origin`
con la URL canónica y sin credenciales, `refs/heads/main` hacia
`refs/heads/main`, sin borrados y solo fast-forward. `ACP_OWNER_PUBLISH` es una
señal de un solo uso: exportarla desde un profile, escribirla en un archivo
versionado o dársela a un agente convertiría una autorización explícita en una
permanente, que es justamente lo que evita. Ningún agente puede fijarla.

**Publicar el repositorio no es adoptar el control plane.** La distinción se
sostiene mecánicamente, no por prosa: el fence mantiene su lista de literales
prohibidos en este roadmap — el marcador que encolaría P9 y las dos afirmaciones
de cutover autorizado, que este ruling no saca de la lista y que por eso no
pueden escribirse aquí, ni siquiera para citarlas — la línea Estado conserva
`NO_PRODUCT_CUTOVER`, y el propio hook lo dice en su texto de rechazo.
Publicar código fuente hace visible lo construido; no autoriza que opere nada.

## Criterio de paralelización

Se paraleliza cuando los write-sets, autoridades y derivados sean disjuntos. La
coordinación paralela nunca puede costar más tokens que el trabajo ahorrado.
Opus conserva los paths compartidos: contracts, schemas centrales, ledger,
orchestrator, leases y adapters base. Sonnet recibe hojas disjuntas: fixtures,
tests, vistas UI y adapters auxiliares. Toda integración pasa por Opus.

## Non-goals iniciales

- no takeover de Modern Rescue;
- no push ni release automáticos;
- no writers concurrentes en un mismo worktree;
- no routing pay-per-token por API en el primer piloto;
- no LangChain/LangGraph/CrewAI/AutoGen como autoridad del control plane;
- no asumir que las preferencias actuales de modelos son permanentes;
- no almacenar secretos en el repositorio, ledger o artifacts.

## Próxima acción

El kickoff de implementación fue autorizado. Kimi K3 abre P0, Opus crea el
repositorio y el scaffold bajo el write-set exacto, Fable hace un único postaudit
y Codex entrega el checkpoint conciso. La autorización permite construir el
repositorio nuevo; no autoriza ninguna integración, mensaje o control sobre
Modern Rescue antes de completar P8 y recibir autorización separada para P9.
