# Paralelización: olas, conflictos y writer único

Dueño de la planificación de concurrencia, no de las dependencias ni del permiso.

[Roadmap](../index.md) · [Packets](../../implementation/packets/index.md) · [Entrega y paradas](../../implementation/index.md)

Estado: **planificación**. No cambia readiness, no autoriza ejecución ni worktrees.
El inventario conserva 39 IDs; los sufijos de packets §1.8 son entregas internas,
no hitos adicionales ni porcentajes nuevos.

La asignación vigente de agentes y el protocolo de consulta viven en
[coordinación](../../kickoff.md); esta página sólo
define dependencias de integración, conflictos y paralelismo permitido.

## 1. Olas de preparación e integración

Cada ola admite preparación RO paralela; su columna de integración es **serial**.
**Las olas son una agenda de referencia, no una barrera adicional.** Una flecha
de la tabla no agrega una dependencia al inventario. En cada cierre el DT vuelve
a elegir entre los packets realmente elegibles, sin esperar una ola completa y
sin inventar readiness. La integración sigue siendo serial en `main`; este plan
no autoriza writers simultáneos, nuevas ramas, worktrees ni cambios de alcance.
La aceleración se obtiene preparando decisiones, oráculos y verificaciones
independientes antes de ocupar la ventana de escritura, no omitiéndolos.
Dependencias, condiciones de habilitación y entregas internas mandan desde
[packets §1](../../implementation/packets/index.md). Un packet arrancado no es un
predecesor aceptado. H-5 está cerrado de diseño; P-23 todavía debe implementar y
probar conformidad. Un fallo de esa conformidad bloquea sus consumidores y release,
sin reabrir M2 ni detener trabajo independiente de la composición nueva.

| Ola | Orden serial propuesto, una vez autorizado | Preparación RO útil / condición de salida |
| --- | --- | --- |
| 0 | P-01 → P-03 → P-02 → P-04 | Destinos de escritura, literales y runners; aislamiento antes de suite y puente antes de código de producto. |
| 1 | P-09/log → P-10 → P-08 → P-05 → P-11 → P-12 → P-13 | CAS, identidad, errores y mapas de imports. P-09 cierra sus comprobaciones completas, no sólo el nombre /log. |
| 2 | P-18/protocolo → P-36/local → P-14 → P-32/captura → P-33/catalogo → P-06 → P-07 | Acceso privado y bootstrap reales; fuentes/políticas antes de consumo. No se anuncia GC, portabilidad o M11 completos. |
| 3 | P-15 → P-16 → P-17/efecto → P-18/recuperación → habilitación de P-17 | Smoke sólo con perfil/cuenta/límite autorizados; matriz de crash y ownership antes de escritura operativa. |
| 4 | P-19 → P-21 → P-22 → P-23/garantías → P-34/admisión → P-20 → P-24 → P-25 | Reservas, control de hijos, continuidad y herramientas; sandbox efectivo o ausencia declarada. |
| 5 | P-26 → P-27 → P-28 → P-29 | Políticas DAG/aprobación y consulta durable; M9 ejecutable sólo tras M3/M5/M6. |
| 6 | P-30 → P-31; cierre completo de P-23 según perfil | Telemetría/stream acotados y composición del perfil; no vender conformidad individual como delegación probada. |
| 7 | P-32 completo → P-33 completo → P-34 → P-35 | Oráculos de rangos/racionales y productor de evaluación; gasto del runner/juez detrás del presupuesto. |
| 8 | P-36 completo → remanente de P-37 | Backup/restore, retención y contratos portables; cierre de anatomía sobre consumidores finales. |
| 9 | P-38 → P-39 | Instalación/perfil fijados y snapshot de certificación, sin writer mutándolo. |

Una extracción necesaria de P-37 puede preceder a su consumidor, con mapa de
paths/imports/exports/tests cerrado y sin mezclar movimiento con nueva semántica.
P-26/P-27 puros pueden adelantarse; eso no activa un scheduler ni cierra M9.
P-23/garantías entrega la primitiva compartida antes de P-34/admisión; el solver
de composición completo permanece en P-23/M7. P-34/admisión precede a equipos M9, sin esperar costo agregado ni desempeño de
M11. Desarrollo del scheduler no habilita concurrencia con gasto antes de ese corte.
No hay obligación de ocupar todos los agentes. No se cuenta dos veces un corte
temprano cuando después se cierra su packet.

### 1.1 Oportunidades en todo el programa

La tabla aplica el inventario; **no lo reemplaza**. Las dependencias completas,
incluidas las de habilitación, permanecen en [packets §1 y §1.8](../../implementation/packets/index.md).
Los IDs de la primera columna identifican el frente, no un permiso de ejecución.
Las condiciones citadas son anclas para comprobar elegibilidad, no listas
alternativas exhaustivas de dependencias. Todo adelanto conserva su prueba de
integración y sus gates de cierre; RO significa sin mutar el checkout ni sus
derivados, con evidencia y temporales propios declarados.

| Frente | Trabajo paralelo útil | Ventana de implementación y límite que no se adelanta |
| --- | --- | --- |
| P-01, P-02, P-03, P-04: base y autoridad | Inventario de destinos de test, oráculos del parser y disponibilidad de runners; no repetir bootstrap aceptado | Respetar dependencias de M0 y autoridad antes de producto. Falta de runner no se convierte en PASS ni detiene preparación independiente. |
| P-09, P-10, P-08, P-05: persistencia e identidad | Casos adversariales de CAS, restore, duplicados y preimagen con expectativas independientes | Append, migraciones y consumidores tienen dueño serial. No partir transacciones ni publicar identidades provisionales. |
| P-11, P-12, P-13: errores, proyecciones y composición | Mapas de duplicación, imports/exports y fixture de equivalencia | Sus dependencias permiten elegirlos sin esperar toda la ola 1. El refactor debe cerrar verde antes de mover sus consumidores; los ya aceptados no se reabren por esta tabla. |
| P-18/protocolo, P-36/local, P-14: acceso privado y bootstrap | Modelo de amenazas, trazado del envelope y negativos de scope/replay | No usar artefactos antes de acceso probado ni ejecución antes del bootstrap. No equivale a recuperación o portabilidad completas. |
| P-32/captura, P-33/catalogo: uso y precio previos al gasto | Oráculos de clases, epochs, intervalos y ausencia de precio | Su disponibilidad operacional, incluido pin, es precondición del gasto de P-15; no diferirla a los reportes de economía. |
| P-06, P-07: contenido y resultado | Mientras se corrige contenido, preparar mapa de salida, casos de error y replay. Con contrato aceptado, mapear en paralelo persistencia y transportes | El consumidor implementado exige su predecesor aceptado. Ledger y providers pueden prepararse en paralelo; se escriben por turnos. El cableado espera ambos, sin éxito ficticio por exit 0. |
| P-15: primera tarea útil | Preparar matriz CLI/API/local, escenarios por puerta, permisos y presupuesto del smoke antes de necesitarlo | P-06/P-07 aceptados y demás dependencias completas. Los fakes verifican contratos, no sustituyen el smoke requerido ni la prueba por puertas reales. |
| P-16, P-17/efecto: verificación y Git | Matriz de receipts inválidos, política NO_COMMIT y oráculos de SHA/base/tree | El efecto Git se prueba sólo en destino descartable autorizado. No habilitar escritura operativa antes de P-18/recuperación. |
| P-18/recuperación | Preparar las ocho fronteras, oráculos de efecto incierto y ownership mientras se implementan sus productores | Drills sobre productores reales, incluyendo P-17/efecto para Git. No deducir recuperación del protocolo puro ni reintentar lo incierto. |
| P-19, P-20: cuotas y handoff | Matrices de reservas, rollups, generaciones y múltiples segmentos, usando contratos aceptados | P-19 exige recuperación; P-20 conserva sus predecesores. Presión con handoff se habilita sólo con N15/P-20 probado; no declarar P-19 completo ignorando esa condición aplicable. |
| P-21, P-22: daemon y lifecycle | Diseñar pruebas de cola/reap y carreras señal/cancelación/timer antes de su turno | Cola y lifecycle mantienen sus dependencias reales. Concurrencia con gasto espera P-34/admisión; desarrollar el scheduler no concede permiso de operarlo. |
| P-23: garantías y composición | Oráculos del gate compartido y matriz de compatibilidad; preparar integración con presupuestos | P-23/garantías puede implementarse tras P-15 y la primitiva de contratos, sin esperar artificialmente P-22. El solver y la conformidad completos conservan sus gates de M7. |
| P-24: herramientas | Schema, paginación y negativos del protocolo tras P-11; mapa de integración con contenido/resultado | No necesita esperar P-20 por estar dibujado después. Integración productiva exige P-06/P-07/P-18/protocolo y los permisos del perfil. |
| P-25: aislamiento | Comparar mecanismo autorizado y diseñar pruebas de red/filesystem sobre el contrato del proceso | Implementación tras P-21 y elección explícita del mecanismo; ausencia de sandbox declarada no es aislamiento probado. |
| P-26, P-27: iniciativa, roadmap y DAG | Preparar políticas puras y oráculos de ciclos/revisiones mientras avanza el camino de ejecución | P-26 tras P-14; P-27 tras P-26/P-05. Adelantos ya admitidos por §1: no activan despacho, equipos ni cierran M9; no compiten con migraciones en vuelo. |
| P-28, P-29: equipos y coordinación | Matriz de aprobación/timeout/revocación y simulación sin efectos | Contratos y predicados pueden prepararse; timers, espera durable, handoff y presupuesto deben existir antes de la integración que los consume. No fabricar stubs para cerrar M9. |
| P-30, P-31: observabilidad y stream | Oráculos de collector lento/caído, redacción, gaps, epochs y backpressure | P-30 tras P-21/P-18/recuperación, sin esperar todos los equipos M9; P-31 tras P-10/P-12/P-30. Mantener la integración con productores reales y límites de cola. |
| P-32 completo, P-33 costos, P-34, P-35: economía y evaluación | Escenarios de liquidación, racionales, incertidumbre, admisión y juez independiente | P-32 tras P-19/P-07; costos P-33 tras P-32/P-16 sin afirmar cierre M11. P-34/admisión no espera el cierre económico completo; sus predecesores sí. P-35 conserva presupuesto y cierre de P-29/P-31 aplicables. |
| P-36 completo: portabilidad | Matriz de backup/restore/retención y conformidad del backend seleccionado | No exige esperar todas las evaluaciones por el número de ola; cierre M12 mantiene P-10/P-18/recuperación/P-23. No agregar segundo backend sólo para ocupar un agente. |
| P-37: arquitectura | Mapas de extracción y detección de duplicación sobre versiones aceptadas | Extracción incremental necesaria antes de su consumidor, sin mezclar renombrado y nueva semántica. No generar deuda nueva para trasladarla aquí; cierre completo conserva P-29/P-36. |
| P-38, P-39: distribución y certificación | Preparar instrucciones de instalación, matriz de plataformas, perfil y requisitos de evidencia | P-38 espera P-04/P-37 y superficie estable. P-39 certifica todos los requisitos seleccionados en snapshot congelado; no sustituir la corrida final por reportes parciales. |

No se abre un nuevo corte interno sólo por aparecer una oportunidad: si necesita
otra frontera de entrega o dependencia, el DT la adjudica conforme al protocolo
vigente antes de implementar. No cortar un fold, migración, contrato/consumidor o
invariante para producir dos paquetes artificialmente independientes.

### 1.2 Elegir el siguiente trabajo sin dejar pendientes de calidad

1. Clasificar: **preparación RO**, **implementación elegible** o **cierre/habilitación**.
   Un borrador preparado no es `DESIGN_READY`, un predecesor en vuelo no es ACCEPT
   y una feature deshabilitada no es una feature certificada.
2. Elegir primero el bloqueo del camino hacia la próxima demostración real; luego
   el paquete elegible que desbloquea más consumidores. Completar antes de iniciar
   nuevas extracciones o inventarios que no lo desbloquean.
3. Mantener como máximo un paquete de código abierto y, normalmente, uno siguiente
   en preparación más un alternativo independiente si hay espera externa. Es un
   límite de trabajo en vuelo, no nuevos roles ni una flota obligatoria.
4. No cerrar con defectos, tests pendientes o una excepción arquitectónica nueva
   para ganar velocidad. Una obligación del paquete no se mueve al siguiente
   por conveniencia. Los cortes previamente definidos por §1.8 conservan su
   aceptación propia: completarlos no cancela las obligaciones del paquete dueño.
5. Un fallo bloquea el cierre y los consumidores afectados. Preparación o trabajo
   independiente autorizado puede continuar cuando no exista conflicto §2; nunca
   se usa ese avance para disimular el defecto ni sumar un cierre inexistente.
6. Pedir temprano permisos de runner, cuenta o smoke. Una respuesta pendiente no
   autoriza gasto; llenar esa espera con trabajo independiente, no con reiteradas
   consultas ni una simulación presentada como evidencia real.

### 1.3 Solapamiento seguro del ciclo de entrega

| Momento | En el checkout canónico | Qué se puede solapar |
| --- | --- | --- |
| Implementación | Un writer, write-set exacto, tests espejo junto al cambio | Preparación de oráculos y del siguiente brief sobre referencias inmutables; si cambia un contrato leído, revalidar antes de usar el resultado. |
| SOURCE_READY y verificación | Fuente, tests, autoridad e índice congelados; temporales de prueba declarados | Revisión de comportamiento, arquitectura/datos y seguridad repartida sobre el mismo snapshot. Una batería pesada propia por vez; no builds/typecheck paralelos que escriban dist/caches. |
| Corrección | Termina la corrida que dependía del snapshot anterior; vuelve el writer con scope acotado | Conservar hallazgos vigentes, no producir un receipt para bytes previos. Revisión enfocada del delta más regresiones y gates exigidos. |
| Commit y poscommit | DT comprueba identidad completa, receipt y pruebas; integra localmente y comprueba el resultado | Preparación RO del siguiente paso. No mezclar documentación ajena ni otra entrega con el índice auditado. |
| Próximo paquete | Revalidar base, dependencias, R/W/O/E y autoridad contra el nuevo HEAD | Consumir el mapa ya preparado sin repetir la auditoría general del proyecto. |

Una lectura del árbol que otro cambia sólo sirve como exploración, no como
auditoría final. Las copias descartables de verificación ya autorizadas no son
worktrees de implementación; deben tener origen y outputs aislados y no crean
permiso para otro writer ni para reanudar cambios que invaliden el receipt.

### 1.4 Despacho concreto por instancia del trabajo restante

El DT aplica esta agenda al **estado verificado**, no a una fecha. Abrir varios
agentes significa repartir objetivos distintos; no pedirles el mismo análisis.
Normalmente bastan el writer y uno o dos apoyos, rotando de función al congelar
la entrega. El auditor independiente nunca hereda como verdad el oráculo del
writer. Si no hay una salida útil o recursos disponibles, no se abre el agente.

| Instancia | Qué despachar en paralelo | Qué debe estar terminado para pasar a la siguiente |
| --- | --- | --- |
| Corrección/aceptación de P-06 | Un writer cierra los defectos de contenido, privacidad y estructura. Un mapeador prepara P-07 contra contratos aceptados, sin cambiar el alcance de P-06. Al congelar, un verificador revisa el cambio y ejecuta su batería; el mapeador sólo trabaja RO | Hallazgos materiales resueltos y aceptación exigida satisfecha, no sólo una adjudicación que los renombre. No implementar el consumidor pendiente para eludir este cierre. |
| P-07, contrato de resultado | Un writer fija contrato/tipos/tests. Un apoyo prepara replay/conflicto y migración; otro prepara las traducciones de terminal de proveedor y negativos. Preauditar las decisiones semánticas antes de usarlas | Contrato aceptado; revalidar ambos mapas contra ese contrato. No inventar dos contratos por separar ledger y transportes. |
| P-07, ledger y providers | Dos mapas y oráculos RO pueden avanzar independientemente; el único writer implementa por turnos los cortes adjudicados. Mientras uno se verifica, preparar el otro sin compilarlo ni mutar el checkout | Cada corte con sus tests y revisión. El corte runtime espera las dos superficies aceptadas. Si falta evidencia de un proveedor, no fabricar SUCCEEDED; tampoco cerrar como soportado el perfil que la exige. |
| P-07 runtime y preparación P-15 | Writer integra resultado; apoyo diseña expectativas distintas para cada puerta CLI/API/local y prepara el smoke autorizado. Auditor revisa límites privados y éxito de operación frente a transporte/proceso | P-07 aceptado con garantías completas de su scope. Permisos y pin/uso antes de ejecutar el smoke de P-15. |
| P-15, primer caso útil | Writer cablea. Apoyo 1 prepara casos de entrada/salida y fallos con oráculos externos; apoyo 2 prepara mapa de receipts y efecto Git para P-16/P-17 sobre especificación, sin ejecutarlos | Caso real de puerta a resultado y consumo trazable en el perfil. No sustituirlo por una llamada directa al puerto desde un test. |
| P-16/P-17 y recuperación P-18 | Writer implementa en orden. Un apoyo mantiene matriz de ocho fronteras; otro analiza revocación, descendientes y efectos inciertos. Verificar snapshots congelados; una corrida pesada | Receipts válidos, efecto Git probado en destino permitido y matriz de recuperación verde antes de habilitar el efecto operativo. |
| P-19 y preparación del daemon/handoff | Writer implementa reservas/cuotas. Apoyos separan mapa de cola/reap P-21 y continuidad P-20, leyendo contratos comunes aceptados | No activar presión con handoffs sin N15/P-20. Resolver por separado dependencias de desarrollo y habilitación, sin convertir esa condición en un ciclo artificial ni fingir un cierre completo. |
| P-21/P-22/P-23 garantías/P-34 admisión | Elegir el próximo corte elegible que desbloquee presupuesto y lifecycle. Un apoyo prepara conformidad del gate compartido y otro el siguiente consumidor (P-20 o telemetría); un solo escritor | Concurrencia con gasto sólo tras enforcement probado. No crear otro gate de garantías dentro del presupuesto o del solver. |
| Continuidad, herramientas y planificación | Tras las dependencias reales, elegir por bloqueo del perfil entre P-20, P-24/P-25 y P-26/P-27. Un apoyo prepara el frente siguiente; no abrir tres implementaciones. Si el camino principal espera permiso externo, usar un frente independiente ya elegible | Pruebas y arquitectura completas de cada entrega. No consumir una interfaz provisional de otro frente ni partir la migración compartida. |
| Observabilidad y economía | Con P-21/recuperación aceptados, preparar P-30/P-31 sin esperar todos los equipos. Con P-19/P-07 aceptados, preparar P-32 y luego costos P-33; un apoyo de cada área sólo si sus entradas son estables | Telemetría usa eventos reales y nunca decide facturación; liquidación usa fuentes canónicas. Cierre económico completo y evaluaciones conservan todas las dependencias de §1.1. |
| Equipos y coordinador P-28/P-29 | Writer integra sobre planificación/receipts/lifecycle/presupuesto aceptados. Apoyo prepara carreras de aprobación y otro revisa simulación/consulta sin efectos, sólo si sus scopes son disjuntos | Esperas, timeout, revocación, handoff y límites funcionan juntos; no cerrar equipos con timers simulados en lugar de los exigidos. |
| P-35, P-36, P-37, P-38 | Seleccionar por elegibilidad y conflicto entre evaluación, portabilidad y estructura; cada extracción necesaria precede a sus consumidores. RO de instalación y manuales puede acompañar interfaces estables | No cambiar APIs durante una certificación dependiente; ninguna extracción obliga a posponer sus propios tests o documentación. Segundo backend sólo en perfil seleccionado. |
| P-39 | Fuente e inputs de prueba congelados. Repartir lecturas de arquitectura/datos, seguridad y documentación sobre un mismo snapshot; ejecutar los grupos pesados secuencialmente con un único responsable de corrida | Conjunción de calidad completa. Un FAIL exige corrección y revalidación de lo afectado, no votación entre auditores. UI y cutover no quedan autorizados. |

La preparación de un frente alternativo no desplaza al camino crítico sin una
razón registrada: bloqueo externo, requisito compartido que desbloquea varios
consumidores, o eliminación comprobable de retrabajo. No se agregan nuevos
entregables para justificar más agentes, ni se promete una fecha sólo por abrirlos.

### 1.5 Decisiones delegadas

La extensión Jev + Laya de [roadmap §2.1](../index.md#21-decisiones-delegadas)
conserva el writer único y las dependencias del
[inventario](../../implementation/packets/index.md). No se adelanta a la primera
tarea útil ni convierte preparación documental en implementación aceptada.

| Instancia | Paralelo permitido | Integración / condición de salida |
| --- | --- | --- |
| Cuentas y planificación aún en desarrollo | Preparación RO del contrato y oráculos junto a P-19 o P-26/P-28, sólo con referencias fijadas y sin restar recursos al camino crítico | Un mapa de Jev y otro de Laya pueden contrastar límites, privacidad y conformidad; no llaman APIs ni descargan pesos por esta orden. |
| Contrato del decisor congelado | Un apoyo prepara normalización/negativos de Jev y otro los de Laya; revisión independiente del contrato compartido | El único writer integra el camino neutral y después cada adapter. Ninguno modifica contratos, migraciones, registry o lockfile por su cuenta. |
| Observabilidad P-30/P-31 | Preparar la proyección de eventos neutrales sobre el contrato estable | No crear dependencias inversas: telemetría y cuentas cierran su scope original sin esperar Jev/Laya. La extensión consume sus capacidades reales al cerrar. |
| Verificación y evaluación | Revisiones RO de privacidad, semántica y arquitectura sobre el mismo snapshot; diseño del siguiente caso independiente | Una batería pesada o benchmark local pesado por vez. No sumar un modelo residente que compita con builds/drills; cada ejecución real tiene recursos y consumo autorizados. |
| Promoción de recomendación a automático | Preparar casos de revocación, carreras, replay, fallback y rollback mientras se verifica el corte anterior | No habilitar hasta cerrar dependencias, conformidad de ambos adapters y calidad del perfil; ninguna votación entre agentes sustituye un gate. |

Sin contrato estable, dos implementaciones en paralelo producirían supuestos
incompatibles: primero se congela la interfaz y el oráculo común. La operatoria
vigente no permite writers simultáneos aun con archivos disjuntos; la aceleración
proviene de preparación y revisión, no de ramas nuevas ni aceptación parcial.
La ampliación se registra separada del baseline de 39 IDs, como manda el roadmap.

## 2. Grafo de conflictos al congelar el scope

El brief fija R(p) (entradas/autoridad), W(p) (escrituras canónicas), O(p)
(outputs/temporales) y E(p) (bases, stores, procesos, sockets, puertos, cuentas).
Definir Q(p) = W(p) ∪ O(p). Existe arista p — q si:

```text
Q(p) ∩ (R(q) ∪ Q(q)) ≠ ∅
o Q(q) ∩ R(p) ≠ ∅
o hay uso incompatible/no aislado de un mismo recurso E.
```

Las intersecciones son **por solapamiento de scope**, no sólo igualdad de strings:
misma ruta resuelta, o un directorio declarado que contiene la ruta del otro.
Se usa límite de componente (/a/b no contiene /a/bc), reglas del filesystem y
destinos de symlink; un prefijo no concede permiso de escribir rutas no listadas.
Incluir exports, project references, entradas de generadores y outputs indirectos.
La fórmula cubre W–W, W–R, O–W, O–O y O–R en ambas direcciones.

Cada fila siguiente es una hiperarista: los escritores y lectores de esa versión
comparten el recurso, aunque sus archivos de implementación sean distintos.
Son anclas para resolver paths al abrir el packet, **no write-sets autorizados**.

| Recurso compartido | Packets especialmente afectados | Regla de integración |
| --- | --- | --- |
| Autoridad, fence, fixtures, digests | P-01/02/03/04/37/38; lectores: todos | Checker/AGENTS/ROADMAP/ADR y manifest literal se cambian con dueño único; fixture no repinea la autoridad viva. |
| Contratos, schemas, barrels, declaraciones públicas | P-05/06/07/11/14/16/18/19/22/23/24/28/31/32/34/36/37 | Versionar primero el contrato; consumidores/negativos exhaustivos en el mismo scope. Ningún default para ocultar un caso nuevo. |
| Migraciones, append, heads, folds | P-05/08/09/10/14/16/17/18/19/20/21/22/23/26/27/28/29/32/33/35/36/37 | El registro de migraciones y la próxima versión se asignan serialmente; un único fold vivo/rebuild. No editar checksums aplicados. |
| Artefactos, pins, credenciales y coordinación | P-06/07/16/17/18/19/20/21/22/25/35/36 | No compartir base, blob tree, PID ni token entre drills. Ledger y arbiters separados no ganan transacción común. |
| Runtime y composición del daemon | P-05/06/07/13/14/15/16/17/18/19/20/21/22/23/24/25/29/34/36/37/38 | P-13 precede al gran cableado; después de extracción se vuelve a resolver el read-set, no se aplican offsets viejos. |
| CLI/API, consultas, stream, telemetry | P-06/07/10/12/14/15/22/26/28/29/30/31/37 | Proyecciones públicas y cursor/hello con dueño; privacidad de resultados no se prueba contra la misma función en ambas puertas. |
| Registry, asignaciones, cuotas, uso/precios | P-14/19/20/23/26/27/28/29/32/33/34/35 | Un solo registry; fuentes/cortes versionados, no lecturas de “lo último” ni telemetría usada para facturar. |
| Git, receipts y snapshot de evidencia | P-16/17/18/28/35/39 | Cambio de base/tree/read-set material invalida el receipt correspondiente. La certificación no observa main en movimiento. |
| Manifests, lockfile, tsconfig, exports, pins y CI | P-04/13/23/25/35/36/37/38 y toda extracción entre paquetes | Lock de integración global; no installs paralelos ni renombrados que dejan roto un consumidor. |
| Outputs de compilación/tests y recursos de proceso | Todo comando que genere archivos o use E | Declarar dist, .d.ts, tsbuildinfo, caches, coverage, logs, sqlite/WAL, artefactos, puertos y sockets. “Sólo comprobar tipos” no demuestra cero escrituras. |

Ejemplos: P-08—P-09—P-10 compiten por migraciones; P-13—P-15—P-21 por
composición; P-17—P-18—P-22 por ownership/Git; P-32—P-33—P-34 por fuentes/cortes;
P-37 invalida el read-set de cualquier consumidor que mueva. El grafo ordena
cambios y revela invalidaciones; **main sigue teniendo un writer incluso si no
hay arista**. RO sobre snapshot inmutable puede correr en paralelo, pero sólo
afirma resultados sobre sus digests; una lectura de un recurso E vivo no es
automáticamente independiente.

## 3. Capacidad del agente y responsabilidad de integración

Integrador es una responsabilidad de coherencia y ownership, **no una obligación
de usar el modelo de mayor capacidad para cada edición**. El coordinador clasifica
el trabajo y elige capacidad proporcional, con las leyes vigentes como límite.

| Trabajo | Reparto |
| --- | --- |
| Fixtures, mapping cerrado, P-11/P-12, paginación, imports según mapa aprobado | Preparación mecánica; no inventa campos, algoritmos, errores, paths ni oráculos. |
| Identidad, DDL/CAS, autoridad, credenciales, fencing, recuperación, VCS o composición compartida | Responsable de integración decide la frontera y revisa el diseño; lo repetitivo puede descomponerse bajo un brief cerrado. |
| Verificación | Worker independiente de quienes redactaron/aplicaron el cambio, incluso si un modelo mecánico propuso el patch. |
| Auditoría | Lectura y dictamen; no edita fixtures para obtener verde ni se convierte en writer. |

**La asignación vigente del writer canónico se respeta.** Un futuro relevo a otro
worker/modelo necesita autorización explícita del owner o delegación que alcance
ese cambio, compatible con la autoridad vigente; este documento no la modifica.
Protocolo del relevo, nunca dos writers:

1. Detener nuevas escrituras del saliente; checkpoint, diff y outputs inventariados,
   sin procesos mutantes pendientes ni ownership incierto.
2. Fijar snapshot de HEAD más cambios tracked/untracked, read/write-set, digests,
   checks/receipt del estado transferido y siguiente acción segura.
3. Liberar y acusar el lease/ownership anterior; conceder explícitamente el único
   lease al entrante. Si falta quiescencia/acuse, no hay relevo.
4. El entrante revalida prestate, autorización y scope antes de escribir. Un
   handoff no amplía el write-set ni hace válido un receipt para otro tree.
5. Mantener verificador distinto. El receipt de transferencia no autoriza commit
   por sí mismo; se conserva el protocolo de [entrega §3](../../implementation/index.md).

Hasta ese acto, los demás agentes sólo investigan/proponen en lectura. No se
crean worktrees, ramas ni permisos alternativos para “aprovechar” paralelismo.

## 4. Brief, evidencia y salida del ciclo

Usar la [plantilla de packet](../../implementation/packets/index.md#6-plantilla-de-un-packet),
añadiendo R/W/O/E, hashes de predecesores, perfil, exclusiones y qué permanece
deshabilitado. Ninguna lista de paths final se inventa antes del prestate.
Comandos/positivos/negativos se fijan desde el runner real; verificación en copia
descartable autorizada, no en checkout vivo. Registrar destinos de escritura,
exit codes, conteos, semillas y outputs; una corrida truncada o ambiental no es PASS.

Stops, receipt y límites de revisión siguen [entrega §2–4](../../implementation/index.md).
Tras REJECT, adjudicar una corrección concreta y comprobar su efecto, sin repetir
la auditoría completa de 39 packets por cada edición. Un defecto de composición
detiene su consumidor, no fabrica readiness ni vuelve a cero lo ya acreditado.

Rollback no es reset/clean: patch inverso acotado para código, corrección aditiva o
restore íntegro autorizado para datos, reconciliación/compensación para efectos.
Nunca reescribir eventos, reanclar hashes, revivir fence viejo ni reintentar un
OUTCOME_UNKNOWN. El handoff final informa gates cerradas, evidencia, capacidad
aún apagada y una siguiente acción segura; nada autoriza publicación o P9.

## 5. Aceptación sin concesiones por paralelización

La autoridad de arquitectura sigue en [arquitectura](../../architecture/index.md),
la de pruebas en [tests](../../quality/testing/index.md) y el cierre del perfil en
[calidad §7](../../quality/index.md). Este plan no crea una rúbrica alternativa.
Antes del receipt, el verificador comprueba para el alcance del paquete:

- Requisitos de aceptación satisfechos y positivos/negativos ejecutados con
  oráculo independiente; ninguna evidencia requerida en `UNKNOWN` o pendiente.
- Folder/index, tipos separados por concepto, tests espejo, dependencias entre
  estratos y autoridad única de contratos/vocabularios; nada de interfaces o
  utilidades clonadas para que dos agentes puedan trabajar sin coordinarse.
- Cuando cambia persistencia: diccionario y naming consistentes, claves,
  constraints, atomicidad, replay/rebuild y migraciones/rewinds probados según el
  contrato; no sólo DDL que compila ni migraciones numeradas en paralelo.
- Integración de consumidores pertinentes, incluidos barrels y puertas públicas;
  mocks sirven para contrato, no para sustituir conformidad o E2E exigidos.
- Privacidad, refusals fail-closed, límites y limpieza de procesos/temporales
  propios. Un proceso ajeno bajo presión no se mata para conseguir una corrida.
- Exactitud de documentación y soporte anunciado. Un subcorte aceptado no declara
  el packet entero completo, ni habilita efectos pendientes de recuperación.

Los comandos se resuelven desde el runner vigente. Los gates existentes,
incluida `pnpm check` cuando el cierre la exige, se ejecutan: no se suprimen
tests, no se rebajan umbrales ni se aceptan fallos ambientales como PASS. Los
conteos de tests no sustituyen cobertura de escenarios.

Puede reutilizarse evidencia **válida para el mismo snapshot y entorno fijado**
con su procedencia y exit code; nunca como si otro worker la hubiera ejecutado.
Un cambio invalida las comprobaciones afectadas y la aceptación del snapshot
previo. La selección de regresiones no exime los gates completos que el cierre
requiera. Un cambio documental de autoridad también se coordina fuera de una
certificación congelada; no se modifica el checker para ocultar un nuevo scope.

## 6. Medir la mejora, no prometerla

Usar el checkpoint/receipt existente, sin construir un sistema de métricas para
coordinar este desarrollo. Por entrega registrar tiempos de preparación,
implementación, verificación, espera externa y corrección; cantidad de rondas,
fallos de integración y si hubo presión de memoria o procesos propios huérfanos.
No confundir las reservas de agentes del producto con esta coordinación manual.

Después de tres entregas comparables, revisar si la preparación adelantada
redujo espera/rework sin degradar tests, arquitectura ni estabilidad del host.
Si produjo especulación obsoleta o más coordinación, reducirla. No estimar un
porcentaje de ahorro antes de medir ni ocupar todos los agentes por obligación.
