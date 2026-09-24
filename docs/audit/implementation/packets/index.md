# Packets: inventario, readiness y especificaciones

Dueño único del concepto **unidad de trabajo**: qué packets existen, cuáles se
pueden asignar hoy, y qué falta congelar en los demás.

[Índice](../../README.md) · [Implementación](../index.md) · [Roadmap](../../roadmap/index.md) · [Migración](../migration/index.md) · [Hallazgos](../../findings/index.md) · [Tests](../../quality/testing/index.md)

**Sólo se asigna un packet con `DESIGN_READY` y `SCOPE_FROZEN`. Esta ronda no
autoriza implementar ninguno.**

## 0. Dos clases de «falta congelar», que no se mezclan

El objetivo es implementación mecánica. Por eso se distingue:

| Clase | Qué es | ¿Legítimo postergar? |
| --- | --- | --- |
| **Readiness operativa** | la lista exacta de rutas contra el HEAD de apertura, la autorización del owner, la elección de proveedor o cuenta, el límite de consumo | **Sí.** Depende de un estado dinámico que no se puede fijar hoy sin mentir |
| **Diseño sin resolver** | un schema, una clave, un algoritmo, una frontera transaccional o un vocabulario que nadie decidió | **No.** O queda decidido en [contratos](../../architecture/contracts/index.md) y en [base de datos](../../architecture/database/index.md), o se lista en §4 como hueco real |

Por eso cada packet lleva **dos estados independientes**:

- **`DESIGN_READY`** — el contrato, el schema, el algoritmo, los invariantes y los
  negativos están decididos. Es lo que esta especificación debe entregar.
- **`SCOPE_FROZEN`** — además, la lista exacta de rutas contra el HEAD de apertura
  está cerrada y la autorización existe. Es lo que el owner y el coordinador
  otorgan, no este documento.

**Un packet se asigna cuando tiene las dos.** No se declara `DESIGN_READY` un
packet cuyo diseño está abierto, y no se esconde diseño abierto detrás de una frase
genérica sobre «schemas pendientes». Las rutas exactas de hoy sirven como **anclas
de partida**, condicionadas al preestado; nunca como autoridad amplia con comodines.

**Cada requisito tiene un dueño explícito en la [correspondencia de los 121 IDs](requirements/index.md).**
Eso no declara cerrado su diseño: §5.1 distingue los huecos materiales.

---

## 1. Inventario

Cada fila declara: qué contrato o schema la gobierna, qué algoritmo está elegido,
qué invariantes y negativos exige, de qué depende, qué familias de archivos toca,
cómo se revierte, y qué le falta congelar. La asignación de requisitos y el hito
único de cierre viven en [requisitos por packet](requirements/index.md), sin
repetir aquí las 121 filas.

Las dependencias distinguen **desarrollo** de **habilitación**: código probado en
un entorno descartable no habilita efectos operativos. G-AUTORIDAD precede todo
packet de producto; P-01–P-04 conservan su autorización bootstrap propia. Los
sufijos nombran entregas acotadas de §1.8, no nuevos IDs ni progreso adicional.
La planificación de olas y conflictos vive en [paralelización](../../roadmap/parallelism/index.md).

### 1.1 M0 — baseline y compuertas

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-01 | Aislar los tests que escriben el checkout vivo | `DESIGN_READY` §2 | [tests §5](../../quality/testing/index.md) | — | confirmar los dos paths contra HEAD y autorización de implementación; no concedida en esta ronda |
| P-02 | Puente de autoridad y admisión documental | `DESIGN_READY` | [migración](../migration/index.md) | diccionario integrado y revisión independiente; P-01, P-03 para verificación segura | operativa: lista literal de rutas; autorización del owner |
| P-03 | Parser de anclas de evidencia | `DESIGN_READY` §3.2 | [tests §6](../../quality/testing/index.md) | P-01 | operativa: rutas contra HEAD |
| P-04 | Cobertura de la compuerta por plataforma | `DESIGN_READY` §3.3 | [tests §10](../../quality/testing/index.md) | P-01, P-03 | operativa: runner y binarios que pinea el owner |

### 1.2 M1–M2 — identidad, contenido, resultado y primera tarea útil

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-05 | Identidad de revisión: preimagen completa del envelope | `DESIGN_READY` | [contratos §3](../../architecture/contracts/index.md), [base de datos §6.2](../../architecture/database/index.md) | P-09/log, P-10, P-08; consumo privado tras P-36/local | operativa: rutas contra HEAD |
| P-06 | Contenido de la instrucción, contrato v1, por CLI, API y local | **Entregado 2026-09-22 (commits A `fdbec5b`, B `f020db2`, C `2a9531a`, CORR `f53abc2`; ADR 0093–0096; decisiones 94–105; cierre auditado por Fable).** Transporte del contenido por CLI, API y local y raíz de composición entregados; la ruta puerta de ingreso → hijo, los clientes reales, local en el daemon, el append de ocurrencias y el smoke son de P-15; el retiro de `objective` va con el primer bump de contrato de P-16, dueño P-16 (decisión 160) (re-apuntado por P-15/D4: los bumps 2.8.0 y 2.9.0 no lo llevaron y el campo sigue en el envelope); la mezcla caracteres/bytes de `INSTRUCTIONS_MAX_CHARS` queda como deuda nombrada; B5 sigue abierto hasta M2. No bloqueante: la palabra de rechazo por modalidad o credencial es el `TRANSPORT_UNAVAILABLE` aplanado (§4.1 `UNSUPPORTED` / §16.2 `CAPABILITY_UNSUPPORTED`), a afinar cuando abra el packet de §16. | [contratos §4.1](../../architecture/contracts/index.md) | P-05, P-18/protocolo, P-36/local | operativa: rutas contra HEAD |
| P-07 | Resultado recuperable: contrato de salida v1 y ocurrencias | **Entregado 2026-09-23 (commits A `6f13fe1`, B `ef60672`, C `cade9cb`, D `66f9b14`; ADR 0097–0100; decisiones 106–115; postauditado por Fable).** Contrato de resultado, par de resultado en el desenlace, tres hechos del puerto, sink privado de salida, decisor, ensamblador, publicador y ocurrencia de respuesta entregados. Límites, de P-15: ningún sitio de producción pasa el registrador de resultado (C9) y el daemon no agrega desenlaces ni ocurrencias; no hay verbo de lectura del resultado; el terminal de la tarea no se acopla al desenlace del efecto (C10); el doble conteo de uso por registro de C (Q-C7) y el retiro de L-P32C-1. B5 y B15 siguen abiertos hasta M2, con P-15. | [contratos §4.2](../../architecture/contracts/index.md), hojas de ejecución y artefactos | P-06, P-18/protocolo, P-36/local; captura de uso: P-32/captura | operativa: rutas contra HEAD |
| P-14 | Bootstrap mínimo: iniciativa y tarea por una puerta real | **Entregado 2026-09-13 (commits A `1418e58`, B `f7cd466`, C `c85eeb8`; ADR 0085–0087; decisiones 70–79).** Deuda nombrada: la existencia del paso dentro del documento del roadmap es de P-26 (ADR 0087, decisión 78); la ejecución del ingreso y la enmienda al ADR 0080 §4 son de P-15; el preflight de `authority[]` es de P-23; las particiones INITIATIVE/STEP son de P-28. **Errata (2026-09-23):** el bootstrap del registry que el párrafo bajo §1 pone en P-14 no se entregó ni se nombró como deuda; lo paga P-15/R (ADR 0104, decisión 127). Diseño: §5. | [contratos §5](../../architecture/contracts/index.md), hoja de planificación | P-05, P-09/log, P-36/local | operativa: rutas contra HEAD |
| P-15 | Composición real de los clientes de API y local, y lectura del resultado | `DESIGN_READY`; **en curso: escalones A `313512d`, B `a0584dd`, C `64b1dfd`, R `fc1e0d1`, D1 `b289b17`, D2 `be3b06f`, D3 `666537c`, D4 `c1bb414`, I `cb81f37` y F0 `8515047`, F `fd84256` y E `a1a8416` (los clientes reales de API y local, y el resolver mínimo de credenciales) entregados; ADR 0101–0108; decisiones 116–160.** **A2 entregado (ADR 0112; decisiones 178–183):** el adapter Claude admite los streams 2.1.280 y 2.1.281 por forma observada, rechaza una versión no observada con `PROTOCOL_UNSUPPORTED` en su primer registro —después del spawn, sin impedir gasto; la compuerta previa al spawn es ND-A2-7— y guarda la versión en el cursor. Queda G; el retiro de `objective` va con el primer bump de contrato de P-16, dueño P-16. **S1 falló (G, 2026-09-24; D-S1-1, decisión 160):** con el CLI 2.1.281 el parser del adapter Claude rechazó con `UNKNOWN_EVENT` el registro `system/thinking_tokens` (registro 1, tras `init`); la sesión se mató y la tarea quedó `FAILED`, `NO_RESULT_RECORDED`, con el uso `UNKNOWN`. **Obligación de A2:** el adapter admite el stream 2.1.281 por forma observada —una tabla de registros sin señal, con conjunto de claves estricto y compuertas por campo, sólo con los valores que una captura muestra, y `estimated_tokens` fuera del uso— sobre la captura completa que el owner autorizó y que se tomó el 2026-09-24 (CLI 2.1.281, saneada `a1bd7d82…095a`); después, una nueva corrida de S1 con su propia autorización. M2 espera esa corrida. **Antes de la nueva corrida de S1 (A2, decisión 183; artefactos del operador):** la cuarta corrección de `s1-assert` (Fable C5: en 2.1.281 el criterio de no-overage se observa sólo como `isUsingOverage === false`; `overageStatus` se afirma sólo donde la clave existe), el hijo del ensayo reconstruido desde la muestra 2.1.281 y la auto-actualización del CLI como condición de parada. **Obligación de E (P-15/F, ADR 0107, decisión 154):** los drills D-F-4 (`API_KEY`, el `fetch` sustituto de E reproduciendo un stream de Messages grabado) y D-F-5 (`LOCAL_OR_SELF_HOSTED`, el stream falso compatible con OpenAI de E) entran por una puerta real y leen de vuelta por `acp result` y el GET privado `taskEffectResult`; E no es aceptable sin esas dos filas. **E las entrega (ADR 0108, decisión 159):** D-F-4 por `POST /tasks` sobre el sustituto de `fetch` (SOCKET_EXERCISED: NONE) y D-F-5 por `acp intake` sobre un socket de loopback real (fixture `.mjs` admitido), con `CREDENTIAL` y `NONE`, leídos por las dos puertas y con el canario barrido de todos los sumideros. **Autorización del owner C4 y E-ND-1:** sólo implementación y pruebas sintéticas; ninguna llamada a una API comercial ni smoke S2. **B15 en dos etapas:** F cierra su aceptación de código; la fila del registro cambia en M2 con G/S1 o un fallo explícito del DT | [contratos §4](../../architecture/contracts/index.md), [arquitectura §6](../../architecture/index.md) | P-06, P-07, P-14, P-13; antes de gasto: P-32/captura, P-33/catalogo | operativa: rutas; elección de proveedor y límite de consumo para el smoke |

### 1.3 M3–M4 — verificación, commit, recuperación y ownership

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-16 | Verificador y auditor ejecutados, con receipt completo | `DESIGN_READY` | [contratos §12](../../architecture/contracts/index.md), [base de datos §6.6](../../architecture/database/index.md) | P-15, P-18/protocolo, P-36/local | operativa: rutas. **Obligación heredada:** retiro de `objective` del envelope con el primer bump de contrato de P-16 (re-apuntado por P-15/D4, y sin versión fija por la decisión 160: si otro paquete sube antes `CONTRACT_VERSION`, la obligación sigue al primer bump de P-16; mueve los vectores de envelope_sha256, decisión 48; el write-set de ese corte incluye task-envelope). **Obligación heredada de S1 (D-S1-2, decisión 160):** la forma registrada del daemon rechaza un write-set vacío (`WRITE_SET_EMPTY`, `runtime/src/enforcement:513`) sólo **después** de registrar la cadena del proveedor, así que una tarea `NO_COMMIT` o de sólo lectura no puede llegar a `CHECKPOINTED` y el gasto precede al rechazo (ensayo A de S1; S1 corrió con un write-set de un archivo por fallo del DT). P-16 decide el camino lícito de `NO_COMMIT` —si un write-set vacío es lícito y dónde se rechaza, antes de todo gasto— sin valor por defecto; el vocabulario `READ_ONLY`/`workspaceMode` es de P-17 |
| P-17 | Commit efectivo, con revalidación y SHA observado | `DESIGN_READY` | contratos §12 | efecto: P-16, P-18/protocolo; habilitación: P-18/recuperación | operativa: rutas; autorización de escritura |
| P-09 | Escritura atómica por lote y watermarks | `DESIGN_READY` | [base de datos §5, §11](../../architecture/database/index.md) | P-01; P-02 por G-AUTORIDAD | operativa: rutas |
| P-10 | Identidad de instancia y de restore | `DESIGN_READY` | base de datos §12 | P-09/log | operativa: rutas |
| P-18 | Saga e identidad lógica mínima: outbox, incertidumbre, fencing y cuarentena | `DESIGN_READY` | [contratos §7, §13](../../architecture/contracts/index.md), [ejecución §§3/6/7/8](../../architecture/database/execution/index.md), base de datos §11 | protocolo: P-09/log, P-05; recuperación: P-15, P-36/local y P-17/efecto para Git | operativa: rutas. **Obligaciones registradas por P-15/D3 (ADR 0105):** (1) un lector de las entregas que quedaron `INTENDED` y de las `SETTLED` sin terminal ni marcador de una tarea no terminada — hoy ningún lector las lista, sólo `INFLIGHT` llega por `listOverdueDispatchAttempts`; (2) un predicado de vencimiento consciente de V2, porque `requested_at` = `submittedAt` y una entrega V2 `INFLIGHT` vence desde su primer instante; (3) la frontera del lease diferido: un crash entre el acquire y la apertura, seguido de un sucesor rechazado antes de su propia apertura, no deja evidencia en ningún sitio. **Obligación registrada por P-15/I (ADR 0106, decisión 147):** la entrada indulgente del árbitro de leases pasa por `Date.parse` y desplaza fechas imposibles (30 de febrero → 2 de marzo, hora 24 → medianoche siguiente, 2026-02-29 → 1 de marzo); decidir si la puerta del lease las rechaza. Latente, no abierta: en producción el `now` del árbitro es el reloj de la composición y todo `expiresAt` se deriva de él, ambos canónicos, y la puerta del archivo de configuración no fija un reloj; sólo un `clock` programático (tests) llega a esa ruta. La suite del árbitro fija el comportamiento actual. **Deuda heredada nombrada por P-15/F (ADR 0107, decisión 152):** `daemon/src/composition` (`:270`) conserva su propia copia del lease store que rechaza toda tenencia (`READER_LEASE_STORE`, del lector de bloques de instrucción); el ledger ya tiene la suya en `readByReference`, a la que P-15/F movió la del objetivo. Plegarla —leer los bloques por `readByReference`— cuando P-18 reabra la composición del daemon para la recuperación. **Heredado de P-15/E (ADR 0108, decisión 159) y de S1 (F1, D-S1-3):** la palabra cerrada del error de transporte (`PROVIDER_RATE_LIMITED`, `PROVIDER_UNREACHABLE`, `UNKNOWN_EVENT`…) vive sólo en el `detail` del evento `error` del puerto y el daemon guarda el trail como digest; `TASK_FAILED` no registra causa. Persistir más allá del digest la palabra cerrada del fallo de transporte y la causa cerrada del fallo de la tarea es de este paquete. **S1 lo amplía (D-S1-3, decisión 160):** también el rechazo del parser (`UNKNOWN_EVENT` en el registro 1) se pierde en la frontera del puerto (`TRANSPORT_UNAVAILABLE` en `events.error`), y la única huella fue un stack no capturado en el stderr del daemon, que salió con 1; sin el tee privado S1 no se podía diagnosticar. La causa cerrada de `TASK_FAILED` cubre también los rechazos del parser, y el fallo no depende de una excepción no capturada para verse. **Obligación registrada por S1 (D-S1-4, decisión 160):** `task_attempt_read_model` no tiene productor de `ended_at`/`outcome` —nulidad declarada en la migración 12 (ADR 0073), a la espera de quien adjudique el mapeo de estado terminal a `effect_outcome_status`—; medido en una copia del ledger de S1: tras `TASK_FAILED` el intento sigue con `ended_at` y `outcome` `NULL`. Adjudicar ese mapeo y cerrar el intento con el par entero (`ck_task_attempt_read_model__outcome_pair`, nunca la mitad) es de este paquete |
| P-08 | Integridad del stream de cuentas | `DESIGN_READY` | base de datos §9 | P-09/log, P-10 | operativa: el preflight de duplicados no se ejecutó; su resultado puede exigir decisión del owner |

### 1.4 M5–M6 — cuentas, continuidad y daemon residente

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-19 | Reservas, ventanas de cuota y presión real | `DESIGN_READY` | [contratos §6](../../architecture/contracts/index.md), hoja de cuentas | P-08, P-15, P-18/recuperación | operativa: rutas; cuentas reales para la prueba de presión; activar presión con handoffs exige cierre N15/P-20. **Ceguera de cuota declarada por P-15 (ADR 0105):** un walk V2 no escribe `TOKEN_USAGE_RECORDED`, así que la cuota y los rollups no ven su gasto hasta que P-19 pliegue las liquidaciones (D3); y desde D2 Codex y Kimi no emiten uso, así que la cuota V1 ya es ciega para ellos. **Obligación registrada por P-15/I (ADR 0106, decisión 147):** las dos declaraciones de `ISO_INSTANT` de accounts (`quota:236`, `routing:642`) son una misma gramática heredada con desfase y calendario estricto, espejada y fijada por un test; plegarlas en una constante local de accounts cuando P-19 abra cuota y ruteo. No es la canónica y no se pliega en `isCanonicalInstant`. **Heredado de P-15/E (ADR 0108, decisión 155; C-E5):** E adelantó sólo el resolver mínimo (`file://` sobre el `credentials.local.json` derivado junto al archivo de cuentas, para las dos hojas HTTP), modificando puntualmente la decisión 60; siguen siendo de P-19 `keychain://`, la rotación, varias credenciales por cuenta, la caché, la revocación, las reservas y el miembro de presión para los transportes no-CLI. **Fila de dueño de P-15/A2 (ADR 0112, decisiones 179 y 183):** el adapter Claude admite `rate_limit_event` con `status: "allowed_warning"` (observado en 2.1.281 sobre la ventana `seven_day`) y los números de cuota del registro (`utilization`, `surpassedThreshold`, `unifiedWindows`) sin emitir señal; mapear esa información a una presión o a un throttle es una afirmación de capacidad que decide P-19, y hasta entonces L-V2B1F4-5 sigue prohibiendo un `pressure` de Claude |
| P-20 | Handoff con múltiples segmentos y presión por generación | `DESIGN_READY` | [contratos §8](../../architecture/contracts/index.md), [ejecución §4.1](../../architecture/database/execution/index.md), N15 | P-19, P-07, P-18/recuperación | operativa: rutas; perfil de proveedores |
| P-21 | Daemon residente: cola, concurrencia y reap | `DESIGN_READY` | [contratos §2.1](../../architecture/contracts/index.md), [tests §9.4](../../quality/testing/index.md) | P-13, P-14, P-15, P-18/recuperación; límites de cuenta: P-19; concurrencia con gasto: P-34/admisión antes de habilitar | operativa: rutas |
| P-22 | Cancelación, attach, señales y timers | `DESIGN_READY` | [contratos §7.1](../../architecture/contracts/index.md) | P-21, P-18/recuperación | operativa: rutas |

### 1.5 M7–M8 — integraciones, herramientas y aislamiento

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-23 | Descriptores de adapter, composición y conformidad | `DESIGN_READY`: H-5 adjudicado | [integraciones §4](../../architecture/integrations/index.md), [composición y documentos de contrato](../../architecture/integrations/composition/index.md) | garantías: P-15 y primitiva compartida de contratos §2.0; composición: desarrollo tras P-15; habilitación M7 tras P-18/recuperación, P-21/P-22 y P-20/P-24 según perfil | operativa: familias/perfiles anunciados, evidencia de interacción y write-set exacto |
| P-11 | Error de herramienta nunca es éxito | `DESIGN_READY` | [contratos §4.2](../../architecture/contracts/index.md) | P-01 | operativa: rutas |
| P-24 | Descubrimiento, schema versionado y paginación de herramientas | `DESIGN_READY`; **primer corte (sólo fixtures) entregado: una herramienta se llama sólo bajo el schema con que se permitió — pin `inputSchema` obligatorio comparado por valor, lista paginada y acotada, descubrimiento antes de cada llamada, `SCHEMA_MISMATCH`; ADR 0109; decisiones 161–164.** Quedan, cada una con su dueño aquí: (a) un verbo de descubrimiento en las puertas (entrada nueva con su e2e y paridad); (b) `outputSchema`/`structuredContent` (`OUTPUT_SCHEMA: "NOT_READ"`); (c) la ventana B en la composición del daemon con conexiones largas: re-listar por llamada o confiar en la notificación —corte de integración productiva de P-24; si la composición se asigna a P-21, la obligación se mueve con ella y no queda sin dueño—; (d) el perfil real y sus permisos del owner (servidores, binarios, alcance, roles de escritura, credenciales, conformidad viva, exposición al modelo, gasto, egreso de red, captura de frames, revisiones aceptadas, qué puede llevar un resultado al prompt); (e) varios pines aceptados por herramienta, sólo si el owner lo quiere | integraciones fila 6 | P-11; integración productiva: P-06, P-07, P-18/protocolo | operativa: rutas |
| P-25 | Sandbox de proceso, o su ausencia declarada | `DESIGN_READY` | integraciones fila 16 | P-21 | operativa: mecanismo de aislamiento que elija el owner |

### 1.6 M9–M11 — producto, observabilidad y economía

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-26 | Iniciativas, revisiones de roadmap y pasos | `DESIGN_READY`; **corte A entregado: la ley de versión de roadmap corre dentro del append (requisito A2) — la puerta de iniciativa decide con `decideRoadmapVersion` bajo su propio `BEGIN IMMEDIATE`, el gateway responde una negativa de la puerta como `WRITE_CONFLICT`, sólo inserción por las dos claves en el pliegue, séptima palabra `VERSION_ID_REUSED`, migración 24 con índice único y preflight sobre el stream; ADR 0110; decisiones 165–170.** **Corte B entregado: una versión declara sus pasos, todo o nada — manifiesto privado `PLAN_DOCUMENT`, un `ROADMAP_STEP_DECLARED` por paso con título, digests y `dependencyRank`, puerta de lote con replay juzgado entero, la puerta re-deriva desde el manifiesto leído por referencia, doce palabras, un productor, migración 25, `CONTRACT_VERSION` 2.10.0 con sus tres actos y API 0.20.0; ADR 0111; decisiones 172–177.** Quedan, además, (e) **corte C**: A10, el diff por `stepId` y la ruta de lectura de pasos; (f) transiciones de estado de paso → P-27; routing STEP → P-28; (g) G-UI: vista de pasos, el timeline que muestra un paso como "Active → Active" y la lista `DECISION_REFUSAL_NAMES` a ampliar con las cinco palabras de paso; (h) un manifiesto publicado y no referenciado tras perder una carrera en la puerta → recolector de P-36 (ND-B7). Registro previo al corte B, cumplido por él: (a) **corte B** (ND-6, ND-7): pasos declarados por una puerta de lote de iniciativa todo-o-nada con replay juzgado por lote entero (un replay parcial es una familia de fallo nueva que el brief de B debe nombrar), manifiesto privado `PLAN_DOCUMENT`, `stepId` acotado y estable entre versiones, ciclos rechazados en la puerta, cohorte de `RoadmapVersion` desde 2.10.0, la ubicación del resultado de ciclos de la planificación §4 en la edición de spec de B, y el cuarto tipo de evento como bump de API; la consola mostrando un paso como "Active → Active" es límite declarado bajo G-UI; (b) **corte C**: A10 y el diff por `stepId`; (c) **decisiones del owner ND-4 y ND-5**: correr la migración 24 sobre un ledger real del operador es autorización del owner, y si su preflight lo rechaza, o su stream tiene un evento de roadmap malformado, la salida es una entrada de excepción o un ledger en cuarentena — la migración nunca borra ni renumera; (d) UI de pasos y diff (G-UI) y un verbo de CLI para escribir roadmap, fuera de API_ONLY; bajo G-UI también: `DECISION_REFUSAL_NAMES` de la consola no incluye `WRITE_CONFLICT` (preexistente: una carrera perdida se muestra como "Refused: unknown." con el mensaje) ni `VERSION_ID_REUSED` (hoy inalcanzable desde el gateway). La habilitación M9 sigue condicionada por M3, M5, M6 y P-34/admisión | hoja de planificación | P-14; habilitación M9: M3, M5, M6; habilitación de equipos: P-34/admisión | operativa: rutas |
| P-27 | DAG, nodos, aristas y predicado READY | `DESIGN_READY` | [base de datos §7](../../architecture/database/index.md), hoja de planificación | P-26, P-05; despacho: P-19, P-21 | operativa: rutas |
| P-28 | Equipos por paso, aprobaciones, espera humana y adjudicación | `DESIGN_READY` | contratos §5 y §12, [interacción §3](../../architecture/contracts/interaction/index.md), planning §8.1 | P-27, P-16; equipos activos: P-19, P-21, P-22; habilitación de equipos: P-34/admisión | operativa: rutas y perfil de espera explícito |
| P-29 | Coordinador durable, simulación de plan y consulta de hito | `DESIGN_READY` | hoja de planificación §7/9/11, [estimación](../../architecture/contracts/estimation/index.md) | P-28, P-20, P-21, P-22; habilitación M9: M3, M5, M6; habilitación de equipos: P-34/admisión | operativa: rutas; elección de modelo coordinador |
| P-30 | Telemetría conectada, avisos y alertas locales | `DESIGN_READY` | integraciones filas 14/18; coordinación §6.1–6.2; [interacción §2](../../architecture/contracts/interaction/index.md); [tests §8](../../quality/testing/index.md) | P-21, P-18/recuperación | operativa: rutas y perfil local de avisos explícito |
| P-31 | Stream: vivacidad, epoch, contrapresión y diagnóstico | `DESIGN_READY` | contratos §14, base de datos §12 | P-10, P-12, P-30 | operativa: rutas |
| P-32 | Liquidación de uso | `DESIGN_READY` | [base de datos §13.1](../../architecture/database/index.md) | captura: P-18/protocolo, P-14; cierre completo: P-19, P-07 | operativa: rutas |
| P-33 | Precios, costos y pronóstico con incertidumbre | `DESIGN_READY` | base de datos §13, economy/performance, [estimación](../../architecture/contracts/estimation/index.md) | catálogo: P-14, P-36/local; costos: P-32, P-16; cierre M11: M9, M10 | operativa: rutas |
| P-34 | Presupuesto efectivo y anomalías de consumo | `DESIGN_READY` | contratos §5 y §7; [interacción §5](../../architecture/contracts/interaction/index.md); execution §11 | admisión/enforcement: P-19, P-22, P-23/garantías, P-32/captura, P-33/catalogo; cierre completo: P-33, P-30 | operativa: rutas y perfil de detección/acción explícito |
| P-35 | Evaluaciones, duelos, desempeño y política de routing | `DESIGN_READY` | integraciones fila 15; [interacción §4](../../architecture/contracts/interaction/index.md); planning §9.3; economy §7 | P-33, P-16, P-28; runner/juez con gasto: P-34; cierre M11: P-29, P-31 | operativa: rutas; autorización de gasto para evaluar |

#### Extensión de P-35: decisiones delegadas

Incorporada por orden expresa del owner, separada del alcance original de la fila
anterior. **PLANIFICADA, no DESIGN_READY ni SCOPE_FROZEN.** Jev + Laya son los dos
adapters IA requeridos para esta entrega; reglas o mocks no sustituyen al segundo.
Al llegar a P-35, el DT debe incorporar esta extensión al brief y al perfil, no
tratarla como una sugerencia externa ni omitirla silenciosamente. El
[roadmap §2.1](../../roadmap/index.md#21-decisiones-delegadas) posee el alcance y
su medición separada; [integraciones §8](../../architecture/integrations/index.md#8-decisiones-delegadas)
posee arquitectura y aceptación; [paralelismo §1.5](../../roadmap/parallelism/index.md#15-decisiones-delegadas)
posee su concurrencia. No agrega IDs de cierre a los 39 originales.

| Corte de la extensión | Dependencias y condición de salida |
| --- | --- |
| Diseño y oráculos | Preparación RO adelantable. Antes de declarar DESIGN_READY: contrato, diccionario/migración y folds, métricas/umbrales previos al benchmark, versiones/perfiles, negativos y boundaries de autoridad adjudicados. Paths y permisos se congelan al abrir. |
| Camino neutral con consumidor | Diseño aceptado; capacidades de planning P-28/P-29 que use el caller, elegibilidad P-19, recuperación P-18 y composición P-23. Asignación explícita/reglas y recomendaciones usan el mismo contrato; sin puerto huérfano ni efectos antes de su habilitación. |
| Adapters Jev + Laya | Camino neutral aceptado; descriptor, normalización y tests espejo por adapter. Integración serial; las dos implementaciones reales y sus límites deben quedar probados. |
| Evaluación y observación | Dependencias originales de P-35 intactas; P-32/P-33 para uso/precios, P-34 antes de gasto y P-29/P-31 para cierre M11. Corpus/oráculo independiente, conformidad compartida y calidad por perfil. Shadow también requiere consumo admitido. |
| Delegación automática acotada | Cortes previos aceptados; P-19, P-18/recuperación, P-23, P-29 y P-34 conformes. Aplicación con revalidación/OCC, replay, fallback y rollback probados; promoción explícita de política sin autorizar P9. |

P-15, los cierres anteriores y el funcionamiento base no dependen de Jev/Laya.
Si la evaluación de Laya falla, no se certifica sustitución: se eleva una opción
de reemplazo al owner. Una limitación declarada no convierte un requisito de este
perfil en aprobado ni autoriza cerrar la extensión con un solo adapter.

### 1.7 M12–M14 — portabilidad, distribución y certificación

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-36 | Puertos de ledger, artefactos y credenciales, con backup, restore y retención | `DESIGN_READY` | integraciones filas 8, 9 y 11; base de datos §12 | local: P-09/log, P-18/protocolo; cierre M12: P-10, P-18/recuperación, P-23 | operativa: rutas; segundo backend sólo si se anuncia |
| P-12 | Proyección única de claves de payload | `DESIGN_READY` | [estructura §4.1](../../architecture/structure/index.md) | P-01 | rutas congeladas contra HEAD 9fe129e0: write-set P12, 15 rutas (canónico en `P12_WRITE_SET`; [ADR 0070](../../architecture/0070-one-payload-keys-projection-serves-both-doors.md)) |
| P-13 | Extracción de la composición del daemon | `DESIGN_READY` | [estructura §3](../../architecture/structure/index.md) | P-01 | rutas congeladas contra HEAD `a1f47ffc`: write-set P13, 21 rutas en dos escalones (18 del brief + 2 suites de la corrección V10 + la hoja de tipos de V11; canónico en `P13_WRITE_SET`; [ADR 0071](../../architecture/0071-the-daemon-composition-root-leaves-the-barrel.md)) |
| P-37 | Extracciones restantes de estructura y separación de tipos | `DESIGN_READY` | estructura §3 y §5; [arquitectura §7](../../architecture/index.md) | P-13, incremental por seam; cierre M13: P-29, P-36 | operativa: mapa de paths contra HEAD. **Deuda heredada nombrada por P-15/F (ADR 0107):** el `Sha256Hex` privado de `protocol/src/schemas` duplica el `Sha256Hex` de contracts (18 usos en la base, +3 de P-15/F, más la declaración); plegarlo poniendo el `Sha256Hex` de contracts en su barrel y borrando la copia de protocol; `EffectIdParam` pasa entonces a ser alias del de contracts. **Seam pagado (decisión 171):** `Sha256Hex` está en los dos barrels de contracts, protocol no declara ni reexporta ninguno, `EffectIdParam` es alias del de contracts, y L-P37S-1 impide una copia en `protocol/src`. **Queda registrado para un seam posterior (ND-3):** 18 archivos bajo `packages/*/*/src` guardan un predicado regex propio `/^[0-9a-f]{64}$/` (accounts, runtime 3, durability 3, daemon 2, ledger 8 archivos con 12 sitios); son predicados booleanos, no schemas zod, y el seam posible es un solo `isSha256Hex` en contracts |
| P-38 | Distribución e instalación en ambos sistemas operativos | `DESIGN_READY` | §3.3; integraciones §5 | P-04, P-37; superficie de paquetes del perfil estable | operativa: pins que faltan y runners |
| P-39 | Matriz de release, presupuestos de recursos y paquete de evidencia | `DESIGN_READY` | [calidad §7](../../quality/index.md), [tests §9](../../quality/testing/index.md) | P-01…P-38 en el perfil elegido; nunca P-39 mismo ni packs NOT_SELECTED | operativa: perfil final y autorización de certificación |

**Packs opcionales**, con packet propio y **compuerta de selección propia**: migración
de motor en caliente, segundo framework de orquestación, comunicación con agentes
externos, modalidades más allá de texto, y memoria con retrieval. Marcados
`NOT_SELECTED` no se prueban, no se documentan como funcionales y no aparecen en la
matriz del release (§5).

La secuencia de M0 se entrega **por partes**: aislamiento de tests, parser de
anclas, admisión documental y cobertura de plataforma son cuatro trabajos con
riesgos distintos, y no se juntan en un packet.

### 1.8 Entregas internas con condición de salida

Son cortes del packet dueño, **no packets nuevos**: el inventario sigue teniendo
39 IDs. Ninguno cierra el hito completo ni obtiene readiness por su nombre. Sus
rutas se congelan contra el prestate; no se corta una transacción, un fold ni una
invariante para conseguir una entrega pequeña. Si un corte no es separable, su
consumidor espera el código obligatorio completo.

| Entrega | Contenido exacto y condición de salida | Lo que sigue pendiente |
| --- | --- | --- |
| `P-09/log` | Append/cabezas/proyecciones atómicos, causalidad tipada, watermarks y stream registry con eventos de configuración/artefactos. Rebuild al mismo vector y fallo intermedio comprobados. [streams](../../architecture/database/streams/index.md) | No declara integridad de cuentas hasta P-08 ni recuperación de arbiters. |
| `P-18/protocolo` | **Entregado 2026-09-12 (commit de G sobre `a6ed7c3`; ADR 0072–0080).** Biyectividad invocation/intento, lookup lógico antes de ordinal, efecto estable entre segmentos y ocurrencia enlazada a dispatch ([ejecución §6.1](../../architecture/database/execution/index.md)); negativo ack→handoff→replay obligatorio antes de P-23, que consume este mínimo y no crea otra identidad. Efectos, dispatch, intención de comando como evento, ACK, cache outbox reconstruible, CAS y tokens con encarnación. Replay conserva IDs; incertidumbre bloquea reenvío. [coordinación §6–8](../../architecture/database/coordination/index.md) | No certifica las ocho fronteras ni autoriza commit operativo. Productores de efecto, despacho y ocurrencia, y la vinculación de la revisión en el daemon: adopción/recuperación. |
| `P-36/local` | **Entregado 2026-09-13 (commit de D sobre `74d2d81`; ADR 0081–0084; decisiones 58–69).** Publicación privada local con scope, referencia autorizada, generación/pin, exclusión efectiva, hash/fsync/rename antes de referencia y reconciliación de publicación; sin persistir secretos: ningún resolver de credenciales existe, P-36/local lo sostiene como negativo (centinela de credencial rechazado por las guardas del contrato, `SECRET_BEARING` bloqueado) y el `CredentialResolverPort` real es de P-19 ([decisión 60](../../decisions/index.md)). Acceso cruzado, symlink, blob ausente y crash rechazan correctamente. [artefactos §7–10](../../architecture/database/artifacts/index.md) | GC, backup/restore integral y otro backend permanecen deshabilitados hasta sus pruebas. Publicación del `TASK_ENVELOPE` por el productor y ligadura de su referencia en la sumisión: adopción (ADR 0084). |
| `P-32/captura` | **Entregado 2026-09-14 (commits A `f5dc412`, B `b9605dd`, C `a974f87`; ADR 0088–0090; decisiones 80–86).** Productor normalizado por fuente/cuenta/segmento/epoch e identidad no reciclable; observaciones, cortes y fold de settlement que el diccionario exige atómicos. Replay/tardanza/ausencia preservados. [economía §1–2](../../architecture/database/economy/index.md) | Certificación de uso con presión real de P-19 y cierre M11; no se inventa FINAL ni cero. Cableado del walk y normalización real de clases: P-15 (retira L-P32C-1). Quota y rollups sobre settlements: P-19. Precios: P-33. |
| `P-33/catalogo` | Catálogo publicado por documento/versión y pin antes del gasto; intervalo/moneda validados; precio ausente explícito, sin respaldo cero. [economía §3](../../architecture/database/economy/index.md) | Snapshots, prorrateo y presupuesto dinámico completos. |
| `P-23/garantías` | Gate puro compartido de operación/capacidad/garantía (contratos §2.0): SUPPORTED/UNSUPPORTED/UNKNOWN con evidencia del perfil; incluye HARD_COST_BOUND. Lo consumen admisión y solver de composición; no un segundo evaluador ni una inferencia desde consentimiento/costo estimado. Prueba rechazo antes del efecto si la garantía requerida falta o es UNKNOWN. | Solver de grafo, bindings e interacción certificada permanecen pendientes del cierre P-23/M7. |
| `P-34/admisión` | Política y reclamo versionados; admisión y enforcement antes/durante gasto con P-19/P-22, captura y catálogo pinneado. Límite monetario obligatorio exige HARD_COST_BOUND comprobado en la composición; capacidad desconocida/no soportada rechaza antes del efecto. Consentimiento, costo estimado o CLI opaca no garantizan hard cap. Negativos: carrera por el saldo, fuente desconocida, revocación y capacidad ausente. | Reportes/estadísticas de M11 y anomalías H-9 conservan su cierre propio. |
| `P-17/efecto` | Commit real sólo en repositorio descartable autorizado, receipt independiente, base/tree/write-set exactos y SHA observado; comando con postcondición reconciliable. [contratos §12](../../architecture/contracts/index.md) | Escritura automatizada operativa deshabilitada. |
| `P-18/recuperación` | Ocho fronteras de crash, reconstrucción de delivery sin reenvío ciego, cuarentena/ACK y fencing efectivos; writer viejo rechazado y descendiente detenido/reapeado o confinado. Incluye P-17/efecto antes de cerrar la rama Git. [tests §7–8](../../quality/testing/index.md) | No promete power-loss por SIGKILL ni aislamiento por un CAS nominal. |

P-14 incluye el **bootstrap del registry único y de la asignación de rol
versionada**: consume las entidades de accounts/planning contra watermarks de
registry/initiative, antes de admitir la primera tarea. *Errata: P-14 no lo
entregó; lo paga P-15/R, `acp registry` (ADR 0104, decisión 127).* No espera equipos M9 ni
precios M11, ni introduce iniciativa sintética, rating duplicado o default tácito.
El presupuesto y el permiso del smoke se fijan antes de P-15; UIs y packs no
seleccionados no se vuelven dependencias por compartir el contrato.

---

## 2. P-01 — Aislar los tests que escriben el checkout vivo

**`DESIGN_READY`, con write-set candidato de dos rutas.** Es el primer packet
porque desbloquea correr la suite completa ([tests §5](../../quality/testing/index.md)).
La autorización para implementarlo y la comprobación del prestate aún no existen;
por tanto, no se declara `SCOPE_FROZEN` ni se ejecuta en esta ronda.

### 2.1 Write-set exacto: dos archivos

```
packages/entrypoints/daemon/test/launchd/drills/index.test.ts
scripts/architecture/roots.test.mjs
```

**Ninguna otra ruta.** Si hiciera falta una tercera, el packet para y propone la
adición exacta.

### 2.2 Qué hace

1. Mover **seis** drills —los que mutan el árbol o ejercitan la línea base de la
   compuerta— al helper de árbol sintético **que ya existe** en
   `scripts/architecture/roots.test.mjs`.
2. **Dejar donde están** los tests de la plantilla de servicio y los de proceso:
   no mutan el árbol y no son el problema.
3. Reescribir los negativos que se conservan para que afirmen un **diagnóstico
   específico**, no un código de salida distinto de cero:
   - comando de arranque incorrecto;
   - ruta inválida;
   - import prohibido;
   - literal duplicado;
   - intento de cutover.
4. Acompañar cada negativo con un **control positivo** sobre el mismo árbol
   sintético, con el digest del roadmap correctamente repineado en el fixture.

**Forma exacta de las aserciones**, porque un fixture mínimo puede fallar por otras
leyes ajenas al caso:

- **Positivo:** exige la **ausencia del diagnóstico específico esperado**. No exige
  código de salida cero global.
- **Negativo:** exige la **presencia exacta** de ese diagnóstico.

Los seis drills a mover son los que hoy mutan rutas del árbol o ejercitan la línea
base de la compuerta contra el repositorio real; se nombran uno a uno en el brief
del packet, resueltos contra el HEAD de apertura. Los tests de la plantilla de
servicio y los de proceso se quedan.

El comando del proyecto de la compuerta se toma de la configuración real del
repositorio —el manifiesto y la configuración del runner de tests—, no se inventa.
**Este packet no se ejecuta hoy** y **no introduce un testkit nuevo**.

### 2.3 Qué no hace

- **No** introduce un testkit nuevo. El helper de árbol sintético ya existe.
- **No** toca el código de producción.
- **No** modifica la compuerta de arquitectura.
- **No** cambia `.gitignore`, `docs/ROADMAP.md`, `AGENTS.md` ni ningún ADR.

### 2.4 Cómo se verifica

El verificador trabaja **sobre una copia descartable** del repositorio, nunca sobre
el checkout vivo. En esta primera vuelta ejecuta **sólo el proyecto de la
compuerta**, no la suite completa, porque la suite completa es precisamente lo que
este packet habilita.

Oráculo del aislamiento, en tres partes, porque **un hash final igual no prueba que
nunca hubo escritura**: prueba integridad al final, y un test que escribe y
restaura pasaría igual.

1. **Copia descartable** del repositorio, y comparación de hash de la fuente, la
   configuración y la documentación al terminar, **excluyendo los temporales
   declarados** del packet.
2. **Inspección de los destinos de escritura** durante la corrida: todo lo escrito
   cae dentro de los temporales propios que el packet declara.
3. **Prueba de no acceso al checkout vivo**: ninguna ruta del checkout aparece como
   destino de escritura.

### 2.5 Regresión

Para cada uno de los seis drills movidos, una **mutación residual exhaustiva** del
archivo que ese drill dice proteger: si el drill sigue pasando con la mutación
aplicada, el drill no mide lo que afirma.

### 2.6 Rollback

Revertir el diff de los dos archivos. No hay migración, no hay estado persistido y
no hay efecto externo. Es el packet más reversible del programa, y por eso va
primero.

---

## 3. Packets siguientes de M0, por separado

### 3.1 P-02 — Puente de autoridad y admisión documental

El contenido exacto está en [migración](../migration/index.md): qué literales de la
lista exacta cambian, qué documentos de autoridad se actualizan y en qué orden.
**No se ejecuta junto con P-01**, porque toca autoridad y P-01 no toca nada.

### 3.2 P-03 — Parser de anclas de evidencia · `DESIGN_READY`

- **Técnica elegida:** el **escáner léxico de TypeScript que el repositorio ya
  tiene instalado**. Tokeniza el archivo anclado, salta trivia y comentarios, y
  preserva cadenas y sus escapes. No hace falta un AST completo: la propiedad a
  decidir es «este literal aparece en un token de código».
- **Condición de ancla válida**, las cuatro: el ancla **no está vacía**, la lista
  de anclas **no está vacía**, el archivo fuente **no está vacío**, y el literal
  aparece en un **token fuera de comentario**.
- **Negativos obligatorios:** ancla sólo en comentario de línea; ancla sólo en
  comentario de bloque; delimitadores de comentario **dentro de una cadena o de una
  URL**, que no deben confundir al escáner; ancla vacía; lista de anclas vacía; y
  una **mutación del código anclado** que debe hacer fallar la ley.
- **Control positivo:** la línea base actual sigue certificando, con sus punteros
  reales.
- **Límite declarado:** esto es una **prueba de ubicación**, no una prueba de
  conducta. Que un ancla resuelva no demuestra que la propiedad de seguridad se
  cumpla; el test conductual sigue siendo obligatorio y separado.

### 3.3 P-04 — Cobertura de la compuerta en ambas plataformas

Diseño cerrado:

- La cobertura hermética actual en Linux se declara **`PROVISIONAL`**: ejecuta un
  subconjunto y las exclusiones se nombran una por una.
- Un runner de macOS con los binarios pineados soporta hoy las suites específicas
  de ese sistema.
- El packet de distribución (P-38) agrega los pins que faltan para Linux y las
  pruebas de servicio por host, y **sólo entonces** Linux pasa a completo.
- **No se finge que hoy corre la misma suite en los dos sistemas**, y un fallo
  ambiental nunca se convierte en `PASS`.

Falta: qué runner y qué binarios pinea el owner. Es una decisión operativa suya.

---

## 4. P-14 — Bootstrap mínimo de una tarea independiente

El primer camino útil no puede esperar a que M9 esté completo. Diseño decidido:

- La iniciativa es **real**, creada por la puerta mínima de M2. No hay iniciativa
  sintética.
- La asignación de rol se resuelve desde **configuración versionada explícita**.
- `step_id` es nullable **sólo** si la tarea no tiene vínculo con un roadmap. Si lo
  tiene, exige una revisión de roadmap y un paso existentes.
- **Un write-set solapado no rechaza el ingreso de dos tareas a la cola.** Las dos
  entran; compiten por una **reserva activa incompatible**, y el scheduler espera o
  rechaza esa reserva según la política. Nunca hay dos writers sobre el mismo
  worktree.

### 4.1 P-05 — Identidad de revisión

Diseño cerrado: la preimagen cubre **todos** los campos del contrato de envelope y
excluye reloj, intento, cuenta y modelo resuelto
([base de datos §6.2](../../architecture/database/index.md)); la idempotencia de
sumisión es por `(client_scope, client_request_key)` con el digest como
precondición comparada ([contratos §15](../../architecture/contracts/index.md)).

Write-set previsto, a congelar contra el HEAD de apertura: el módulo de sumisión,
el parsing de configuración del hijo del daemon, las interfaces de los transportes
de API y local, el puerto de ejecución, los contratos que definen el envelope, y
los tests espejo de todos ellos. **Se congela entero antes de entregarlo**; no se
entrega como «todos los paths que haga falta».

---

## 5. Huecos de diseño y packs no seleccionados

### 5.1 Huecos de diseño reales

Se listan individualmente en lugar de delegarlos. Ninguno se resuelve improvisando
durante la implementación.

| ID | Hueco | Dueño del cierre | Bloquea | Estado |
| --- | --- | --- | --- | --- |
| H-1 | El schema versionado de bloques de contenido | contratos | P-06 | **CERRADO** en [contratos §4.1](../../architecture/contracts/index.md): contrato de contenido v1 |
| H-2 | La **matriz de traducción de errores** entre las uniones de cada contexto | contratos | la exhaustividad que comprueba el compilador | **CERRADO** en [contratos §16](../../architecture/contracts/index.md): mapa exhaustivo sobre los errores reales del árbol, con origen, fase, estado del efecto y política de reintento |
| H-3 | El conjunto exacto de **sinks protegidos** contra fugas | tests | el negativo 20 | **CERRADO** en [tests §8.1](../../quality/testing/index.md): perfil de sinks, excepciones de lectura privada e inventario de fixtures. El diseño está cerrado; los tests todavía no se escribieron |
| H-4 | La lista literal de rutas canónicas de esta documentación en la compuerta | migración, sobre el inventario integrado y HEAD aceptado | P-02 | **abierto**, y es readiness operativa |
| H-5 | Contrato ejecutable del preflight de composición: schemas de claims/delegaciones/diagnósticos, algoritmo y snapshot/bindings normalizados con su identidad | integraciones y datos | P-23 | **CERRADO de diseño** en [composición](../../architecture/integrations/composition/index.md), contratos strict, algoritmo y diccionario enlazados. Adjudicación del root tras revisión K3 y comprobación independiente acotada de selección, límites, preimágenes y denegación. No acredita adapters ni implementación |
| H-6 | Avisos/alertas G5/D10: configuración, dedup/acuse, tasa por cuenta/modelo y entrega local; una sola outbox | observation + accounts; contratos | P-30 completo | **CERRADO de diseño**: [interacción §2](../../architecture/contracts/interaction/index.md) y [notifications](../../architecture/database/execution/notifications/index.md). LOCAL_INBOX privado, rate por intervalo durable sin reset por policy, tres particiones al mismo corte. DELIVERED no significa leído; caída/acuse perdido no bloquea la tarea ni duplica éxito |
| H-7 | A15/D14/E8: política, muestras, incertidumbre y replay, con UNKNOWN explícito | planning + economy | P-29/P-33/P-35 | **CERRADO de diseño**: [contratos y algoritmos de estimación](../../architecture/contracts/estimation/index.md), [simulation](../../architecture/database/planning/simulation/index.md) y cuota §11.2. Parámetros obligatorios del perfil, forecast condicional, cierre de incertidumbre por recursos y fuentes/reset fijados; no realiza efectos ni gasto |
| H-8 | B17: identidad/admisión del duelo, dos tareas READ_ONLY/NO_COMMIT, presupuesto y árbitro independiente | planning + economy | P-35 completo | **CERRADO de diseño**: [interacción §4](../../architecture/contracts/interaction/index.md) y planning §9.3. QUALITY_ONLY permite costo UNKNOWN visible, no recomendación económica ni hard cap ficticio; todo check puntuable indeterminado produce INCONCLUSIVE. No aplica cambios ni publica política automáticamente |
| H-9 | D18: unidad, cohorte, baseline, muestra, umbral y acción autorizada | economy + runtime | P-34 completo | **CERRADO de diseño**: [interacción §5](../../architecture/contracts/interaction/index.md) y execution §11. Reutiliza la estadística de estimación; datos normalizados, intención separada de confirmación. Baseline ausente no vale cero; repetir detección no repausa; detectar no amplía permisos ni cambia routing |
| H-10 | E9: cohorte exacta, ventana, frescura, muestra y evidencia | economy | P-35 | **CERRADO de diseño**: [algoritmos E9](../../architecture/contracts/estimation/algorithms/index.md) y [performance](../../architecture/database/economy/performance/index.md). Identidad incluye corte, UNKNOWN no es cero, intervalos descriptivos sin claim causal ni benchmark ejecutado |
| H-11 | X19: espera/timer y carrera entre aprobación, cancelación y timeout | planning + runtime | P-28 completo | **CERRADO de diseño**: [interacción §3](../../architecture/contracts/interaction/index.md) y planning §8.1. Cota temporal durable, resolución con CAS y deadline estricto, timers reconstruibles; aviso no concede permiso y grant no acredita ejecución. Otra revisión, revocación o plazo vencido no reanudan |

H-1–H-3 y H-5–H-11 están adjudicados como **diseño**, no como producto.
La revisión cerró los faltantes materiales detectados al mapear los requisitos
originales: no agregó nuevos IDs ni entregas certificadas. H-4 sigue siendo
readiness operativa. Los protocolos y negativos normativos están definidos;
el implementador debe escribir y ejecutar sus pruebas, no inventar políticas
en vuelo. DESIGN_READY no sustituye SCOPE_FROZEN, conformidad, receipts ni
autorización de instalación, gasto o implementación.

### 5.2 Packs no seleccionados

Un pack marcado `NOT_SELECTED` en el perfil de certificación
([calidad §7.1](../../quality/index.md)) **tiene su propia compuerta de
selección** y no se anuncia como soportado mientras no la pase. No se prueba, no se
documenta como funcional, y no aparece en la matriz de compatibilidad del release.
Seleccionarlo más tarde es una decisión registrada, no un efecto lateral de que
alguien escriba un adapter.

---

## 6. Plantilla de un packet

Todo packet nuevo declara, sin excepción:

| Campo | Contenido |
| --- | --- |
| Objetivo | qué requisito o defecto cierra, por ID |
| Write-set exacto | la lista cerrada de rutas, fijada contra el HEAD de apertura |
| Autoridad | los documentos que lo gobiernan, por ruta y digest |
| Algoritmo | la decisión ya tomada, no una exploración |
| Tests | los casos positivos y los **negativos** que debe agregar |
| Regresión | qué prueba existente debe seguir pasando, y cuál debe fallar sin el cambio |
| Rollback | cómo se deshace, y qué estado persistido queda si algo se aplicó |
| Evidencia | qué comandos ejecuta el verificador y qué registra |
| Parada | qué situaciones obligan a escalar en lugar de decidir |

Un packet sin estos campos no tiene `SCOPE_FROZEN`. Si falta un contrato,
schema, algoritmo o invariante, tampoco tiene `DESIGN_READY`; el coordinador debe
adjudicar ese hueco antes de asignarlo.
