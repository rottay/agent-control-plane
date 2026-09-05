# Casos de uso del Agent Control Plane

Este documento describe el sistema completo que queremos tener, no sólo el que
existe. Sirve para contarle a alguien qué hace el control plane y para medir
cuánto de eso ya está. Cada caso de uso lleva un estado honesto:

| Estado | Significa |
| --- | --- |
| Hoy | Existe y está cableado en el path productivo, con test conductual. |
| Parcial | Existe como contrato, librería o drill, pero no completa el caso de punta a punta. |
| Planificado | Está en el draft V2 o en el orden corregido del audit del 2026-09-04. |
| Propuesto | Surge del audit o de esta lista y todavía no está en ningún plan. |

Fecha: 2026-09-04. Base: HEAD `4569478` más el audit y la rúbrica de esta misma carpeta.

---

## Cómo contarlo en un minuto

El Agent Control Plane es un programa que corre en tu propia máquina y
coordina varios agentes de programación a la vez: Claude, Codex, Kimi, y los
que vengan. Vos le das una iniciativa con un roadmap; él lo convierte en pasos,
arma un equipo por paso (quién dirige, quién escribe, quién verifica, quién
audita), reparte las tareas entre tus cuentas de suscripción según la cuota que
le queda a cada una, y ejecuta cada tarea en un worktree aislado con un
write-set exacto: si un agente toca un archivo que no le corresponde, el
worktree se pone en cuarentena y nadie lo limpia a la fuerza.

Por cada paso elegís qué modelo y qué versión exacta hace cada rol, y el
sistema te dice cuántos tokens y cuántos dólares lleva cada iniciativa, cuánto
falta para terminarla y si la cuota alcanza antes del próximo reset.

Todo lo que pasa se escribe en un ledger append-only encadenado por hashes:
qué prompt se mandó, a qué modelo, con qué cuenta, cuánto costó, qué
herramientas usó, quién verificó, qué commit salió. Cualquier vista, la CLI,
la API o la consola, se deriva de ese ledger y las tres están probadas iguales.
Si el proceso muere a mitad de una tarea, se reanuda desde el ledger sin
repetir efectos. Si una cuenta se queda sin cuota, se hace checkpoint y se
sigue con otra.

Ningún secreto entra al sistema, nada sale de la máquina, y nadie publica ni
adopta nada sin un acto explícito del owner.

Tres lazos sobre un ledger:

```
planificación   iniciativa → roadmap → pasos con equipo → grafo de tareas → aprobación
ejecución       tarea → ruta → sesión con instrucción → eventos → conformance → verificación → commit → checkpoint
economía        cuentas → cuota observada → presión → switch → reserva → continuar
```

---

## A. Iniciativas, roadmaps y planificación

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| A1 | Registrar una iniciativa | Owner | Nombre, objetivo, repositorio objetivo y owner. `INITIATIVE_REGISTERED`. Toda tarea posterior se atribuye a una iniciativa en un solo lugar. | Parcial |
| A2 | Escribir y versionar el roadmap de una iniciativa | Owner, DT | Versiones inmutables por digest, control de concurrencia optimista, restauración a una versión anterior. | Hoy |
| A3 | Declarar el roadmap como plan estructurado | DT | Pasos con objetivo, criterio de aceptación, write-set esperado y dependencias entre pasos. `ROADMAP_STEP_DECLARED`. Deja de ser un texto opaco. | Propuesto |
| A4 | Configurar el equipo por paso | Owner, DT | Por cada paso: qué modelo dirige, cuántos implementadores y cuáles, quién investiga, quién verifica, quién audita, qué versión de política de routing. Es un documento versionado, no código. | Propuesto |
| A5 | Descomponer un paso en un grafo de tareas | DT | Tareas con dependencias y write-sets exactos, generadas por el coordinador como workflow durable. `TASK_GRAPH_PLANNED`. El scheduler respeta el orden, no sólo la compatibilidad de write-sets. | Propuesto |
| A6 | Pedir un plan al coordinador y registrarlo | Owner, sistema | `DT_PLAN_REQUESTED` y `DT_PLAN_RECORDED`, con el prompt del pedido trazable por digest. | Propuesto |
| A7 | Aprobar o rechazar un plan, un paso o un commit | Owner | La tarea espera en `WAITING_OWNER`; la aprobación es una señal durable que reanuda. Un rechazo registra el motivo. | Parcial |
| A8 | Pausar, reordenar o cancelar un paso o una iniciativa | Owner | Cancelación en cascada de las tareas del paso, con los checkpoints intactos. | Propuesto |
| A9 | Ver el portafolio | Owner | Todas las iniciativas con avance, bloqueos, tareas en cuarentena y gasto. | Hoy |
| A10 | Comparar versiones de roadmap | Owner, DT | Diff entre dos versiones y vuelta atrás explícita. | Parcial |
| A11 | Fijar modelo y versión por rol en cada paso | Owner, DT | Para cada rol del paso, el id exacto de versión del modelo, no un alias: qué Claude, qué Codex, qué Kimi. Si se usa un alias, la versión resuelta queda grabada en el ledger junto a la ruta. | Propuesto |
| A12 | Precedencia en tres niveles | Owner | Política global, defaults de la iniciativa, override del paso. Cada edición es una versión inmutable con diff y autor, y aplica a las tareas que todavía no arrancaron; una tarea en curso conserva su ruta salvo un switch. | Propuesto |
| A13 | Validar la edición fail-closed | Sistema | Un modelo o versión que no existe en el registry, o no está admitido para ese rol y transporte, rechaza la edición con la razón. Una versión retirada por el proveedor bloquea el paso y propone la migración en lugar de degradar en silencio. | Propuesto |
| A14 | Recomendación de independencia | Sistema | Al declarar el equipo de un paso, si el verificador o el auditor son el mismo worker que el writer, o del mismo proveedor, el plan se acepta igual y queda registrada una recomendación con el motivo. La ley dura no cambia: un receipt con verificador igual al writer sigue siendo inválido. | Propuesto |
| A15 | Simular un plan antes de ejecutarlo | Owner | Con el grafo de tareas y el histórico por tipo de tarea, rol y modelo: costo estimado en tokens y dólares, tiempo, cuota que va a consumir por cuenta y si alcanza antes del próximo reset. | Propuesto |

## B. Tareas y ejecución

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| B1 | Someter una tarea | Owner, DT | Un envelope: objetivo, rol, write-set y read-set, autoridad por digest, presupuesto, política de commit. Entra a una cola que el daemon residente consume, por CLI o por API. | Parcial |
| B2 | Elegir la ruta | Sistema | Proveedor, modelo, cuenta y transporte por una política versionada; queda la ruta elegida y la versión de política que la decidió. | Hoy |
| B3 | Reservar cuenta y worktree | Sistema | Una reserva de cuenta del pool y un lease exclusivo del worktree. Dos tareas nunca comparten worktree. | Parcial |
| B4 | Verificar el prestate | Sistema | Branch, HEAD, digests de autoridad y de write-set coinciden con el brief antes de empezar; si no, la tarea no arranca. | Parcial |
| B5 | Abrir la sesión con la instrucción | Sistema | El prompt se construye desde el objetivo, el brief y el contexto, se manda al proveedor por su protocolo, y queda registrado por digest. `PROMPT_RECORDED`. | Planificado |
| B6 | Seguir la ejecución en vivo | Owner | Eventos normalizados de cualquier proveedor: texto, uso de herramientas, tokens, errores. Al ledger sólo llegan escalares; a la consola, un stream SSE con reconexión sin huecos. | Hoy |
| B7 | Ejecutar herramientas acotadas | Agente | Tools MCP por stdio o loopback, allowlist por nombre y digest de schema, receipt por llamada, exactamente una ejecución aunque dos procesos la pidan. | Hoy |
| B8 | Verificar conformance del write-set | Sistema | Después de cada paso atómico se compara el diff y los archivos nuevos contra el write-set. Una violación revoca el lease y pone el worktree en `SUSPECT_WORKTREE`. Nunca se limpia ni se resetea. | Hoy |
| B9 | Escribir un checkpoint | Sistema | Al cierre de cada paso atómico: HEAD, digests, receipts, trabajo pendiente, próxima acción segura. Acotado en bytes, sin transcript, sin credenciales. `CHECKPOINT_WRITTEN` con digest. | Parcial |
| B10 | Cancelar, reattach, señales y timers | Owner | Cancelar llega hasta el proceso hijo; reattach permite mirar o esperar una ejecución desde otra terminal; señales y timers durables para gates y esperas. | Parcial |
| B11 | Recuperar tras un crash | Sistema | Muerte del daemon o SIGKILL a mitad de un paso: se reanuda desde el ledger sin repetir efectos ya registrados; si el proveedor corrió sin dejar evidencia, se registra la exposición de gasto. | Hoy |
| B12 | Ejecutar tareas en paralelo | Sistema | N tareas a la vez en worktrees disjuntos, admitidas por el grafo de conflictos y por los topes de concurrencia por cuenta. | Hoy |
| B13 | Correr en modo sólo lectura | Owner, auditor | Política `NO_COMMIT`: la tarea investiga o audita sin que el plan incluya commit. | Parcial |
| B14 | Reintentar con otra ruta | Owner, sistema | Nuevo intento sobre el mismo checkpoint con otro modelo o cuenta, sin perder la historia del anterior. | Parcial |
| B15 | Registrar el resultado | Sistema | Respuesta del modelo por digest, uso de tokens, duración, veredicto de redacción. `RESPONSE_RECORDED`, `TOKEN_USAGE_RECORDED`. | Parcial |
| B16 | Escalera de reintento | Sistema | Política por rol: tras N fallos o rechazos, escalar a un modelo mayor o cambiar de proveedor; cada escalón queda registrado con su motivo y su costo. | Propuesto |
| B17 | Duelo de modelos | Owner | La misma tarea con dos rutas en `NO_COMMIT`; se comparan veredicto de auditoría, costo y tiempo. Sirve para decidir el modelo de un rol con evidencia propia. | Propuesto |
| B18 | Límites de tiempo | Owner | Tope de reloj por tarea, por paso y por iniciativa; al vencer, checkpoint y cancelación limpia, nunca un proceso huérfano. | Propuesto |

## C. Verificación, auditoría y commit

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| C1 | Verificación independiente | Verificador | Un worker distinto del writer ejecuta los checks y registra los exit codes. `VERIFICATION_COMPLETED` con el receipt. La prosa del writer no es evidencia. | Parcial |
| C2 | Auditoría | Auditor | Un auditor read-only emite exactamente un veredicto: aceptar, aceptar con correcciones o rechazar. `AUDIT_COMPLETED` con veredicto y evidencia. | Parcial |
| C3 | Autorizar y registrar el commit | Sistema | Sólo con receipt válido: verificador distinto del writer, todos los checks en cero, ningún cambio fuera del write-set. `COMMIT_RECORDED` con el sha real. | Parcial |
| C4 | Adjudicar tras un rechazo | DT | El coordinador decide una corrección concreta; no se piden versiones sucesivas del mismo contrato sin código nuevo. | Propuesto |
| C5 | Consulta en hitos | Consultor | Revisión de fase registrada como evento con su digest, no como texto suelto. | Propuesto |
| C6 | Publicar | Owner | Nunca automático. Un solo comando con una señal de un solo uso, fast-forward a `main` en el remoto canónico. Todo lo demás lo rechaza el hook. | Hoy |
| C7 | Verificar el receipt al commitear | Sistema | Un hook de pre-commit que rechaza un commit sin receipt válido, para que la ley no dependa de la disciplina. | Propuesto |

## D. Cuentas, cuotas y costo

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| D1 | Registrar cuentas de suscripción | Owner | Tres o cuatro cuentas por proveedor, cada una con su config root aislado y una referencia opaca a la credencial. El secreto nunca entra. | Hoy |
| D2 | Estimar la cuota restante | Sistema | Desde observaciones reales: uso registrado por cuenta más las señales del proveedor, con calendario de reset con recurrencia (la ventana de cinco horas rueda). | Parcial |
| D3 | Enrutar por margen | Sistema | Se rechaza una cuenta sin margen para el próximo paso atómico más su checkpoint. La razón del rechazo queda registrada. | Parcial |
| D4 | Detectar presión de cuota en vivo | Sistema | El adapter clasifica rate limit, usage limit y auth como señales tipadas; nace un `SwitchTrigger`. | Planificado |
| D5 | Cambiar de cuenta a mitad de tarea | Sistema | Checkpoint, liberar la cuenta, reservar otra, rehidratar el checkpoint, continuar. `ACCOUNT_SWITCH_COMPLETED` sólo cuando la sesión nueva existe. Puede cambiar de proveedor si la política lo permite. | Parcial |
| D6 | Drenar, rehabilitar, re-autenticar u override | Owner | Acciones del operador sobre una cuenta, con receipt, que la elección de ruta respeta desde la próxima sumisión. | Parcial |
| D7 | Reservas y topes por cuenta | Sistema | Dos tareas no pueden elegir el último margen de la misma cuenta; concurrencia máxima por cuenta. `ACCOUNT_RESERVED`, `ACCOUNT_RELEASED`. | Propuesto |
| D8 | Clase de costo y presupuesto | Owner, sistema | Suscripción o metered en la política; preferir suscripción por defecto; presupuesto por tarea e iniciativa en tokens, tiempo y dinero, que el router honra. | Propuesto |
| D9 | Ver consumo por iniciativa | Owner | Tokens por tarea e iniciativa existen hoy como rollups; faltan por cuenta, por paso y por rol. El gasto que no se puede ubicar se reporta, no se esconde. | Parcial |
| D10 | Alertas de cuota y gasto | Owner | Cuenta cerca del límite, reset próximo, gasto fuera de presupuesto, cuenta que necesita re-autenticación. | Propuesto |
| D11 | Contabilizar tokens por tipo | Sistema | Por cada llamada: entrada, salida, escritura de cache y lectura de cache, con el id exacto de modelo y la cuenta. Hoy los adapters registran un único total. | Parcial |
| D12 | Tabla de precios versionada | Owner | Precio por millón de tokens por proveedor, modelo, versión y tipo de token, con fecha de vigencia y autor. Cada costo registrado referencia la versión de precios que lo calculó, así un cambio de precio no reescribe la historia. | Propuesto |
| D13 | Costo en dólares por iniciativa | Sistema | Costo derivado por llamada, sin evento propio, como función del uso y de la versión de precios vigente en ese momento; rollups por iniciativa, paso, tarea, rol, cuenta, proveedor y modelo. Dos medidas siempre juntas: costo real, que en API metered es precio por tokens y en suscripción es la cuota mensual del plan, declarada en el registro de la cuenta, prorrateada por el consumo del período; y valor equivalente a precio de API, para saber qué habría costado sin suscripción. | Propuesto |
| D14 | Pronóstico para terminar | Owner | Con el grafo pendiente y el histórico: cuánto falta en tokens y dólares, cuánta cuota por cuenta, y si alcanza antes del próximo reset. | Propuesto |
| D15 | Retorno de cada suscripción | Owner | Por cuenta y por mes: valor equivalente consumido contra la cuota del plan. Dice si el tier paga, si sobra o si conviene otra cuenta. | Propuesto |
| D16 | Costo por resultado | Owner | Costo por commit autorizado, por auditoría aceptada y por paso cerrado; y aparte, el costo del rework: lo gastado en trabajo rechazado y en sus correcciones. | Propuesto |
| D17 | Exportar uso y costo | Owner | CSV y JSON por período e iniciativa, más un reporte periódico: tokens, dólares, tareas cerradas, rework, estado de cuota y próximo reset. | Propuesto |
| D18 | Anomalías de consumo | Sistema | Una tarea que gasta varias veces la mediana de su tipo se pausa y avisa antes de seguir quemando cuota. | Propuesto |

## E. Proveedores, modelos y política

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| E1 | Registrar un proveedor por CLI | Owner, contribuidor | Binario admitido por path absoluto con chequeo de dueño y permisos, entorno construido clave a clave, protocolo declarado. Un descriptor tipado; agregar uno sin adapter no compila. | Parcial |
| E2 | Registrar un proveedor por API key | Owner, contribuidor | Un cliente inyectado que guarda la credencial en su propio closure; sin SDK obligatorio; una entrada en la política. | Parcial |
| E3 | Registrar un proveedor local o self-hosted | Owner | Mismo contrato, endpoint local; la operación por suscripción nunca depende de él. | Parcial |
| E4 | Mantener un único registry de capacidades | Owner | Modelos, roles elegibles, transportes, calidad, latencia, contexto y costo, versionado e inmutable. Un cambio de routing es una revisión del documento, no un cambio de código. | Hoy |
| E5 | Confirmar capacidades con un sujeto real | Owner | Un drill autorizado con un CLI real y una cuenta real saca a una capacidad de `UNKNOWN`. Nada se declara soportado sin eso. | Planificado |
| E6 | Evaluar modelos | Sistema | Benchmarks y red-team en CI, con consumo contabilizado, que producen versiones nuevas del único registry. Nunca un segundo registry. | Planificado |
| E7 | Routing adaptativo | Sistema | La calidad medida decide entre modelos elegibles, con el orden del documento sólo como desempate. | Planificado |
| E8 | Replay y what-if | Owner | Re-elegir rutas sobre una historia pasada bajo otra versión de política y ver el diff de decisiones y de costo. | Propuesto |
| E9 | Tabla de desempeño por modelo y rol | Owner | Tasa de aceptación en auditoría, costo por tarea aceptada, tiempo mediano y rework por modelo y versión, calculados sobre tareas reales. Alimenta el registry y la elección por paso. | Propuesto |

## F. Trazabilidad y observabilidad

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| F1 | Reconstruir la cadena completa de una tarea | Owner, auditor | Worker, cuenta, modelo, prompt, respuesta, herramientas, uso, verificación, commit, receipt: una sola consulta al ledger. | Parcial |
| F2 | Leer un prompt o una respuesta | Owner | Bytes en un vault local content-addressed, con permisos 0600, escaneados por credenciales y publicados redactados si hace falta. Lectura detrás del bearer local. | Propuesto |
| F3 | Verificar la integridad | Owner | Cadena de hashes sobre los tres streams, read models reconstruibles byte a byte, detección de triggers borrados. | Hoy |
| F4 | Navegar la línea de tiempo | Owner | Eventos por iniciativa, tarea, worker, tipo y estado; filtros, paginación, cursores estables. | Hoy |
| F5 | Exportar telemetría neutral | Sistema | Trazas OTel/OpenInference hacia un backend opcional; su caída no toca routing, ejecución ni recuperación. Los prompts viajan como digests, nunca como texto. | Planificado |
| F6 | Correlacionar logs y trazas | Owner | Logs estructurados con ids de traza y span, redacción de paths y secretos. | Parcial |
| F7 | Medir la línea de base | Owner | Acuerdo de routing, tokens, tiempo y rework por tarea e iniciativa, calculados sobre cadenas reales. | Parcial |
| F8 | Saber quién hizo qué | Owner, auditor | Identidad uniforme proveedor, modelo, rol e instancia en cada evento. | Hoy |

## G. Superficies

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| G1 | Operar todo desde la CLI | Owner | Un verbo por ruta o una excepción escrita; exit codes exhaustivos; salida JSON. La CLI construye su respuesta desde el ledger sin ver la del servidor. | Parcial |
| G2 | Operar todo desde la API local | Owner, herramientas | HTTP en loopback, lecturas libres, escrituras detrás de un bearer por digest, SSE con `Last-Event-ID` anclado a la secuencia del ledger. | Hoy |
| G3 | Operar todo desde la consola | Owner | Portafolio, iniciativas, grafo de tareas, línea de tiempo, agentes, cuentas y cuotas, ejecuciones y logs, evaluaciones, configuración. Modo lectura y modo operador. | Parcial |
| G4 | Confiar en que las tres dicen lo mismo | Owner | Ledger, servidor, CLI y consola se prueban iguales ruta por ruta, incluyendo orden, paginación y redacción. | Hoy |
| G5 | Recibir avisos | Owner | Aprobación pendiente, cuenta agotada, tarea en cuarentena, rechazo de auditoría: en la terminal, en la consola y opcionalmente por un webhook local. | Propuesto |

## H. Seguridad y gobernanza

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| H1 | Garantizar que ningún secreto entra | Sistema | Contratos con referencias opacas, entorno del hijo construido clave a clave, guardias de credenciales en cada frontera, redacción por ausencia. | Hoy |
| H2 | Mantener el plane en loopback | Sistema | Bind constante en código; sin autenticación en lectura porque los datos ya están en la máquina; escrituras fail-closed. | Hoy |
| H3 | Un solo writer por worktree | Sistema | Lease exclusivo, write-set exacto, cuarentena sin Git destructivo. | Hoy |
| H4 | Aislar el proceso hijo | Sistema | Filesystem y red acotados para el agente más allá del allowlist de entorno. Hoy declarado fuera de alcance. | Propuesto |
| H5 | Respaldar y restaurar el ledger | Owner | Copia consistente bajo WAL, restauración probada, identidad de instancia para que un cliente conectado no confunda dos ledgers en el mismo path. | Parcial |
| H6 | Sostener la arquitectura con leyes ejecutables | Sistema | Estratos, imports, write-sets, docs y receipts verificados en cada check y en el pre-commit, con leyes como datos y sondas de fallo por familia. | Parcial |
| H7 | Adoptar el plane en un repo de producto | Owner | Cutover explícito, reversible, con rollback probado y una autorización separada del owner. Nunca parcial. | Planificado |

## I. Operación

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| I1 | Instalar, arrancar y detener el daemon | Owner | Proceso residente con singleton, puertos reservados, status document, apagado ordenado que reapea lo que arrancó; integración opcional con launchd. | Parcial |
| I2 | Elegir el motor de durabilidad | Owner | Supervisor SQLite por defecto o Restate opcional, intercambiables sin tocar el dominio; Temporal u otro como tercer driver por el mismo puerto. | Parcial |
| I3 | Actualizar pins y volver atrás | Owner | Cambio deliberado de versiones de binarios y dependencias, con rollback que no destruye nada. | Hoy |
| I4 | Diagnosticar | Owner | Clases de fallo con nombre, runbook y guía de troubleshooting; el sistema dice qué le falta en lugar de degradarse en silencio. | Hoy |
| I5 | Operar sin servicios opcionales | Owner | Sin Restate, sin backend de telemetría, sin API key, sin MCP remoto: todo sigue funcionando por suscripción. | Hoy |

## J. Extensión por contribuidores

| # | Caso de uso | Quién | Qué pasa y qué queda en el ledger | Estado |
| --- | --- | --- | --- | --- |
| J1 | Agregar un proveedor sin tocar el dominio | Contribuidor | Descriptor, adapter, test espejo y entrada en la política. El compilador señala cada sitio. | Parcial |
| J2 | Agregar un driver de durabilidad | Contribuidor | Implementar el puerto de orquestación; el daemon lo consume polimórficamente; el dominio no cambia. | Parcial |
| J3 | Agregar un exporter de telemetría | Contribuidor | Implementar el puerto de exportación en un edge nuevo; import dinámico sólo si hay configuración. | Planificado |
| J4 | Agregar una herramienta MCP | Owner | Entrada en el allowlist con digest del schema; un cambio de schema se rechaza. | Parcial |
| J5 | Agregar una superficie | Contribuidor | Un verbo nuevo o una ruta nueva no puede entrar sin su par y sin paridad probada. | Parcial |
| J6 | Leer la arquitectura desde el árbol | Contribuidor | Cada carpeta se llama por su rol o su familia; el barrel raíz es sólo un barrel; ninguna narración de historia en el código. | Parcial |

---

## Lo que deliberadamente no hace

- No corre en la nube ni tiene multi-tenancy: un plane por máquina, un operador.
- No autentica lecturas ni cifra el transporte: loopback es la frontera.
- No publica, no agrega remotos y no adopta ningún repositorio de producto sin un acto explícito del owner.
- No carga plugins en runtime ni código remoto.
- No exige ningún vendor: ni motor durable, ni observabilidad, ni SDK de modelos, ni MCP remoto.
- No reproduce transcripts como estrategia de recuperación: la continuidad es por digests y checkpoints.
- No limpia, resetea ni restaura worktrees a la fuerza, nunca.

## Conteo por estado

| Estado | Casos |
| --- | --- |
| Hoy | 22 |
| Parcial | 37 |
| Planificado | 8 |
| Propuesto | 31 |
| Total | 98 |
