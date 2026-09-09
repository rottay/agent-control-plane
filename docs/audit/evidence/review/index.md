# Revisión independiente y adjudicación

[Evidencia](../index.md) · [Decisiones](../../decisions/index.md) · [Packets](../../implementation/packets/index.md)

## 1. Veredicto y alcance

Kimi: **ACCEPT_WITH_CHANGES**. Adjudicación del root: conservar la arquitectura,
corregir contratos, datos y secuencia antes de asignar los packets afectados.
No se propone empezar de cero ni sustituir el plan por una lista de frameworks.
Esta consulta evalúa la especificación contra el código; no certifica el producto.

Se solicitó una opinión externa con tres lanes paralelos: arquitectura/neutralidad,
persistencia/recuperación y roadmap/implementabilidad. Kimi consolidó quince
hallazgos de veinte observaciones iniciales; el root decidió qué incorporar.
Los reviewers no editaron el repositorio. Los cambios canónicos de esta consulta
son exclusivamente documentación bajo docs/audit.

## 2. Identidad de la consulta

| Dato | Valor |
| --- | --- |
| Base Git | a92756bec0397d4354b07fee13b281dabf9f18d7 |
| Fecha de evidencia | 2026-09-08; no es versión del producto |
| Entradas | snapshot de 562 archivos de código y documentación; no se incluyeron almacenes de credenciales ni directorios locales de sesiones |
| SHA-256 del manifiesto | 96c289fa73d0d491fbcffa1ad51b29b27f2305b10a452df266d211e4185bba15 |
| Modelo | kimi-code/k3, thinkingEffort=max |
| CLI | Kimi Code 0.41.0 |
| Sesión | session_465bda54-f5de-4815-b8be-1d70faac117b |
| Hijos | agent-0: arquitectura; agent-1: datos; agent-2: ejecución del plan |
| Salida | proceso terminado con code=0; verdict estructurado ACCEPT_WITH_CHANGES |
| SHA-256 del reporte consolidado | 934e32fc800af392aa9589b04890b08003d2ec106c095e1a6effaff7775431ef |

El modelo de los tres hijos fue comprobado por el root en metadata llm.request
de sus wire logs, no inferido del prompt ni del nombre de la sesión de terminal.
El parent no pudo verificarlo por sí mismo. El campo de adapter API compatible no
cambia la identidad del modelo K3. Hubo dos errores transitorios de conexión,
recuperados.

Original y snapshot protegidos por sandbox de sistema: lectura/escritura negadas
al repositorio original y escritura negada al snapshot. El perfil del padre era
read-only; los explore hijos conservaron Bash, por lo que **no se afirma que no
tuvieran shell**. Se inspeccionaron sus 25 comandos: lectura, búsqueda y conteo;
ninguno ejecutó builds, tests del producto, instalaciones o escrituras de código.
La prohibición de escritura sobre snapshot se comprobó con EPERM; los hashes
de sus 562 archivos seguían coincidiendo con el manifiesto al terminar la consulta.

Material temporal: /private/tmp/acp-k3-debrief.QMF0FJ/ contiene manifest.json,
brief.md, reviewer.md, readonly.sb, completion.json, kimi-report.md y los tres
agent-N-report.md. Es auxiliar, puede desaparecer; esta página y los documentos
dueños conservan la adjudicación necesaria para implementar, sin depender de él.

## 3. Adjudicación de los quince hallazgos

Los IDs D01–D15 pertenecen sólo a esta revisión, no son nuevos packets.

| ID | Conclusión aceptada y corrección | Documento dueño |
| --- | --- | --- |
| D01 | Los vocabularios provider/driver/preflight no son intercambiables; conservar origen/evidencia y mapear sólo hacia la evaluación neutral, sin conversión inversa inventada | [contratos §2.0](../../architecture/contracts/index.md) |
| D02 | La admisión de cuota necesita predicado y transacción; intenciones pendientes y gasto aún no cubierto por observación siguen debitados aunque se libere el slot | [cuentas §4](../../architecture/database/accounts/index.md) |
| D03 | Había requisitos sin algoritmo o responsable completo; correspondencia exhaustiva y huecos explícitos, no promover readiness por poner un nombre en una tabla | [121 requisitos por packet](../../implementation/packets/requirements/index.md) y [huecos §5.1](../../implementation/packets/index.md) |
| D04 | Dependencias de desarrollo, habilitación y recursos compartidos se distinguen; consumos tempranos tienen cortes aceptables y no esperan al cierre completo de otro hito | [paralelismo](../../roadmap/parallelism/index.md) |
| D05 | La frontera ledger también afecta al supervisor hijo y shadow-ledger; separar política, puerto e I/O sin perder operación | [estructura E9/E20](../../architecture/structure/index.md) |
| D06 | No reescribir la decisión histórica congelada: ADR sucesor y enlace permitido; puente tras bootstrap de tests seguros | [migración](../../implementation/migration/index.md) |
| D07 | Clave de presión sin generación colisiona entre rutas; corregir helper, productores y pruebas, preservando eventos legacy | [execution §4.1](../../architecture/database/execution/index.md) |
| D08 | Outbox necesita row_version persistida y CAS contra estado/encarnación, no una expected_version sin autoridad | [coordinación §6.1](../../architecture/database/coordination/index.md) |
| D09 | Anclas stream/secuencia/hash y sujeto real por comando; no inventar una tarea SYSTEM para notificaciones de cuenta | [coordinación §6.2](../../architecture/database/coordination/index.md) |
| D10 | Corregir ejemplos a los cinco estados reales de cuenta; no introducir READY/DRAINED/DISABLED | [arquitectura](../../architecture/index.md) |
| D11 | Preservar los estados legacy etiquetados; no convertir CHECKPOINTED en prueba de éxito ni reactivar historia bajo el autómata nuevo | [contratos §2.2](../../architecture/contracts/index.md) |
| D12 | Simulación conserva estado/fuente de cuota del corte; handoff SUCCEEDED exige segmento y continuación reales, sin filas parciales | [planning §11](../../architecture/database/planning/index.md) y [cuentas §5](../../architecture/database/accounts/index.md) |
| D13 | Corregir cifras de índices, fronteras y tests mutantes; la sonda que requiere dist no es una prueba del checkout fresco | [evidencia](../index.md), [estructura](../../architecture/structure/index.md), [tests](../../quality/testing/index.md) |
| D14 | Sidecar declara baseline y cobertura desde activación; watermark hashea el corte aplicado, no la cabeza posterior | [streams §8.2](../../architecture/database/streams/index.md) |
| D15 | X12 exige contrato y harness nativo conectado; segundo framework no seleccionado. Un requisito tiene un solo hito de cierre, aunque se construya en varios | [correspondencia](../../implementation/packets/requirements/index.md) |

## 4. Qué no se copió de las sugerencias

- No invertir P-01/P-02: primero bootstrap autorizado de aislamiento y prueba del
  fence; después el puente formal. Tampoco reescribir un ADR histórico ahora.
- No posponer ledger, artefactos, catálogo o presupuesto hasta después de sus
  consumidores: se fijaron entregas internas con negativos y gates propios.
- No usar una resta ingenua de reservas HELD para afirmar cuota disponible;
  el gasto incierto y la actividad externa requieren tratamiento explícito.
- No inventar identidades nuevas por handoff, mapear historia a éxito, ni afirmar
  exactly-once cuando un proveedor no ofrece reconciliación suficiente.
- No convertir el esquema conceptual de solapamientos en una tabla mutable sin
  contrato: se adjudicaron schemas strict, pins, snapshots, roles por scope,
  límites agregados y representación normalizada con pruebas negativas.
- No incorporar un segundo framework o backend sólo por estar de moda. La
  comparativa conserva opciones; la selección del release conserva su compuerta.

## 5. Revisiones complementarias y límites

Tres agentes internos trabajaron en correspondencia/secuencia, contratos/datos
y composición/políticas. Entregaron borradores temporales; el root integró.
La revisión independiente acotada de composición verificó selección explícita,
conteos atómicos por ancestro, DTO/preimágenes con goldens y denegación de perfiles.
No se confundió ese ACCEPT con conformidad de adapters ni suite productiva.

Las revisiones focales de los borradores también corrigieron:

- Propagación de duración UNKNOWN hasta punto fijo en dependencias y recursos
  compartidos; selección de cuota histórica, ventanas/reset y débito B5 único;
  identidad de reportes de desempeño que incluye el corte, no sólo cohorte/fecha.
- Enums reales READ_ONLY/NO_COMMIT, checks puntuables indeterminados que impiden
  adjudicar un duelo, y reloj durable para resolver una espera tras reinicio.
- QUALITY_ONLY con costo UNKNOWN visible; rate por intervalo de evaluated_at
  que no se reinicia cambiando policy; tres particiones de avisos con reemplazo
  parcial acotado y lectura combinada al mismo vector causalmente cerrado.

Estos protocolos quedaron adjudicados en [estimación](../../architecture/contracts/estimation/index.md)
y [interacción](../../architecture/contracts/interaction/index.md), con diccionarios
normalizados bajo sus dueños existentes. H-5–H-11 están cerrados **de diseño**;
H-4, scope y aceptación de implementaciones continúan en [packets](../../implementation/packets/index.md).
Los perfiles publicados son explícitos, versionados y seleccionables; no se
introdujeron montos de gasto ni autorizaciones implícitas.

Se usaron sondas de especificación con SQLite en memoria y hash de fixtures
sintéticos, sin importar módulos del producto: restricciones NULL, CAS y
preimágenes. Los enlaces, inventarios y preservación de fuente se verifican aparte.
El DDL de interacción se comprobó con ocho tablas en SQLite en memoria, claves
padre mínimas y diez casos de NULL/plazo; esto comprueba ese subconjunto de la
especificación, **no** una migración completa ni el schema del producto.
La suite completa continúa pendiente del aislamiento de tests descrito en P-01.
No se inspeccionaron todos los 562 archivos línea por línea ni se certificaron
todas las parejas de proveedores. La matriz de calidad conserva UNKNOWN donde
no hay ejecución probatoria. El siguiente implementador debe producir receipts,
tests de conformance y medidas reales; esta revisión no los sustituye.

## 6. Corte documental resultante

Al cerrar esta reconsulta, antes del posterior prompt de coordinación, el canon
tenía 37 documentos Markdown bajo docs/audit, con un único punto de entrada.
Conserva 99 casos y 22 criterios transversales: 121 filas con packet
primario e hito de cierre, 39 packets y los mismos 89 criterios de calidad.
La matriz de producto permanece en 20 criterios medidos por fuente y 69 UNKNOWN;
la especificación adicional no aumentó ese progreso.

La validación documental comprueba enlaces locales/anclas, tablas Markdown,
inventarios, visibilidad Git y ausencia de cambios de código contra el manifiesto
de consulta. HEAD e índice se conservan; no se ejecutaron builds, suite completa,
commits ni publicación. La opinión K3 se emitió sobre el snapshot inicial: el root
adjudicó e integró las correcciones posteriores, con comprobaciones focales, sin
atribuirle a Kimi una certificación del texto final que no realizó.
