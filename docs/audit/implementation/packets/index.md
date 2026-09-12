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
| P-06 | Contenido de la instrucción, contrato v1, por CLI, API y local | `DESIGN_READY` | [contratos §4.1](../../architecture/contracts/index.md) | P-05, P-18/protocolo, P-36/local | operativa: rutas contra HEAD |
| P-07 | Resultado recuperable: contrato de salida v1 y ocurrencias | `DESIGN_READY` | [contratos §4.2](../../architecture/contracts/index.md), hojas de ejecución y artefactos | P-06, P-18/protocolo, P-36/local; captura de uso: P-32/captura | operativa: rutas contra HEAD |
| P-14 | Bootstrap mínimo: iniciativa y tarea por una puerta real | `DESIGN_READY` §5 | [contratos §5](../../architecture/contracts/index.md), hoja de planificación | P-05, P-09/log, P-36/local | operativa: rutas contra HEAD |
| P-15 | Composición real de los clientes de API y local, y lectura del resultado | `DESIGN_READY` | [contratos §4](../../architecture/contracts/index.md), [arquitectura §6](../../architecture/index.md) | P-06, P-07, P-14, P-13; antes de gasto: P-32/captura, P-33/catalogo | operativa: rutas; elección de proveedor y límite de consumo para el smoke |

### 1.3 M3–M4 — verificación, commit, recuperación y ownership

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-16 | Verificador y auditor ejecutados, con receipt completo | `DESIGN_READY` | [contratos §12](../../architecture/contracts/index.md), [base de datos §6.6](../../architecture/database/index.md) | P-15, P-18/protocolo, P-36/local | operativa: rutas |
| P-17 | Commit efectivo, con revalidación y SHA observado | `DESIGN_READY` | contratos §12 | efecto: P-16, P-18/protocolo; habilitación: P-18/recuperación | operativa: rutas; autorización de escritura |
| P-09 | Escritura atómica por lote y watermarks | `DESIGN_READY` | [base de datos §5, §11](../../architecture/database/index.md) | P-01; P-02 por G-AUTORIDAD | operativa: rutas |
| P-10 | Identidad de instancia y de restore | `DESIGN_READY` | base de datos §12 | P-09/log | operativa: rutas |
| P-18 | Saga e identidad lógica mínima: outbox, incertidumbre, fencing y cuarentena | `DESIGN_READY` | [contratos §7, §13](../../architecture/contracts/index.md), [ejecución §§3/6/7/8](../../architecture/database/execution/index.md), base de datos §11 | protocolo: P-09/log, P-05; recuperación: P-15, P-36/local y P-17/efecto para Git | operativa: rutas |
| P-08 | Integridad del stream de cuentas | `DESIGN_READY` | base de datos §9 | P-09/log, P-10 | operativa: el preflight de duplicados no se ejecutó; su resultado puede exigir decisión del owner |

### 1.4 M5–M6 — cuentas, continuidad y daemon residente

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-19 | Reservas, ventanas de cuota y presión real | `DESIGN_READY` | [contratos §6](../../architecture/contracts/index.md), hoja de cuentas | P-08, P-15, P-18/recuperación | operativa: rutas; cuentas reales para la prueba de presión; activar presión con handoffs exige cierre N15/P-20 |
| P-20 | Handoff con múltiples segmentos y presión por generación | `DESIGN_READY` | [contratos §8](../../architecture/contracts/index.md), [ejecución §4.1](../../architecture/database/execution/index.md), N15 | P-19, P-07, P-18/recuperación | operativa: rutas; perfil de proveedores |
| P-21 | Daemon residente: cola, concurrencia y reap | `DESIGN_READY` | [contratos §2.1](../../architecture/contracts/index.md), [tests §9.4](../../quality/testing/index.md) | P-13, P-14, P-15, P-18/recuperación; límites de cuenta: P-19; concurrencia con gasto: P-34/admisión antes de habilitar | operativa: rutas |
| P-22 | Cancelación, attach, señales y timers | `DESIGN_READY` | [contratos §7.1](../../architecture/contracts/index.md) | P-21, P-18/recuperación | operativa: rutas |

### 1.5 M7–M8 — integraciones, herramientas y aislamiento

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-23 | Descriptores de adapter, composición y conformidad | `DESIGN_READY`: H-5 adjudicado | [integraciones §4](../../architecture/integrations/index.md), [composición y documentos de contrato](../../architecture/integrations/composition/index.md) | garantías: P-15 y primitiva compartida de contratos §2.0; composición: desarrollo tras P-15; habilitación M7 tras P-18/recuperación, P-21/P-22 y P-20/P-24 según perfil | operativa: familias/perfiles anunciados, evidencia de interacción y write-set exacto |
| P-11 | Error de herramienta nunca es éxito | `DESIGN_READY` | [contratos §4.2](../../architecture/contracts/index.md) | P-01 | operativa: rutas |
| P-24 | Descubrimiento, schema versionado y paginación de herramientas | `DESIGN_READY` | integraciones fila 6 | P-11; integración productiva: P-06, P-07, P-18/protocolo | operativa: rutas |
| P-25 | Sandbox de proceso, o su ausencia declarada | `DESIGN_READY` | integraciones fila 16 | P-21 | operativa: mecanismo de aislamiento que elija el owner |

### 1.6 M9–M11 — producto, observabilidad y economía

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-26 | Iniciativas, revisiones de roadmap y pasos | `DESIGN_READY` | hoja de planificación | P-14; habilitación M9: M3, M5, M6; habilitación de equipos: P-34/admisión | operativa: rutas |
| P-27 | DAG, nodos, aristas y predicado READY | `DESIGN_READY` | [base de datos §7](../../architecture/database/index.md), hoja de planificación | P-26, P-05; despacho: P-19, P-21 | operativa: rutas |
| P-28 | Equipos por paso, aprobaciones, espera humana y adjudicación | `DESIGN_READY` | contratos §5 y §12, [interacción §3](../../architecture/contracts/interaction/index.md), planning §8.1 | P-27, P-16; equipos activos: P-19, P-21, P-22; habilitación de equipos: P-34/admisión | operativa: rutas y perfil de espera explícito |
| P-29 | Coordinador durable, simulación de plan y consulta de hito | `DESIGN_READY` | hoja de planificación §7/9/11, [estimación](../../architecture/contracts/estimation/index.md) | P-28, P-20, P-21, P-22; habilitación M9: M3, M5, M6; habilitación de equipos: P-34/admisión | operativa: rutas; elección de modelo coordinador |
| P-30 | Telemetría conectada, avisos y alertas locales | `DESIGN_READY` | integraciones filas 14/18; coordinación §6.1–6.2; [interacción §2](../../architecture/contracts/interaction/index.md); [tests §8](../../quality/testing/index.md) | P-21, P-18/recuperación | operativa: rutas y perfil local de avisos explícito |
| P-31 | Stream: vivacidad, epoch, contrapresión y diagnóstico | `DESIGN_READY` | contratos §14, base de datos §12 | P-10, P-12, P-30 | operativa: rutas |
| P-32 | Liquidación de uso | `DESIGN_READY` | [base de datos §13.1](../../architecture/database/index.md) | captura: P-18/protocolo, P-14; cierre completo: P-19, P-07 | operativa: rutas |
| P-33 | Precios, costos y pronóstico con incertidumbre | `DESIGN_READY` | base de datos §13, economy/performance, [estimación](../../architecture/contracts/estimation/index.md) | catálogo: P-14, P-36/local; costos: P-32, P-16; cierre M11: M9, M10 | operativa: rutas |
| P-34 | Presupuesto efectivo y anomalías de consumo | `DESIGN_READY` | contratos §5 y §7; [interacción §5](../../architecture/contracts/interaction/index.md); execution §11 | admisión/enforcement: P-19, P-22, P-23/garantías, P-32/captura, P-33/catalogo; cierre completo: P-33, P-30 | operativa: rutas y perfil de detección/acción explícito |
| P-35 | Evaluaciones, duelos, desempeño y política de routing | `DESIGN_READY` | integraciones fila 15; [interacción §4](../../architecture/contracts/interaction/index.md); planning §9.3; economy §7 | P-33, P-16, P-28; runner/juez con gasto: P-34; cierre M11: P-29, P-31 | operativa: rutas; autorización de gasto para evaluar |

### 1.7 M12–M14 — portabilidad, distribución y certificación

| ID | Packet | Diseño | Contratos y schemas | Depende de | Falta congelar |
| --- | --- | --- | --- | --- | --- |
| P-36 | Puertos de ledger, artefactos y credenciales, con backup, restore y retención | `DESIGN_READY` | integraciones filas 8, 9 y 11; base de datos §12 | local: P-09/log, P-18/protocolo; cierre M12: P-10, P-18/recuperación, P-23 | operativa: rutas; segundo backend sólo si se anuncia |
| P-12 | Proyección única de claves de payload | `DESIGN_READY` | [estructura §4.1](../../architecture/structure/index.md) | P-01 | rutas congeladas contra HEAD 9fe129e0: write-set P12, 15 rutas (canónico en `P12_WRITE_SET`; [ADR 0070](../../architecture/0070-one-payload-keys-projection-serves-both-doors.md)) |
| P-13 | Extracción de la composición del daemon | `DESIGN_READY` | [estructura §3](../../architecture/structure/index.md) | P-01 | rutas congeladas contra HEAD `a1f47ffc`: write-set P13, 21 rutas en dos escalones (18 del brief + 2 suites de la corrección V10 + la hoja de tipos de V11; canónico en `P13_WRITE_SET`; [ADR 0071](../../architecture/0071-the-daemon-composition-root-leaves-the-barrel.md)) |
| P-37 | Extracciones restantes de estructura y separación de tipos | `DESIGN_READY` | estructura §3 y §5; [arquitectura §7](../../architecture/index.md) | P-13, incremental por seam; cierre M13: P-29, P-36 | operativa: mapa de paths contra HEAD |
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
| `P-18/protocolo` | Biyectividad invocation/intento, lookup lógico antes de ordinal, efecto estable entre segmentos y ocurrencia enlazada a dispatch ([ejecución §6.1](../../architecture/database/execution/index.md)); negativo ack→handoff→replay obligatorio antes de P-23, que consume este mínimo y no crea otra identidad. Efectos, dispatch, intención de comando como evento, ACK, cache outbox reconstruible, CAS y tokens con encarnación. Replay conserva IDs; incertidumbre bloquea reenvío. [coordinación §6–8](../../architecture/database/coordination/index.md) | No certifica las ocho fronteras ni autoriza commit operativo. |
| `P-36/local` | Publicación privada local con scope, referencia autorizada, generación/pin, exclusión efectiva, hash/fsync/rename antes de referencia y reconciliación de publicación; resolver de credenciales existente sin persistir secretos. Acceso cruzado, symlink, blob ausente y crash rechazan correctamente. [artefactos §7–10](../../architecture/database/artifacts/index.md) | GC, backup/restore integral y otro backend permanecen deshabilitados hasta sus pruebas. |
| `P-32/captura` | Productor normalizado por fuente/cuenta/segmento/epoch e identidad no reciclable; observaciones, cortes y fold de settlement que el diccionario exige atómicos. Replay/tardanza/ausencia preservados. [economía §1–2](../../architecture/database/economy/index.md) | Certificación de uso con presión real de P-19 y cierre M11; no se inventa FINAL ni cero. |
| `P-33/catalogo` | Catálogo publicado por documento/versión y pin antes del gasto; intervalo/moneda validados; precio ausente explícito, sin respaldo cero. [economía §3](../../architecture/database/economy/index.md) | Snapshots, prorrateo y presupuesto dinámico completos. |
| `P-23/garantías` | Gate puro compartido de operación/capacidad/garantía (contratos §2.0): SUPPORTED/UNSUPPORTED/UNKNOWN con evidencia del perfil; incluye HARD_COST_BOUND. Lo consumen admisión y solver de composición; no un segundo evaluador ni una inferencia desde consentimiento/costo estimado. Prueba rechazo antes del efecto si la garantía requerida falta o es UNKNOWN. | Solver de grafo, bindings e interacción certificada permanecen pendientes del cierre P-23/M7. |
| `P-34/admisión` | Política y reclamo versionados; admisión y enforcement antes/durante gasto con P-19/P-22, captura y catálogo pinneado. Límite monetario obligatorio exige HARD_COST_BOUND comprobado en la composición; capacidad desconocida/no soportada rechaza antes del efecto. Consentimiento, costo estimado o CLI opaca no garantizan hard cap. Negativos: carrera por el saldo, fuente desconocida, revocación y capacidad ausente. | Reportes/estadísticas de M11 y anomalías H-9 conservan su cierre propio. |
| `P-17/efecto` | Commit real sólo en repositorio descartable autorizado, receipt independiente, base/tree/write-set exactos y SHA observado; comando con postcondición reconciliable. [contratos §12](../../architecture/contracts/index.md) | Escritura automatizada operativa deshabilitada. |
| `P-18/recuperación` | Ocho fronteras de crash, reconstrucción de delivery sin reenvío ciego, cuarentena/ACK y fencing efectivos; writer viejo rechazado y descendiente detenido/reapeado o confinado. Incluye P-17/efecto antes de cerrar la rama Git. [tests §7–8](../../quality/testing/index.md) | No promete power-loss por SIGKILL ni aislamiento por un CAS nominal. |

P-14 incluye el **bootstrap del registry único y de la asignación de rol
versionada**: consume las entidades de accounts/planning contra watermarks de
registry/initiative, antes de admitir la primera tarea. No espera equipos M9 ni
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
