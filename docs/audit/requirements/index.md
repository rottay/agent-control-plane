# Requisitos: 99 casos, 22 criterios transversales y su trazabilidad

Dueño único del concepto **requisito**: el catálogo completo y, por cada entrada,
la cadena `requisito → dueño → contrato o caso → entrega → puerta de aceptación`.

[Índice](../README.md) · [Arquitectura](../architecture/index.md) · [Contratos](../architecture/contracts/index.md) · [Datos](../architecture/database/index.md) · [Roadmap](../roadmap/index.md) · [Calidad](../quality/index.md) · [Packets](../implementation/packets/index.md)

Estado: **especificación**. Cobertura de planificación, **no** progreso de
implementación. Ninguna fila afirma que algo esté implementado; la columna
*Situación* describe lo que se leyó en `a92756b`.

---

## 1. Cómo leer una fila

| Columna | Qué significa |
| --- | --- |
| ID | identificador estable. **Los 99 IDs A1–J6 se conservan exactamente**; los 22 `X01–X22` son criterios transversales del alcance ampliado y **no** inflan los 99 |
| Caso | el enunciado conservado del catálogo histórico |
| Dueño | el contexto que posee la capacidad ([arquitectura §3](../architecture/index.md)) |
| Contrato / datos | el eslabón de [contratos](../architecture/contracts/index.md) y la hoja de [datos](../architecture/database/index.md) que lo sostienen |
| Entrega | hitos de construcción de [roadmap](../roadmap/index.md); el único hito de cierre por ID está en la [correspondencia de packets](../implementation/packets/requirements/index.md) |
| Situación | base reutilizable · defecto observado · planificado · pendiente de prueba · diferido |
| Aceptación | la prueba que cierra el requisito, escrita como un hecho falsable |

**La situación no es un porcentaje.** No se publica un número global: esta ronda no
ejecutó 99 escenarios y el alcance de los packs opcionales todavía se está fijando.
Los tres denominadores separados están en [roadmap](../roadmap/index.md).

La aceptación se limita al **perfil de soporte declarado**: sistema operativo,
proveedor, transporte, driver y capacidades. Una combinación no soportada rechaza
antes de iniciar efectos.

---

## 2. A — Iniciativas y planificación

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Registrar una iniciativa | planning | admisión · [planning](../architecture/database/planning/index.md) | M2/M9 | base parcial | Crear iniciativa por comando y por API, sin sembrar tablas a mano; IDs y aislamiento persisten tras reinicio |
| A2 | Escribir y versionar el roadmap | planning | admisión · planning | M9 | base parcial | Revisiones inmutables con autor, digest y OCC; la unicidad `(initiative_id, version)` es una restricción, no una convención |
| A3 | Declarar el roadmap como plan estructurado | planning | admisión · planning | M9 | planificado | Plan validado con paso, dependencia y estado inequívocos; un ciclo o una referencia inexistente rechaza nombrando los nodos |
| A4 | Configurar el equipo por paso | planning | admisión §5 · planning | M9 | planificado | Coordinador, writer, verificador y auditor configurables por paso; la independencia writer/verificador se comprueba en el receipt |
| A5 | Descomponer un paso en un grafo de tareas | planning | admisión · planning | M9 | planificado | El DAG ejecuta sólo nodos que cumplen el predicado READY de cuatro condiciones; fan-in, límite de concurrencia y política de dependencia fallida medidos |
| A6 | Pedir un plan al coordinador y registrarlo | planning | admisión · planning | M9 | planificado | La propuesta del modelo queda versionada y no se ejecuta sin la aprobación exigida |
| A7 | Aprobar o rechazar un plan, un paso o un commit | planning | admisión §5 · planning | M3/M9 | base parcial | La aprobación fija sujeto, digest de revisión y vencimiento; repetida es replay, distinta es conflicto, vencida es `STALE` |
| A8 | Pausar, reordenar o cancelar | planning | admisión · planning | M6/M9 | planificado | Reordenar no mueve tareas en vuelo; cancelar las lleva a un terminal explícito con su checkpoint intacto |
| A9 | Ver el portafolio | planning | consulta · planning | M9 | base parcial | Dos iniciativas con estados y agregados independientes, con paginación real |
| A10 | Comparar versiones de roadmap | planning | consulta · planning | M9 | base parcial | Diff semántico de cambios, roles y dependencias; restaurar una versión previa crea una **revisión nueva** trazable, no reescribe |
| A11 | Fijar modelo y versión por rol | planning | admisión §5 · planning | M7/M9 | planificado | La resolución fija proveedor, modelo y versión observable por rol; un alias mutable no se registra como versión |
| A12 | Precedencia en tres niveles | planning | admisión §5 · planning | M7/M9 | planificado | `defaults → iniciativa → paso → override autorizado`; la política de autoridad fija techos que el override no ensancha |
| A13 | Validar la edición fail-closed | planning | admisión §5 · economy | M9 | planificado | Modelo inexistente, retirado, no elegible para el rol o no admitido para el transporte rechaza con la razón; retirado **propone migración**, nunca degrada en silencio |
| A14 | Recomendación de independencia | planning | admisión §5 · planning | M9 | planificado | Mismo worker o mismo proveedor produce una recomendación registrada sin bloquear; la ley dura sigue siendo el receipt con verificador distinto del writer |
| A15 | Simular un plan antes de ejecutarlo | planning | consulta · planning | M9/M11 | planificado | El dry-run explica capacidades, dependencias y costo estimado sin spawn ni consumo de cuota |

## 3. B — Ejecución

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Someter una tarea | runtime | petición §3 · [execution](../architecture/database/execution/index.md) | M1/M2 | defecto N01 | Dos envelopes que difieren en cualquier campo del contrato producen digests distintos; una tarea entra por una puerta real y genera trabajo |
| B2 | Elegir la ruta | runtime + accounts | admisión §5 · execution | M5/M7 | base parcial | Selección justificada por política, capacidades y cuenta; un requisito desconocido rechaza antes de gastar |
| B3 | Reservar cuenta y worktree | accounts + runtime | reserva §6 · [coordination](../architecture/database/coordination/index.md) | M4/M5 | base parcial | Reserva concurrente atómica; tras recuperación, cada reserva queda conservada o liberada de forma consistente en ambas bases |
| B4 | Verificar el prestate | runtime | dispatch §7 · execution | M3/M4 | base parcial | El prestate se lee de verdad antes del efecto; una diferencia rechaza sin mutar el workspace |
| B5 | Abrir la sesión con la instrucción | runtime + providers | contenido §4 · execution | M1/M2 | defecto N02 | El prompt exacto llega por CLI, API y local admitidos; un handshake rechazado **no** cuenta como soporte |
| B6 | Seguir la ejecución en vivo | observation | resultado §10 · streams | M10 | base parcial | El stream muestra ejecución real, reconecta sin huecos ni duplicados y distingue silencio de desconexión |
| B7 | Ejecutar herramientas acotadas | runtime + tools | dispatch §7 · execution | M8 | defecto N07 | Permiso, schema y herramienta ligados; un error de herramienta nunca produce un receipt exitoso |
| B8 | Verificar conformance del write-set | runtime | conformance §13 · execution | M3/M8 | base parcial | La conformance se calcula sobre efectos reales; una salida fuera del set impide la aprobación y conserva la evidencia |
| B9 | Escribir un checkpoint | runtime | checkpoint §11 · execution | M1/M4 | base parcial: escritura sí, lectura sin consumidor | Un checkpoint escrito se **rehidrata** y continúa el trabajo; hoy `persist` tiene caller productivo y `read` no |
| B10 | Cancelar, reattach, señales y timers | runtime + durability | dispatch §7 · execution | M6/M7 | base parcial | Cada verbo tiene semántica efectiva por driver; cancelación aceptada y proceso terminado son dos hechos distintos |
| B11 | Recuperar tras un crash | runtime | dispatch §7 · [datos §11](../architecture/database/index.md) | M4 | defecto N04 | Crash en cada ventana: sin efecto conocido duplicado; el desenlace incierto y su costo quedan visibles |
| B12 | Ejecutar tareas en paralelo | runtime | reserva §6 · coordination | M5/M6/M9 | base parcial | Dos tareas independientes avanzan a la vez sin doble lease ni exceso de presupuesto |
| B13 | Correr en modo sólo lectura | runtime | commit §12 · execution | M2/M3/M8 | defecto N03 | `NO_COMMIT` omite autorización y commit pero permite editar dentro del write-set; `READ_ONLY` impide mutar workspace y herramientas y permite estado interno. Ninguno produce confirmaciones ficticias |
| B14 | Reintentar con otra ruta | runtime | handoff §8 · execution | M4/M5/M7 | base parcial | La ruta nueva conserva revisión, autoridad y checkpoint compatible; una ruta no capaz rechaza |
| B15 | Registrar el resultado | runtime | resultado §10 · execution | M1/M2 | defecto — marcador P-15/F (ADR 0107, decisión 154): aceptación de **código** por las puertas reales en ambos sentidos con hijos sintéticos; la fila cambia en M2 sólo con el smoke autorizado G/S1 o un fallo explícito del DT | El resultado es recuperable por referencia y digest, y el terminal es correcto; un conteo de tokens no es un resultado |
| B16 | Escalera de reintento | runtime | dispatch §7 · execution | M4/M5 | planificado | Retry, backoff y escalado acotados por presupuesto; `OUTCOME_UNKNOWN` no se reintenta ciegamente |
| B17 | Duelo de modelos | planning | admisión §5 · planning | M9/M11 | planificado | El duelo sólo sobre tareas sin conflicto de escritura; árbitro independiente y costo de ambos visible |
| B18 | Límites de tiempo | runtime | dispatch §7 · execution | M6/M8 | planificado | El deadline alcanza a hijos y herramientas y distingue solicitud cancelada de proceso realmente terminado |

## 4. C — Verificación, auditoría y publicación

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Verificación independiente | runtime | commit §12 · execution | M3 | defecto N03 | Un proceso verificador distinto ejecuta los checks y produce un receipt sobre base y tree concretos |
| C2 | Auditoría | runtime | commit §12 · execution | M3 | defecto N03 | Un auditor real devuelve un veredicto trazable; un evento `PLAIN` no simula una auditoría |
| C3 | Autorizar y registrar el commit | runtime | commit §12 · execution | M3 | defecto N03 | Política y receipt validados antes de tocar Git; el `commit_sha` se consulta al VCS y coincide con el tree autorizado |
| C4 | Adjudicar tras un rechazo | planning | admisión · planning | M3/M9 | planificado | Un `REJECT` devuelve hallazgos accionables y produce una revisión nueva; no un bucle de auditorías |
| C5 | Consulta en hitos | planning | admisión · planning | M9 | planificado | La consulta se dispara por evento al cerrar una tanda, con contexto compacto, no por polling |
| C6 | Publicar | entrypoints | commit §12 | M3 | base parcial | Publicación sólo con autorización vigente, destino y ref exactos; sin permiso, no hay push |
| C7 | Verificar el receipt al commitear | runtime | commit §12 · execution | M0/M3 | planificado | Existe un receipt independiente **antes** del commit y queda vinculado durablemente a su contenido |

## 5. D — Cuentas y economía

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Registrar cuentas de suscripción | accounts | admisión · [accounts](../architecture/database/accounts/index.md) | M5 | base parcial | Cuenta, proveedor y autenticación aislados; la identidad activa es visible sin revelar credenciales |
| D2 | Estimar la cuota restante | accounts | admisión · accounts | M5 | base parcial | Conocida, estimada o desconocida, con fuente, frescura y margen; nunca una cuota exacta inventada, nunca `UNKNOWN` como 100 % |
| D3 | Enrutar por margen | accounts | admisión §5 · accounts | M5/M11 | base parcial | El routing considera reservas, uso propio y externo y costo, y evita cuentas drenadas o no disponibles |
| D4 | Detectar presión de cuota en vivo | accounts + providers | dispatch §7 · accounts | M5 | planificado | Una señal real del proveedor clasifica cuota, auth y transitorio por separado y provoca una acción acotada |
| D5 | Cambiar de cuenta a mitad de tarea | accounts + runtime | handoff §8 · execution | M4/M5 | defecto N05 | El destino inicia y rehidrata el checkpoint **antes** de confirmar; no se reutiliza la cuenta anterior |
| D6 | Drenar, rehabilitar, re-autenticar u override | accounts | admisión · accounts | M5 | base parcial | Estado efectivo del enum real, con procedencia; un override no bypassa el contrato |
| D7 | Reservas y topes por cuenta | accounts | reserva §6 · coordination | M5 | planificado | Dos workers compiten por el último margen: sólo avanza la reserva admisible |
| D8 | Clase de costo y presupuesto | economy | admisión §5 · [economy](../architecture/database/economy/index.md) | M5/M11 | planificado | Clases de costo, preferencia configurable y topes por iniciativa, paso, tarea y cuenta; una estimación no es un límite |
| D9 | Ver consumo por iniciativa | economy | consulta · economy | M10/M11 | base parcial | El uso agregado se reconstruye desde eventos; lo faltante, tardío o externo no se cuenta como cero |
| D10 | Alertas de cuota y gasto | accounts | consulta · accounts | M5/M10 | planificado | Alertas accionables con límite de tasa y reintentos acotados por cuenta y modelo |
| D11 | Contabilizar tokens por tipo | economy | resultado §10 · economy | M5/M11 | base parcial | Entrada, salida, cache y otros soportados; los desconocidos explícitos, enteros y con procedencia |
| D12 | Tabla de precios versionada | economy | admisión · economy | M11 | planificado | Catálogo versionado con vigencia, moneda, unidad y fuente, sin intervalos solapados; el replay usa la versión correcta |
| D13 | Costo en dólares por iniciativa | economy | consulta · economy | M11 | planificado | El costo se deriva de uso × versión de catálogo con rebuild determinista, sin hecho de costo independiente; precisión fija y separación entre gasto API, equivalente y prorrateo |
| D14 | Pronóstico para terminar | economy | consulta · economy | M11 | planificado | El pronóstico incluye intervalo e incertidumbre y datos suficientes; no una fecha inventada |
| D15 | Retorno de cada suscripción | economy | consulta · economy | M11 | planificado | ROI con ventana, uso y prorrateo explicados; la cuota no equivale a dinero marginal |
| D16 | Costo por resultado | economy | consulta · economy | M11 | planificado | Incluye fallos, reintentos, auditores y consumo ambiguo |
| D17 | Exportar uso y costo | economy | consulta · economy | M11 | planificado | Export neutral, reproducible y acotado, sin credenciales ni prompts |
| D18 | Anomalías de consumo | economy | dispatch §7 · economy | M11 | planificado | Anomalía justificada y configurable; no cambia política en silencio ni amplía permisos |

## 6. E — Modelos y evaluaciones

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Registrar un proveedor por CLI | providers | [integraciones §4](../architecture/integrations/index.md) | M2/M7 | base parcial | Un adapter CLI se registra sin tocar el dominio; handshake, payload, cancelación y uso verificados |
| E2 | Registrar un proveedor por API key | providers | contenido §4 · integraciones | M1/M2/M7 | defecto N02 | La configuración de producto construye el cliente y entrega la instrucción, sin inyector manual oculto |
| E3 | Registrar un proveedor local o self-hosted | providers | contenido §4 · integraciones | M1/M2/M7 | defecto N02 | Un servidor local se selecciona por configuración y entrega contenido, resultados y límites reales |
| E4 | Mantener un único registry de capacidades | accounts | [datos §4](../architecture/database/index.md) · economy | M7/M11 | base parcial | Un registry de calidad y capacidades; el manifiesto de instalación no duplica ratings |
| E5 | Confirmar capacidades con un sujeto real | providers | admisión §5 | M2/M7/M14 | pendiente de prueba | Un smoke real acotado, con autorización de consumo, fija versión, proveedor y perfil |
| E6 | Evaluar modelos | economy | admisión · economy | M11 | defecto N12 | Runner, dataset, juez, uso y timestamps válidos; un productor que no ejecuta modelos no cuenta como evaluación |
| E7 | Routing adaptativo | economy + accounts | admisión §5 · economy | M11 | planificado | Una versión nueva de política basada en muestras reales, con canary, decisión y rollback trazables |
| E8 | Replay y what-if | economy | consulta · economy | M9/M11 | planificado | Replay histórico sin efectos, con what-if distinguido de medición real |
| E9 | Tabla de desempeño por modelo y rol | economy | consulta · economy | M11 | planificado | Calidad por rol, tarea y modelo, con tamaño de muestra, frescura e incertidumbre |

## 7. F — Trazabilidad y observabilidad

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Reconstruir la cadena completa de una tarea | observation | §14 digests · execution | M1/M3/M10 | base parcial | Instrucción → ruta → efectos → resultado → receipt reconstruible por IDs y digests |
| F2 | Leer un prompt o una respuesta | observation | §14 · [artifacts](../architecture/database/artifacts/index.md) | M1/M10 | planificado | Lectura autorizada de artefactos privados, con tamaño, retención y redacción; no un endpoint público |
| F3 | Verificar la integridad | persistence | [datos §9](../architecture/database/index.md) | M4/M5 | base parcial | La integridad cubre los cuatro streams y declara desde qué secuencia protege |
| F4 | Navegar la línea de tiempo | observation | consulta · streams | M10 | base parcial | Timeline causal paginada, con IDs estables y límites de lectura |
| F5 | Exportar telemetría neutral | observation + telemetry | integraciones fila 14 | M10 | defecto N11 | Un dispatcher productivo entrega OTLP, muestra fallos parciales y no bloquea tareas |
| F6 | Correlacionar logs y trazas | observation | §14 | M10 | base parcial | Correlación por run, tarea, intento y efecto, sin prompt crudo ni secretos |
| F7 | Medir la línea de base | observation | consulta · economy | M10/M11 | base parcial | Métricas reales de throughput, latencia, recursos, uso y fallos antes de optimizar |
| F8 | Saber quién hizo qué | observation | §14 · streams | M3/M10 | base parcial | Actor, autenticación y autoridad registrados; un evento no usurpa a un worker que no corrió |

## 8. G — Superficies

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | Operar todo desde la CLI | entrypoints | [estructura §4.3](../architecture/structure/index.md) | M2/M14 | base parcial | Cada operación anunciada tiene verbo contractual y exit codes verificables |
| G2 | Operar todo desde la API local | entrypoints | estructura §4.3 | M2/M14 | base parcial | Las mismas operaciones por API local autenticada, no sólo consultas |
| G3 | Operar todo desde la consola | entrypoints | estructura §4.3 | UI posterior | **diferido** | Se conserva el contrato para la UI; su diseño e implementación no forman parte de esta ronda |
| G4 | Confiar en que las tres dicen lo mismo | entrypoints | estructura §4.3 | M2/M14 + UI posterior | base parcial | Expectativas independientes; comparar dos llamadas al mismo helper no demuestra paridad |
| G5 | Recibir avisos | observation | integraciones fila 18 | M10/M12 | planificado | Aviso por adapter configurable, sin duplicados silenciosos, y su caída no detiene el trabajo |

## 9. H — Seguridad y operación

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | Garantizar que ningún secreto entra | kernel + runtime | §14 egress | M1/M8/M14 | defecto N08 | Garantía acotada a superficies con schema y pruebas sintéticas; no una promesa universal por regex |
| H2 | Mantener el plane en loopback | entrypoints | [estructura §4.2](../architecture/structure/index.md) | M8/M14 | base parcial | Listener y control en loopback; el egress hacia modelos y telemetría es explícito y por destino permitido |
| H3 | Un solo writer por worktree | runtime | reserva §6 · coordination | M4/M8 | base parcial | Lease y fencing efectivos ante crash; el writer viejo no puede continuar |
| H4 | Aislar el proceso hijo | providers | integraciones fila 16 | M8 | planificado | El sandbox bloquea filesystem y red fuera del perfil; el modo no aislado lo declara y exige política |
| H5 | Respaldar y restaurar el ledger | persistence | [datos §12](../architecture/database/index.md) | M4/M12 | base parcial | Backup consistente de ledger, WAL y artefactos; el restore escribe un `restore_id` nuevo antes de admitir trabajo |
| H6 | Sostener la arquitectura con leyes ejecutables | gobernanza | [calidad](../quality/index.md) | M0/M13 | defecto N06/N09 | Leyes conductuales no vacuas, con parser léxico y anclas no vacías; las mutaciones sólo sobre fixtures |
| H7 | Adoptar el plane en un repo de producto | owner | — | P9 posterior | **diferido** | Requiere autorización separada y un perfil demostrado; los repositorios de producto quedan fuera |

## 10. I — Instalación y durabilidad

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| I1 | Instalar, arrancar y detener el daemon | entrypoints | integraciones fila 4 | M6/M13 | base parcial | Daemon residente instalado, con stop, restart y reap, cola durable y límites |
| I2 | Elegir el motor de durabilidad | durability | [contratos §9](../architecture/contracts/index.md) | M6/M7 | base parcial | Dos drivers reales ejecutan el mismo caso; la semántica avanzada se negocia, no se cambia por un enum |
| I3 | Actualizar pins y volver atrás | entrypoints | [datos §15](../architecture/database/index.md) | M7/M13 | base parcial | Pins, versiones y migraciones compatibles; el rollback de datos no se presume trivial |
| I4 | Diagnosticar | observation | integraciones §4 | M10/M13 | base parcial | El diagnóstico identifica binding, capacidad, cuota y runtime, sin secretos y con acciones claras |
| I5 | Operar sin servicios opcionales | entrypoints | [integraciones §2](../architecture/integrations/index.md) | M7/M10/M14 | base parcial | Funciona con la integración habilitada, ausente y fallando; no basta con que no haya callers |
| I6 | Operar en Linux | entrypoints | [tests](../quality/testing/index.md) | M13/M14 | pendiente de prueba | CI Linux real con perfil completo o exclusiones declaradas; instalación y ciclo de vida probados |

## 11. J — Extensibilidad

| ID | Caso | Dueño | Contrato / datos | Entrega | Situación | Aceptación |
| --- | --- | --- | --- | --- | --- | --- |
| J1 | Agregar un proveedor sin tocar el dominio | providers | [integraciones §4](../architecture/integrations/index.md) | M7 | base parcial | Adapter, descriptor y conformance; sin un enum de marcas en el kernel |
| J2 | Agregar un driver de durabilidad | durability | contratos §9 | M7 | base parcial | El driver implementa el contrato propio sin filtrar tipos de SDK; prueba de selección, reinicio y compatibilidad |
| J3 | Agregar un exporter de telemetría | telemetry | integraciones fila 14 | M10/M12 | base parcial | Usa el mismo dominio y el mismo batch; el dispatcher lo conecta y lo aísla de la ejecución |
| J4 | Agregar una herramienta MCP | tools | dispatch §7 | M8 | base parcial | La herramienta se descubre y se autoriza por schema versionado; un mismatch rechaza |
| J5 | Agregar una superficie | entrypoints | estructura §4.3 | M2/M12 | base parcial | Una puerta nueva sólo consume casos de uso y autorización; sin lógica de negocio clonada |
| J6 | Leer la arquitectura desde el árbol | gobernanza | [estructura](../architecture/structure/index.md) | M13 | base parcial | Los paths cuentan responsabilidad; folder/index, tests espejo y tipos por dueño, sin depósitos genéricos |

---

## 12. Criterios transversales X01–X22

No se contabilizan como implementados ni inflan los 99. Son criterios de diseño y
certificación del alcance ampliado; los adapters especializados se priorizan por
perfil, no todos en un release.

| ID | Necesidad | Dueño | Entrega | Condición verificable |
| --- | --- | --- | --- | --- |
| X01 | Selección independiente de modelo, transporte, cuenta, harness y motor | integraciones | M7 | Cambiar un eje no reescribe casos de uso ni modifica los otros ejes |
| X02 | Continuidad portable | runtime | M4/M5/M7 | El checkpoint conserva autoridad, entrada y resultados; un destino incompatible rechaza |
| X03 | Migración entre motores activos | durability | M7, opcional explícito | Transferencia, fencing, journal y export con protocolo; tener una interfaz no promete hot swap |
| X04 | Identidad de revisión y de efecto | runtime | M1/M4 | Un cambio semántico no reutiliza resultado ni costo de la revisión anterior |
| X05 | Actor, rol y configuración dinámicos | planning | M7/M9 | El coordinador y el modelo cambian por reglas versionadas; ninguna marca queda fija a una responsabilidad |
| X06 | Instalación modular de integraciones | integraciones | M7/M13 | Un pack opcional puede faltar; un manifiesto por instalación, con contratos y capacidades validados; la selección ejecutable pasa el [preflight de composición](../architecture/integrations/composition/index.md), no sólo la validación individual de los adapters |
| X07 | Base de datos intercambiable | persistence | M12 | Ledger transaccional equivalente; sin dependencia de una base compartida de Rottay |
| X08 | Artefactos, límites y retención | artifacts | M1/M12 | Permisos, hash, backup y GC bajo generación exclusiva; una referencia a bytes borrados es explícita |
| X09 | Credenciales y autenticación intercambiables | accounts | M8/M12 | Resolver, identidad y autorización separados; el proveedor de login no posee la política |
| X10 | Memoria y retrieval por iniciativa | integraciones | M12 | Embeddings y vector store seleccionables, con permisos y citaciones; índice reconstruible |
| X11 | Mensajes entre agentes | integraciones | M9/M12 | Inbox y outbox causales e idempotentes; A2A futuro no duplica el scheduler |
| X12 | Harness o framework externo | integraciones | M7/M12 | Un dueño de retry y ownership; los límites y la cancelación atraviesan el harness |
| X13 | Multimodalidad | runtime | M1/M12 | Bloques de contenido versionados; texto, imagen, audio y realtime con capacidades distintas y acotadas |
| X14 | Logs, trazas y métricas | observation | M10 | OTLP con recepción parcial honesta; no depender de un backend para ejecutar |
| X15 | Egress y seguridad de contenidos | runtime | M1/M8 | El prompt sale sólo al destino autorizado; los artefactos privados no aparecen en el stream público ni en trazas |
| X16 | Aislamiento y extensión no confiable | providers | M8 | Perfil de red, filesystem e hijos efectivo; un plugin no hereda la autoridad del host |
| X17 | Límite de gasto y uso incierto | economy | M4/M5/M11 | Desconocido, externo y tardío visibles; no se gasta ni se renueva sin política admitida |
| X18 | Versionado y migración | persistence | M7/M12/M13 | Versiones de schema y de adapter fijadas; estrategia compatible de replay, rollback y downgrade |
| X19 | Notificaciones y espera humana | planning | M6/M9/M12 | Aprobación exacta, con timeout, cancelación y carreras deterministas; la entrega del aviso no concede el permiso |
| X20 | Tests de neutralidad por perfil | calidad | M14 | Con proveedor A y B, ausente, fallando e incompatible; evidencia real, no sólo mocks |
| X21 | Recursos locales y contrapresión | entrypoints | M6/M10/M14 | Límites de disco, memoria, procesos, cola y descriptores; un consumidor lento no agota el daemon |
| X22 | Herramientas productivas extensibles | tools | M8/M12 | Filesystem, git, shell, navegador y retrieval como adapters con permisos y receipts; no se presume que todos estén implementados |

---

## 13. Perfil de certificación: las 121 filas, asignadas

Asignación **exhaustiva y previa**, como exige
[calidad §7.1](../quality/index.md). Ninguna fila cambia de estado después de ver
un resultado.

| Estado | Filas | Cuáles |
| --- | --- | --- |
| `MANDATORY` | **115** | casos: **A1–A15** (15), **B1–B18** (18), **C1–C7** (7), **D1–D18** (18), **E1–E9** (9), **F1–F8** (8), **G1, G2, G4, G5** (4), **H1–H6** (6), **I1–I6** (6), **J1–J6** (6) = 97. Transversales: **X01, X02, X04, X05, X06, X07, X08, X09, X12, X14, X15, X16, X17, X18, X19, X20, X21, X22** = 18 |
| `NOT_SELECTED` | **4** | **X03** migración de motor en caliente · **X10** memoria y retrieval · **X11** mensajes entre agentes externos · **X13** multimodalidad más allá de texto |
| `DEFERRED` | **2** | **G3** consola · **H7** adopción en un repositorio de producto |
| `OPTIONAL_SELECTED` | **0** | ninguno en el primer release; seleccionar uno es una decisión registrada, no un efecto lateral |

115 + 4 + 2 + 0 = **121**. Los 99 casos se reparten en 97 obligatorios y 2
diferidos; los 22 transversales, en 18 obligatorios y 4 no seleccionados.

Notas que evitan malentendidos:

- **G4 se parte.** Su parte de backend —CLI y API responden lo mismo, con
  expectativas independientes— es `MANDATORY`. Su parte de interfaz es `DEFERRED`
  junto con G3.
- **Los transversales `MANDATORY` exigen el contrato, no toda la implementación.**
  Para `X07`, `X09`, `X12`, `X18` y `X22` el objetivo del release es que el
  contrato portable exista, esté probado y tenga al menos una implementación real;
  no que existan todos los adapters imaginables.
- **Dos implementaciones reales** se exigen sólo en las familias que el release
  anuncie como **intercambiables**
  ([integraciones §2](../architecture/integrations/index.md)). Una implementación
  real basta para anunciar **funcional**.
- Un requisito `NOT_SELECTED` **no se prueba, no se documenta como funcional y no
  aparece en la matriz de compatibilidad**. Tiene su propia compuerta de selección
  ([packets §5.2](../implementation/packets/index.md)).
- **X12 se divide por alcance, no por conteo.** Su contrato y un harness nativo
  real, conectado y probado, son `MANDATORY`; el segundo framework externo es
  `NOT_SELECTED`. No se afirma integración externa ni se agrega una fila 122.
- **Cada ID tiene un packet primario y un hito de cierre**, en la
  [correspondencia única de los 121 IDs](../implementation/packets/requirements/index.md).
  Los rangos de Entrega describen construcción, no dos cierres. Un mapeo no
  declara listo el diseño: los huecos materiales se registran en packets §5.1.

---

## 14. Cobertura de las dimensiones de la rúbrica anterior

Los 99 casos describen capacidades; los 71 criterios de la rúbrica histórica
describían **madurez**. No se pierde ninguna dimensión: la trazabilidad criterio a
criterio, con su disposición (conservado, revisado o diferido), vive en
[calidad §5](../quality/index.md). Este documento no la duplica.

---

## 15. Amplitud sin sobreingeniería

«Cualquier necesidad» exige poder agregar capacidades sin romper las existentes; no
permite declarar soporte infinito. El catálogo reserva la frontera de audio,
búsqueda y comunicación sin imponer WebRTC, Temporal, LangGraph, S3 y otro SQL en
el mismo primer release.

El perfil inicial cierra primero: ejecución útil, cuentas, recuperación, equipo y
plan, herramientas, observabilidad y pruebas. Una familia anunciada como
**intercambiable** exige dos implementaciones reales conformes. Una integración
puede anunciarse **funcional** con una implementación verificada, sin reclamar
sustitución probada. Lo no construido permanece como *extensible, no implementado*.
