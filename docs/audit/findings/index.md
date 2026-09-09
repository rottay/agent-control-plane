# Hallazgos: defectos, deudas y disposiciones

Dueño único del concepto **defecto**: qué está roto, con qué evidencia, quién lo
cierra y en qué entrega. Las referencias `archivo:línea` corresponden al snapshot
`a92756b`; después de un movimiento hay que actualizarlas.

[Índice](../README.md) · [Evidencia](../evidence/index.md) · [Roadmap](../roadmap/index.md) · [Calidad](../quality/index.md) · [Datos](../architecture/database/index.md) · [Estructura](../architecture/structure/index.md)

---

## 1. Veredicto

**Continuar sobre la base existente, con cambios sustantivos al plan. No certificar
todavía el backend como producto completo ni como universalmente intercambiable.**

El trabajo conservado es real y sus recibos están vinculados a nueve diffs exactos.
Lo que no está listo es de otra naturaleza: el espinazo está cableado y **lo que
transporta está incompleto**; varias garantías se afirman por encima de lo que el
código hace; y la evidencia de las compuertas es más débil de lo que su prosa
sugiere.

Nada de esto exige detener y rehacer la arquitectura. Todo exige corregir antes de
certificar. Ninguno de estos hallazgos demuestra mala fe de ningún agente.

---

## 2. Defectos reproducidos o directamente trazados

| ID | Prioridad | Hecho y evidencia | Impacto y corrección | Entrega |
| --- | --- | --- | --- | --- |
| N01 | Alta | `runtime/src/submission/index.ts:75–108` no incorpora objetivo ni autoridad al digest; `daemon/src/daemon-child/index.ts:861–889` admite ambos por separado. Sonda: dos objetivos y dos autoridades distintos, aceptados con el mismo digest | Cambiar el trabajo puede reutilizar identidad y evidencia anteriores. Vincular **todos** los campos del contrato de envelope a la identidad de revisión ([datos §6.2](../architecture/database/index.md)) | M1 |
| N02 | Alta | `providers/src/execution-port/index.ts:530–535, 564–569`: las peticiones de API y local omiten las instrucciones. Sonda: el cliente recibe sólo modelo, tarea, intento e identidad, y el stream termina en completado | La abstracción puede completar sin entregar la tarea. Contrato neutral con contenido, probado desde la puerta CLI y API ([contratos §4](../architecture/contracts/index.md)) | M1–M2 |
| N03 | Alta | `runtime/src/core/lifecycle/index.ts:58–61` y `step-executor/index.ts:282–304`: verificación, auditoría y commit siguen siendo eventos sin efecto. `daemon/src/index.ts:963, 980, 1282` fija la política de commit | Se registra un commit sin commit real, incluso bajo `NO_COMMIT`. **No se observó ejecución de Git no autorizada**: el defecto es evidencia ficticia y política ignorada. El checkpoint sí tiene efecto persistente | M3 |
| N04 | Alta | `runtime/src/execution-effects/index.ts:507, 527–570, 603–616`; el test `runtime/test/execution-effects/index.test.ts:470–495` espera dos arranques y una observación tras el fallo | Ventana de ejecución duplicada y gasto sin registrar. Registrar exposición y handle, y reconciliar; lo desconocido no se convierte en reintentable | M4 |
| N05 | Alta | `runtime/src/switch-landing/index.ts:347–390` admite salud desconocida y marca el switch completo antes de abrir el destino; `daemon/src/index.ts:845–864` crea el efecto después. `CheckpointPort.read` sin caller productivo | Un spawn fallido deja un cambio aparentemente exitoso y sin continuidad. Separar autorizado, admitido, iniciado y continuado ([contratos §8](../architecture/contracts/index.md)) | M5 |
| N06 | Alta | `scripts/check-architecture.mjs:22334–22357, 22508`: filtro por líneas y comprobación de subcadena sin exigir ancla no vacía. La sección real del gate pasa con 39 anclas vacías y con un ancla que sólo aparece dentro de un bloque de comentario | La certificación permite pruebas vacuas. Parser léxico o de AST, anclas obligatorias y pruebas adversariales. **Las 39 anclas actuales son reales, no vacías**: el defecto es que el checker no lo exige | M0 |
| N07 | Alta | `tools/src/client/index.ts:289–291` no interpreta el indicador de error; `tools/src/port/index.ts:302–314` convierte el resultado en éxito. Sonda: un error de herramienta devuelve `ok: true` | Un error de herramienta cuenta como éxito. Separar éxito de transporte, ejecución terminada y resultado fallido | M8 |
| N08 | Alta | `kernel/contracts/src/schemas/control-plane-event/index.ts:133–137` admite payload arbitrario. Sonda: un JWT en prosa y un secreto sintético como **nombre de clave** no se detectan; un prompt bajo `stdout` se acepta | No está demostrada la garantía de no registrar secretos ni prompts. Schemas de payload por tipo, allowlists de egress sobre claves y valores, canal privado de artefactos. Una expresión regular sola no basta | M1/M8 |
| N09 | Alta | `daemon/test/launchd/drills/index.test.ts:456–474, 555–581` modifica rutas vivas y `docs/ROADMAP.md`, y restaura en un `finally` | Un crash o un cambio concurrente puede dañar trabajo ajeno. Aislar todos los drills mutantes en un árbol sintético. **Por esto no se corrió la suite completa** | M0 |
| N10 | Media-alta | `gateway/src/database-identity/index.ts:22–27` deriva la identidad del path; el heartbeat del stream es un comentario y el cliente degrada tras el silencio | Un restore en el mismo path conserva la identidad; silencio y desconexión se confunden. Identidad de instancia y de restore, y un frame de vivacidad que no avanza el cursor | M4/M10 |
| N11 | Media-alta | `telemetry/src/http/index.ts:92–99` acepta cualquier respuesta 2xx sin leer el cuerpo; el exporter no está conectado a un dispatcher productivo | Rechazos parciales invisibles; observabilidad ausente no equivale a independencia funcional. Cola acotada, estado, descartes, éxito parcial y prueba de no interferencia | M10 |
| N12 | Media-alta | Sonda del productor `scripts/evals/registry-cut.mjs`: acepta lista de modelos vacía, fechas inválidas, transporte mal escrito y tokens fraccionarios | El registro de evaluaciones no valida procedencia ni consumo. Artefacto versionado con identidad, dataset, juez, muestra, uso y timestamps válidos. **No implica que el productor haya gastado cuota**: no ejecuta modelos | M11 |
| N13 | Media | `ledger/src/ledger/index.ts:2585–2601` escribe eventos de cuenta sin cadena de hashes; la verificación de integridad no cubre el stream de cuentas | La integridad de tareas no cubre decisiones de cuenta. Sidecar append-only con baseline explícito ([datos §9](../architecture/database/index.md)) | M4/M5 |
| N14 | Media | `durability/src/contracts/index.ts:27` exporta un tipo derivado del SDK; el runtime abre el ledger concreto; los registries de proveedores y drivers están cerrados y una factory tiene motor por defecto | Sustituir exige tocar capas ajenas y puede clasificar mal un adapter nuevo. Contratos propios, manifiesto validado y composición exhaustiva fail-closed | M7/M12/M13 |
| N15 | Media | `runtime/src/pressure/index.ts:65–66` genera `pressure.<operationIndex>.<trailIndex>` sin generación; productores `daemon/src/index.ts:916, 1251`. [ADR 0046](../../architecture/0046-the-switch-lands-on-the-account-it-chose.md) difirió expresamente esta colisión; `runtime/src/usage/index.ts:90–95` ya incluye generación | Presión en origen y destino para la misma operación/trail comparte clave con payload de cuenta distinto y falla por idempotencia. Defecto latente en el baseline, no fallo productivo observado. Forma y compatibilidad histórica decididas en [ejecución §4.1](../architecture/database/execution/index.md). P-20 lo cierra; P-19 no activa presión con handoffs antes. Negativo: tres segmentos y replay producen tres hechos distinguibles, sin conflicto ni duplicados | M5 / P-20 |

Prefijos: `runtime`, `accounts` y `observation` están en `packages/domains/`;
`providers`, `tools`, `telemetry` y `durability` en `packages/edges/`; `daemon`,
`gateway` y `console` en `packages/entrypoints/`; `ledger` en
`packages/persistence/`.

---

## 3. Hallazgos estructurales y de DRY

Detectados en la revisión cruzada de arquitectura. Ninguno es un fallo de
ejecución; todos son costo de cambio y riesgo de divergencia.

| ID | Hecho | Impacto y corrección | Entrega |
| --- | --- | --- | --- |
| S01 | `daemon/src/index.ts` tiene 1.981 líneas: es barrel público y composition root a la vez, con `startDaemon` en `:510` | El archivo que un contribuidor abre primero es el que esconde el cableado. Extraer a `composition/` sin renombrar símbolos | M13, incremental |
| S02 | El mismo walk se compone dos veces, en `daemon/src/index.ts:857` y `:1219` | Dos caminos que pueden divergir en silencio. Una sola construcción con dependencias explícitas, y un fixture de equivalencia entre walk único, agendado y de un ítem | M13 |
| S03 | Aperturas de SQLite e imports concretos desde runtime y observation, inventariados en [estructura §3](../architecture/structure/index.md) | Los dominios contienen adapters. E3/E9/E20 separan política, puerto e I/O, con inventario de todos los callers; no basta corregir sólo actions | M13 |
| S04 | `ledger/src/roadmap-version/index.ts:98` decide política de planificación; `gateway/src/roadmap-write/index.ts:134` orquesta | Un concepto con tres dueños. La política a `planning`, el OCC y la atomicidad a persistencia, el recurso HTTP sólo invoca | M13 |
| S05 | **Duplicación con divergencia**: `gateway/src/mappers/index.ts:111` usa orden de inserción y no acota; `cli/src/observation/index.ts:67` ordena y acota a 64; `protocol/src/schemas/index.ts:400` acepta como máximo 64 | Dos puertas responden distinto. Una sola proyección propiedad de `observation`, con fixtures de claves desordenadas y por encima del tope, y oráculo escrito a mano | M13 |
| S06 | El mismo patrón en los DTO de tarea y worker, la cola de eventos, el resumen de portafolio y el hash de identidad de base | Igual que S05, cuatro veces más | M13 |
| S07 | `gateway/src/constants/index.ts` repite topología de despliegue ya declarada en `runtime/src/constants/index.ts` | Dos declaraciones de la misma regla. Compartir la regla de loopback y el inventario de puertos; los pins del motor al edge | M13 |
| S08 | El barrel de `runtime` exporta el repositorio de escenarios, el supervisor SQLite y las constantes del motor | Andamiaje y vocabulario de vendor como API pública. Subpath propio para escenarios; el resto al edge | M13 |
| S09 | `observation/src/index.ts:105` sigue exportando el traductor a Langfuse | Código muerto sobreviviendo a una decisión. Retirada con inventario de callers, no a ciegas | M13 |
| S10 | El PRNG de test está byte a byte en `ledger/test/canonical-json/helpers/index.ts:18` y `protocol/test/routes/helpers/index.ts:23`, y el gate de duplicación filtra sólo `src` | Un arreglo hay que aplicarlo dos veces. Compartir la mecánica en `kernel/testkit`, nunca el oráculo de dominio | M13 |
| S11 | Trece constantes del motor durable viven en `runtime/src/constants/index.ts` y las consumen sólo el edge y el daemon | Vocabulario de vendor en el dominio. Al edge; sólo la topología neutral al kernel | M13 |

---

## 4. Hallazgos de datos

| ID | Hecho y evidencia | Impacto y corrección | Entrega |
| --- | --- | --- | --- |
| DB01 | `ledger/src/migrations/index.ts:287`: `account_events_by_account` es un índice **no único** sobre `(account_id, version)` | Dos eventos con la misma versión son insertables. Preflight de duplicados, luego unicidad, luego CAS por versión esperada | M4/M5 |
| DB02 | `ledger/src/ledger/index.ts:2538–2609`: el append de acción de cuenta comprueba identificador de evento y clave de idempotencia, pero **no** una versión esperada | Idem DB01: el camino de escritura no puede detectar la carrera que la unicidad prohibiría | M4/M5 |
| DB03 | `ledger/src/ledger/index.ts:457–458`: `journal_mode = WAL` con `synchronous = NORMAL` | Los drills de SIGKILL prueban muerte de proceso, **no** pérdida de energía. Declarar la garantía por perfil y probar la matriz de crash correspondiente; no afirmar durabilidad universal | M4/M14 |
| DB04 | Las migraciones 1–6 están verificadas por checksum | No se reescriben para normalizar nombres. Toda corrección es aditiva, con preflight y baseline histórico explícito | permanente |
| DB05 | La clave `(task_id, attempt)` de la ruta de ejecución no puede representar varios handoffs dentro de un intento | El segundo y el tercer segmento se pierden. Segmentos de ruta con linaje ([datos §7](../architecture/database/index.md)) | M4/M5 |
| DB06 | Una clave por digest de prompt confunde identidad de bytes con ocurrencia | Los mismos bytes enviados dos veces se cuentan una. Separar blob de ocurrencia | M1 |
| DB07 | `projection_meta` tiene una fila por proyección y no puede describir una proyección alimentada por dos streams | Sin watermarks vectoriales no hay lectura consistente entre streams | M4 |
| DB08 | Un identificador de restore basado en un contador colisiona al restaurar dos veces el mismo backup | Un cliente puede no distinguir dos restores. `restore_id` aleatorio escrito **antes** de admitir trabajo | M4 |

---

## 5. Los diez bloqueantes históricos, corregidos al HEAD actual

| Anterior | Dictamen actual | Qué no repetir y qué conservar |
| --- | --- | --- |
| B1 instrucciones | PARCIAL | Ya existen campos y entrega por entrada estándar para un proveedor. No reimplementar eso; cerrar API, local, handshakes, respuesta y linaje |
| B2 pasos ficticios | ABIERTO, con subconjuntos reparados | El checkpoint ahora persiste. Falta que verificación, auditoría y commit tengan efecto real |
| B3 cuentas | PARCIAL | **No** afirmar que hay un solo binding ni que el drenaje se ignora en toda la CLI: se reparó. Continuidad y pool siguen faltando |
| B4 receipts | DEUDA HISTÓRICA | El espejo se reparó y los últimos nueve recibos están vinculados. Siete recibos históricos siguen ausentes: no inventarlos ni afirmar que se recuperaron |
| B5 CI | PARCIAL | Linux ejecuta un subconjunto de proyectos y excluye dos. Esta ronda no consultó una corrida hosted: la cobertura Linux completa **no** está certificada |
| B6 identidad del ledger en el stream | ABIERTO | El path no identifica una instancia restaurada |
| B7 motor durable y recuperación | PARCIAL | La recuperación de identidad del servidor y las factories de ciclo de vida ya existen. Ejecución polimórfica, cancelación y daemon residente siguen pendientes |
| B8 duplicación de efectos | ABIERTO | Un conflicto de sumisión no elimina la ventana de efecto externo ni la exposición de uso |
| B9 registro de proveedores | ABIERTO | Totalizar un `Record` es higiene, no neutralidad de proveedor |
| B10 mantenibilidad | PARCIAL | El README mejoró. El fence está en 22.984 líneas y el barrel del daemon en 1.981. Anatomía incremental, no otro bloqueo documental |

---

## 6. Las catorce mejoras, con su estado

| # | Estado | Trabajo residual y dueño |
| --- | --- | --- |
| 1 cadena de cuentas | Abierta | Migración con baseline, integridad y replay; M4/M5. Ver DB01, DB02 |
| 2 payloads y privacidad | Abierta | Schemas cerrados, detección estructural y egress; M1/M8 |
| 3 schemas MCP | Abierta | Descubrimiento versionado, schema aprobado, validación, invalidación y paginación; M8 |
| 4 telemetría y proyecciones | **Reparación acotada válida** | Emisores, ruta y tokens corregidos; no equivale a exporter productivo; M10 |
| 5 paridad | Parcial | Códigos de salida y rutas mejoran; la pata de UI compara dos llamadas al mismo helper. Test independiente después; contratos M2/M14 |
| 6 stream | Parcial | Replay reforzado; faltan vivacidad, cabeza acotada y epoch; M4/M10 |
| 7 registry | **Reparación acotada válida** | Ranking medido determinista. No confundir la maquinaria con calidad ganada ni con un pool; M5/M11 |
| 8 constantes | Abierta | Dueño semántico; constantes de proveedor en los edges; la igualdad textual no sustituye al dueño; M13. Ver S07, S11 |
| 9 identidad de invocación | **Descripción inexacta** | Conserva tarea e intento y rechaza conflictos de digest en el ledger; **no** incorpora el digest al identificador. N01 y N04 siguen abiertos; M1/M4 |
| 10 tipos de SDK | Abierta | El contexto del motor no debe cruzar un puerto propio; M7/M13 |
| 11 anatomía | Abierta | Entregar funcionalidad por contexto; ni paquetes vacíos ni una mudanza masiva previa; M13 incremental |
| 12 anclas de seguridad | Abierta | La comprobación de subcadena sobre texto no es prueba conductual; M0. Ver N06 |
| 13 tests mutantes | Abierta | Toda escritura al checkout vivo debe aislarse; M0. Ver N09 |
| 14 flujo completo | Abierta | Conectar cada fase y cada recibo a trabajo ejecutado; M2/M3/M4 |

---

## 7. Los cinco puntos del auditor previo, y los límites del cierre

- **F1:** los seis punteros originales fueron corregidos. Los 39 actuales resuelven
  incluso quitando comentarios con un escáner de TypeScript. Lo que persiste es la
  vacuidad **de la lógica del checker**: acepta un ancla vacía y un ancla dentro de
  un bloque de comentario. El vacío ya existía en la ronda anterior y aquel barrido
  no lo detectó.
- **F2:** aparece un conteo de cierres y una deuda en un checkpoint, pero no es un
  debrief completado. El registro tiene cinco disclosures; no llamarlos una sola
  deuda total.
- **F3:** el espejo y el log están presentes, con hash exacto. **Siete recibos
  históricos ausentes no fueron recuperados** por ese cambio. La igualdad de hash de
  los últimos nueve diffs no certifica una fecha inmutable de autorización.
- **F4:** el destino del cableado cambió de etiqueta en el registro y en el fence.
  **Falta conectar el exporter**: mover la etiqueta no ejecuta el trabajo.
- **F5:** persisten una clave duplicada en un registro de literales vencidos y un
  comentario obsoleto. Son correcciones pequeñas y no justifican otra cadena serial
  de reauditorías.

---

## 8. Riesgos del diseño propuesto anteriormente

1. Los journals externos **no** son descartables sólo porque el ledger sea la
   autoridad de negocio. Retirar su estado sin exportar timers, señales y efectos
   pendientes puede perder continuidad.
2. Una factory obligatoria sin argumentos favorece globals ocultos. Inyección
   explícita en el composition root.
3. «Un archivo por caso de uso» y «cero duplicación textual» llevados al extremo
   producen archivos gigantes o abstracciones prematuras. Se comparte semántica con
   un dueño, no todo texto parecido.
4. Un vault sin borrado y un egress que «nunca sale nada» contradicen el
   almacenamiento acotado y el uso de modelos externos. Separar contenido privado,
   recibos y retención.
5. Planificación y economía son necesarias, pero no deben retrasar demostrar que
   una instrucción útil llega a un proveedor y su resultado vuelve.
6. Completar el viejo programa de leyes no equivale a completar los 99 casos de
   producto, ni a entregar todos los packs posibles.

---

## 9. Alcance funcional que todavía no está ensamblado

No son defectos: es trabajo no hecho. Se distingue a propósito de la sección 2.

- **Proveedores.** Un proveedor recibe el objetivo por entrada estándar. Otros dos
  rechazan por handshake requerido antes del spawn: honestidad correcta, soporte no
  entregado. La ruta de API exige un cliente inyectado por incrustación y el daemon
  distribuido no lo compone. La ruta local es rechazada por su configuración actual.
- **Resultados.** La extracción descarta el contenido del asistente y conserva
  señales y uso; el runtime guarda digest y conteo del trail, no una respuesta
  recuperable. El vault y el contexto necesitan diseño de privacidad y acceso.
- **Durabilidad.** Existen drivers reales y factories de ciclo de vida. La ejecución
  todavía tiene caminos por modo; el avance del driver externo lanza; el supervisor
  local rechaza las cuatro capacidades avanzadas; el vocabulario público no expone
  señales ni timers. Cancelar en el driver no equivale a terminar el proceso del
  proveedor.
- **Cuentas.** Hay bindings plurales, uso desde el ledger, baseline de cuota y
  drenaje. Faltan reservas concurrentes, presión productiva, pool, secuencia
  repetible y cambio con recuperación real. El aterrizaje actual es del mismo
  proveedor, al reiniciar, una vez por intento.
- **Operación.** El daemon residente con ingreso continuo, scheduler, cola, esperas
  y timers no aparecía como entrega explícita; se agrega como hito propio.
- **Producto.** Ejecución útil, dos iniciativas con grafo y equipos, economía,
  artefactos privados y cambios de configuración deben probarse desde puertas
  reales; una biblioteca aislada no basta.

---

## 10. Lo que estos hallazgos **no** dicen

- No dicen que se haya ejecutado Git sin autorización. No se observó.
- No dicen que el productor de evaluaciones haya gastado cuota. No ejecuta modelos.
- No dicen que la negociación de MCP no valide nada: la versión de protocolo sí se
  valida; lo que falta es tratar el error de herramienta como error.
- No dicen que los recibos históricos ausentes se hayan recuperado.
- No dicen que las 39 anclas actuales estén vacías: son reales. El defecto es que el
  checker aceptaría que no lo fueran.
- No dicen que la cobertura de CI en Linux sea insuficiente ni suficiente: no se
  midió en esta ronda.
