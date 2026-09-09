# Tests: estrategia, oráculos y negativos obligatorios

Dueño único del concepto **prueba**: qué clase de test prueba qué, qué es un
oráculo válido, qué escenarios son obligatorios y qué no se puede ejecutar todavía.

[Índice](../../README.md) · [Calidad](../index.md) · [Datos](../../architecture/database/index.md) · [Contratos](../../architecture/contracts/index.md) · [Estructura](../../architecture/structure/index.md) · [Packets](../../implementation/packets/index.md)

Estado: **especificación**. No se corrió la suite completa en esta ronda; el motivo
y su alcance están en [evidencia](../../evidence/index.md).

---

## 1. Topología

- Los tests viven **fuera de `src`**, en un árbol `test/` que es **espejo
  topológico**: para `src/<ruta>/index.ts` existe `test/<ruta>/index.test.ts`. Hoy
  los 211 archivos de `src` se llaman `index.ts` y ninguno vive bajo un directorio
  de test; esa propiedad se conserva mecánicamente.
- El espejo es **topológico, no simbólico**: no se exige un archivo de test por
  cada símbolo exportado por un barrel.
- El espejo alcanza a **todos los estratos**, incluidos kernel, persistence, edges y
  entrypoints; no sólo a los dominios.
- Fixtures de compilación negativa —código que **debe** fallar a la comprobación de
  tipos— viven en el espejo del concepto que protegen, no en un bucket global.
- **No se escriben tests artificiales de barrel** cuyo único contenido es que un
  `index.ts` exporta lo que exporta. Un export sin consumidor es un problema de
  estructura, no algo que se resuelve con un test.
- Un solo sustantivo de andamiaje: `drills/` para escenarios con procesos reales,
  `fixtures/` para datos. Hoy conviven cuatro nombres para el mismo concepto.

---

## 2. Oráculos

Un test vale por su oráculo. Escala, de mejor a peor:

| Clase | Qué es | Cuándo vale |
| --- | --- | --- |
| Externo independiente | el resultado se compara contra algo que la implementación no produjo: el filesystem, la base, un valor escrito a mano, otra herramienta | siempre |
| Metamórfico | una transformación conocida de la entrada debe producir una transformación conocida de la salida | cuando el valor exacto no se puede escribir a mano |
| Propiedad | una invariante se comprueba sobre entradas generadas con semilla | complemento, nunca sustituto de un caso concreto |
| Pin estructural | una lista congelada de nombres o de rutas | sólo para superficies públicas, y con la razón escrita |
| Autocomparación | `f(x) == f(x)`, o comparar una grabación con su propia grabación | **nunca**; es el defecto que se está corrigiendo en la paridad |

**Regla del mock.** Un mock sirve para desarrollar un contrato. No demuestra
compatibilidad ni sustitución. Cuando el requisito pide dos implementaciones
reales, dos mocks son cero.

**Regla del helper compartido.** `kernel/testkit` comparte **mecánica
determinista**: PRNG sembrado, generación estructural, ejecución de propiedades.
**No** comparte un oráculo de dominio, no reimplementa el algoritmo de producción y
no tiene privilegios ni I/O ocultos: si necesita abrir un archivo o una base, la
recibe como argumento explícito.

---

## 3. Clases de prueba, por lo que garantizan

| Clase | Garantiza | Reglas |
| --- | --- | --- |
| Unitaria de política | una decisión pura, sin efectos | sin I/O, sin reloj implícito, sin azar sin semilla |
| De contrato | que un adapter cumple el puerto | una sola suite, ejecutada contra **cada** implementación real; el fallo nombra la implementación |
| De composición | que el cableado del entrypoint produce el sistema esperado | fixture de equivalencia: walk único, walk agendado y walk de un ítem dan el mismo resultado |
| Drill | que el sistema sobrevive a un proceso real muriendo | procesos reales, señales reales, oráculo en filesystem o base; **cero skips silenciosos** |
| De concurrencia | que dos procesos no ganan lo mismo | N procesos reales del sistema operativo; un ganador, N−1 rechazos tipados, cero crashes de lock |
| De propiedad | una invariante sobre entradas generadas | semilla por iteración, de modo que un fallo imprima el número que lo regenera |
| Metamórfica | relaciones entre corridas | usada donde no hay valor esperado escribible |
| De extremo a extremo | que una operación funciona desde una puerta del producto | por CLI y por API; expectativas independientes por puerta |

---

### 3.1 Selección y composición de integraciones

Oráculos para la política de [composición](../../architecture/integrations/composition/index.md).
Se ejecutan al cerrar P-23 y se incluyen en la matriz de P-39 del perfil elegido:

1. Dos dueños de scheduling/recovery sobre el mismo run rechazan; dos tareas
   independientes con distintos motores no se rechazan por nombre de proveedor.
2. Dependencia ausente, ciclo, versión incompatible y composición desconocida
   devuelven diagnósticos distinguibles. Ninguno invoca al modelo ni herramientas.
3. Perfil delegado admitido propaga cancelación, presupuesto y autoridad. La
   pérdida del acuse no duplica un efecto; retries ocultos/fallback no autorizado
   hacen fallar el perfil, aunque ambos adapters pasen sus tests individuales.
4. Cambiar un descriptor, permiso o selección relevante tras preflight impide
   despacho con el snapshot viejo; cambios ajenos no invalidan el perfil.
5. Dos preflights verdes concurrentes no adquieren la misma reserva incompatible.
6. CLI/API dan el mismo diagnóstico con expectativas independientes. Reordenar
   entradas no cambia la decisión; no se requiere LLM para validarla.
7. Una integración opcional ausente o caída se maneja según el perfil; si la tarea
   la requiere, no hay omisión silenciosa. Una cascada de tres capas se prueba,
   no sólo parejas aisladas.
8. Fanout de telemetría, cuando se seleccione, mantiene límites de egress/cola y
   no duplica hechos de uso/costo. Un receptor caído no bloquea la ejecución.

No son tests ejecutados ni certificados en esta ronda documental. Un fixture de
marcas no prueba compatibilidad: los perfiles anunciados requieren adapters reales.

---

## 4. Determinismo

- **El reloj es una dependencia.** Ningún test consume `Date.now()` implícito;
  recibe un reloj controlado. Un contrato que necesita el instante lo declara como
  parámetro ([datos §6.3](../../architecture/database/index.md)).
- **El azar es una dependencia sembrada.** La semilla se imprime en el fallo.
- **El orden de las claves no se asume.** Todo fixture que ejercita una proyección
  de claves incluye un caso desordenado y uno por encima del tope.
- **Los procesos reales se eligen a propósito.** No se convierte en real algo que
  se puede probar en memoria; se hace real lo que sólo se rompe entre procesos:
  leases, claims, reservas, señales y muerte del proceso.

---

## 5. Aislamiento: nada escribe el checkout vivo

Es un defecto abierto y es la razón por la que la suite completa **no** se corrió
en esta ronda: cinco casos del archivo `daemon/test/launchd/drills/index.test.ts`
modifican rutas vivas —uno incluye `docs/ROADMAP.md` y el checker— y las
restauran en un `finally`. Un sexto caso consulta la línea base del checkout.
P-01 aísla esos seis casos, además de la compuerta de raíces de arquitectura
en su segundo archivo autorizado. Un crash o un cambio concurrente durante esa ventana
daña trabajo ajeno.

Reglas objetivo:

1. Ningún test escribe fuera de un directorio temporal propio ni de un árbol
   sintético.
2. Los drills que ejercitan la compuerta de arquitectura corren contra un **árbol
   sintético**, con el helper que ya existe para eso, no contra el repositorio.
3. Un test que afirma una propiedad **global** del árbol de trabajo no puede
   además mutar ese árbol: falla por razones que no son la suya.
4. Un control positivo debe afirmar un diagnóstico **específico**, no «el proceso
   salió distinto de cero». Un fence que sale 1 por un archivo suelto no prueba
   nada sobre la ley que el test dice medir.

---

## 6. Compuertas: qué hace verde a una compuerta

- **Una compuerta que no puede pasar es peor que ninguna.** Si un runner no tiene
  el binario que la suite exige, se declara el subconjunto que ese runner ejecuta y
  se nombra lo que queda fuera. No se convierte un fallo ambiental en `PASS`.
- **Ninguna ley pasa con evidencia vacía.** Un ancla debe resolver a código real,
  no vacío y fuera de un bloque de comentario, comprobado con un parser léxico o de
  AST, no con búsqueda de subcadena. Cada familia de ley tiene una sonda
  adversarial que la hace fallar en un árbol sintético.
- **La presencia de un ancla no sustituye a un test conductual.** Un ancla mide
  frescura de documentación; una conducta se mide ejecutándola.
- **La suite pinea su propio conteo.** Una corrida truncada falla con un mensaje
  sobre archivos faltantes, no sólo con un código de salida.
- **La cobertura de líneas no es una garantía.** Se mide y se publica, y no decide
  nada por sí sola. Lo que decide es la matriz de escenarios de §8.

---

## 7. Perfiles y matriz de crash

La durabilidad depende del perfil, y el perfil se declara
([datos §10](../../architecture/database/index.md)).

| Perfil | Configuración | Qué prueba la matriz | Qué **no** se puede afirmar |
| --- | --- | --- | --- |
| Desarrollo | WAL + `synchronous = NORMAL` | muerte de proceso: SIGKILL en cada frontera de la saga | durabilidad ante corte de energía |
| Certificado | WAL + `synchronous = FULL` | lo anterior, más corte simulado del dispositivo de escritura | nada más allá de lo ejecutado |

Fronteras de crash que la matriz recorre, una por una
([datos §11](../../architecture/database/index.md)):

1. después de la intención y antes del CAS del arbiter;
2. después del CAS y antes del acuse en el ledger;
3. después del acuse y antes del trabajo externo;
4. durante el trabajo externo, antes de registrar el handle;
5. después del handle y antes del resultado;
6. después del resultado y antes de publicar el artefacto;
7. después de publicar y antes de referenciar;
8. después de referenciar y antes de liberar.

En cada una: sin efecto conocido duplicado, exposición registrada donde el
desenlace es incierto, y reservas consistentes entre el ledger y el arbiter.

---

## 8. Negativos obligatorios

Ninguno es opcional. Cada uno nombra el hecho que debe falsar.

**Identidad y contratos**

1. Dos envelopes que difieren en cualquier campo del contrato producen digests
   distintos.
2. La misma clave de sumisión con el mismo digest es un replay; con un digest
   distinto es un conflicto.
3. Un efecto reintentado tras un reinicio produce la misma clave de idempotencia.
4. Un handshake rechazado no cuenta como soporte y no abre un proceso.

   Matiz necesario: el **preflight** puede rechazar antes de abrir nada cuando la
   combinación es conocida como no soportada. Un **handshake real** a veces exige
   abrir un proceso o un socket para negociar. Cuando lo exige, el negativo que se
   prueba es otro: el intento cierra y reapea el proceso sin dejar huérfanos, sin
   realizar trabajo útil y **sin consumo no autorizado**. No se promete cero
   procesos en los dos casos.

**Aprobación y autoridad**

4b. Una aprobación **forjada** —sin autoridad válida— no libera trabajo.
4c. Una aprobación emitida por quien no tiene autoridad sobre ese sujeto rechaza.
4d. Una aprobación cuyo digest de revisión difiere del trabajo no lo libera.
4e. Una aprobación **vencida** es `STALE`, no `DENIED`, y no libera trabajo.
4f. Una aprobación **revocada** antes de consumirse no libera trabajo.
4g. Carreras: cancelación contra decisión, timeout contra decisión, y decisión
    repetida. La primera es replay idempotente; una decisión distinta sobre el
    mismo sujeto y revisión es conflicto tipado. Las tres son obligatorias.

**Datos**

5. Dos eventos de cuenta con la misma versión → rechazo tipado.
6. Un digest de 64 caracteres con una letra fuera de rango en posición no inicial →
   rechazado por la restricción.
7. Reconstrucción multi-stream desde cero, dos veces, al mismo vector de cabezas →
   filas canónicas idénticas.
8. Trigger append-only borrado → detectado al abrir.
9. Uso parcial, cumulativo, con corrección y tardío → una liquidación correcta.
10. Uso sin precio aplicable → exposición desconocida, nunca costo cero.
11. Asignado más no asignado de un período = costo del período.

**Ejecución y recuperación**

12. Crash en cada una de las ocho fronteras de §7.
13. Un `INFLIGHT` vencido no habilita reintento: exige reconciliación.
14. Fence viejo tras recuperación → el holder anterior no puede continuar.

    Dos negativos concretos, porque el número por sí solo no lo garantiza
    ([contratos §6.1](../../architecture/contracts/index.md)): un **writer revocado
    que intenta mutar** debe ser rechazado en la operación mediada, y un
    **descendiente vivo del proceso anterior** debe estar detenido y reapeado, o
    confinado, antes de reasignar el workspace. Un perfil que no puede garantizarlo
    se declara `TRUSTED_PROCESS` y no cuenta como aislamiento.
15. Varios handoffs en un intento, mismo proveedor y entre proveedores → linaje
    completo; un destino sin binding, sin capacidad, con spawn fallido o con
    checkpoint alterado rechaza.
16. `NO_COMMIT` permite editar dentro del write-set y no produce commit;
    `READ_ONLY` impide mutar el workspace y permite estado interno.
17. Un check en rojo impide el commit; un receipt cuyo verificador es el writer es
    inválido.

**Herramientas, privacidad y observabilidad**

18. Un error de herramienta nunca produce un receipt exitoso.
19. Un schema de herramienta alterado rechaza.
20. Un secreto sintético en un **valor**, otro en un **nombre de clave**, y un
    prompt bajo una clave inocente: los tres detectados en **cada** sink protegido
    de §8.1.
21. Un artefacto de otra iniciativa conocido por digest → acceso denegado.
22. Una respuesta OTLP con rechazo parcial no se cuenta como entrega completa.
23. Un collector caído y uno lento no alteran la ejecución.

**Neutralidad por perfil**

24. Configuración A → ejecución → resultado.
25. Configuración B → misma operación y semántica → resultado.
26. Adapter retirado o incompatible → rechazo explicado, o degradación previamente
    permitida.
27. Integración ausente y en fallo: el sistema opera y lo declara.

**Superficies**

28. Cada operación anunciada responde igual por CLI y por API, con expectativas
    independientes por puerta.
29. Cada error de la unión tiene su código de salida propio; ninguno cae en un
    caso por defecto.

**Plataforma**

30. Linux y macOS: perfil completo, o el subconjunto ejecutado y las exclusiones
    declaradas por nombre.
31. Un stream lento no agota descriptores, memoria ni cola del daemon.

**Interfaz visual, en su ronda posterior**

No se implementa UI ahora, y por eso mismo su compuerta se declara ahora, para que
no se retire después alegando que el release fue sólo de backend:

32. Ninguna implementación de UI empieza antes de que el owner acepte el diseño.
33. Antes de un release con UI y antes de P9: navegación por teclado, manejo de
    foco, semántica y roles, lectura por lector de pantalla, contraste,
    preferencia de movimiento reducido, y flujos reales de extremo a extremo con
    datos reales, no capturas.

---

## 8.1 Perfil de sinks protegidos

El conjunto se **congela antes** de escribir los fixtures, y una excepción de
lectura privada se audita antes, nunca se agrega después de un fallo.

### Sinks protegidos

| Familia | Qué incluye |
| --- | --- |
| Ledger | los cuatro streams y todas sus proyecciones |
| Coordinación | los metadatos persistidos de leases, claims, reservas y outbox |
| Stream de eventos | todo frame del canal público |
| Respuestas públicas | HTTP y CLI, **incluidos los cuerpos de error** |
| Logs | daemon, adapters y herramientas, más `stdout`, `stderr` capturados y toda salida de diagnóstico |
| Telemetría | trazas, atributos, eventos de span, métricas, baggage y la cola de exportación |
| Receipts | los públicos |
| Temporales | caches intermedias del plane |
| CI | reportes, salidas de test y artefactos de la corrida |
| Control de versiones | cualquier archivo que llegue a un commit |
| DOM | cuando exista interfaz, entra por la compuerta de UI |

### Qué puede contener cada cosa

- **Prompt crudo, argumentos de herramienta y salida del modelo** viven **sólo**
  como artefacto de contenido privado, por referencia, con lista de control de
  acceso, clasificación y retención. Viajan por un canal privado —memoria, tubería
  o transporte cifrado— hacia un destino de la allowlist, o se leen por una lectura
  explícitamente autorizada. **Nunca** como metadatos JSON en el ledger, y nunca de
  refilón en una traza o un log.
- **Las credenciales** existen sólo dentro del resolver de credenciales y en la
  memoria del destino que autentica. **No se guardan como artefacto.**
- **Rutas y nombres externos sensibles** no se publican tal cual: se sanean.
- **El payload público es una allowlist estricta y versionada**: identificadores
  opacos, contadores, estados y etiquetas configuradas seguras. **Nunca**
  transcripciones, variables de entorno, cabeceras, argumentos de herramienta ni
  texto libre de error de un proveedor.

### Cómo se prueba

- Un **sentinela por fuente** en cada sink: prompt, respuesta, resultado de
  herramienta, error, cabeceras, entorno, y etiqueta o ruta.
- Un inventario `campo del sink → transformación permitida → fixture` vive en la
  sección de seguridad del contrato de tests.
- **Una fuga sintética conocida, o contenido crudo, dentro de un sink protegido es
  `FAIL`.** No existe la salida «el alcance estaba declarado».
- Lo que **no** se promete: que una expresión regular detecte cualquier secreto
  arbitrario. Lo que se prueba es la allowlist por frontera y la separación de
  canales.

---

## 9. Presupuestos numéricos

Todo lo de esta sección es **`DESIGN_TARGET`**: un objetivo publicado **antes** de
medir. **Ninguno es un resultado, ninguno es un SLA genérico y ninguno se ha
medido.** Se fijan aquí, y no se dejan al implementador, precisamente para que no
se elijan después de ver un resultado.

### 9.1 Perfil de referencia

Sin perfil, un número no significa nada.

| Eje | Valor de referencia |
| --- | --- |
| CPU | ≥ 4 núcleos lógicos |
| Memoria | ≥ 8 GiB |
| Disco | SSD |
| Runtime | la versión de Node pineada por el repositorio |
| Sistemas | macOS y Linux |

Las extensiones pesadas —motores externos, receptores de telemetría, packs de
modalidades— se miden en **su propio perfil**, no en éste.

### 9.2 Carga fija

| Eje | Valor |
| --- | --- |
| Eventos en el ledger | 100.000 |
| Iniciativas | 100 |
| Tareas | 10.000 |
| Workers de fixture independientes | 4 |
| Clientes de stream simultáneos | 25 |
| Tasa de eventos | 50 por segundo |

### 9.3 Latencia y recuperación

| Métrica | `DESIGN_TARGET` |
| --- | --- |
| Lectura de cabeza y estado, paginada | p95 ≤ 250 ms · p99 ≤ 750 ms |
| Entrega por el stream | p95 ≤ 1.000 ms |
| Arranque local | ≤ 10 s |
| Recuperación sobre el fixture | ≤ 30 s |
| Cancelación de un hijo propio | ≤ 10 s |

### 9.4 Recursos del daemon

| Métrica | `DESIGN_TARGET` |
| --- | --- |
| Memoria residente en régimen | ≤ 512 MiB |
| Crecimiento de memoria en 30 min tras el calentamiento | ≤ 64 MiB |
| Descriptores de archivo al final | ≤ línea base + 10 |
| Procesos hijo huérfanos | 0 |

### 9.5 Topes de protocolo y de cola

| Límite | `DESIGN_TARGET` |
| --- | --- |
| Cola de exportación | 10.000 elementos o 16 MiB, lo que ocurra primero |
| Respuesta de herramienta o de red | ≤ 1 MiB |
| Evento seguro por el stream | ≤ 32 KiB |
| Petición de metadatos | ≤ 256 KiB |
| Artefacto individual, por defecto | ≤ 8 MiB |
| Cuota total de artefactos, configurable | 1 GiB |

**Todo desbordamiento falla de forma cerrada o descarta con un contador explícito
de telemetría. Nunca en silencio.**

### 9.6 Reglas de uso

1. Si una política vigente en el código es **más restrictiva** que un número de
   arriba, **gana la política vigente** hasta que un packet adjudique el cambio.
2. Cada límite tiene un dueño compartido y una unidad en su nombre, declarados con
   el resto de las constantes ([estructura §4.2](../../architecture/structure/index.md)).
3. Se mide **throughput sintético**, no calidad de modelo. Instalaciones, builds y
   proveedores reales se miden aparte y con autorización de gasto.
4. **Un objetivo no se modifica después de una corrida para que quede en verde.**
   Cambiarlo es una decisión explícita, versionada y con motivo, registrada en
   [decisiones](../../decisions/index.md) **antes** de volver a medir.
5. Un objetivo incumplido se reporta como incumplido.

---

## 10. Lo que hoy no se puede ejecutar, y por qué

| Qué | Estado | Motivo |
| --- | --- | --- |
| Suite completa | **no ejecutada** | los casos mutantes escriben el checkout vivo (§5). Se ejecuta cuando P-01 cierre |
| Proveedor real, consumo pagado | no ejecutado | requiere autorización de gasto y elección de cuenta por el owner |
| CI hosted en Linux con perfil completo | no verificado | esta ronda no consultó una corrida hosted |
| Benchmark de aceptación | no ejecutado | requiere la carga fija de §9, que todavía no está fijada |
| Motor durable externo y receptor de telemetría vivos | no ejecutados | sin instalaciones nuevas en esta ronda |

Ninguna de estas ausencias se convierte en un `PASS`, y ninguna se presenta como
cobertura.

---

## 11. Orden de construcción de la suite

1. **Aislar** todo lo que escribe el checkout vivo. Es la precondición de correr la
   suite completa una sola vez con confianza.
2. **Fixtures adversariales** para las duplicaciones con divergencia
   ([estructura §4.1](../../architecture/structure/index.md)), con oráculo escrito
   a mano.
3. **Suite de contrato** por familia de integración, ejecutable contra cada
   implementación real.
4. **Matriz de crash** de §7, empezando por las fronteras que hoy tienen la ventana
   abierta.
5. **Negativos de privacidad y de herramientas**, con secretos sintéticos.
6. **Paridad con expectativas independientes** por puerta.
7. **Plataforma y recursos**, con la carga fija de §9 ya congelada.

Cada escalón deja la suite ejecutable. Ninguno introduce un testkit nuevo sin un
consumidor en el mismo packet.
