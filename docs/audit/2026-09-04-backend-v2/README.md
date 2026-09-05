# Auditoría del backend V2 y paquete de entrada para el roadmap

Snapshot auditado: HEAD `456947875c453269ab7d105fa5088e947bc3cb90` (`4569478`), branch `main`, 2026-09-04.
Solicitante: davila. Auditores: Claude Fable 5.1 orquestando doce auditores nombrados, todos read-only. Ningún archivo del repositorio fue modificado por la auditoría.

Esta carpeta es un paquete cerrado. Se escribió para el agente que arme el
próximo roadmap cuando termine el proceso V2 del backend que hoy corre Codex.
No es un packet, no autoriza trabajo, y no debe aplicarse sobre el árbol vivo
sin re-medir: el árbol ya cambió desde el snapshot.

## Qué hay acá y en qué orden leerlo

| Orden | Archivo | Qué es | Qué decidís con él |
| --- | --- | --- | --- |
| 1 | `audit-report.md` | El informe: veredicto, notas, diez bloqueantes con evidencia `file:line`, catorce mejoras, sobreingeniería, capacidades ausentes, orden corregido del plan, respuestas a las veinte preguntas del brief | Qué está roto, qué se arregla primero y por qué |
| 2 | `rubric.md` | El instrumento: doce dimensiones, setenta y un criterios, una escalera de madurez 0–4, lo afirmado contra lo medido, y su aplicación al snapshot | Cómo volver a medir sin re-derivar, y cuánta falsa seguridad hay por dimensión |
| 3 | `use-cases.md` | El sistema completo que queremos tener, en 98 casos de uso con actor, evento y estado honesto | Qué es producto y qué es plomería; qué falta de verdad |
| 4 | `data-model.md` | El modelo de datos objetivo dibujado sobre el schema real: streams, read models, arbiter stores, artifact store, invariantes | Qué tablas y eventos exige cada caso de uso, y en qué orden aterrizan |
| 5 | `architecture-decision.md` | La decisión: el macro se queda, la anatomía interna adopta la de los módulos de Rottay; contextos nuevos, árbol objetivo, mapa de casos de uso a mutations y queries, leyes ejecutables, orden y condiciones | Cómo se organiza el código para que los casos de uso tengan dueño |
| 6 | `evidence/` | Los doce reportes de la flota, uno por óptica, con comandos ejecutados y sondas | La evidencia cruda detrás de cada afirmación del informe |

Los cinco documentos principales están en castellano. Los reportes de evidencia están en inglés, como los escribieron los auditores.

## Los números que importan

- Veredicto: `ACCEPT_WITH_CHANGES`. Continuar con correcciones puntuales y el plan reordenado. No detener.
- Notas del informe: arquitectura 8, durabilidad 7, neutralidad 6, seguridad 8, testabilidad 8, observabilidad 3, mantenibilidad 5, producto 3.
- Rúbrica aplicada: 4,6 sobre 10 ponderado; índice de falsa seguridad 1,2 sobre 4. Las cuatro brechas más grandes: CI que no puede pasar, receipts sin verificador, autoridad V2 sin commitear, y ninguna instrucción llega al modelo.
- Completitud: ≈55 % del V2 tal como está escrito, ≈35 % del backend que el owner describe.
- Casos de uso: 22 existen cableados, 37 parciales, 8 planificados, 31 propuestos.
- Suite en el snapshot aislado: 133 archivos, 3.032 tests, 3.030 verdes; los 2 rojos fueron un archivo del auditor rechazado por el fence, no un defecto.
- Fence en el snapshot: 123 leyes verdes, 13 paquetes en 5 estratos; una sola violación, el mismo archivo del auditor.

## Los diez bloqueantes, en una línea cada uno

1. Ninguna instrucción llega al modelo: el request de ejecución no tiene campo de contenido y stdin se abre y nunca se escribe.
2. Cinco de once pasos del plan graban verificado, auditado, commiteado y checkpointeado sin que ningún código lo haga; la commit policy está hardcodeada.
3. Multi-cuenta inerte: un binding por daemon, cuota siempre al 100 %, switches falsos como hechos, sin señal de presión de cuota, drain invisible para la elección.
4. Dieciocho commits sin receipt de verificador; la autoridad del programa V2 vive en un archivo gitignored.
5. El CI no puede pasar en este HEAD y el README dice que corre el mismo check que un writer local.
6. La identidad del ledger en SSE es un digest del path.
7. Un SIGKILL del daemon en modo Restate deja huérfano al server; el driver nunca se construye en producción.
8. El proveedor se ejecuta dos veces en la ventana de crash con gasto sin registrar; la cuarentena no es atómica.
9. El eje de proveedor es un enum cerrado más un mapa por string sin pin.
10. Barrel del daemon de 1.216 líneas, narración de packets en 143 de 195 archivos, fence de 17K líneas tocado por 143 de 145 commits, README desactualizado.

## El orden que el informe propone, condensado

1. Ahora, un packet de correcciones puntuales: eje de proveedor, tres fixes de cuentas, paridad de exit codes, composición fuera del barrel, README, CI, receipts retroactivos y autoridad V2 commiteada.
2. Puertas de lifecycle CLI y API, ya en curso como ADR 0029.
3. Canal de instrucción y linaje de prompts. Es la precondición de todo lo demás.
4. Drill con sujeto real, con autorización del owner.
5. Reap del server Restate, marcador de intención, `appendBatch`, identidad de instancia del ledger.
6. Ola de cuentas, antes de cualquier routing adaptativo.
7. Observabilidad: primero las claves de telemetría, después el puerto y el edge OTLP.
8. Contratos de producto: iniciativas y tareas, pasos con equipo, grafo, coordinador, compuerta del owner.
9. Dieta del fence y árbol objetivo, antes de abrir un segundo writer.
10. Certificación con un hijo que ecoe la instrucción, receipt por commit, CI verde real, cero doble gasto, identidad por instancia.

La decisión de arquitectura agrega dos condiciones: la anatomía nueva se aplica primero a los paquetes nuevos y sólo después, en un mapa atómico, a los existentes; y nunca antes del canal de instrucción y de la ola de cuentas.

## Evidencia: qué mide cada reporte

| Archivo | Óptica | Lo que encontró |
| --- | --- | --- |
| `evidence/wiring.md` | Conectividad de punta a punta | El espinazo está cableado pero vacío; enforcement, observación y switch de cuentas son islas |
| `evidence/product.md` | El producto contra el modelo del owner | Sin prompt, sin plan estructurado, sin equipo por paso, sin coordinador; diseño de linaje de prompts y de telemetría |
| `evidence/accounts.md` | Multi-cuenta y cuota | Un binding, cuota constante, switch falso, sin señal de presión, drain ignorado |
| `evidence/durability.md` | Restate y recuperación | Drills reales y fuertes; server huérfano tras SIGKILL; driver sin consumidor; vocabulario Restate en el dominio |
| `evidence/ledger.md` | El ledger como verdad | Cadena e idempotencia correctas; `account_events` fuera de la cadena; doble ejecución en la ventana de crash; sin `appendBatch` |
| `evidence/neutrality.md` | Proveedores y duplicación | Transporte forzado por el compilador; proveedor por disciplina; registry versionado del que sólo cinco campos deciden |
| `evidence/structure.md` | Árbol y nombres | Rango de paquetes excelente, rango de carpetas plano; barrel del daemon como composition root; árbol objetivo |
| `evidence/security.md` | Fugas y MCP | Superficies cerradas por construcción; guardia de payload heurística; tools unidas por nombre |
| `evidence/streaming.md` | SSE y consola | Secuencia, replay y tormenta correctos; identidad por path; Degraded en ledger quieto |
| `evidence/parity.md` | CLI, API, consola | Tool-call byte-idéntico; ocho rutas con una sola puerta; pata UI tautológica |
| `evidence/tests.md` | Calidad de aserciones y compuertas | 94 % conductual; CI imposible; receipt sin caller; 18 commits sin verificador |
| `evidence/fence.md` | Proporcionalidad del fence y docs | 17K líneas, 40 % historia, 0,43 líneas por línea de código; tres drifts del README |

Tres artefactos crudos de la corrida se resumieron arriba y no se conservan acá porque no le sirven a un lector: el log completo de la suite, la salida completa del fence y un listado de 1.200 nombres de archivo de `.acp-local`. Lo único que ese listado probaba está en el bloqueante 4: los receipts de commit terminan el 28-08 y ningún artefacto referencia los últimos dieciocho commits.

## Estado del árbol vivo al cierre de este paquete

- HEAD seguía en `4569478`. Estaba staged el packet `lifecycle-operation` (ADR 0029, 23 archivos), que ataca en parte los bloqueantes 2 y 7. No fue auditado.
- Una flota de writers corría en sesiones de terminal sobre el árbol vivo (un writer Opus, dos mappers Opus adjudicando los bloqueantes B1–B10, y un Fable auditor). Esa flota sacaba de `docs/` cualquier archivo no rastreado durante sus ventanas de verificación y lo guardaba, con digest verificado, fuera del repositorio. Copia durable de esta carpeta: el archivo de documentación del owner.
- Nota histórica, sobre el estado previo al commit de esta carpeta: mientras estos paths estaban sin rastrear, el fence los rechazaba como paths fuera del write-set. Era la ley funcionando, y se resolvió con la entrada de write-set del packet de gobernanza —diecinueve literales, uno por archivo— y no editando el fence desde acá. Ver `docs/architecture/0030-the-audit-record.md`.

## Glosario mínimo para un agente nuevo

- **Ledger**: el log SQLite append-only, encadenado por hash, que es la única verdad. Todo lo demás se deriva.
- **Read model / proyección**: tabla derivada del ledger, reconstruible byte a byte.
- **Walk / beat / plan**: la ejecución durable de una tarea es un walk que recorre un plan de beats; cada beat apendea uno o más eventos, y algunos disparan un efecto.
- **Envelope**: el documento que describe una tarea: objetivo, rol, write-set, read-set, autoridad por digest, presupuesto, política de commit.
- **Write-set exacto**: la lista cerrada de paths que un packet puede tocar. Tocar otro es violación y cuarentena, nunca limpieza.
- **Lease**: exclusividad sobre un worktree. Uno por worktree, con fence monotónico.
- **Receipt**: el registro de que un verificador distinto del writer ejecutó los checks y anotó los exit codes. Sin receipt no hay commit.
- **Fence**: `scripts/check-architecture.mjs`, las leyes ejecutables del repositorio: estratos, imports, write-sets, docs, hook de publicación.
- **Packet**: la unidad de trabajo de un writer: brief, write-set, commit local, verificación, postaudit, receipt.
- **DT**: el coordinador técnico, el rol que clasifica, emite briefs y adjudica.
- **CLI_SUBSCRIPTION**: el transporte por el que un proveedor se usa a través de su CLI con una cuenta de suscripción, sin API key.
- **Checkpoint**: continuidad por digests, nunca por transcript: HEAD, autoridad, receipts, trabajo pendiente, próxima acción segura.

## Convención de esta carpeta

Los nombres dicen qué es cada archivo, sin fecha ni usuario: la fecha y el tema van en el nombre de la carpeta. Una auditoría nueva es una carpeta nueva al lado de esta, nunca una edición de esta. Ningún archivo de acá es evidencia de nada sobre un HEAD distinto de `4569478`.
