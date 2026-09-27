# Roadmap: secuencia, gates y readiness

Dueño único del concepto **orden**: qué se entrega, en qué secuencia, qué
dependencia lo bloquea, qué evidencia lo cierra y qué gate lo deja pasar.

[Índice](../README.md) · [Requisitos](../requirements/index.md) · [Calidad](../quality/index.md) · [Packets](../implementation/packets/index.md) · [Migración](../implementation/migration/index.md) · [Hallazgos](../findings/index.md)

Estado: **planificación**. Ningún hito de esta página autoriza trabajo. La
autorización se emite packet por packet ([implementación](../implementation/index.md)).

---

## 1. Tres denominadores separados

Nunca se suman, y ninguno se presenta como «el porcentaje del producto».

| Denominador | Qué mide | Quién lo cierra |
| --- | --- | --- |
| Programa de leyes anterior | filas de su registro de cierre y sus deudas declaradas | su propio registro |
| Backend utilizable | escenarios E2E soportados y sus pruebas reales | [calidad §7](../quality/index.md) |
| Neutralidad | familias anunciadas con dos implementaciones conformes y protocolos de cambio probados | [integraciones §2](../architecture/integrations/index.md) |

Los 99 casos se asignan **una vez** a una entrega. No se suman documentos, leyes ni
commits como funcionalidades completas. **Hoy no se publica ningún porcentaje de
producto:** esta ronda no ejecutó 99 escenarios y el alcance de los packs opcionales
se fija en el perfil de certificación.

### 1.1 Casos de uso antes que catálogo de integraciones

Mandato del owner: **funcionalidad real con arquitectura correcta y reemplazable**.
El orden favorece entregas completas de los casos existentes, no completar una
matriz de marcas. No agrega requisitos ni cambia los gates de seguridad.

Primeras demostraciones, en un entorno autorizado sin cutover:

1. Pedir trabajo por CLI/API, transportar la instrucción al modelo, recuperar su
   resultado y verificarlo; commit sólo al aceptar sus garantías (M2/M3).
2. Interrumpir y recuperar una ejecución: conservar resultados conocidos y
   reconciliar efectos inciertos sin reenvío ciego (M4).
3. Gestionar indisponibilidad de cuenta y reanudar con contexto, capacidades y
   límites comprobados, sin fingir cuota o recuperación transparente (M5).

Cada packet explica qué parte demostrable entrega o qué dependencia imprescindible
de esos casos resuelve. Foundation, contratos y tests se construyen junto con sus
consumidores; esta prioridad no permite saltarse aislamiento, autoridad, integridad
o recuperación para mostrar una demo.

Elegir el mínimo de integraciones reales que cubra el perfil aprobado. Una segunda
implementación se incorpora para una necesidad concreta o para **probar** una
sustitución anunciada, no por llenar el catálogo. No retirar soporte existente ni
excluir requisitos MANDATORY silenciosamente. Los packs NOT_SELECTED permanecen
opcionales y no bloquean el funcionamiento básico.

La dependencia concreta queda detrás de su contrato, con configuración, datos y
pruebas de conformidad por dueño. Nada de tipos del proveedor filtrados al dominio
ni duplicación de autoridad. Capacidades específicas siguen explícitas: no reducir
todo al mínimo común ni crear una interfaz universal que acepte cualquier cosa.
Extender puede requerir un adapter nuevo y evolución versionada del contrato;
**no se promete integrar cualquier tecnología sin cambios o migrar runs en vivo**.
Los niveles de soporte y sus pruebas se definen sólo en [integraciones §1–2](../architecture/integrations/index.md).

Mostrar resultados, fallos/reanudación y consumo conocido o UNKNOWN en cada
demostración. Medir tiempo humano, latencia y calidad aceptada antes de afirmar
ahorros; ni un puerto vacío ni una nueva dependencia son un entregable funcional.

---

## 2. Entregas

Cada fila es un hito, no un commit. El responsable de planificación lo divide en
packets con write-set exacto **una vez aceptado el programa**. Las listas de
archivos se fijan contra el HEAD de apertura del packet; no se inventa hoy una
lista inmóvil para semanas de cambios.

| ID | Entrega | Depende de | Qué queda utilizable | Evidencia para cerrar |
| --- | --- | --- | --- | --- |
| M0 | Baseline y pruebas confiables | — | estado conciliado y reglas de verificación proporcionales | Drills mutantes aislados en árbol sintético; parser léxico y anclas no vacías en la compuerta; recibos faltantes clasificados sin fabricarlos; documentos admitidos por la lista exacta; versión del plan duradera |
| M1 | Identidad, contenido y resultado | M0; P-09/log, P-18/protocolo y P-36/local antes del contenido | un pedido real transporta objetivo, contexto y resultado por referencias seguras | La preimagen cubre todo el contrato de envelope; cambiar objetivo, autoridad o write-set bajo la misma revisión rechaza; CLI y clientes de API y local reciben contenido; el resultado se recupera; secretos sintéticos ausentes de las superficies protegidas |
| M2 | Primera tarea útil por CLI y API | M1 + bootstrap P-14 | enviar, ejecutar y obtener resultado desde configuración de producto | Composición real de clientes; adapters admitidos según su soporte declarado; procesos de prueba con protocolo fiel; un smoke real acotado por proveedor anunciado |
| M3 | Verificar, auditar y commitear de verdad | desarrollo: M2; habilitación: P-18/recuperación | una tarea con política explícita produce receipt y commit verificables | `NO_COMMIT` omite autorización y commit sin impedir edición; un check en rojo impide el commit; el receipt fija tree, base y política, con worker distinto; el sha se consulta al VCS; ownership, cuarentena y reconciliación probados antes de habilitar escritura automatizada |
| M4 | Recuperación y ownership | protocolo temprano; recuperación tras M1/M2 y P-17/efecto para la rama Git | reiniciar sin duplicar efectos conocidos y sin doble writer | Intención, handle e idempotencia; fallos antes y después de despacho, resultado y registro; lo desconocido bloquea el reintento ciego; append atómico y outbox; cuarentena y lease consistentes; restaurar el ledger cambia la identidad que ve el cliente |
| M5 | Cuentas y continuidad | M2 + M4 | varias cuentas con selección, cuotas y cambio seguro | Se conserva lo implementado; cuotas conocidas, estimadas o desconocidas; reservas concurrentes; presión real; **más de un handoff por intento**, misma marca y entre proveedores compatibles; destino sin binding, sin capacidad, con spawn fallido o con checkpoint alterado rechaza; continuar antes de marcar completo |
| M6 | Daemon residente y coordinación durable | M2 + M4; reservas/límites de cuenta de P-19 | cola consumida continuamente; cancelación, attach, señales y timers con control real de hijos | Reinicios en cola, ejecución, espera y timer; apagado y reap; límites por cuenta y workspace; cancelación aceptada frente a terminada; señal autorizada y correlacionada; el supervisor local cumple su perfil, con excepciones explícitas |
| M7 | Integraciones seleccionables y sustituciones | contratos de M1 + M4 + M6; continuidad/tools del perfil | driver, harness, modelo y herramientas elegidos por política, con compatibilidad publicada | Instalación y configuración distintas de capacidades; [preflight de composición](../architecture/integrations/composition/index.md) antes de efectos y revalidación al despachar; dos implementaciones reales por cada familia anunciada intercambiable; una marca nueva no modifica el dominio; sustitución en checkpoint; la pérdida del journal no se asume inocua |
| M8 | Herramientas y aislamiento | M1; contrato disponible temprano | herramientas fiables y límites efectivos para trabajo sobre repositorios | Error de herramienta, schema alterado, capacidades y paginación; perfiles de transporte; sandbox de proceso con pruebas de red y filesystem; ciclo de vida de recursos; un error nunca es éxito |
| M9 | Iniciativas y equipos | M3 + M5 + M6 + P-34/admisión | dos iniciativas separadas; plan editable; DAG; roles configurables; aprobación durable | Dependencias, ciclos y revisión concurrente; la simulación no ejecuta; límites de workers; entrega entre agentes; consulta sin polling; un rechazo produce una corrección trazable |
| M10 | Observabilidad operativa | M2; eventos estables de M4 | ver progreso y fallas, y exportar señal útil con backend opcional | Exporter conectado a una cola acotada; éxito parcial de OTLP; collector lento o caído no afecta la tarea; métricas de descarte y reintento; huecos, identidad y contrapresión del stream; lectura privada de artefactos separada |
| M11 | Economía y evaluaciones reales | M5 + M9 + M10 | costo y uso por cuenta y por resultado; mejoras de routing justificadas | Tokens por clase, consumo desconocido y externo; catálogo de precios versionado; prorrateo frente a costo API; runner, juez y dataset registrados; el productor valida el artefacto; canary y rollback de política |
| M12 | Portabilidad de almacenamiento y extensiones | local seguro temprano; portabilidad completa tras M4 + M7 | cambiar almacenamiento y servicios sin cambiar la semántica del plane | Contratos de ledger, artefactos, credenciales y notificaciones; segundo backend real si se anuncia; migración, restore y replay; packs con límites y pruebas propias |
| M13 | Arquitectura mantenible y distribución | extracción incremental desde M0; cierre tras M9 | código legible por path; un consumidor puede instalar un perfil mínimo | Folder/index y tests espejo; declaraciones de tipo separadas; composition roots pequeños; SDKs sólo en adapters; sin utilidades clonadas; instalación limpia sin red cuando corresponda; ambos sistemas operativos con la cobertura que se anuncie |
| M14 | Certificación del backend como producto | M0–M13 dentro del perfil elegido | release con matriz real de compatibilidad y manual operativo | La conjunción completa de [calidad §7](../quality/index.md) |

**Orden crítico:** M0 → log/identidad/protocolo/artefactos locales → bootstrap y
contenido → M2 → verificación/efecto Git deshabilitado → recuperación → habilitar
M3 → M5/M6 → M9 → certificación del perfil M14.
Las entregas internas exactas viven en [packets §1.8](../implementation/packets/index.md):
no adelantan el cierre completo de M4/M11/M12 ni agregan unidades de progreso.

P-17/efecto se desarrolla en un repositorio descartable autorizado; su crash se
prueba en P-18/recuperación **antes** de habilitar commit operativo. Captura de uso
y pin del catálogo preceden al gasto, no esperan a los reportes de M11. P-23 no
habilita M7 sólo por componer un cliente: necesita recuperación, control del run y
conformidad del perfil. Su diseño H-5 conserva el estado que declara el inventario.
M13 sigue siendo incremental, sin gran renombrado previo a la primera tarea útil.

### 2.1 Decisiones delegadas

**Incorporación expresa del owner: Jev + Laya, no Jev solo.** ACP planifica y
ejecuta features mediante workflows persistentes; delegar una decisión es una
capacidad propia, no una dependencia de una marca. El usuario puede asignar roles
y modelos explícitamente, aplicar reglas, pedir una recomendación o delegar una
selección automática dentro de límites. Cambiar el decisor no cambia el plan,
las tareas, su evidencia ni la autoridad del control plane.

Se incorpora como **extensión de evaluaciones y routing P-35/M11**, con consumidor
en planificación y coordinación. Es opcional para la operación del producto,
pero la entrega seleccionada incluye **dos adapters IA reales: Jev y Laya**.
Reglas y mocks son útiles para desarrollo y fallback, no satisfacen la segunda
implementación. Una compatibilidad de API no demuestra equivalencia de calidad.

Primer caso completo: elegir quién implementa, verifica o audita un paso entre
candidatos ya admitidos por rol, capacidad, cuenta, cuota y presupuesto. El
decisor evalúa opciones; ACP conserva autorización, reservas, despacho, calidad,
recuperación y evidencia. No es un planificador universal, un segundo scheduler
ni un sustituto del motor durable. Clasificar fallos o sugerir otras transiciones
requiere operaciones y pruebas propias; no queda habilitado implícitamente.

**No se intercala en P-15 ni bloquea la primera tarea útil.** Sus cortes y
dependencias de desarrollo/habilitación tienen dueño en
[packets](../implementation/packets/index.md). Su contrato, arquitectura, datos,
proveedores y aceptación tienen dueño en
[integraciones §8](../architecture/integrations/index.md#8-decisiones-delegadas).
La [agenda de paralelismo](parallelism/index.md#15-decisiones-delegadas) permite
preparación RO adelantada, no otro writer ni pruebas pesadas simultáneas.

Orden de entrega: contrato y oráculos → camino neutral con consumidor → adapters
Jev y Laya → conformidad y evaluación → observación/recomendación → delegación
automática acotada. Ninguna etapa hereda aceptación de la siguiente. Los dos
adapters deben superar el mismo perfil contractual y de calidad antes de anunciar
sustitución. Si Laya no alcanza ese perfil, la extensión no cierra: se presenta
una alternativa al owner, sin omitir la segunda implementación silenciosamente.

Esta ampliación queda **planificada, no implementada ni DESIGN_READY**. No cambia
el alcance ni los cierres anteriores de los 39 packets. Al abrirla, el DT fija su
perfil y avance separado del baseline original; no se absorbe trabajo nuevo
silenciosamente en el porcentaje anterior. P-35 conserva el readiness de su
alcance original, no lo extiende automáticamente a este agregado. La certificación
del perfil que anuncie esta capacidad exige su cierre completo; el producto base
sigue funcionando sin activarla.

La orden actual incorpora documentación. No autoriza instalaciones, descarga de
pesos, gasto de API/suscripción, nuevas cuentas, UI, publicación ni P9. Los smokes
reales conservan la autorización de perfil y límites exigida por el repositorio.

---

### 2.2 Extensiones de producto planificadas

**Mandato incorporado el 2026-09-26 por el [roadmap canónico](../../ROADMAP.md).**
El owner seleccionó RAG contextual **y acciones propuestas**, y autorizó integrar
las capacidades representadas por el mock. Esta sección es el addendum vigente
de planificación, no una invitación a implementar contratos sin congelar.
Preserva 39 packets baseline, 121 IDs históricos, sus cierres y camino crítico;
ninguna nueva capacidad hereda DESIGN_READY/SCOPE_FROZEN. No demora P-16 ni acepta
sus cambios en curso. Los cortes T/R/P/E/Q/O/S/N/V del mock no son IDs backend ni
evidencia de soporte. Gobierno opcional y producto local-first, sin dependencia
de módulos de producto, otros repositorios, tenancy o servicios de equipo.

#### Cobertura completa O1–O13

| Origen | Clasificación y destino canónico | Límite veraz |
| --- | --- | --- |
| O1 Asistencia contextual | selección planificada X10; [integraciones §5.1](../architecture/integrations/index.md#51-recuperación-contextual-y-acciones-seleccionadas) | contexto/citas + propuestas de acciones, no acceso ni ejecución desde un documento recuperado |
| O2 Conversaciones/búsqueda | enmienda acotada de [planning](../architecture/database/planning/index.md#extensión-planificada-perfiles-equipos-e-historia), artefactos e integraciones | brief/roadmap privados, inferencias propuestas y edición manual; búsqueda de registros sin X10 ni modelo; no segundo task store |
| O3 Revisión humana | P-28 baseline más extensión separada de [interacción](../architecture/contracts/interaction/index.md#extensión-planificada-aprobación-y-propuestas-exactas) | autoridad/independencia/CAS, nunca mensajes o personas simuladas |
| O4 Gobernanza de equipos | nueva extensión [GOV](../architecture/governance/index.md) | E1(b), E2 y E3; opcional, no seguridad instalada |
| O5 Configurar suscripción/API/local | plan existente P-19/P-20/P-23/P-32/P-33/P-34 | cuota, uso, gasto y capacidad desconocidos no equivalen a cero; fallback pagado exige autorización |
| O6 Analítica de uso | plan existente P-30–P-35, economía/observación/evaluación | totales/heatmaps reproducibles desde runs; no otra contabilidad ni ahorro universal |
| O7 Composición neutral | P-23 y dueños existentes de tools/confinamiento/instalación; [catálogo](../architecture/integrations/market/index.md) y [composición](../architecture/integrations/composition/index.md) | defaults de proyecto y alternativas por necesidad, no catálogo de casillas; seleccionar no instala ni prueba; un resolver/preflight |
| O8 Jev + Laya | extensión P-35 de §2.1, sin cambio | dos adapters reales, contrato único y gates previos conservados |
| O9 Autoría guiada/etapas | P-26/P-27/P-28/P-29 más agrupación revisionada propuesta de pasos | objetivo → entregables → equipo/componentes/pruebas/concurrencia; cadencia de commits separada de aprobación/push; no reabrir historia, nueva jerarquía ejecutable ni segundo DAG |
| O10 Vista móvil simplificada | frontera de representación | contexto read-only y derivación honesta al desktop; no servicio remoto ni autorización multiusuario |
| O11 Empaquetado desktop | plan existente P-38 | shell/runtime de escritorio sigue siendo decisión; preview no es instalador firmado, updater ni permisos OS |
| O12 Voz/multimodal | X13 OPTIONAL_SELECTED planificado sólo [captura → STT → texto revisado](../architecture/integrations/index.md#52-captura-y-transcripción-de-voz-seleccionadas) | opcional para describir feature/agente; sin soporte actual implícito; TTS/realtime/imagen/video/voz como identidad y archivos/URLs arbitrarios no seleccionados |
| O13 Agentes AI con nombre | biblioteca reusable y extensión separada P-28 | publicación workspace explícita con ACL existentes y legacy privado; skills/nivel descriptivos; planning posee revisión/asignación, runtime worker/run real; builtin ID/versión/digest y ASCII legacy opcional |

#### Registro de extensión, dependencias y cierre

Los nombres siguientes son descriptivos, **no** números de packet nuevos. El DT
congelará cortes/leases exactos en el dueño de packets antes de implementación.

| Entrega planificada | Dueño y dependencias | Criterio de terminación, no satisfecho por esta página |
| --- | --- | --- |
| Biblioteca de perfiles AI | planning; streams/artefactos; publicación workspace y acceso privados existentes | identidad/revisión/head, skills/nivel, límites, OCC/idempotencia y archive; legacy privado, clone autorizado, conteos sin filtración, rebuild de cohorte y lectura autorizada con pruebas de [planning](../architecture/database/planning/index.md#extensión-planificada-perfiles-equipos-e-historia) |
| Equipos/asignaciones e historia | extensión P-28; perfiles; resolver existente; admisión y run identity reales | adopción explícita con OCC, snapshot de revisión exacta, pins, run/receipt inmutables, ausencia de perfil baseline válida; aprobación nunca fabricada |
| Autoría por etapas y propuestas | planning; P-26/P-27/P-28/P-29 y composición | grupos sobre pasos existentes, defaults/payload/fingerprint exactos, replay sin recalcular, cancelar patch conserva draft y descarte sucio confirmado; pruebas/coverage objetivos no son medición; cadencia no concede commits/push |
| Gobernanza opcional | GOV-0…GOV-11 de [su dueño §16](../architecture/governance/index.md#16-alcance-backend-por-cortes-dependencias-y-paralelización) | cada corte congela datos/contratos y negativos, cobertura declarada por adapter; E1(b)/E2/E3 aplicados; no habilitar sin validación real |
| Contexto y acciones X10 | integraciones y artefactos; permisos de fuente/gobernanza cuando aplica; P-36 custodia la selección | fuentes/citas/índice reconstruible, revocación, instrucciones no confiables, confirmación exacta y ciclo de efecto normal; conformidad real antes de soporte |
| Conversaciones y búsqueda | planning/artefactos/observation; metadatos scoped y acceso vigente | contenido privado, ownership real, historia/propuestas sin autoridad; búsqueda de registros independiente de X10 y sin filtrar nombres/conteos privados |
| Captura/transcripción opcional X13 | P-06/M12 conserva responsabilidad primaria; integraciones, artefactos y consumidores de draft | congelar dispositivo/consentimiento, adapter/versión, formatos/límites, egress, retención/borrado, costo/UNKNOWN y cancelación; revisar antes de insertar; edición manual ante rechazo/fallo; no TTS/realtime implícito |
| Seguimiento agente/paso | runtime/observation, asignación exacta y lectura autorizada | enlace a intento/run/log/console con worker y ruta efectivos, frescura/cursor, costos y evidencia; no nueva tabla/autoridad de consola ni proceso activo inventado desde planned/legacy/unknown |
| Economía/heatmap/compatibilidad/distribución | packets y dueños existentes indicados en O5–O8/O11 | recorridos completos, recuperación, oráculos independientes y límites reales de su perfil; no nuevo subsistema por pantalla |

Secuencia mecánica: (1) preparación RO de modelos de amenaza, límites, oráculos
y contratos sobre snapshots; (2) congelar por entrega diccionario, eventos,
cohortes, normalización, composición y negativa tipada; (3) integrar la transición
física con sus owners serializados; (4) publicar descriptor/perfil privado;
(5) extender asignación/admisión y capturar identidad real; (6) exponer lectura,
aprobación y acciones por las puertas existentes; (7) conformidad/paridad,
crash/rebuild/privacidad y revisión independiente. Gobernanza sigue su DAG propio;
contexto sin acciones puede ser subcorte, pero **no cierra X10 seleccionado** sin
acciones propuestas seguras. Nada consume modelos o instala adapters por este
orden. El baseline y la primera tarea útil no esperan una extensión opcional.
La cantidad de pantallas es flexible: defaults con procedencia evitan preguntas
repetidas, sin cachear permiso. Jev/Laya conservan su selección de candidato y
gates; planificador amplio requiere consumidor/contrato propios antes de código.
Concurrencia máxima es una preferencia acotada por dependencias, leases/write-set,
recursos, cuota y presupuesto, nunca garantía de paralelismo o corrección.

#### Reconciliación física obligatoria antes de código

Estos cinco owners permanecen fuera de la escritura documental concurrente con
P-16. Su baseline sigue vigente; este registro **ya** agrega el alcance a la
planificación y exige la siguiente reconciliación en su safe point:

| Owner canónico | Integración requerida antes del código que la consuma |
| --- | --- |
| [Packets](../implementation/packets/index.md) | cortes/readiness y write-sets de extensiones separados de 39; dependencia en A10/STEP, aprobación/re-resolución y worker revocation sin borrar baseline P-28 |
| [Decisiones](../decisions/index.md) | registrar decisiones técnicas pendientes cuando se resuelvan; las selecciones del owner constan aquí y en [requisitos §13.2](../requirements/index.md#132-perfil-sucesor-voz-acotada-2026-09-26); las exclusiones previas de X10 y del alcance captura/STT de X13 son históricas, no se supersede el resto de X13 |
| [Contratos](../architecture/contracts/index.md) | composición exacta del envelope, bytes/digests, perfil/asignación, planner/voz, validación humana, confirmación y frontera de cadencia con operaciones de commit existentes, errores/versiones y recovery; no editar receipts P-16 |
| [Ejecución](../architecture/database/execution/index.md) | snapshot inmutable de perfil/asignación por intento y route, pins/lifetime, identidad emitida real; no renombrar historia ni cambiar un run admitido |
| [Datos raíz](../architecture/database/index.md) | diccionario/cohortes/DER y transición serializada coherentes con streams/planning/artefactos; causalidad tipada y publicación atómica; no DDL implícito |

Readiness exige productor de cada hecho, transacción/OCC/replay, schema/revision
compatibles, consumidores/privacidad, oráculos y rollback/rebuild definidos. Las
asignaciones baseline conservan STEP > INITIATIVE > GLOBAL; “project” de UX se
mapea explícitamente a iniciativa/repositorio admitidos, nunca crea una capa
PROJECT ni autorización global. Una fila o un CHECK de forma no valida identidad.
No se reserva ADR/decisión/migración aquí. [Tests](../quality/testing/index.md#82-aceptación-futura-de-las-extensiones-de-producto)
y [paralelismo](parallelism/index.md#16-preparación-de-extensiones-de-producto) son gates,
no evidencia ejecutada. El cierre documental requiere receipt independiente;
la implementación sigue pendiente hasta sus propios DESIGN_READY y SCOPE_FROZEN.

## 3. Gates

Un gate es una condición **verificable** que separa dos hitos. No se pasa por
consenso ni por prosa.

| Gate | Antes de | Condición |
| --- | --- | --- |
| G-SUITE | cualquier hito que dependa de la suite completa | ningún test escribe el checkout vivo, y la suite corre entera con su conteo pineado |
| G-AUTORIDAD | M1 y todo packet posterior | el puente de autoridad está cerrado: la especificación vigente está commiteada, pineada por digest y admitida por la lista exacta ([migración](../implementation/migration/index.md)) |
| G-IDENTIDAD | M2 | la preimagen del envelope cubre todo el contrato, y dos trabajos distintos no comparten identidad |
| G-CONTENIDO | M3 y M5 | la instrucción llega y el resultado vuelve por **todas** las puertas admitidas del perfil |
| G-ARTEFACTOS | primer prompt/resultado privado de M1 | P-36/local probado: publicación antes de referencia, acceso por scope y negativos de privacidad; registry existe antes del primer evento de artefacto |
| G-COMPOSICIÓN | habilitar M7/P-23 en el perfil | diseño de H-5 cerrado y conformidad de composición probada, con revalidación al despacho; no basta descriptor válido ni dos mocks |
| G-RECUPERACIÓN | habilitar commit operativo, M5 y M6 | la matriz de crash de [tests §7](../quality/testing/index.md) pasa en las ocho fronteras, **y** el enforcement de revocación de [contratos §6.1](../architecture/contracts/index.md) está probado: writer revocado rechazado y descendiente vivo detenido o confinado |
| G-DATOS | cada escalón persistente, incluidos M1, M5, M9 y M11 | sus migraciones están aplicadas con preflight y la reconstrucción multi-stream es determinista; un corte no divide transacciones ni folds obligatorios |
| G-ARQUITECTURA | M13 y M14 | cero ciclos, cero deep imports, ningún dominio abre una base, declaraciones de tipo separadas, y cada duplicación con divergencia resuelta o adjudicada por escrito |
| G-FENCE | M0 y M14 | ninguna ley pasa con evidencia vacía; cada familia tiene su sonda adversarial |
| G-PARIDAD | M14 | expectativas independientes por puerta; ninguna comparación de una función consigo misma |
| G-PERFIL | M14 | cada una de las 121 filas de requisitos tiene estado de perfil asignado **antes** de ejecutar |
| G-UI | release con interfaz, y P9 | diseño aceptado antes de implementar, y la matriz de accesibilidad de [tests §8](../quality/testing/index.md) |

---

## 4. Readiness por packet

Un hito no se entrega a un implementador: se entrega un packet. Los dos estados
independientes, `DESIGN_READY` y `SCOPE_FROZEN`, se definen únicamente en
[packets §0](../implementation/packets/index.md), junto con el inventario. Se
necesitan ambos; **la autorización de esta ronda es sólo documental**.

Regla que acompaña: **un agente no inventa diseño material en vuelo.** Si al
ejecutar aparece una decisión de contrato, de schema o de atomicidad que el packet
no resuelve, el agente **para** y la escala. La decisión se registra en
[decisiones](../decisions/index.md) antes de continuar.

---

## 5. Paralelización

Las [olas, el grafo de conflictos y el relevo de writer](parallelism/index.md)
tienen allí un único dueño. La tabla de dependencias sigue en
[packets](../implementation/packets/index.md); no se mantiene otro inventario.
**Un solo writer en main**, preparación/auditoría paralela en lectura sobre
snapshots; ningún worktree, relevo, implementación o gasto queda autorizado aquí.

La tabla de olas no añade dependencias: en cada cierre se elige el siguiente
packet por sus predecesores aceptados y sus conflictos reales. La
[matriz de oportunidades y el ciclo de entrega](parallelism/index.md) cubren todo
el inventario, distinguiendo preparación, implementación y habilitación. El
objetivo es eliminar espera y retrabajo, no cerrar con defectos o tests pendientes.
Un consumidor no avanza sobre una aceptación faltante; el trabajo independiente
puede continuar con su propia autorización. Arquitectura y pruebas no se difieren
para aparentar paralelismo ni para aumentar el porcentaje de cierre.

---

## 6. Cierre honesto de cada hito

Cada cierre guarda: HEAD, perfil y configuración, binarios y versiones usados,
comandos con sus códigos de salida, casos cubiertos, pruebas negativas, límites
conocidos, receipt y la siguiente acción segura.

**Un fallo ambiental no se convierte en `PASS`** y no autoriza pruebas sobre el
checkout vivo. Un objetivo numérico incumplido se reporta como incumplido
([tests §9](../quality/testing/index.md)).

---

## 7. Fuera de esta secuencia

Interfaz visual, shell de escritorio, distribución multiusuario o en la nube, y
P9 se planifican como releases posteriores. Sus contratos de backend se
contemplan, pero **ningún cierre del backend autoriza adoptar este control plane
en un repositorio de producto ni publicar nada**. El owner pidió diseñar la
interfaz antes de implementarla, y esa secuencia se conserva.
