# Agent Control Plane — especificación de arquitectura y ejecución

Punto único de entrada. Esta carpeta es **una sola documentación estable**: no hay
ciclos, versiones ni carpetas fechadas compitiendo entre sí. Las fechas aparecen
sólo cuando son metadatos necesarios de una evidencia.

---

## 1. Qué es y qué no es

**Es** la especificación consolidada de qué debe ser el Agent Control Plane: su
arquitectura, su modelo de datos, sus contratos, sus requisitos, cómo se mide su
calidad y en qué orden se construye.

**No es** autoridad operativa. Hasta que se cierre el puente de
[migración](implementation/migration/index.md), la ley que gobierna el trabajo
diario sigue siendo `AGENTS.md` y el roadmap vigente del repositorio. Esta
documentación **no está admitida todavía** por la lista exacta de rutas de la
compuerta de arquitectura, y **no se modificó el checker para autoaprobarla**.

**No autoriza nada**: ni implementación, ni gasto, ni instalaciones, ni
publicación, ni cutover. Las autorizaciones las emite el owner, o el coordinador
técnico en quien el owner delegue la apertura y el cierre de packets dentro de un
alcance y unos límites declarados. Vuelve a hacer falta una aprobación explícita
del owner para ampliar el alcance, exceder el consumo autorizado, acceder a algo fuera de este
repositorio, publicar, o cuando la ley del repositorio lo exija.

---

## 2. Los documentos, y quién posee cada concepto

**Un concepto, un dueño.** Ninguna regla se repite en varios archivos: se declara
una vez y los demás enlazan.

| Documento | Dueño del concepto | Para qué leerlo |
| --- | --- | --- |
| [Arquitectura](architecture/index.md) | estratos, contextos, puertos, separación de tipos | dónde vive cada cosa y en qué dirección dependen |
| [Estructura](architecture/structure/index.md) | árbol objetivo, movimientos, duplicación | qué se mueve de dónde a dónde, y qué duplicación es un defecto |
| [Contratos](architecture/contracts/index.md) | el ciclo de una tarea | qué operaciones existen, con qué precondiciones, errores y garantías |
| [Base de datos](architecture/database/index.md) | reglas de persistencia, DER e invariantes | nombres, tipos, claves, causalidad, transacciones, migración |
| ↳ [streams](architecture/database/streams/index.md) · [planificación](architecture/database/planning/index.md) · [ejecución](architecture/database/execution/index.md) · [cuentas](architecture/database/accounts/index.md) · [economía](architecture/database/economy/index.md) · [artefactos](architecture/database/artifacts/index.md) · [coordinación](architecture/database/coordination/index.md) | el diccionario físico, columna por columna | qué tabla, qué columna, qué tipo, qué restricción |
| [Integraciones](architecture/integrations/index.md) | familias, niveles y sustitución | qué significa opcional, funcional e intercambiable, y qué prueba lo demuestra |
| ↳ [Comparativa de mercado](architecture/integrations/market/index.md) · [Composición](architecture/integrations/composition/index.md) | alternativas y compatibilidad entre selecciones | dónde encaja cada herramienta y cómo impedir doble autoridad antes de ejecutar |
| [Requisitos](requirements/index.md) | los 99 casos y los 22 criterios transversales | qué hay que construir, quién lo posee y qué lo acepta |
| [Calidad](quality/index.md) | la rúbrica y la conjunción de certificación | cómo se mide, qué es CRITICAL y qué se sabe hoy |
| [Tests](quality/testing/index.md) | estrategia, oráculos y negativos | qué se prueba, con qué oráculo y con qué presupuesto |
| [Hallazgos](findings/index.md) | los defectos | qué está roto, con qué evidencia y quién lo cierra |
| [Evidencia](evidence/index.md) | baseline, método y límites | qué se ejecutó, qué no, y qué sostiene cada afirmación |
| ↳ [Revisión independiente](evidence/review/index.md) | consulta K3 y adjudicación | hallazgos incorporados, sugerencias descartadas y límites de lo verificado |
| [Decisiones](decisions/index.md) | mandatos y adjudicaciones | qué está resuelto, qué quedó superseded y qué sigue abierto |
| [Roadmap](roadmap/index.md) | secuencia y gates | en qué orden, con qué dependencia y qué compuerta |
| [Implementación](implementation/index.md) | cómo se entrega | el prompt de arranque, cuándo parar, qué evidencia se exige |
| [Coordinación y kickoff de Kimi](kickoff.md) | gestión de agentes | Kimi DT y commits, Opus writer, consultas a Codex, continuidad y ritmo de trabajo |
| ↳ [Packets](implementation/packets/index.md) | unidades de trabajo | qué se puede asignar hoy y qué falta congelar |
| ↳ [Cobertura por packet](implementation/packets/requirements/index.md) · [Paralelismo](roadmap/parallelism/index.md) | asignación y concurrencia | un responsable por requisito; dependencias, cortes, conflictos y delegación acotada |
| ↳ [Migración](implementation/migration/index.md) | el puente de autoridad | cómo esta especificación pasa a gobernar, y cómo se retiran los borradores |

---

## 3. Por dónde empezar

| Si sos… | Leé, en este orden |
| --- | --- |
| el owner | esta página · [decisiones](decisions/index.md) · [roadmap](roadmap/index.md) · [calidad §7](quality/index.md) |
| el coordinador técnico | [implementación](implementation/index.md) · [packets](implementation/packets/index.md) · [roadmap](roadmap/index.md) |
| un implementador | el prompt de [implementación §1](implementation/index.md), y sólo los documentos que tu packet nombra |
| un auditor | [evidencia](evidence/index.md) · [hallazgos](findings/index.md) · [calidad](quality/index.md) |
| alguien nuevo | esta página · [arquitectura](architecture/index.md) · [requisitos](requirements/index.md) |

---

## 4. Estado, en una tabla

| Pregunta | Respuesta |
| --- | --- |
| ¿El backend está certificado? | **No.** Cuatro de las siete compuertas CRITICAL están medidas y ninguna alcanza el nivel exigido |
| ¿Cuánto está implementado? | **No se publica un porcentaje.** Esta ronda no ejecutó los escenarios; los tres denominadores separados están en [roadmap §1](roadmap/index.md) |
| ¿Qué se midió? | 20 de 89 criterios, por lectura de fuente citada. 69 quedan en `UNKNOWN`, que no es cero |
| ¿Se corrió la suite completa? | **No**, y el motivo está en [evidencia §3](evidence/index.md) |
| ¿Qué se puede asignar hoy? | esta ronda sólo autoriza documentación; el siguiente coordinador debe validar autorización y prestate del primer packet ([packets](implementation/packets/index.md)) |
| ¿Está P9 o el cutover autorizado? | **No.** Sigue diferido y requiere un acto separado del owner |

---

## 5. Reglas de esta documentación

1. **Un concepto, un dueño.** Si una regla aparece dos veces, una de las dos está
   mal. Se enlaza, no se copia.
2. **Nombres por responsabilidad**, sin fechas, sin identificadores de fase y sin
   versiones en el título. Una revisión edita el documento dueño; no crea un
   documento paralelo.
3. **Las tablas son herramientas** para contratos y mapeos, no para repetir
   filosofía.
4. **La prosa no es evidencia.** Una afirmación se sostiene con un comando y su
   salida, un hash, o una línea de código citada.
5. **Lo desconocido se dice.** `UNKNOWN` no es cero, un fallo ambiental no es un
   `PASS`, y una nota histórica no se transcribe como estado actual.
6. **Toda ruta nueva se comprueba con `git check-ignore` antes de escribir en
   ella.** Dos documentos quedaron ignorados por no hacerlo; los dos se
   recuperaron, y la comprobación es ahora parte de la verificación del paquete.

---

## 6. Procedencia

Esta documentación consolida dos paquetes previos. Los veinticinco documentos de
esas dos carpetas fueron retirados del árbol, después de validar los veintitrés
canónicos y comprobar cada archivo contra el backup, para no dejar dos jerarquías
compitiendo:

| Carpeta | Snapshot | Qué aportó |
| --- | --- | --- |
| `2026-09-04-backend-v2/` | `4569478` | el catálogo de 99 casos, el inventario de entidades, la rúbrica de 71 criterios, doce reportes de evidencia y las decisiones del owner sobre el stack |
| `2026-09-08-provider-neutrality/` | `a92756b` | catorce hallazgos, los 22 criterios transversales, las familias de integración, los hitos M0–M14 y los nueve commits con sus recibos |

El manifiesto de retirada —las veinticinco rutas, con destino, digest y forma de
recuperación— está en [migración §4.3](implementation/migration/index.md). **Los
veinticinco son recuperables**: los rastreados desde `HEAD`, y los modificados y no
rastreados desde el backup verificado de [evidencia §6.2](evidence/index.md).
La retirada no incluyó código, commits ni publicación.

Ninguna nota obsoleta de esos paquetes se transcribe como hecho actual: en
particular, sus puntuaciones fueron medidas sobre otro snapshot con otro
instrumento y son históricas.

Base inspeccionada por esta especificación:
`a92756bec0397d4354b07fee13b281dabf9f18d7`.
