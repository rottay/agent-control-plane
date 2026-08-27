# Rottay Agent Control Plane — roadmap canónico

Estado: `P0_COMPLETE / P1A_SOURCE_READY / P1_INCOMPLETE / NO_PRODUCT_CUTOVER`

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

### P8 — Producto completo y certificación pre-cutover

Kimi adjudica; Fable audita evidencia; Codex comunica una evaluación concisa al
owner.

- routing coincide con DT en al menos 95%, sin desacuerdos de seguridad;
- tokens de coordinación bajan al menos 30%; total no sube más de 10% a igual o
  mejor calidad;
- tiempo mediano no empeora más de 10%; objetivo posterior: mejora neta;
- cero writers concurrentes por worktree y cero writes fuera de scope;
- cada packet tiene checkpoint o receipt terminal;
- UI completa: overview, task graph, timeline, workers/sessions, routing, cuentas,
  cuotas, worktrees, leases, write-sets, logs, diffs, gates, auditorías,
  checkpoints, commits, approvals, errores y recuperación;
- experiencia responsive, navegación por teclado, WCAG AA, estados loading/empty/
  degraded/error, búsqueda/filtros y evidencia visual desktop/mobile;
- tests unitarios, integración, contratos, E2E y sighted QA sobre los workflows
  principales, sin defectos críticos o mayores abiertos;
- documentación operativa, troubleshooting, backup/restore, cambio de cuenta,
  actualización y rollback reproducibles por una sesión fresca;
- owner acepta explícitamente el producto completo. Esta aceptación certifica el
  candidato, pero todavía no toca Modern Rescue.

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
