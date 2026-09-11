# Calidad: rúbrica, escalera de madurez y estado medido

Dueño único del concepto **medición**: la escalera, las dimensiones, los criterios
observables, las compuertas críticas y el estado actual con sus vacíos declarados.

[Índice](../README.md) · [Tests](testing/index.md) · [Arquitectura](../architecture/index.md) · [Hallazgos](../findings/index.md) · [Evidencia](../evidence/index.md) · [Roadmap](../roadmap/index.md)

Estado: **instrumento**, no certificación. La aplicación de esta rúbrica al árbol
actual está **incompleta a propósito**: sólo se puntúa lo que esta ronda midió, y
todo lo demás dice `UNKNOWN`.

---

## 1. La escalera, conservada

| Nivel | Nombre | Condición observable |
| --- | --- | --- |
| 0 | Ausente | No hay tipo, schema, prosa ni código |
| 1 | Declarado | Existe en prosa, ADR, tipo, schema o constante; ningún código productivo lo realiza |
| 2 | Implementado aislado | Hay código y tests, pero falta al menos uno: caller productivo, path ensamblado, o test conductual con oráculo externo |
| 3 | Cableado y probado | Caller productivo sobre el path ensamblado, más un test conductual con control positivo o negativo que lo haría fallar |
| 4 | Forzado | Una compuerta mecánica —compilador, fence con sonda de fallo sintético, hook, contrato ejecutable— impide la regresión, y la afirmación documental coincide con la medida |

Cuatro columnas por criterio, también conservadas:

- **Medido**: nivel, con evidencia `archivo:línea`, test o sonda.
- **Afirmado**: el nivel que la documentación da a entender, **con la cita exacta
  que lo afirma**. Sin una cita `archivo:línea` de una afirmación documental, la
  celda dice `NOT_REASSESSED`; no se hereda el valor de una ronda anterior y no se
  infiere una afirmación desde la existencia de un defecto.
- **Brecha**: `max(0, Afirmado − Medido)`, calculable **sólo** cuando *Afirmado*
  tiene cita. Con `NOT_REASSESSED` no hay brecha, y no se promedia.
- **Medición**: el comando, la sonda o el test que decide el nivel. Un criterio sin
  medición no entra en la rúbrica.

Regla de qué evidencia habilita qué nivel:

| Nivel a asignar | Evidencia suficiente |
| --- | --- |
| 1 o 2 | lectura del código, con `archivo:línea` citado |
| 3 o 4 | un **receipt de conducta**: un test o una sonda que se ejecutó, con su salida. La lectura no alcanza |

### 1.1 `UNKNOWN` no es `0`

Un criterio **no medido** se marca `UNKNOWN` y **no participa** de ningún promedio.
`0` significa «se midió y no existe». Confundirlos produce las dos mentiras
simétricas: un promedio deprimido por lo que nadie miró, o un promedio inflado
excluyendo en silencio lo incómodo. El conteo de `UNKNOWN` se publica junto a
cualquier nota.

### 1.2 Las compuertas críticas no se compensan

Ciertos criterios son **CRITICAL**. Un CRITICAL por debajo de 3 **impide la
certificación**, cualquiera sea el promedio. No hay dimensión brillante que compre
un CRITICAL rojo.

Un criterio sube a 3 o 4 sólo con conducta observada; el resto de la escalera
admite observación de fuente citada.

| CRITICAL | Por qué |
| --- | --- |
| `CON-1` la instrucción llega y el resultado vuelve | sin esto no hay producto que certificar |
| `LED-2` cadena de hashes sobre los cuatro streams | el ledger es la autoridad o no lo es |
| `EJE-4` sin efecto conocido duplicado y con exposición registrada | doble gasto real de cuota |
| `SEG-1` ningún secreto en superficies registradas | daño irreversible |
| `SEG-3` un solo writer por worktree, con fencing efectivo | corrupción del trabajo del owner |
| `TST-3` receipt de verificador independiente por commit | es la ley que el producto existe para mecanizar |
| `TST-4` la compuerta mecánica corre y puede pasar de verdad | una compuerta decorativa es peor que ninguna |

### 1.3 Cómo se puntúa, y cuándo no se puntúa

- Nota de dimensión = promedio de sus niveles medidos × 2,5, **excluyendo** los
  `UNKNOWN`, y publicada junto a `medidos/total`.
- Nota global = promedio ponderado de dimensiones, **sólo si** menos de un cuarto de
  los criterios está en `UNKNOWN`. Por encima de ese umbral **no se publica ninguna
  nota global ni ningún índice agregado**: se publica el inventario.
- Índice de falsa seguridad = promedio de brechas sobre los criterios cuya columna
  *Afirmado* tiene cita. Si no hay suficientes, **no se publica el índice**; se
  listan las brechas individuales.
- **Un criterio que sube a 4 debe nombrar la compuerta mecánica que lo sostiene.**
  Si no puede nombrarla, es 3.

---

## 2. Criterios observables: qué cuenta y qué no

Reglas que hacen falsable a esta rúbrica.

**Cuenta como evidencia:**

- un test conductual con oráculo externo y control negativo que lo haría fallar;
- una sonda de fallo sintético sobre un árbol de prueba, que hace fallar la ley;
- un caller productivo alcanzable desde una puerta del producto;
- un inventario de consumidores reales de un símbolo.

**No cuenta como evidencia:**

- un `grep` de un literal de marca como prueba semántica de neutralidad;
- la presencia de un ancla de texto en un archivo como prueba de una conducta;
- una comparación de una función consigo misma;
- un mock donde el requisito pide dos implementaciones reales;
- un puerto sin caller;
- un porcentaje de cobertura de líneas como única garantía;
- un documento nuevo y un `index.ts` nuevo como avance de producto.

**Criterios retirados**, con su motivo:

| Retirado | Motivo |
| --- | --- |
| Carpetas de primer nivel / archivos `< 0,5` | mide forma, no responsabilidad; un paquete de cinco archivos coherentes lo incumple sin defecto |
| Lista negra universal de nombres de carpeta | se conserva como guía de nombres; el gate real es ciclos, deep imports, base de datos en el dominio y consumidores reales |
| Factory obligatoria de cero argumentos | favorece globals ocultos ([arquitectura §6](../architecture/index.md)) |
| «Un caso de uso, un archivo» | produce archivos gigantes o abstracciones prematuras |
| `grep` de vendor en `kernel` y `domains` = 0 | se reemplaza por inventario de consumidores reales |

**Criterios agregados** para cubrir lo que la rúbrica anterior no miraba: ciclos
entre paquetes, deep imports, apertura de base de datos desde un dominio,
separación de declaraciones de tipo respecto de valores de runtime, y
determinismo de reconstrucción multi-stream.

---

## 3. Dimensiones y pesos

| Dim. | Nombre | Peso | Qué mide |
| --- | --- | --- | --- |
| ARQ | Estratos y dependencias | 2 | dirección del grafo, puertos, ausencia de ciclos |
| EST | Estructura, DRY y tipos | 2 | responsabilidad legible desde el árbol, duplicación con divergencia, separación de declaraciones |
| CON | Contratos y ejes de sustitución | 3 | que la instrucción llegue, que el resultado vuelva, que un eje se cambie sin reescribir |
| LED | Ledger y datos | 3 | autoridad, integridad, reconstrucción, atomicidad |
| EJE | Lazo de ejecución | 3 | efectos reales, recuperación, ownership |
| CTA | Cuentas | 3 | inventario, cuota honesta, reservas, handoff |
| PLA | Planificación | 3 | pasos, DAG, equipo, aprobación durable |
| ECO | Economía | 2 | uso, precios, costo derivado, presupuesto |
| SEG | Seguridad operacional | 2 | secretos, egress, aislamiento, writer único |
| PAR | Paridad de puertas | 2 | una operación, tres puertas, misma respuesta |
| OBS | Observabilidad y trazabilidad | 2 | linaje, telemetría no bloqueante, línea de base |
| TST | Tests y evidencia | 2 | conducta probada, compuertas que pueden pasar, receipts |
| GOB | Gobernanza y costo de cambio | 1 | proporcionalidad del fence, ADRs aterrizados, segundo writer posible |
| OPE | Operabilidad | 1 | instalación, diagnóstico, límites de recursos, backup y restore |

Los pesos codifican los objetivos del owner: los tres lazos de producto y lo que
los sostiene pesan más que la gobernanza.

---

## 4. Criterios

Cada fila: criterio · medición que decide el nivel. `[C]` marca CRITICAL.

**ARQ — Estratos y dependencias**

| # | Criterio | Medición |
| --- | --- | --- |
| ARQ-1 | El grafo de [arquitectura §2](../architecture/index.md) se cumple en ambas direcciones | sonda sintética: un import `domains → edges` y otro `domains → persistence` deben fallar |
| ARQ-2 | Cero ciclos entre paquetes y cero deep imports | análisis del grafo de imports por AST, no por regex |
| ARQ-3 | Ningún dominio abre una base de datos | inventario: `openLedger`, `better-sqlite3` y equivalentes no aparecen bajo `domains/*/src` |
| ARQ-4 | Cada seam tiene su puerto donde está su consumidor | inventario de `*Port` cruzado con sus consumidores reales |
| ARQ-5 | Composition root único, fuera del barrel público | el `index.ts` de cada paquete sin imports de runtime ni declaraciones |
| ARQ-6 | Grafo de dependencias congelado, sin install scripts, nativas pineadas | `pnpm install --frozen-lockfile`; fence de `onlyBuiltDependencies` |

**EST — Estructura, DRY y tipos**

| # | Criterio | Medición |
| --- | --- | --- |
| EST-1 | El path cuenta la responsabilidad | revisión de nombres contra la guía de [estructura](../architecture/structure/index.md); sin ratio numérico |
| EST-2 | Espejo `src`/`test` **topológico**, barrels cerrados, un solo sustantivo de andamiaje | el fence comprueba que cada ruta de `src` tenga su ruta espejo en `test`; **no** exige un archivo de test por cada símbolo del barrel. `export *` = 0 |
| EST-3 | Ninguna duplicación con divergencia de comportamiento | un fixture adversarial por familia duplicada; dos puertas, un resultado |
| EST-4 | Declaraciones de tipo separadas de valores de runtime | ningún `type`, `interface` ni `enum` fuera de `types/`; ningún valor en `types/` |
| EST-5 | Sin `enum` ni `const enum` de TypeScript | comprobación de `erasableSyntaxOnly` |
| EST-6 | Sin narración de packets ni de fases en el código | barrido con límite de palabra sobre `src` |

**CON — Contratos y ejes de sustitución**

| # | Criterio | Medición |
| --- | --- | --- |
| CON-1 `[C]` | La instrucción llega al modelo y el resultado vuelve | un hijo que devuelve lo recibido, ejercitado desde CLI **y** API; el resultado se recupera por referencia |
| CON-2 | Eje de transporte forzado por el compilador | `switch` con `never`; un cuarto transporte rompe la compilación en cada consumidor |
| CON-3 | Eje de proveedor por descriptor validado con registro | agregar un proveedor sin adapter falla en la composición con un rechazo correcto, no como error de cuenta |
| CON-4 | Eje de durabilidad consumido polimórficamente | un driver stub pasa el walk por el puerto; un segundo motor no toca el dominio |
| CON-5 | Errores por contexto con mapeo exhaustivo en cada frontera | el compilador comprueba la exhaustividad de la traducción |
| CON-6 | Contratos estrictos y versionados, con guardias no heurísticas donde la forma es fija | schema por tipo de evento; una sonda de token embebido rechaza |
| CON-7 | Un tipo de vendor nunca cruza un contrato compartido | inspección del `.d.ts` emitido de cada paquete público |

**LED — Ledger y datos**

| # | Criterio | Medición |
| --- | --- | --- |
| LED-1 | Append-only por trigger, con inventario que detecta remoción | sonda `UPDATE`/`DELETE` sobre tabla poblada en los cuatro streams |
| LED-2 `[C]` | Cadena de hashes sobre los cuatro streams e integridad total, con cobertura declarada | forjar una fila con triggers apagados → integridad falla y reporta `covered_since_sequence` |
| LED-3 | Reconstrucción determinista multi-stream a un vector de cabezas | dos reconstrucciones producen filas canónicas idénticas; sobre cadena rota se rehúsa |
| LED-4 | Identidad de instancia y de restore, no del path | mismo path, otro archivo, y un restore formal → cursores distintos |
| LED-5 | Escrituras multi-evento atómicas | SIGKILL entre eventos de un `appendBatch` deja cero estados intermedios |
| LED-6 | Concurrencia entre procesos con procesos reales | N procesos: un ganador, N−1 replays o conflictos tipados, cero crashes de lock |
| LED-7 | Restricciones de dominio efectivas | un digest de 64 caracteres con una letra fuera de rango en posición no inicial es rechazado |

**EJE — Lazo de ejecución**

| # | Criterio | Medición |
| --- | --- | --- |
| EJE-1 | Cada paso del plan tiene efecto real o no existe | cero pasos que afirmen trabajo sin un puerto de efecto |
| EJE-2 | La política de commit se lee del envelope | envelope `NO_COMMIT` sin registro de commit, y con edición permitida dentro del write-set |
| EJE-3 | Checkpoint producido **y** rehidratado | un checkpoint escrito continúa el trabajo en otro proceso |
| EJE-4 `[C]` | Sin efecto conocido duplicado; exposición registrada donde el desenlace es incierto | SIGKILL en cada frontera de la saga |
| EJE-5 | Recuperación tras SIGKILL en ambas lanes, daemon incluido | el server del motor se reapea y el reinicio funciona |
| EJE-6 | Puerta de sometimiento y daemon residente con cola | una tarea entra por CLI o API y el daemon la consume sin reinicio |
| EJE-7 | Cancelación, señal, timer y reattach llegan hasta el hijo | un verbo interrumpe un hijo real; la matriz de capacidades se verifica desde una puerta |
| EJE-8 | Drill con sujeto real | al menos una capacidad de proveedor sale de `UNKNOWN` con un CLI y una cuenta reales |

**CTA — Cuentas**

| # | Criterio | Medición |
| --- | --- | --- |
| CTA-1 | Pool con reserva por walk y tope por cuenta | dos walks eligen cuentas distintas; el tope por cuenta se honra |
| CTA-2 | Cuota derivada de observaciones reales, con estado explícito | un registro con margen bajo nunca publica margen completo; `UNKNOWN` no vale 100 % |
| CTA-3 | Presión de cuota clasificada por el adapter | una señal real produce un disparador de handoff |
| CTA-4 | Handoff ejecutado de verdad | sesión abierta y checkpoint rehidratado en el destino antes de marcar éxito |
| CTA-5 | Estado efectivo del operador plegado en la elección | drenar una cuenta impide que la siguiente sumisión la elija |
| CTA-6 | Varios handoffs en un intento, mismo y distinto proveedor | linaje completo de segmentos |
| CTA-7 | Calendario de suscripción y ventana de cuota separados | la ventana rueda sin producir un reset ya pasado |

**PLA — Planificación**

| # | Criterio | Medición |
| --- | --- | --- |
| PLA-1 | Roadmap como plan estructurado con equipo por paso | pasos declarados, con diff entre versiones |
| PLA-2 | Grafo de tareas con dependencias y predicado READY | el scheduler respeta orden, no sólo compatibilidad de write-sets |
| PLA-3 | Coordinador ejecutable como workflow durable | un walk con rol coordinador produce y registra un plan |
| PLA-4 | Aprobación del owner con señal durable, digest y vencimiento | reanudación por señal; una aprobación stale no libera trabajo |
| PLA-5 | Iniciativas con OCC y restauración trazable | restaurar crea una revisión nueva |
| PLA-6 | Precedencia de tres niveles resuelta contra un vector de cabezas | un cambio de defaults no afecta ejecuciones en curso |

**ECO — Economía**

| # | Criterio | Medición |
| --- | --- | --- |
| ECO-1 | Tokens por tipo, con procedencia y estado | entrada, salida y cache soportados; desconocidos explícitos |
| ECO-2 | Catálogo de precios versionado sin intervalos solapados | una versión con solapamiento rechaza |
| ECO-3 | Costo derivado y determinista, sin hecho de costo independiente | reconstruir dos veces da el mismo snapshot; sin tarifa de respaldo cero |
| ECO-4 | Prorrateo, gasto medido y equivalente separados y conciliados | asignado más no asignado igual al costo del período |
| ECO-5 | Presupuesto aplicado antes y durante el efecto | una ruta sin margen rechaza |
| ECO-6 | Evaluaciones válidas producen versiones del único registry | un artefacto inválido no crea versión |

**SEG — Seguridad operacional**

| # | Criterio | Medición |
| --- | --- | --- |
| SEG-1 `[C]` | Ningún secreto ni prompt crudo en ledger, stream público, logs ni trazas | secretos sintéticos en clave y en valor, y prompt bajo una clave inocente |
| SEG-2 | Egress explícito y mínimo hacia destinos autorizados | un destino no autorizado no recibe nada |
| SEG-3 `[C]` | Un solo writer por worktree con fencing efectivo | tras recuperación, el holder viejo no puede continuar |
| SEG-4 | Entorno del hijo construido clave a clave, un solo spawn authority | una variable plantada no llega al hijo |
| SEG-5 | Superficie de escritura fail-closed y loopback como frontera | sin credencial, rechazo; ausente e incorrecta indistinguibles |
| SEG-6 | Aislamiento del proceso hijo, o su ausencia declarada | un intento de red o de escritura fuera del perfil falla de verdad |
| SEG-7 | Herramientas unidas por digest de schema | un cambio de schema rechaza; un error de herramienta nunca es éxito |

**PAR — Paridad de puertas**

| # | Criterio | Medición |
| --- | --- | --- |
| PAR-1 | Una operación, no dos implementaciones | respuestas equivalentes por CLI y API con control negativo |
| PAR-2 | Mapa total de verbo por ruta, con excepción escrita | el mapa cubre todas las rutas |
| PAR-3 | Exit codes exhaustivos sobre la unión de errores | `switch` sin `default` |
| PAR-4 | La pata de UI no es tautológica | expectativa independiente, o la pata se retira y se documenta |
| PAR-5 | Stream: secuencia como identidad, replay sin huecos ni duplicados, identidad por instancia y restore | reconexión con filas apendeadas en la ventana |

**OBS — Observabilidad y trazabilidad**

| # | Criterio | Medición |
| --- | --- | --- |
| OBS-1 | Cadena completa de una tarea reconstruible | una consulta reconstruye worker, cuenta, modelo, prompt, respuesta, uso, commit y receipt |
| OBS-2 | Telemetría con claves alineadas al emisor y árbol de trazas | test contra eventos del emisor real, no fixtures planos |
| OBS-3 | Exporter conectado, no bloqueante, con salud independiente | collector caído o lento no altera el walk; descartes visibles |
| OBS-4 | Éxito parcial de OTLP manejado | una respuesta con rechazo parcial no se cuenta como entrega completa |
| OBS-5 | Logs estructurados con redacción y correlación | identificadores de traza en cada línea; scrub probado |
| OBS-6 | Consumo y costo por cuenta e iniciativa | el gasto no ubicable se reporta, no se esconde |

**TST — Tests y evidencia**

| # | Criterio | Medición |
| --- | --- | --- |
| TST-1 | Aserciones conductuales con oráculo externo y controles negativos | muestreo clasificado: conducta, pin estructural, texto fuente, tautología |
| TST-2 | Drills con procesos y señales reales, sin skips silenciosos | cero skips en drills; SIGKILL real; oráculo en filesystem o base |
| TST-3 `[C]` | Receipt de verificador independiente por commit, verificado mecánicamente | un commit sin receipt válido es rechazado por una compuerta |
| TST-4 `[C]` | La compuerta mecánica corre en un runner real y puede pasar | una corrida verde registrada en el log del workflow |
| TST-5 | Ninguna ley del fence pasa con evidencia vacía | anclas no vacías, parser léxico, y una sonda adversarial por familia |
| TST-6 | Ninguna prueba escribe el checkout vivo | los drills mutantes corren sobre un árbol sintético |
| TST-7 | La suite pinea su propio conteo | una corrida truncada falla con un mensaje sobre archivos faltantes |

**GOB — Gobernanza y costo de cambio**

| # | Criterio | Medición |
| --- | --- | --- |
| GOB-1 | Fence proporcional: leyes como datos, historia fuera del script, imports por AST | write-sets en un archivo de datos; cero regex de import |
| GOB-2 | Sonda de fallo sintético por familia de ley | cada familia con al menos una sonda que la hace fallar |
| GOB-3 | La autoridad vigente está commiteada y pineada por digest, y las docs que afirman completitud se verifican | el documento de autoridad vive en el árbol rastreado con su digest en la compuerta; superficie verificada por paquete; conteos del README pineados |
| GOB-4 | Un ADR aceptado implica un árbol que lo refleja | cero decisiones aceptadas sin aterrizar ni enmendar |
| GOB-5 | Un segundo writer es posible | dos write-sets disjuntos no colisionan en el fence |

**OPE — Operabilidad**

| # | Criterio | Medición |
| --- | --- | --- |
| OPE-1 | Instalación, arranque, parada y reap del daemon | reinicio en cola, en ejecución, en espera y en timer |
| OPE-2 | Diagnóstico que nombra qué falta | clases de fallo con nombre y acción, sin secretos |
| OPE-3 | Límites de disco, memoria, procesos, cola y descriptores | un consumidor lento no agota el daemon |
| OPE-4 | Backup consistente y restore probado | restore con identidad nueva, hashes y acceso comprobados |
| OPE-5 | Funciona con la integración presente, ausente y fallando | los tres escenarios, no sólo la inexistencia de callers |
| OPE-6 | Perfil de durabilidad declarado y observable | el perfil vigente se lee del estado, no se supone |

Total: **89 criterios en 14 dimensiones** — ARQ 6, EST 6, CON 7, LED 7, EJE 8,
CTA 7, PLA 6, ECO 6, SEG 7, PAR 5, OBS 6, TST 7, GOB 5, OPE 6.

---

## 5. Trazabilidad de los 71 criterios anteriores

Ninguna dimensión de la rúbrica previa se pierde. Los scores de 2026-09-04 son
**históricos** y no describen el árbol actual.

| Antes | Ahora | Disposición |
| --- | --- | --- |
| A1 estratos verificados en ambas direcciones | ARQ-1 | conservado, con el grafo corregido |
| A2 puerto por seam en el dominio | ARQ-4 | revisado: el puerto va donde está el consumidor |
| A3 sin vocabulario de vendor por `grep` | ARQ-3 + CON-7 | revisado: inventario de consumidores y `.d.ts` emitido, no `grep` |
| A4 composition root único | ARQ-5 | conservado |
| A5 grafo congelado | ARQ-6 | conservado |
| B1 nombre de paquete declarativo | EST-1 | conservado |
| B2 nivel de familia, ratio < 0,5 | EST-1 | **revisado**: el ratio se retira; queda el juicio de responsabilidad |
| B3 lista negra de nombres de carpeta | EST-1 | **revisado**: guía, no gate |
| B4 sin sinónimos ni colisiones | EST-1 | conservado |
| B5 espejo, barrels, un sustantivo de andamiaje | EST-2 | conservado |
| B6 sin narración de packets | EST-6 | conservado |
| C1 transporte forzado por el compilador | CON-2 | conservado |
| C2 proveedor por descriptor tipado | CON-3 | conservado |
| C3 durabilidad consumida polimórficamente | CON-4 | conservado |
| C4 telemetría: puerto en el dominio, exporter en un edge | OBS-3 | conservado, con exigencia de caller |
| C5 tools: puerto, transportes, MCP acotado | SEG-7 | conservado |
| C6 contratos estrictos, versionados, no heurísticos | CON-6 | conservado |
| D1 append-only por trigger | LED-1 | conservado, ampliado a cuatro streams |
| D2 cadena e integridad total | LED-2 `[C]` | conservado, más cobertura declarada |
| D3 rebuild byte-equivalente | LED-3 | **revisado**: filas canónicas a cabezas fijadas, no bytes |
| D4 identidad por instancia | LED-4 | conservado, más `restore_id` |
| D5 escrituras multi-evento atómicas | LED-5 | conservado |
| D6 concurrencia con procesos reales | LED-6 | conservado |
| E1 la instrucción llega al modelo | CON-1 `[C]` | conservado, más el retorno del resultado |
| E2 cada paso tiene efecto real | EJE-1 | conservado |
| E3 política de commit del envelope; checkpoint producido | EJE-2 + EJE-3 | dividido; EJE-3 exige rehidratación |
| E4 idempotencia con exposición registrada | EJE-4 `[C]` | conservado, elevado a CRITICAL |
| E5 recuperación tras SIGKILL en ambas lanes | EJE-5 | conservado |
| E6 puerta de sometimiento y daemon residente | EJE-6 | conservado |
| E7 cancel, signal, timer y reattach hasta el hijo | EJE-7 | conservado |
| E8 drill con sujeto real | EJE-8 | conservado |
| F1 pool con reserva y tope por cuenta | CTA-1 | conservado |
| F2 cuota desde observaciones reales | CTA-2 | conservado, con estado explícito |
| F3 presión de cuota clasificada | CTA-3 | conservado |
| F4 switch ejecutado de verdad | CTA-4 | conservado |
| F5 estado efectivo en la elección | CTA-5 | conservado |
| F6 clase de costo y presupuesto | ECO-5 | movido a economía |
| F7 calendario de reset con recurrencia | CTA-7 | conservado, separado del período comercial |
| G1 roadmap como plan con equipo por paso | PLA-1 | conservado |
| G2 grafo de tareas con dependencias | PLA-2 | conservado, más predicado READY |
| G3 coordinador durable | PLA-3 | conservado |
| G4 compuerta de aprobación con señal durable | PLA-4 | conservado, más digest y vencimiento |
| G5 iniciativas con OCC y rollback | PLA-5 | conservado |
| G6 linaje de prompts con vault | OBS-1 | movido a observabilidad, con acceso por referencia |
| H1 entorno del hijo clave a clave | SEG-4 | conservado |
| H2 escritura fail-closed | SEG-5 | conservado |
| H3 sin secretos en ledger, stream ni DOM | SEG-1 `[C]` | conservado, elevado a CRITICAL |
| H4 guardia de payload por schema | SEG-1 | absorbido, con alcance declarado |
| H5 tools por digest de schema | SEG-7 | conservado |
| H6 loopback como frontera | SEG-5 | absorbido |
| I1 una operación, no dos implementaciones | PAR-1 | conservado |
| I2 mapa total de verbo por ruta | PAR-2 | conservado |
| I3 exit codes exhaustivos | PAR-3 | conservado |
| I4 la pata de UI no es tautológica | PAR-4 | conservado |
| I5 SSE con secuencia como identidad | PAR-5 | conservado, más restore |
| J1 cadena completa reconstruible | OBS-1 | conservado |
| J2 telemetría con claves del emisor | OBS-2 | conservado |
| J3 exporter opcional y no bloqueante | OBS-3 | conservado, más éxito parcial en OBS-4 |
| J4 logs con redacción y correlación | OBS-5 | conservado |
| J5 consumo y costo por cuenta e iniciativa | OBS-6 | conservado |
| K1 aserciones conductuales | TST-1 | conservado |
| K2 drills con procesos reales | TST-2 | conservado |
| K3 CI corre la misma compuerta y pasa | TST-4 `[C]` | conservado, elevado a CRITICAL |
| K4 receipt de verificador por commit | TST-3 `[C]` | conservado, elevado a CRITICAL |
| K5 autoridad del programa commiteada y pineada | GOB-3 | movido a gobernanza |
| K6 la suite pinea su conteo | TST-7 | conservado |
| L1 fence proporcional | GOB-1 | conservado |
| L2 sonda de fallo por familia | GOB-2 | conservado; TST-5 agrega la vacuidad de anclas |
| L3 docs verificadas | GOB-3 | conservado |
| L4 ADR aceptado implica árbol | GOB-4 | conservado |
| L5 segundo writer posible | GOB-5 | conservado |

Criterios nuevos sin antecedente: ARQ-2, EST-3, EST-4, EST-5, CON-5, LED-7,
CTA-6, ECO-1 a ECO-4, ECO-6, PLA-6, SEG-2, SEG-6, TST-5, TST-6, OPE-1 a OPE-6.

---

## 6. Estado medido en `a92756b`

Esta ronda **no** aplicó los 89 criterios. Midió lo que la
[evidencia](../evidence/index.md) documenta, con sondas read-only y sin correr la
suite completa. Todo lo demás es `UNKNOWN`, que no es `0`.

La columna *Afirmado* dice `NOT_REASSESSED` en todas las filas: esta ronda **no**
reauditó qué nivel afirma la documentación del snapshot, y un defecto observado no
prueba que un documento afirmara lo contrario. Sin esa relectura no hay brecha
calculable y no se publica ningún índice agregado.

| Criterio | Medido | Afirmado | Fuente de la medición |
| --- | --- | --- | --- |
| CON-1 `[C]` | 1 | `NOT_REASSESSED` | N01, N02: el digest no cubre objetivo ni autoridad; API y local no transportan instrucciones |
| EJE-1 | 1 | `NOT_REASSESSED` | N03: verificación, auditoría y commit siguen siendo eventos sin efecto |
| EJE-2 | 1 | `NOT_REASSESSED` | N03: la política de commit está fijada en el daemon |
| EJE-3 | 2 | `NOT_REASSESSED` | escritura con caller productivo; lectura sin consumidor |
| EJE-4 `[C]` | 2 | `NOT_REASSESSED` | N04: la ventana está declarada y aseverada, y la exposición no se registra |
| CTA-4 | 1 | `NOT_REASSESSED` | N05: el aterrizaje admite salud desconocida y confirma antes de abrir el destino |
| SEG-7 | 1 | `NOT_REASSESSED` | ~~N07: un error de herramienta se convierte en éxito~~ **N07 CERRADO en P-11** (`c2ca1c0`, ADR 0069): el indicador `isError` se interpreta, el receipt queda `REFUSED`/`RESULT_IS_ERROR`, drills rojos→verdes en ambas puertas; re-puntuar en la reevaluación de la rúbrica |
| SEG-1 `[C]` | 2 | `NOT_REASSESSED` | N08: payload abierto; un secreto sintético como nombre de clave y un prompt bajo una clave inocente no se detectan |
| LED-2 `[C]` | 2 | `NOT_REASSESSED` | N13: el stream de cuentas está fuera de la cadena |
| TST-5 | 1 | `NOT_REASSESSED` | N06: la sección real del gate pasa con anclas vacías y con un ancla dentro de un bloque de comentario |
| TST-6 | 1 | `NOT_REASSESSED` | N09: cinco casos mutantes del drill de launchd escriben el checkout vivo; P-01 también aísla su sexto caso de línea base ([tests §5](testing/index.md)) |
| OBS-3 | 1 | `NOT_REASSESSED` | N11: el exporter no está conectado a un dispatcher productivo |
| OBS-4 | 1 | `NOT_REASSESSED` | N11: cualquier respuesta 2xx se toma como entrega completa |
| ECO-6 | 1 | `NOT_REASSESSED` | N12: el productor acepta modelos vacíos, fechas inválidas y tokens fraccionarios |
| CON-4 | 2 | `NOT_REASSESSED` | N14: los registries están cerrados y una factory tiene motor por defecto |
| CON-7 | 2 | `NOT_REASSESSED` | un tipo del SDK sale por un barrel público |
| LED-4 | 1 | `NOT_REASSESSED` | N10: la identidad se deriva del path |
| OPE-6 | 1 | `NOT_REASSESSED` | el perfil de durabilidad es `NORMAL`; la garantía por perfil no está declarada |
| EST-3 | 1 | `NOT_REASSESSED` | tres implementaciones divergentes de la proyección de claves de payload |
| ARQ-3 | 2 | `NOT_REASSESSED` | un dominio abre el ledger en un sitio |

**20 medidos de 89; 69 en `UNKNOWN`, el 77,5 %.**

Consecuencias que se declaran en lugar de esconderse:

- **No se publica ninguna nota global ni ningún índice de falsa seguridad.** Los
  `UNKNOWN` superan por mucho el umbral de §1.3, y la columna *Afirmado* no fue
  reauditada.
- Los veinte niveles medidos se apoyan en lectura de fuente citada, no en conducta
  ejecutada: por eso ninguno supera 2. Subir cualquiera de ellos a 3 exige un
  receipt de conducta.
- **Cuatro de las siete compuertas CRITICAL están medidas y ninguna alcanza 3**;
  las otras tres —SEG-3, TST-3 y TST-4— están en `UNKNOWN`. Con eso basta para que
  la certificación no proceda, sin importar el resto.
- **La nota ponderada de 2026-09-04 no es el estado actual.** Fue medida sobre otro
  snapshot con otro instrumento; se conserva como dato histórico en
  [evidencia](../evidence/index.md) y no se recalcula aquí.

---

## 7. La conjunción de certificación

La certificación del backend es una **conjunción**. Se cumplen todas las
condiciones o no hay certificación; ninguna se compensa con otra.

1. Todo requisito con estado `MANDATORY` en el perfil publicado está en `PASS`.
2. Todo requisito con estado `OPTIONAL_SELECTED` en ese perfil está en `PASS`.
3. Toda compuerta `CRITICAL` está en nivel 3 o más, y **ninguna** está en `UNKNOWN`.
4. No queda ningún defecto material abierto de [hallazgos §2](../findings/index.md).
5. El puente de autoridad está cerrado
   ([migración](../implementation/migration/index.md)): la especificación vigente
   está commiteada, pineada por digest y admitida por la compuerta.
6. Existe evidencia de extremo a extremo por cada combinación soportada. **Que los
   scripts compilen y que las comprobaciones documentales pasen no sustituye a un
   escenario E2E.**

### 7.1 Perfil: cada requisito lleva su estado, antes de ejecutar

Cada una de las 121 filas de [requisitos](../requirements/index.md) —99 casos más
22 criterios transversales— recibe uno de estos estados **antes** de que empiece la
ronda de certificación, junto con la compuerta que la cierra:

| Estado | Significado |
| --- | --- |
| `MANDATORY` | parte del núcleo del release; su fallo impide certificar |
| `OPTIONAL_SELECTED` | pack elegido para este release; su fallo impide certificar |
| `NOT_SELECTED` | pack no elegido; no se prueba y no se anuncia |
| `DEFERRED` | fuera de alcance por decisión registrada |

**Ninguna fila cambia de estado después de ver un resultado.** Excluir algo para
aprobar es exactamente lo que esta regla prohíbe; un cambio de estado es una
decisión previa, versionada y con motivo, en
[decisiones](../decisions/index.md).

Asignación de partida propuesta para el primer release:

- **Núcleo `MANDATORY`:** los 99 casos, con dos excepciones — `G3` (consola) es
  `DEFERRED` a la ronda de UI, y `H7` (adopción en un repositorio de producto) es
  `DEFERRED` a P9. `G4` queda `MANDATORY` en su parte de backend —CLI y API dicen
  lo mismo— y `DEFERRED` en su parte de UI.
- **Transversales `MANDATORY`:** los criterios `X01`–`X22` cuya estructura o
  contrato portable es objetivo del release, aunque su implementación completa sea
  posterior: el contrato debe existir y estar probado.
- **`NOT_SELECTED` en el primer release:** migración de un motor activo en caliente
  (`X03`), un segundo framework de orquestación, comunicación con agentes externos
  (`X11`), voz y multimodalidad más allá de texto (`X13`), y memoria con retrieval
  (`X10`).
- **Dos implementaciones reales** se exigen sólo en las familias anunciadas como
  **intercambiables**; una implementación real basta para anunciar **funcional**
  ([integraciones §2](../architecture/integrations/index.md)). Una prueba `A + B`
  que exigiría instalar todos los proveedores del mercado no es obligatoria: lo es
  para la familia que se anuncie intercambiable, y para ninguna otra.

---

## 8. Qué no certifica esta rúbrica todavía

Se dice explícitamente para que nadie lo lea de otra forma:

- **Esta rúbrica no autoriza ejecución.** El diccionario físico se especifica en
  los siete dominios y sus hojas de [base de datos](../architecture/database/index.md); las rutas
  y los permisos se congelan contra el HEAD de apertura de cada packet. Los dos
  estados de readiness tienen un único dueño: [packets §0](../implementation/packets/index.md).
- Un documento nuevo, un `index.ts` nuevo y un test de documentación **no** son
  avance de producto y no suben ningún criterio.
- Ninguna afirmación de esta página se apoya en una corrida de la suite completa:
  no se ejecutó, por la razón que documenta [evidencia](../evidence/index.md).

---

## 9. Cómo re-aplicar la rúbrica

1. Pinear un snapshot por SHA y copiarlo fuera del árbol vivo. Nunca medir sobre un
   árbol que un writer está tocando.
2. Correr la compuerta mecánica en el snapshot y guardar el log.
3. Ejecutar las sondas de la columna *Medición* para cada criterio con brecha en la
   aplicación anterior. Una sonda que ya no reproduce el defecto sube el nivel, con
   la evidencia nueva anotada.
4. Actualizar *Afirmado* leyendo sólo la documentación del snapshot.
5. Recalcular. Publicar `medidos/total` y el conteo de `UNKNOWN` junto a cualquier
   nota. Si los `UNKNOWN` superan un cuarto, publicar el inventario y no una nota.
6. Un criterio que sube a 4 nombra su compuerta mecánica. Si no puede, es 3.
7. Registrar la aplicación como una sección nueva de este documento, con su SHA.
   **No** se crea una carpeta fechada nueva: este documento es el instrumento y su
   propio historial.
