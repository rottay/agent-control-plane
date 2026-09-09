# Requisito → packet responsable → hito de cierre

Dueño único de esta correspondencia; el catálogo y el perfil siguen en
[requisitos](../../../requirements/index.md), y dependencias/readiness en el
[inventario](../index.md). No es un segundo roadmap ni evidencia de implementación.

Cada uno de los 121 IDs aparece **una vez**, con un packet primario responsable
de reunir su aceptación. Los componentes pueden entregar partes antes o después:
no trasladan la responsabilidad ni cuentan el requisito de nuevo. Un hito no se
cierra hasta que todos sus componentes consumidos pasen; el número de hito no
sustituye al DAG. La tabla no obliga a esperar el cierre completo de un packet
cuando el [corte exacto](../index.md#18-entregas-internas-con-condición-de-salida)
que se consume ya fue aceptado.

Los rangos de «Entrega» del catálogo describen construcción entre hitos. Esta
tabla fija el **único hito de aceptación** de cada fila dentro del perfil.
Para G3/H7 el packet primario sólo custodia la exclusión: no implementa la UI ni
autoriza P9. Para X03/X10/X11/X13 sólo custodia la selección futura: sus hitos son
condicionales, no entregas del release vigente.

## 1. Correspondencia exhaustiva

| ID | Packet primario | Hito de cierre | Componentes y límite de aceptación |
| --- | --- | --- | --- |
| A1 | P-14 | M2 | P-05, P-15: creación por las dos puertas y reinicio. |
| A2 | P-26 | M9 | P-09: append/OCC y revisión inmutable. |
| A3 | P-27 | M9 | P-26: revisión del grafo y referencias versionadas. |
| A4 | P-28 | M9 | P-14, P-16: asignaciones e independencia efectiva. |
| A5 | P-27 | M9 | P-19, P-21: reservas y concurrencia del DAG. |
| A6 | P-29 | M9 | P-28, P-15: propuesta del coordinador, aprobación antes del dispatch. |
| A7 | P-28 | M9 | P-16, P-17: sujeto/digest exacto y consumo de aprobación. |
| A8 | P-29 | M9 | P-22, P-27: cancelación efectiva y edición sin mover trabajo en vuelo. |
| A9 | P-29 | M9 | P-26: consulta paginada y aislamiento de iniciativas. |
| A10 | P-26 | M9 | Diff semántico y restauración como revisión nueva. |
| A11 | P-28 | M9 | P-14: registry/versiones y resolución por rol. |
| A12 | P-28 | M9 | P-14: precedencia completa y techos de autoridad. |
| A13 | P-28 | M9 | P-14, P-19: elegibilidad/capacidad sin fallback silencioso. |
| A14 | P-28 | M9 | P-16: recomendación separada de independencia obligatoria. |
| A15 | P-29 | M11 | P-27, P-19, P-33/catalogo; H-7: simulación sin efectos, estimación explícita. |
| B1 | P-05 | M2 | P-14, P-15: envelope distinto y puerta productiva. |
| B2 | P-19 | M7 | P-14, P-23: resolución y composición del perfil. |
| B3 | P-19 | M5 | P-18, P-21: reserva y reconciliación de stores. |
| B4 | P-17 | M4 | P-16, P-18: prestate real y revalidación antes del efecto. |
| B5 | P-06 | M2 | P-15: prompt por CLI/API/local admitidos. |
| B6 | P-31 | M10 | P-21, P-30: eventos reales, cursor y vivacidad. |
| B7 | P-24 | M8 | P-11, P-25: permiso/schema, errores y aislamiento. |
| B8 | P-16 | M8 | P-17, P-25: efectos reales y write-set observado. |
| B9 | P-18 | M4 | P-07, P-15, P-36/local: read/rehidratación, no sólo persist. |
| B10 | P-22 | M7 | P-21, P-23: contrato efectivo de cada driver anunciado. |
| B11 | P-18 | M4 | P-09, P-10, P-17/efecto: ocho fronteras y exposición incierta. |
| B12 | P-21 | M9 | P-19, P-27, P-34/admisión: concurrencia, reservas y enforcement antes de habilitar equipos; no espera los reportes de M11. |
| B13 | P-17 | M8 | P-16, P-24, P-25: NO_COMMIT y READ_ONLY distintos. |
| B14 | P-20 | M7 | P-18, P-23: checkpoint, autoridad y destino capaz. |
| B15 | P-07 | M2 | P-15, P-36/local: resultado recuperable y terminal correcto. |
| B16 | P-18 | M5 | P-19, P-20: retry/backoff/presupuesto; nunca reintento ciego. |
| B17 | P-35 | M11 | P-28, P-19, P-34: H-8, dos tareas READ_ONLY/NO_COMMIT y árbitro independiente. QUALITY_ONLY registra costo de ambos o UNKNOWN visible; no afirma ganador económico. |
| B18 | P-22 | M8 | P-24, P-25: deadline aplicado a hijos/herramientas. |
| C1 | P-16 | M3 | P-15, P-18: worker distinto y checks ejecutados. |
| C2 | P-16 | M3 | Auditor real, veredicto y referencias de evidencia. |
| C3 | P-17 | M3 | P-16, P-18/recuperación: receipt, política, tree y SHA observado. |
| C4 | P-28 | M9 | P-16, P-29: REJECT, corrección y revisión nueva. |
| C5 | P-29 | M9 | P-28: evento de hito y consulta durable, sin polling. |
| C6 | P-17 | M3 | PublicationPort separado; autorización/destino/ref exactos. Ningún release documental autoriza push. |
| C7 | P-16 | M3 | P-01, P-02, P-03, P-17: receipt anterior al commit y ligado al tree. |
| D1 | P-19 | M5 | P-08, P-36/local: identidad y resolver, sin credenciales en eventos. |
| D2 | P-19 | M5 | P-08: observación con fuente, margen, frescura y UNKNOWN. |
| D3 | P-34 | M11 | P-19, P-20, P-33: routing por margen, costo y exposición. |
| D4 | P-19 | M5 | P-15, P-18: presión real y errores por clase. |
| D5 | P-20 | M5 | P-18, P-19: destino iniciado antes de completar el handoff. |
| D6 | P-19 | M5 | P-08: enum real y procedencia del override. |
| D7 | P-19 | M5 | P-21: último margen y reserva concurrente. |
| D8 | P-34 | M11 | P-19, P-22, P-33; P-34/admisión temprano: política y límites antes/durante el efecto, cierre económico completo en M11. |
| D9 | P-32 | M11 | P-31, P-33: consulta de uso sin convertir faltantes en cero. |
| D10 | P-30 | M10 | P-19, P-33/catalogo: H-6, alerta de cuenta/modelo y entrega acotada. |
| D11 | P-32 | M11 | P-07, P-19: clases de tokens, fuente y asentamiento. |
| D12 | P-33 | M11 | P-14: catálogo único, intervalos y versión pinneada. |
| D13 | P-33 | M11 | P-32: valores REAL/EQUIVALENT/prorrateo separados y rebuild exacto. |
| D14 | P-33 | M11 | P-29, P-32, P-16: H-7, pronóstico e incertidumbre; historial ausente no inventa precisión. |
| D15 | P-33 | M11 | P-19, P-32: ventana y asignación exacta del período de suscripción. |
| D16 | P-33 | M11 | P-16, P-17, P-20, P-32: incluye costo de fallos, reintentos y auditoría. |
| D17 | P-33 | M11 | P-31: exportación neutral, paginada y sin contenido privado. |
| D18 | P-34 | M11 | P-32, P-33, P-22, P-30: H-9, política de anomalía y acción autorizada. |
| E1 | P-23 | M7 | P-06, P-07, P-15, P-22: adapter CLI con conformance real. |
| E2 | P-15 | M7 | P-06, P-07, P-23: cliente API desde configuración productiva. |
| E3 | P-15 | M7 | P-06, P-07, P-23: servidor local desde configuración productiva. |
| E4 | P-14 | M11 | P-23, P-33, P-35: registry único; instalación no duplica capacidades ni ratings. |
| E5 | P-15 | M14 | P-23, P-39: smoke autorizado y certificación del perfil/versiones. |
| E6 | P-35 | M11 | P-16, P-32, P-33, P-34: runner, dataset, juez y consumo reales. |
| E7 | P-35 | M11 | P-19, P-34: muestras, canary, publicación y rollback de política. |
| E8 | P-35 | M11 | P-29, P-32, P-33: H-7, replay/what-if sin efectos ni datos contrafácticos como observados. |
| E9 | P-35 | M11 | P-16, P-33: H-10, cohorte/ventana, muestra, frescura e incertidumbre. |
| F1 | P-31 | M10 | P-05, P-07, P-16, P-18: cadena causal por IDs/digests. |
| F2 | P-36 | M10 | P-07, P-12, P-31: lectura privada, límites y retención del perfil. |
| F3 | P-09 | M5 | P-08, P-10: integridad de cuatro streams y baseline declarado. |
| F4 | P-31 | M10 | P-09, P-10: timeline causal paginada y límites. |
| F5 | P-30 | M10 | P-21: dispatcher conectado, recepción parcial y aislamiento. |
| F6 | P-30 | M10 | P-12, P-31: correlación de run/tarea/intento/efecto sin secretos. |
| F7 | P-30 | M11 | P-31, P-32, P-33, P-39: baseline medido antes de optimizar; no esperar a certificar para medir. |
| F8 | P-31 | M10 | P-16, P-18, P-28: actor y autoridad verdaderos. |
| G1 | P-39 | M14 | P-12, P-14, P-15, P-22, P-29, P-31, P-33: verbos CLI de todas las operaciones anunciadas. |
| G2 | P-39 | M14 | Mismos componentes de G1; oráculos independientes para API local autenticada. |
| G3 | P-39 | UI posterior | DEFERRED: P-39 verifica exclusión; no entrega ni certifica la consola. |
| G4 | P-39 | M14 | P-12, P-37: CLI/API MANDATORY; rama consola DEFERRED con G3, sin segundo conteo. |
| G5 | P-30 | M12 | P-22, P-28, P-36: H-6, adapter local de aviso; su caída no detiene trabajo. |
| H1 | P-39 | M14 | P-06, P-07, P-12, P-24, P-25, P-31, P-36: sinks protegidos y negativos sintéticos. |
| H2 | P-25 | M14 | P-21, P-38, P-39: loopback y egress explícito por perfil. |
| H3 | P-18 | M8 | P-17, P-19, P-21, P-25: fencing efectivo y viejo writer detenido/confinado. |
| H4 | P-25 | M8 | P-21, P-22: sandbox real o ausencia declarada, sin aislamiento ficticio. |
| H5 | P-36 | M12 | P-09, P-10, P-18: backup consistente y restore_id nuevo. |
| H6 | P-37 | M13 | P-01, P-02, P-03, P-04, P-12, P-13: fence no vacuo y anatomía comprobable. |
| H7 | P-39 | P9 posterior | DEFERRED: P-39 conserva exclusión; sólo el owner puede autorizar adopción. |
| I1 | P-38 | M13 | P-21, P-22, P-25: instalación y ciclo de vida residente. |
| I2 | P-23 | M7 | P-18, P-21, P-22: dos drivers reales cuando se anuncia elección intercambiable. |
| I3 | P-38 | M13 | P-23, P-36, P-37: pins y compatibilidad de migración/rollback. |
| I4 | P-31 | M13 | P-19, P-23, P-30, P-38: diagnóstico del perfil, sin secretos. |
| I5 | P-39 | M14 | P-23, P-30, P-36: habilitado/ausente/fallando por integración opcional seleccionada. |
| I6 | P-38 | M14 | P-04, P-21, P-22, P-39: Linux real, pins y exclusiones explícitas. |
| J1 | P-23 | M7 | P-15, P-37: nueva marca sin editar dominio. |
| J2 | P-23 | M7 | P-18, P-21, P-22: contrato propio, selección y recuperación. |
| J3 | P-30 | M12 | P-36: exporter conectado al mismo batch/dominio, aislado de la tarea. |
| J4 | P-24 | M8 | P-11: discover, permiso y schema versionado. |
| J5 | P-37 | M12 | P-12, P-14, P-15, P-39: puerta como adaptación; consola no incluida. |
| J6 | P-37 | M13 | P-12, P-13, P-38: folder/index, tipos, imports y tests espejo. |
| X01 | P-23 | M7 | P-14, P-19, P-21: ejes independientes y preflight conjunto; H-5. |
| X02 | P-20 | M7 | P-18, P-23, P-36/local: checkpoint portable dentro del perfil. |
| X03 | P-23 | M7 | NOT_SELECTED: sólo dueño de selección; no implementar ni anunciar migración viva. |
| X04 | P-05 | M4 | P-09, P-18: revisión semántica y effect_id estables, sin reutilizar resultado/costo. |
| X05 | P-28 | M9 | P-14, P-23, P-29: actor/rol/configuración versionados. |
| X06 | P-38 | M13 | P-23, P-37: instalación modular y preflight ejecutable, no descriptor aislado. |
| X07 | P-36 | M12 | P-09, P-10: contrato + SQLite real; segundo backend sólo si se anuncia intercambiabilidad. |
| X08 | P-36 | M12 | P-07, P-18: scope, hash, generación/pins, backup y GC. |
| X09 | P-36 | M12 | P-19, P-25: resolver/identidad/autoridad separados, una implementación real. |
| X10 | P-36 | M12 | NOT_SELECTED: memoria/retrieval sólo tiene dueño de selección, no soporte funcional. |
| X11 | P-29 | M12 | NOT_SELECTED: mensajes externos sólo tienen dueño de selección; no segundo scheduler. |
| X12 | P-23 | M12 | MANDATORY: contrato + harness nativo real conectado; segundo framework NOT_SELECTED. |
| X13 | P-06 | M12 | NOT_SELECTED para modalidades más allá de texto; texto obligatorio en B5/X15. |
| X14 | P-30 | M10 | P-31: logs/trazas/métricas con export parcial honesto. |
| X15 | P-06 | M8 | P-07, P-12, P-25, P-36/local: egress autorizado y contenido fuera de sinks públicos. |
| X16 | P-25 | M8 | P-21, P-22, P-24: autoridad acotada de extensión/hijos. |
| X17 | P-34 | M11 | P-18, P-19, P-32, P-33; P-34/admisión temprano: gasto acotado y UNKNOWN/external/late visibles. |
| X18 | P-36 | M13 | P-09, P-10, P-23, P-38: replay/migración y downgrade del perfil probado. |
| X19 | P-28 | M12 | P-22, P-30: H-11, espera humana/timeout/cancelación; aviso no concede permiso. |
| X20 | P-39 | M14 | P-23, P-24, P-30, P-36, P-38: matriz real A/B, ausente/fallando/incompatible. |
| X21 | P-39 | M14 | P-21, P-22, P-25, P-31, P-36: límites medidos y backpressure. |
| X22 | P-24 | M12 | P-11, P-25, P-36: contrato + herramientas reales del perfil; no todos los adapters imaginables. |

## 2. Perfil sin capacidades implícitas

Los estados se heredan de [requisitos §13](../../../requirements/index.md#13-perfil-de-certificación-las-121-filas-asignadas):
115 MANDATORY, 4 NOT_SELECTED, 2 DEFERRED; nada pasa a implementado por estar aquí.
G4 cuenta una sola vez por su rama backend; la consola queda fuera junto con G3.

| Pack no seleccionado | ID que posee su frontera | Alcance que no se anuncia |
| --- | --- | --- |
| Migración de motor en caliente | X03 | Migrar ejecuciones activas entre motores. |
| Memoria y retrieval | X10 | Memoria/retrieval del pack, no búsqueda ya admitida por herramientas. |
| Comunicación con agentes externos | X11 | Red/A2A o scheduler externo; no las tareas internas de M9. |
| Modalidades más allá de texto | X13 | Imagen/audio/realtime; no elimina el texto obligatorio de M1. |
| Segundo framework de orquestación | X12 | Adapter externo adicional. X12 sigue MANDATORY para contrato + harness nativo conectado y probado; no se afirma que el externo exista. |

Seleccionar uno exige la [compuerta de packs](../index.md#52-packs-no-seleccionados)
y evidencia del perfil. X12 no crea una fila 122 ni convierte cinco packs en cinco
filas NOT_SELECTED: su contrato/nativo y su adapter externo son alcances distintos.

## 3. Aceptación de la correspondencia

El verificador documental debe extraer IDs del catálogo y de esta tabla, exigir
igualdad de conjuntos y 121 filas sin duplicados, resolver los 39 IDs de packet y
comprobar un solo hito de cierre por fila. Debe rechazar ID desconocido, fila
MANDATORY sin dueño, G4 duplicado o pack excluido anunciado funcional.
Los componentes no se convierten mecánicamente en dependencias de desarrollo:
la adquisición/activación consume cortes aceptados según el inventario y sus gates.

La correspondencia **no prueba DESIGN_READY**. El estado adjudicado y los dueños
de contratos/algoritmos/datos están en [packets §5.1](../index.md#51-huecos-de-diseño-reales).
Los huecos de diseño señalados allí se cerraron mediante protocolos y negativos;
sus pruebas productivas siguen pendientes. DDL o un nombre de puerto solos no
cierran un requisito: se exige implementación, recuperación y evidencia de su
hito. La asignación requiere además SCOPE_FROZEN y autorización operativa.
