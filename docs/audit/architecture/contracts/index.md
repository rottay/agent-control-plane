# Contratos: el ciclo de una tarea, sus estados y sus garantías

Dueño único del concepto **contrato de ejecución**: qué operaciones existen, en
qué orden, con qué precondiciones, qué errores producen, qué es idempotente y qué
no, y qué se puede afirmar honestamente sobre un efecto externo.

[Índice](../../README.md) · [Arquitectura](../index.md) · [Datos](../database/index.md) · [Integraciones](../integrations/index.md) · [Requisitos](../../requirements/index.md) · [Hallazgos](../../findings/index.md)

Estado: **especificación**. Base `a92756b`. Los nombres de estado y de rechazo son
normativos; las firmas concretas las fija el packet que las implementa.

Los protocolos V1 de [avisos locales, espera humana, duelos y anomalías](interaction/index.md)
tienen allí su dueño. Reutilizan este ciclo, B3 y las garantías de capacidad;
no crean otro scheduler, outbox ni permiso de gasto.

---

## 1. La cadena, en una línea

```
petición → admisión → reserva → dispatch → resultado → checkpoint → verificación → commit
```

Cada eslabón tiene: precondiciones comprobables, un efecto con dueño, un evento
durable, una unión cerrada de rechazos y una regla de idempotencia. **Un eslabón
sin efecto real no existe**: no se apendea un evento que afirme un trabajo que
nadie hizo.

---

## 2. Vocabularios cerrados

| Vocabulario | Valores |
| --- | --- |
| `task_state` | `DISCOVERED`, `CLASSIFIED`, `READY`, `RESERVED`, `RUNNING`, `WAITING_APPROVAL`, `VERIFYING`, `AUDITING`, `READY_TO_COMMIT`, `COMMITTED`, `CHECKPOINTED`, `COMPLETED`, `CANCELLED`, `FAILED`, `SUSPECT_WORKTREE` |
| `dispatch_state` | `INTENDED`, `CLAIMED`, `INFLIGHT`, `SETTLED`, `ABANDONED` |
| `effect_outcome_status` | `SUCCEEDED`, `FAILED`, `CANCELLED`, `OUTCOME_UNKNOWN` |
| `refusal_class` | `REQUEST_INVALID`, `PRECONDITION_FAILED`, `AUTHORITY_REFUSED`, `CAPABILITY_UNSUPPORTED`, `RESOURCE_EXHAUSTED`, `CONFLICT`, `TRANSPORT_UNAVAILABLE` |
| `commit_policy` | `NO_COMMIT`, `LOCAL_COMMIT_WITH_RECEIPT` |
| `workspace_mode` | `READ_ONLY`, `MUTABLE_WITHIN_WRITE_SET` |
| `capability_support` | `SUPPORTED`, `UNSUPPORTED`, `UNKNOWN` |

Cada rechazo lleva `refusal_class`, un código propio del contexto y un `at`: la
ruta del campo o del recurso que lo causó. Un rechazo sin `at` no es accionable.
El mapa completo desde los errores reales de cada edge está en §16.

### 2.0 Declaración de capacidad y resultado de preflight

No son tres registros competidores. El edge conserva su declaración original;
`capability_support` es el resultado neutral de evaluar una **operación requerida,
un perfil y una evidencia concretos**, no un reemplazo de los enums persistidos.

| Origen | Declaración | Traducción al preflight |
| --- | --- | --- |
| driver, `DriverCapabilityState` | `SUPPORTED` | `SUPPORTED` sólo si la operación y su correspondencia contractual pasan la conformidad del perfil; falta de esa evidencia deja la **evaluación** `UNKNOWN`, no convierte el estado declarado del driver en un tercero |
| driver | `UNSUPPORTED` | `UNSUPPORTED`; nunca intentar el verbo como fallback |
| provider, `CapabilityState` | `CONFIRMED` | `SUPPORTED` para la capacidad y sujeto acreditados; evidencia `PROTOCOL` o `RUNTIME/REAL` conforme al contrato del edge. Un fake no acredita al proveedor real |
| provider | `UNKNOWN` | `UNKNOWN`, conservando la ausencia o el alcance de la evidencia; nunca completar datos supuestos |
| provider | `REFUSED` | `UNSUPPORTED`, conservando el rechazo de origen y su razón tipada |

El adapter traduce exhaustivamente **hacia** el resultado neutral y conserva
`origin_kind`, `origin_state`, capacidad y referencia/sujeto de evidencia en el
diagnóstico. No existe traducción inversa automática: `UNSUPPORTED` no identifica
por sí solo cuál de los dos orígenes lo produjo. El kernel no importa los tipos
privados del edge. Se mantiene la ley de ADR 0016: el driver sólo declara dos
estados y su declaración debe corresponder al comportamiento del verbo; un
descriptor de driver con `UNKNOWN` es inválido. Un `CONFIRMED` inválido se rechaza,
no se degrada silenciosamente. Negativos de P-22/P-23: driver con tercer estado,
provider confirmado por fake y pérdida de la razón `REFUSED` deben fallar.

### 2.1 El autómata, exhaustivo

`COMPLETED` es el **terminal exitoso**. `COMMITTED` registra un hecho real de Git y
`CHECKPOINTED` un hecho recuperable: **ninguno de los dos es el único final
exitoso**, y una tarea sin commit puede completarse.

| Desde | Hacia | Precondición | Evento | ¿Terminal? |
| --- | --- | --- | --- | --- |
| — | `DISCOVERED` | envelope válido, idempotencia de sumisión resuelta | tarea descubierta | no |
| `DISCOVERED` | `CLASSIFIED` | rol y política resueltos | tarea clasificada | no |
| `CLASSIFIED` | `READY` | dependencias satisfechas y asignación resuelta | tarea lista | no |
| `READY` | `RESERVED` | reserva de cuenta y lease de worktree concedidos y acusados | recursos reservados | no |
| `RESERVED` | `RUNNING` | prestate verificado; sesión abierta con contenido entregado | ejecución iniciada | no |
| `RUNNING` | `WAITING_APPROVAL` | el plan exige aprobación en este punto | aprobación solicitada | no |
| `WAITING_APPROVAL` | `RUNNING` | aprobación concedida, vigente, con digest de revisión coincidente | aprobación decidida | no |
| `RUNNING` | `VERIFYING` | efectos liquidados; ninguno en `OUTCOME_UNKNOWN` | verificación solicitada | no |
| `VERIFYING` | `AUDITING` | receipt de un verificador **distinto del writer**, con todos los checks en cero | verificación completada | no |
| `AUDITING` | `READY_TO_COMMIT` | veredicto de aceptación **y** `commit_policy = LOCAL_COMMIT_WITH_RECEIPT` | auditoría completada | no |
| `AUDITING` | `COMPLETED` | veredicto de aceptación **y** `commit_policy = NO_COMMIT` | tarea completada | **sí** |
| `READY_TO_COMMIT` | `COMMITTED` | autorización vigente para ese tree; base y tree revalidados | commit registrado con el SHA observado | no |
| `COMMITTED` | `CHECKPOINTED` | checkpoint escrito y recuperable | checkpoint escrito | no |
| `CHECKPOINTED` | `COMPLETED` | recursos liberados y acusados | tarea completada | **sí** |
| cualquiera | `CANCELLED` | cancelación autorizada; efectos liquidados o reconciliados | tarea cancelada | **sí** |
| cualquiera | `FAILED` | fallo terminal con causa registrada | tarea fallida | **sí** |
| cualquiera | `SUSPECT_WORKTREE` | violación de write-set detectada | violación y revocación de lease | **sí**, hasta reconciliación explícita |

Diferencias que el autómata hace explícitas:

- **`NO_COMMIT`** permite editar dentro del write-set, **no** pasa por
  `READY_TO_COMMIT` ni por `COMMITTED`, y termina en `COMPLETED` con su resultado y
  los checks que sí correspondan. **No se fabrica un commit** y no se afirma una
  verificación que no se ejecutó.
- **`READ_ONLY`** recorre el mismo camino sin mutar el workspace; el plane sí
  registra su propio estado y sus checkpoints.
- **`OUTCOME_UNKNOWN` pertenece a un efecto, no a la tarea.** Impide finalizar y
  impide reintentar hasta que haya reconciliación; **no equivale a `FAILED`**.

---

### 2.2 Historia de estados: conservación, no renombrado retroactivo

El autómata anterior gobierna **eventos nuevos de la cohorte V2**, no reinterpreta
los eventos ya persistidos. La lectura común de P-09/P-12/P-31 devuelve una unión
estricta `{ vocabulary: 'LEGACY', value: LegacyTaskState } | { vocabulary:
'TASK_V2', value: TaskStateV2 }`; ambas hojas de tipos reutilizan su schema dueño.
La cohorte se determina por la versión soportada y las coordenadas V2 del evento
([streams §1.1](../database/streams/index.md#11-la-coordenada-v2-sobre-un-stream-que-no-se-puede-reescribir)),
no por adivinar el significado de un string. Forma mixta o versión desconocida
rechaza con `REQUEST_INVALID / STATE_COHORT_INVALID`.

| Lectura legacy | Conservación exacta |
| --- | --- |
| ciclo | `DISCOVERED`, `DT_CLASSIFIED`, `READY`, `RESERVED`, `RUNNING`, `VERIFYING`, `AUDITING`, `READY_TO_COMMIT`, `COMMITTED`, `CHECKPOINTED` |
| excepciones | `WAITING_OWNER`, `DRAINING`, `QUOTA_BLOCKED`, `AUTH_REQUIRED`, `REJECTED`, `FAILED`, `SUSPECT_WORKTREE`, `CANCELLED` |
| terminales históricos | `CHECKPOINTED`, `REJECTED`, `FAILED`, `SUSPECT_WORKTREE`, `CANCELLED`; terminal histórico **no acredita** éxito, verificación o commit real |

No se transforma `DT_CLASSIFIED` en `CLASSIFIED`, `WAITING_OWNER` en
`WAITING_APPROVAL` ni `CHECKPOINTED` en `COMPLETED` al leer. El timeline mantiene
la etiqueta y la cohorte originales. El scheduler V2 no reactiva filas legacy;
continuarlas exige reconciliar su estado y efectos, autorización y una revisión
V2 con linaje explícito, nunca fabricar resultados históricos. El adaptador de
lectura soporta ambas cohortes; el writer nuevo sólo emite V2.

Negativos: los 18 estados legacy se reconstruyen sin pérdida; los nombres
compartidos conservan su cohorte; historia desconocida rechaza; un terminal
legacy no habilita el camino de `COMPLETED`; replay mixto produce las mismas
filas y la misma respuesta pública dos veces.

## 3. Petición

**Qué es.** Un envelope normalizado: iniciativa, paso, rol, objetivo, autoridad,
read-set y write-set, política de commit, presupuesto, contexto de entrada.

**Identidad.** El `envelope_sha256` se computa sobre la preimagen definida en
[datos §6.2](../database/index.md). Objetivo y autoridad **entran** en la preimagen.
Este es el defecto N01: hoy dos objetivos distintos y dos autoridades distintas
producen el mismo digest de sumisión.

**Revisión, no retry invisible.** Un cambio semántico crea una revisión nueva
(`revision_number + 1`) y no reutiliza el marcador, el resultado ni el costo de la
revisión anterior. Un reintento de la misma revisión crea un intento nuevo.

**Precondiciones.** El envelope valida contra su schema estricto; la iniciativa
existe y, si la tarea pertenece a un roadmap, su revisión y paso existen; el rol
tiene asignación resuelta.

**Ingreso no es adquisición.** Dos tareas con write-sets solapados pueden entrar
a la cola. El conflicto se resuelve al adquirir una reserva/lease activo
incompatible (§6): el scheduler espera o rechaza la adquisición según la política,
pero nunca habilita dos writers del mismo workspace. Encolar no concede ownership.

**Rechazos.** `REQUEST_INVALID` (schema, ciclo, referencia inexistente),
`AUTHORITY_REFUSED` (autoridad no vigente o fuera de scope), `CONFLICT`
(digest en conflicto con una revisión existente). El conflicto de ownership se
reporta en la adquisición, no como prohibición general de encolar trabajo.

**Idempotencia.** Reenviar el mismo envelope con la misma clave devuelve la misma
tarea y la misma revisión. Reenviar un envelope distinto bajo la misma clave es
`CONFLICT`, nunca una sobreescritura.

---

## 4. Contenido de la instrucción

La petición transporta contenido, no sólo identificadores. Este es el defecto N02:
hoy los transportes de API y local envían `model`, `taskId`, `attempt` e
`identity`, y el stream termina en `completed` sin que la instrucción haya salido.

### 4.1 Contrato de contenido, versión 1 — congelado

`content_contract_version = 1`. Una **lista ordenada** de bloques discriminados.
No hay tres formatos por cliente.

| Campo del bloque | Regla |
| --- | --- |
| `kind` | `text`, `image`, `audio`, `document`, `tool_result`. Unión cerrada |
| `block_id` | estable dentro de la lista; permite referenciar un bloque concreto |
| `artifact_ref_id` | referencia **autorizada** por ocurrencia; obligatoria para todo lo que no sea texto corto |
| `media_type` | declarado, validado contra la clase |
| `byte_length` | declarado, validado contra los límites del perfil |
| `content_sha256` | de los bytes referenciados |

El texto viaja en UTF-8. La clase, el tipo de medio y la codificación se validan;
los límites son los del perfil compartido: artefacto individual configurable, y
topes de metadatos, de evento y de respuesta de herramienta
([tests §9.5](../../quality/testing/index.md)). El **agregado del pedido** no puede
superar la cuota del contrato admitido.

- **Los datos en línea existen sólo del lado privado de la frontera del adapter**,
  después de resolver y validar la referencia. **Jamás** en un evento, en el stream
  público ni en una traza.
- Una **modalidad no seleccionada** devuelve `UNSUPPORTED` en el preflight. **El
  texto es obligatorio**; nada obliga hoy a instalar audio.
- Un `tool_result` referencia su tool call y su `effect_id`.
- Los campos propios de una variante se declaran de forma estricta y **sin campos
  de vendor**.

### 4.2 Contrato de resultado, versión 1 — congelado

`effect_id`, `status`, la **lista ordenada** de bloques de salida y una referencia
de uso. `SUCCEEDED` **exige** un resultado válido y recuperable.

- Mismo efecto con el mismo digest: **replay**. Mismo efecto con digest distinto:
  **conflicto**.
- **Tres hechos separados y nunca confundidos:** éxito de transporte, terminación
  del proceso, y resultado de la operación.
- Un resultado de herramienta marcado como error produce un resultado `FAILED`
  **aunque el transporte haya respondido correctamente y el proceso haya salido con
  código cero**.

### 4.3 Prueba de aceptación

Un hijo que devuelve lo que recibió, ejercitado desde la puerta real —CLI y API— y
no desde un fixture. Un adapter que no puede transportar el contenido declara
`UNSUPPORTED` **en el preflight**, antes de gastar cuota; un handshake rechazado no
cuenta como soporte.

Matiz operativo: el preflight puede rechazar sin abrir nada cuando la combinación
es conocida como no soportada, pero un **handshake real** a veces exige abrir un
proceso o un socket. Cuando lo exige, la obligación es cerrar y reapear sin
trabajo útil y **sin consumo no autorizado**; no se promete cero procesos en los
dos casos.

---

## 5. Admisión

**Resolución del conjunto.** Cada ejecución fija y registra: modelo, versión
resuelta, cuenta, transporte, harness, driver, tools admitidas, política de
seguridad, presupuesto y versión de schema. Un cambio de defaults afecta sólo a
ejecuciones nuevas.

**Precedencia**, en este orden y sin excepciones:

```
defaults de instalación → iniciativa → paso → override explícito autorizado de tarea
```

La política de seguridad y de presupuesto fija techos; **un override no los
ensancha**. La resolución cruza dos fuentes: `registry_events` para el scope
`GLOBAL` e `initiative_events` para `INITIATIVE` y `STEP`
([datos §4](../database/index.md)). La comparación entre fuentes se hace contra un
vector de watermarks, nunca contra «lo último».

**Validación fail-closed.** Un `model_version_id` inexistente, `RETIRED`, no
elegible para el rol o no admitido para el transporte rechaza la edición con la
razón. Una versión retirada bloquea y **propone migración**; no degrada en
silencio a otra versión.

**Independencia: dos reglas distintas, y no se confunden.**

| Situación | En la **edición del plan** | En la **admisión ejecutable** |
| --- | --- | --- |
| El verificador o el auditor requerido **es el writer**, por identidad de worker emitida por el supervisor | se advierte | **se rechaza con `AUTHORITY_REFUSED`, temprano** |
| Mismo **proveedor** o mismo modelo, en instancias independientes | se registra una recomendación y el plan se acepta | se admite |

La identidad que decide **no es la etiqueta de rol**: es un `worker_instance_id` y
un `worker_run_id` **emitidos por el supervisor**, con su mapeo registrado. Sin
eso, un worker podría auto-verificarse cambiándose el rol de nombre.

El auditor requerido, además, es de sólo lectura y distinto del writer. Verificador
y auditor pueden ser el mismo **sólo si una política explícita lo admite** y
ninguno de los dos es el writer; por defecto son revisores independientes en
trabajo de riesgo alto, y un packet mecánico puede usar sólo verificador.

La ley dura sigue en pie: un receipt cuyo verificador es igual al writer es
inválido. La recomendación por proveedor es otra cosa y no bloquea.

**Preflight.** Antes de abrir procesos o consumir cuota, la negociación devuelve
`SUPPORTED`, `UNSUPPORTED` o `UNKNOWN` con sus condiciones y su perfil de
evidencia, y explica qué falta. «Soportado por el motor», «instalado»,
«configurado» y «verificado con este proveedor» son cuatro hechos distintos y se
reportan por separado.

---

## 6. Reserva

Se reservan dos recursos, y en este orden: la **cuenta** y el **worktree**.

**Cuenta.** Cantidades, unidades y ventanas se admiten en una transacción del
ledger, incluyendo intenciones pendientes y débitos no reconciliados
([cuentas §4](../database/accounts/index.md)). El arbiter concede sólo slot,
TTL de reconciliación y token, con scope/checkpoint asociado
([coordinación §5](../database/coordination/index.md)). Dos workers que compiten
por el último margen: sólo se admite la reserva que satisface aquel predicado;
el otro recibe `RESOURCE_EXHAUSTED` con cuenta y dimensión. Liberar un slot no
recrea cuota consumida; UNKNOWN/ESTIMATED no prometen un hard cap del proveedor.

**Worktree.** Un lease exclusivo con fence monotónico. Hoy el store del lease
commitea el grant **antes** del evento `LEASE_ACQUIRED`; el objetivo es que el
grant y su ack ocurran en la secuencia de [datos §11](../database/index.md), de modo
que una recuperación pueda decidir sin ambigüedad.

**Recuperación.** Tras un reinicio, cada reserva se resuelve como conservada o
liberada de forma **consistente**: nunca «liberada en el arbiter y viva en el
ledger».

### 6.1 Qué puede y qué no puede un número de fence

**Un fence en una base local no impide, por sí solo, que un proceso hijo con los
permisos del host escriba archivos.** Un CLI arbitrario puede escribir aunque su
lease esté revocado. Decir «el holder viejo falla por fence» sin más es falso.

El punto de enforcement real, en dos partes:

1. **Operaciones mediadas.** Toda operación mutante que pasa por el plane
   —commit, publicación, escritura de artefacto, llamada a herramienta— comprueba
   el token de fence y rechaza si no es el vigente.
2. **Hijo mutante.** Un proceso hijo que escribe el workspace por su cuenta
   necesita **un entorno de ejecución revocable o aislado**, o bien su **detención
   y reap verificados** antes de reasignar el workspace. Sin una de las dos, la
   revocación es nominal.

**No se admite un writer nuevo mientras el origen siga vivo o su ownership sea
incierto.** La condición no es que el `compare-and-set` haya avanzado el número:
es que el proceso anterior esté demostrablemente detenido o confinado.

**Perfil `TRUSTED_PROCESS`.** Un perfil que no puede impedir escrituras fuera del
permiso se anuncia con ese nombre, **declara que no ofrece aislamiento**, requiere
una decisión explícita para habilitarse, y **no satisface ninguna afirmación de
sandbox**. Nada de esto protege frente al propio owner o al administrador del host,
y eso también se dice.

Que un modelo o un transporte de API concedan acceso remoto **no concede** permisos
locales: son dos autorizaciones distintas.

Esta prueba forma parte del mínimo de recuperación que habilita el commit
operativo (§12): **no alcanza con el `compare-and-set` en SQL**. Los negativos
obligatorios son dos: un writer revocado que intenta mutar, y un descendiente vivo
del proceso anterior.

---

## 7. Dispatch y efecto externo

El protocolo, completo:

Antes de asignar ordinal o crear un efecto, aplicar el lookup lógico de
[execution §6.1](../database/execution/index.md), obligatorio en P-18/M4. Replay
reutiliza efecto y preimagen original; no crea otra intención por un handoff.
La secuencia siguiente crea una intención sólo cuando el lookup admite una
operación lógica nueva. Un reenvío posterior, si está autorizado, registra su
propio dispatch_attempt y segmento efectivo sin reemplazar el efecto.

1. Registrar **intención** con `effect_id`, clave de idempotencia, revisión de
   política y reclamo de presupuesto, junto con el evento de comando durable en
   la transacción del ledger. La outbox es una cache en otro store, no una fila
   de esa transacción. Identidad de comando, acuses y reconstrucción se definen
   en [coordinación §6–7](../database/coordination/index.md).
2. Entregar la clave de idempotencia al proveedor **cuando la soporte**, y
   registrar que se entregó o que el adapter no la soporta.
3. Registrar la **aceptación y el handle externo** de forma durable, antes de
   esperar el resultado.
4. Registrar el **resultado** por referencia y digest.
5. Tras un crash, **reconciliar**: consultar por handle o por clave, o comprobar
   una postcondición confiable.
6. Si no se puede saber si ocurrió: `OUTCOME_UNKNOWN`, con exposición de costo
   registrada. **No se reintenta ciegamente y no se declara exactamente una
   ejecución.**
7. Registrar el acuse del comando y confirmar el trabajo de ACP; liberar o
   conservar recursos mediante la saga del mismo contrato de coordinación.

**Un efecto externo cuyo desenlace es desconocido no se convierte en
`NOT_DONE` reintentable.** Este es el defecto N04: hoy un test verde afirma dos
`start` y una sola observación tras un fallo. La ventana existe; lo que falta es
registrarla.

**Un log local no elimina la ventana** «el proveedor ejecutó y ACP murió antes de
registrar». Lo que se puede garantizar depende de las garantías del adapter, y el
producto informa esa diferencia por familia en
[integraciones](../integrations/index.md). No hay exactly-once mágico.

### 7.1 Cancelación

Una cancelación aceptada y un proceso realmente terminado son **dos hechos
distintos**, con dos eventos distintos.

**Cancelación local, sobre un hijo propio:**

```
solicitud aceptada, registrada
  → SIGTERM, con gracia configurable, por defecto 5 s
  → SIGKILL y reap, con objetivo de 10 s en total
```

- **Nunca se señaliza un proceso fuera del ownership del plane.**
- Si el proceso no responde dentro del objetivo, se reporta `DEGRADED` con su
  fencing y su cuarentena. **No se reporta un éxito falso.**
- **No se afirma «cero huérfanos» de forma universal** por el mero hecho de enviar
  una señal.

**Cancelación remota:** abortar una petición HTTP **no** es cancelar el trabajo del
proveedor. Cada adapter declara su `cancellation_support`:

| Soporte | Qué se puede afirmar |
| --- | --- |
| `NONE` | la solicitud queda registrada; el trabajo remoto sigue con **exposición declarada** |
| `REQUEST` | se registra `requested`; `confirmed` sólo si el proveedor lo confirma; si no, `unknown` con exposición |
| `TERMINATE` | `confirmed` tras la terminación efectiva, y se consulta por handle cuando el adapter lo permite |

Un deadline alcanza a los hijos y a las herramientas; al vencer produce checkpoint
y cancelación limpia por esta misma tabla.

---

## 8. Handoff de ruta dentro de un intento

Cambiar de cuenta, de modelo, de proveedor o de transporte **dentro de un intento**
crea un segmento de ruta nuevo, con linaje explícito hacia el anterior
([ejecución](../database/execution/index.md)). **No** crea otro efecto para un
paso lógico ya registrado ni cambia su idempotency_key. El mínimo de identidad
P-18 preserva invocationId, efecto, preimagen y request; los despachos guardan
su segmento efectivo y las ocurrencias enlazan esos despachos. Handoff no
convierte una key de proveedor/cuenta origen en deduplicación del destino.

Secuencia obligatoria, y cada transición es un evento con su clave de idempotencia
referenciada:

```
1. quiesce del origen: se deja de admitir trabajo nuevo en ese segmento
2. checkpoint consistente
3. reconciliación de los efectos pendientes del origen
4. revocación del fence del origen, CON acuse
5. reserva del destino
6. inicio y rehidratación en el destino, sin mutar la autoridad
7. adquisición del fence nuevo
8. continuación de un paso real
9. handoff COMPLETED
```

`SUCCEEDED` sólo después del paso 8. Hoy el aterrizaje admite salud `UNKNOWN` y
marca el switch completo antes de abrir el destino (N05); un spawn fallido deja un
cambio aparentemente exitoso y sin continuidad.

Dos reglas de fallo:

- **Si el destino falla, el rollback exige una adquisición nueva y autorizada.
  Jamás se resucita el fence viejo.**
- **Si el origen quedó incierto** —por ejemplo, una API remota cuya revocación no
  se pudo comprobar— **no se promete suspensión**. Se espera y se reconcilia; no se
  produce un segundo efecto conocido.

**Cambiar de modelo o de cuenta no autoriza cambiar el objetivo ni la autoridad.**
El `envelope_sha256` se conserva a través del handoff; si cambia, es una revisión
nueva y el handoff se rechaza.

Perfiles que hay que probar por separado: mismo proveedor, entre proveedores
compatibles, y **varios handoffs en un mismo intento**. Un aterrizaje de un solo
switch de la misma marca no satisface el objetivo; cuando un perfil no puede
cumplirlo, queda `UNSUPPORTED` explícito.

---

## 9. Motor durable y journal

ACP fija una jerarquía: **una** autoridad de scheduling y retry por run. Un harness
puede gestionar pasos internos identificados, con ownership, cancelación,
presupuesto y checkpoint conectados al plane. Los identificadores internos del
motor viven en una referencia opaca del adapter, nunca en un contrato de negocio.

**El journal del motor no es una cache descartable.** El ledger es la autoridad de
los hechos de negocio; el journal conserva estado operativo: timers, señales,
decisiones y efectos pendientes. Borrarlo sin una prueba de reconstrucción de esas
cuatro cosas pierde continuidad.

**Migración de un run vivo entre motores**, cuando exista:

```
detener admisión al run → llegar a checkpoint consistente → confirmar efectos
pendientes → fijar cabeza y epoch → retirar ownership anterior → validar
capacidades del destino → importar estado portable → adquirir fencing token nuevo
→ reanudar
```

Con rollback conservado y el escritor viejo prohibido. Hasta que ese protocolo
exista y esté probado, **un run existente conserva su driver**. Tener la misma
interfaz no implica hot swap.

---

## 10. Resultado

El resultado transporta **contenido útil recuperable por referencia y digest**, no
un conteo de tokens y un `COMPLETED`. Hoy la extracción descarta el contenido del
asistente y conserva señales y uso; el runtime guarda el digest y el conteo del
trail, no una respuesta.

No hace falta almacenar cadena de pensamiento ni transcripciones internas del
proveedor. Sí hace falta que exista una respuesta al pedido, persistida, legible
detrás de autorización, y con clasificación de privacidad.

**Terminal correcto.** `COMPLETED` exige un resultado registrado. Un stream que
termina sin resultado es `FAILED` o `OUTCOME_UNKNOWN`, según §7.

---

## 11. Checkpoint

Contenido: último paso atómico, HEAD, digests de autoridad, read-set y write-set,
receipts, trabajo pendiente, **una** próxima acción segura, y referencias a
artefactos por digest. Acotado en bytes. **Nunca** transcript del proveedor,
nunca credenciales.

**Portabilidad.** Un checkpoint conserva autoridad, entrada y resultados de forma
que un destino compatible puede rehidratarlo. Un destino incompatible **rechaza**;
no rehidrata parcialmente. Hoy `CheckpointPort.read` no tiene caller productivo
localizado: existe el store de bytes y falta el consumidor.

---

## 12. Verificación, auditoría y commit

Las cuatro son **efectos con receipt propio**, no eventos `PLAIN`. Hoy la
verificación, la auditoría y el commit se apendean sin que ningún código los
ejecute, y la política de commit está fijada en el daemon en lugar de leerse del
envelope (N03).

| Eslabón | Precondición | Evidencia mínima | Rechazo |
| --- | --- | --- | --- |
| Verificación | proceso verificador distinto del writer, base y tree concretos | comandos ejecutados con sus exit codes, `base_sha`, `tree_sha` | `AUTHORITY_REFUSED` si el verificador es el writer |
| Auditoría | auditor real con acceso de lectura al diff | veredicto trazable con evidencia por digest | `PRECONDITION_FAILED` sin diff disponible |
| Autorización | receipt válido, todos los checks en cero, sin cambios fuera del write-set | evento de autorización con el digest del receipt | `PRECONDITION_FAILED` con la lista de checks no cero |
| Commit | autorización vigente para ese tree | `commit_sha` **consultado al VCS**, no asumido | `CONFLICT` si el tree cambió |

**`NO_COMMIT` no es lo mismo que read-only.** `NO_COMMIT` prohíbe la autorización
y la realización de un commit, y **permite editar archivos dentro del write-set**.
`READ_ONLY` prohíbe efectos mutantes sobre el workspace y las herramientas, y
**permite** que el plane registre estado y checkpoints internos. Ninguno de los dos
produce confirmaciones ficticias.

**La habilitación operativa del commit requiere el mínimo de recuperación.** El
enforcement se puede desarrollar y probar antes, sobre repositorios descartables,
pero no se habilita la escritura automatizada sin ownership, cuarentena y
reconciliación de efectos y commits inciertos. La condición está escrita en
[roadmap](../../roadmap/index.md) como M3 dependiente de M4 mínimo.

**Los receipts históricos ausentes no se recrean.** Se revalidan
retrospectivamente o se exceptúan de forma explícita y nombrada. Fabricar un
timestamp anterior a un commit es exactamente el defecto que este producto existe
para impedir.

---

## 13. Conformance del write-set y cuarentena

La conformance se calcula sobre **efectos reales** —diff rastreado más rutas no
rastreadas— no sobre una intención declarada. Una salida fuera del set impide la
aprobación y conserva la evidencia.

Dentro del ledger son **atómicos** la cuarentena, la **intención** de revocar el
lease y el evento durable de comando. Su proyección a la cache outbox no comparte
esa transacción. La revocación efectiva en el arbiter y su acuse se
reconcilian por saga: son archivos distintos y no comparten transacción
([datos §11](../database/index.md)). **No se admite un writer nuevo hasta que el
acuse existe y el fencing es efectivo.**

El worktree no se limpia, no se resetea y no se restaura, nunca.

---

## 14. Instrucciones, artefactos y digests

Cuatro digests distintos, con cuatro significados distintos:

| Digest | Qué identifica | Cambia cuando |
| --- | --- | --- |
| `authority_sha256` | el documento de autoridad vigente | cambia la autoridad, no el trabajo |
| `envelope_sha256` | la revisión del trabajo | cambia objetivo, autoridad, sets, política o presupuesto |
| `prompt_sha256` | los bytes de una instrucción concreta | cambian los bytes |
| `content_sha256` | los bytes de un artefacto | cambian los bytes |

**Salida pública frente a artefacto privado.** El stream público transporta
progreso, escalares y referencias seguras. Prompts y respuestas viven detrás de
autorización, con clasificación, retención y redacción declaradas. Un artefacto
privado no aparece en SSE, ni en el DOM, ni en una traza.

**Egress explícito y mínimo.** El prompt sale sólo hacia el destino autorizado por
la ruta resuelta. No se promete «cero secretos» por expresión regular: la garantía
es allowlist por frontera, schemas de payload por tipo de evento, separación de
canales y pruebas con secretos sintéticos, con el alcance declarado.

---

## 15. Tabla de idempotencia por eslabón

| Eslabón | Clave | Repetir produce | No es idempotente cuando |
| --- | --- | --- | --- |
| Petición | `UNIQUE(client_scope, client_request_key)` | la misma tarea y la misma revisión | el `envelope_sha256` almacenado difiere del recibido: `CONFLICT` |
| Admisión | `(task_id, revision_number, attempt_number)` | la misma resolución | cambió la precedencia: nueva versión de asignación |
| Reserva | `operation_id` del CAS | el mismo fence | el fence avanzó: el viejo falla |
| Dispatch | `idempotency_key` de [datos §6.3](../database/index.md) | el mismo efecto, si el proveedor lo soporta | el proveedor no soporta idempotencia: se declara y se reconcilia |
| Resultado | `effect_id` | la misma referencia | — |
| Checkpoint | `checkpoint_sha256` | la misma fila | — |
| Verificación | `receipt_sha256` | el mismo receipt | cambió `tree_sha`: el receipt no aplica |
| Commit | `(task_id, receipt_sha256)` | el mismo `commit_sha` | el tree cambió: `CONFLICT` |

**La clave de idempotencia de la sumisión es del cliente, no del contenido.** El
`envelope_sha256` almacenado es una **precondición que se compara**, no parte de la
clave única: si formara parte de la clave, cambiar el payload esquivaría el
conflicto y crearía una tarea nueva en silencio.

- misma clave + mismo digest → replay de la original;
- misma clave + digest distinto → `CONFLICT`;
- una revisión nueva se pide con una **operación nueva y una clave explícita**, no
  reutilizando la anterior.

El identificador de efecto y el de intento de despacho son independientes de esto y
no cambian ([datos §6](../database/index.md)).

---

## 16. Traducción de errores: el mapa exhaustivo

Hoy los errores de adapter se aplastan contra `TRANSPORT_UNAVAILABLE` en el puerto
de ejecución. Eso pierde la causa y produce las dos mentiras clásicas: culpar a la
cuenta por un adapter ausente, y reintentar algo que ya gastó.

**La causa tipada se guarda antes de mapear.** El registro neutral de un rechazo
lleva siete campos, y **ninguna clase decide el reintento por sí sola**:

| Campo | Valores |
| --- | --- |
| `refusal_class` | la unión de §2 |
| `code` | enum contextual conocido y validado; **nunca** texto crudo de un tercero |
| `origin` | `PROVIDER`, `EXECUTION`, `DURABILITY`, `TOOLS`, `PRESSURE`, `TELEMETRY`, `ADMISSION` |
| `phase` | `PREFLIGHT`, `HANDSHAKE`, `DISPATCH`, `INFLIGHT`, `RESULT`, `RECOVERY`, `EXPORT` |
| `effect_status` | `NOT_DISPATCHED`, `INFLIGHT`, `SETTLED`, `OUTCOME_UNKNOWN` |
| `retry_policy` | `NONE`, `BOUNDED`, `RECONCILE`, `WAIT_CONDITION` |
| `at` | la ruta del campo o recurso |

### 16.1 Las cuatro políticas de reintento

| Política | Qué autoriza |
| --- | --- |
| `NONE` | nada. El rechazo es terminal para ese efecto |
| `BOUNDED` | como máximo **dos** reintentos, con esperas de 250 ms y 1.000 ms, dentro del deadline y del presupuesto, y **sólo** si está probado que no hubo despacho o si la idempotencia del destino está comprobada |
| `RECONCILE` | **no retransmitir**. Consultar por handle o comprobar una postcondición |
| `WAIT_CONDITION` | esperar un hecho durable que habilite una admisión nueva. **No** repetir el efecto |

### 16.2 El mapa

| Origen y código | Clase | Retry | Regla |
| --- | --- | --- | --- |
| Adapter: raíz de configuración rechazada, binario no admitido, violación de sólo lectura, material de credencial | `AUTHORITY_REFUSED` | `NONE` | no se eluden permisos, cuenta ni raíz |
| Adapter: capacidad no probada, protocolo no soportado; proveedor con handshake requerido | `CAPABILITY_UNSUPPORTED` | `NONE` | desconocido **no** es caída |
| Adapter: fallo de spawn | `TRANSPORT_UNAVAILABLE` | `BOUNDED` | sólo si ningún hijo llegó a iniciar |
| Adapter: salida inesperada, timeout de handshake | `TRANSPORT_UNAVAILABLE` | `RECONCILE` | pudo haber gasto |
| Adapter: interrupción escalada | `PRECONDITION_FAILED` | `RECONCILE` | cancelación aceptada, no terminada |
| Adapter: presupuesto de salida excedido | `RESOURCE_EXHAUSTED` | `NONE` | no se recorta ni se amplía automáticamente |
| Adapter: evento desconocido o malformado | `TRANSPORT_UNAVAILABLE` | `RECONCILE` | protocolo remoto inválido; **no** se culpa al usuario |
| Adapter: transición ilegal | `PRECONDITION_FAILED` | `NONE` | invariante interna rota |
| Ejecución o driver: capacidad no soportada | `CAPABILITY_UNSUPPORTED` | `NONE` | se nombra la capacidad exacta |
| Ejecución: ya hay una ejecución en vuelo | `CONFLICT` | `NONE` | **attach**, no un segundo spawn |
| Ejecución: reattach no disponible | `PRECONDITION_FAILED` | `NONE` | no autoriza un efecto nuevo |
| Ejecución: ruta inválida por schema | `REQUEST_INVALID` | `NONE` | subrazón: schema de entrada inválido |
| Ejecución: ruta inválida por binding o proveedor | `PRECONDITION_FAILED` | `NONE` | subrazón: binding no coincide |
| Ejecución: cliente no configurado, o binding de cuenta ausente | `TRANSPORT_UNAVAILABLE` | `NONE` | **dos códigos distintos**, no uno |
| Admisión: proveedor no instalado | `CAPABILITY_UNSUPPORTED` | `NONE` | proveedor no instalado; **no** se culpa a la cuenta |
| Driver: invocación inexistente, tarea terminal | `PRECONDITION_FAILED` | `NONE` | una ausencia no es una caída del motor |
| Driver: postcondición desconocida | `PRECONDITION_FAILED` | `RECONCILE` | desenlace desconocido; **nunca** un éxito fingido |
| Herramienta: argumentos sin acotar | `REQUEST_INVALID` | `NONE` | entrada inválida |
| Herramienta: identidad sin permiso de escritura, servidor no admitido, herramienta no permitida, resultado inseguro | `AUTHORITY_REFUSED` | `NONE` | ni se admite ni se difunde |
| Herramienta: resultado sin acotar | `RESOURCE_EXHAUSTED` | `NONE` | no hay éxito parcial fingido |
| Herramienta: sesión no viva | `PRECONDITION_FAILED` | `NONE` | no se resucita |
| Herramienta: violación de protocolo | `TRANSPORT_UNAVAILABLE` | `RECONCILE` | error remoto, no petición del usuario; incluye un `structuredContent` que no es objeto y su ausencia bajo un `outputSchema` fijado (ADR 0117) |
| Herramienta: transporte rechazado | por subrazón | `NONE` | descriptor inválido → `REQUEST_INVALID`; transporte no soportado → `CAPABILITY_UNSUPPORTED`; destino prohibido → `AUTHORITY_REFUSED` |
| Herramienta: resultado marcado como error | `PRECONDITION_FAILED` | `NONE` | ejecución fallida, **aunque el transporte respondiera bien** |
| Herramienta: schema anunciado distinto del fijado, o herramienta no anunciada (`SCHEMA_MISMATCH`) | `PRECONDITION_FAILED` | `NONE` | la interfaz no es la revisada; la petición es válida y lo que corresponde es un re-pin del operador (ADR 0109, 0117) |
| Herramienta: resultado conforme que este cliente no lleva entero, `structuredContent` sin bloque de texto que lo refleje (`RESULT_NOT_CARRIED`) | `CAPABILITY_UNSUPPORTED` | `NONE` | se nombra la capacidad: llevar contenido estructurado sin su espejo de texto; nunca se recorta (ADR 0117) |
| Presión: autenticación requerida | `AUTHORITY_REFUSED` | `NONE` | **no es cuota** |
| Presión: cuota agotada | `RESOURCE_EXHAUSTED` | `WAIT_CONDITION` | reset observado, o handoff autorizado |
| Presión: advertencia de cuota | `RESOURCE_EXHAUSTED` **sólo si** rechaza la admisión | `WAIT_CONDITION` | una advertencia es una señal, **no** un fallo |
| Presión: transitorio | `TRANSPORT_UNAVAILABLE` | `BOUNDED` o `RECONCILE` | depende de si el despacho está probado |
| Presión: sin clasificar | `TRANSPORT_UNAVAILABLE` | `NONE` | edge sin clasificar; **no** se adivina auth ni cuota |
| Telemetría: endpoint inalcanzable o con timeout | `TRANSPORT_UNAVAILABLE` | `BOUNDED` | sólo la exportación; ver §16.3 |
| Telemetría: endpoint rechaza | `TRANSPORT_UNAVAILABLE` | `NONE` | hoy no hay estado; no se asume ningún código |
| Telemetría: redirección rechazada | `AUTHORITY_REFUSED` | `NONE` | no se sigue el destino |
| Telemetría: nada que exportar | **no es un rechazo**: `SKIPPED` | `NONE` | no hace fallar la tarea |
| Telemetría: payload demasiado grande | `RESOURCE_EXHAUSTED` | `NONE` | re-lotear es una operación explícita |
| Admisión: endpoint malformado, timeout rechazado, nombre de servicio rechazado | `REQUEST_INVALID` | `NONE` | schema de configuración |
| Admisión: esquema de endpoint rechazado | `CAPABILITY_UNSUPPORTED` | `NONE` | transporte no soportado |
| Admisión: host, credencial en URL, ruta o cabeceras rechazadas | `AUTHORITY_REFUSED` | `NONE` | destino o contenido fuera de política |

### 16.3 Telemetría, aparte

La telemetría es **observación derivada**. Su entrega es al menos una vez, acotada,
con duplicados posibles y un contador explícito de descartes. **No se promete
exactamente una**, y **no se usa para facturar**. Su reintento **nunca** dispara una
ejecución de modelo.

### 16.4 Reglas de forma

- Un error remoto desconocido, o una excepción, entra por validación como **edge sin
  clasificar**, con su diagnóstico privado por referencia. **Nunca** el payload
  crudo.
- Los mapas de uniones conocidas se declaran de forma exhaustiva y terminan en
  `never`: **cero casos por defecto**, y ningún caso por defecto que resulte en
  éxito.
- **No se aplican expresiones regulares sobre `at`** para recuperar una subrazón que
  se perdió al mapear. Si la subrazón importa, es un campo.

### 16.5 Los diez negativos de esta sección

1. Un miembro nuevo de una unión rompe la exhaustividad en compilación.
2. Un error remoto desconocido queda sin clasificar y **no** se reintenta.
3. Autenticación requerida no se mapea como cuota.
4. Una advertencia de cuota no es terminal.
5. Un proveedor ausente no se reporta como problema de cuenta.
6. Un mensaje remoto malformado no se reporta como petición inválida.
7. Una postcondición desconocida no reejecuta ni confirma una cancelación.
8. Una ejecución en vuelo no produce un segundo hijo.
9. Un resultado de herramienta marcado como error produce un fallo.
10. Un error parcial de exportación no reejecuta el modelo.

---

## 17. Qué no promete este contrato

Los cálculos de [estimación y desempeño](estimation/index.md) tienen contrato y
algoritmos propios bajo esta misma jerarquía. Leer/simular no equivale a ejecutar,
guardar un reporte es una orden distinta y una estimación no prueba un hard cap.

- No promete exactly-once sobre un efecto externo cuyo proveedor no ofrece
  idempotencia ni consulta por handle.
- No promete durabilidad ante corte de energía con el perfil de desarrollo
  ([datos §10](../database/index.md)).
- No promete migración transparente de runs vivos entre motores (§9).
- No promete ausencia universal de secretos por regex (§14).
- No promete que una capacidad declarada por un motor esté verificada con un
  proveedor concreto (§5).
