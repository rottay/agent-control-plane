# Migración: el puente de autoridad y la retirada de los borradores

Dueño único del concepto **transición**: cómo esta especificación pasa de ser una
propuesta a ser admitida por la compuerta, qué literales y qué documentos de
autoridad cambian, y en qué orden se retiran los borradores previos.

[Índice](../../README.md) · [Implementación](../index.md) · [Packets](../packets/index.md) · [Evidencia](../../evidence/index.md) · [Roadmap](../../roadmap/index.md)

**Este documento no ejecuta nada.** Describe un packet que otro agente implementa,
con autorización del owner, antes de que empiece cualquier trabajo de producto.

---

## 1. El problema exacto

Hay una contradicción que hay que resolver de frente, no rodear:

- La autoridad vigente declara que **una auditoría es un registro fechado y
  congelado, no una autoridad**, que su carpeta no autoriza ningún packet, y que el
  roadmap del repositorio sigue siendo la autoridad canónica.
- La compuerta de arquitectura exige que **todo archivo rastreado esté dentro de un
  write-set exacto**, con un literal por archivo, y su bloque para la documentación
  de auditoría enumera veintidós rutas del paquete de 2026-09-04.
- El owner autorizó **consolidar esta documentación y retirar los borradores
  duplicados** después de una verificación independiente.

Las tres cosas no pueden ser verdad a la vez. La resolución es un **puente
explícito**, no una reinterpretación silenciosa.

**Hasta que ese puente se cierre, esta documentación no está admitida**, y decir lo
contrario sería exactamente el defecto de certificación vacua que
[hallazgos](../../findings/index.md) documenta.

---

## 2. Qué cambia, exactamente

Autoridades y bloque de literales del futuro packet. Ninguna se toca en este
trabajo documental; se enumeran para cerrar su alcance antes de implementarlo.

| Qué | Dónde | Cambio |
| --- | --- | --- |
| El bloque de literales de la documentación de auditoría | `scripts/check-architecture.mjs`, `V2DOCSAUDIT_WRITE_SET`, hoy en el entorno de las líneas 5805–5856 | El baseline enumera 19 documentos y 3 rutas de soporte. Sustituir los documentos retirados por **la lista completa vigente** bajo `docs/audit`, enumerada y pineada contra HEAD al abrir P-02; no conservar el conteo histórico 23 como autoridad. Conservar soporte aplicable, admitir explícitamente el ADR nuevo y comprobar `AGENTS.md` y `docs/ROADMAP.md`. Una ruta por literal, sin comodines ni duplicados |
| Un ADR nuevo para admitir la especificación viva | `docs/architecture/<siguiente-número-libre>-<nombre>.md`, fijado al abrir P-02 | Usar la plantilla y el siguiente número contiguo comprobado, nunca un número supuesto. Distinguir registro histórico congelado de especificación viva; `Supersedes:` referencia 0030 sólo en esa decisión. No reescribir el cuerpo de un ADR publicado |
| Referencia inversa del ADR histórico | `docs/architecture/0030-the-audit-record.md` | Único cambio permitido: `Superseded-by:` hacia el ADR nuevo, conforme a la convención del corpus. El cuerpo y la evidencia histórica se preservan |
| El índice de decisiones de arquitectura | `docs/architecture/index.md` | agregar el ADR nuevo y reflejar la sucesión en la fila de 0030 |
| El roadmap canónico | `docs/ROADMAP.md` | apunta a esta especificación como fuente de planificación, **sin ceder** su condición de autoridad operativa hasta que el owner lo decida |
| La ley operativa | `AGENTS.md` | nombra esta especificación como lectura obligatoria; concilia roles/commits con [coordinación](../../kickoff.md). Preservar los invariantes de sus diez leyes: writer único, scope, independencia, permisos, privacidad y recuperación; no confundirlos con staffing histórico |
| Reglas específicas de Claude | `CLAUDE.md` | alinear delegación de Opus, exclusión de nuevos worktrees y commit por Kimi con el mandato de coordinación. No agregar excepciones a independencia, write-set o publicación |

El puente incorpora el mandato de gestión aprobado por el owner. Kimi dirige y
commitea trabajo independientemente verificado; Opus integra código; Codex revisa
ediciones propias de Kimi e hitos. Los literales de roles, ownership y paralelismo
que el checker compruebe deben inventariarse con sus tests antes del cambio, y
ajustarse de forma explícita en ese mismo packet; no se eliminan comprobaciones
para evitar conciliar textos. El write-set exacto se congela contra el HEAD de
apertura, incluyendo CLAUDE.md y los consumidores/pruebas realmente afectados.
Codex revisa este cambio de autoridad antes del cierre M0. Nada de esto se aplica
silenciosamente durante la redacción del kickoff.

Reglas del packet, no negociables:

1. **Listas exactas, jamás comodines.** El mecanismo de la compuerta es una
   comprobación de pertenencia sobre rutas literales; un patrón no coincidiría con
   nada y ampliar el mecanismo sería un cambio de ley, no una edición.
2. **Nada de reemplazo de digest a ciegas.** Si un digest de autoridad cambia, se
   recalcula sobre el contenido nuevo y se registra qué contenido produjo ese
   digest.
3. **No se toca ningún archivo de producto** ni se debilita ninguna ley para que
   estos documentos entren. Si un documento no puede entrar sin debilitar una ley,
   **el documento se corrige**, no la ley.
4. **No se agrega ninguna ruta ignorada por Git.** Cada ruta se comprueba con
   `git check-ignore` antes de escribirla en la lista. Fue el defecto que ya costó
   dos documentos ([evidencia §6.3](../../evidence/index.md)).
5. **Historia inmutable.** El verificador rechaza cualquier modificación sustantiva
   de 0030; comprueba la referencia cruzada, la numeración contigua y la plantilla
   del ADR nuevo. No se amplía la excepción al resto del corpus.

---

## 3. Orden

El mandato vigente del owner es **no dejar dos jerarquías compitiendo** hasta un
commit futuro. Por eso la retirada **no espera** al commit del puente:

```
1. Validación del inventario canónico vigente (23 documentos en la consolidación inicial)
2. Backup verificado que incluye todo lo modificado y lo no rastreado
3. Retirada de los veinticinco documentos de las dos carpetas fechadas
4. Auditoría independiente de la especificación consolidada
5. Decisión del owner sobre el puente de autoridad
6. Packet de admisión: literales de la compuerta + enmienda de los documentos de
   autoridad, en un solo diff
7. Verificación por un worker distinto; receipt; commit autorizado
```

Mientras el paso 6 no ocurra, **el conjunto documental se declara no admitido y con
su puente pendiente**. No se toca el código de la compuerta ahora, y **no se
presenta un verde ficticio**. Toda operación sobre código posterior sigue
dependiendo de la autorización del owner y del puente.

---

## 4. Disposición de los veinticinco borradores

**Retirada ejecutada por root**, tras revisión e integración de correcciones. Las
25 rutas se compararon íntegramente contra el backup antes de retirarlas. Quedan
23 documentos canónicos en aquel checkpoint, sin tocar la compuerta ni hacer commit.
Las ampliaciones posteriores se enumeran en [evidencia](../../evidence/index.md);
ese conteo histórico no limita la lista literal que P-02 debe admitir.
El puente de autoridad de §2 sigue pendiente: consolidación no es admisión.

### 4.1 Paquete de 2026-09-04

| Documento | Contenido consolidado en | Disposición propuesta |
| --- | --- | --- |
| `README.md` | [índice](../../README.md) | retirar |
| `audit-report.md` | [hallazgos §5](../../findings/index.md) y [evidencia](../../evidence/index.md) | retirar del árbol; preservar sin reescribir en Git y backup |
| `rubric.md` | [calidad](../../quality/index.md), con los 71 criterios trazados | retirar; su aplicación numérica queda citada como histórica |
| `use-cases.md` | [requisitos](../../requirements/index.md), 99 IDs preservados | retirar |
| `data-model.md` | [base de datos](../../architecture/database/index.md) y sus hojas subordinadas | retirar; el nombre se conserva sólo como referencia histórica |
| `architecture-decision.md` | [arquitectura](../../architecture/index.md) y [estructura](../../architecture/structure/index.md) | retirar |
| `evidence/` (doce reportes) | citados uno a uno en [hallazgos](../../findings/index.md) | retirar del árbol; preservar las mediciones originales en Git y backup |

### 4.2 Paquete de 2026-09-08

| Documento | Contenido consolidado en | Disposición propuesta |
| --- | --- | --- |
| `README.md` | [índice](../../README.md) | retirar |
| `findings/index.md` | [hallazgos](../../findings/index.md) | retirar |
| `architecture/index.md` | [arquitectura](../../architecture/index.md) e [integraciones](../../architecture/integrations/index.md) | retirar |
| `roadmap/index.md` | [roadmap](../../roadmap/index.md) | retirar |
| `coverage/index.md` | [requisitos](../../requirements/index.md) | retirar. **Nunca estuvo rastreado**: `.gitignore:15` lo capturaba por el nombre `coverage/` |
| `decisions/index.md` | [decisiones](../../decisions/index.md) | retirar |
| `evidence/index.md` | [evidencia](../../evidence/index.md) | retirar |

### 4.3 Manifiesto de retirada: las veinticinco rutas

**Los veinticinco se retiran**, incluidos los trece informes de evidencia. Su
preservación no es dejarlos en el árbol: es `HEAD` en `a92756b` más el backup
verificado. Ninguno se sigue actualizando, y ninguna jerarquía paralela se duplica
dentro de `docs/audit`.

**Todos son `RECOVERABLE`.** No hay ningún borrado irreversible en esta operación.

| # | Ruta, relativa a `docs/audit/` | Destino del contenido | SHA-256 (16) | Recuperación |
| --- | --- | --- | --- | --- |
| 1 | `2026-09-04-backend-v2/README.md` | [índice](../../README.md) | `1a1d786737270319` | Git `a92756b` (modificado, en el backup) |
| 2 | `2026-09-04-backend-v2/audit-report.md` | [hallazgos §5](../../findings/index.md) | `a47b24c4024d7006` | Git `a92756b` |
| 3 | `2026-09-04-backend-v2/rubric.md` | [calidad §5](../../quality/index.md) | `9ecbd7cbf8834bb2` | Git `a92756b` |
| 4 | `2026-09-04-backend-v2/use-cases.md` | [requisitos](../../requirements/index.md) | `a58600fc5de4ea1a` | Git `a92756b` (modificado, en el backup) |
| 5 | `2026-09-04-backend-v2/data-model.md` | [base de datos](../../architecture/database/index.md) y sus siete hojas | `060dca22895803a6` | Git `a92756b` |
| 6 | `2026-09-04-backend-v2/architecture-decision.md` | [arquitectura](../../architecture/index.md), [estructura](../../architecture/structure/index.md) | `bcef306b7139f9b4` | Git `a92756b` (modificado, en el backup) |
| 7 | `2026-09-04-backend-v2/evidence/accounts.md` | [hallazgos §5–6](../../findings/index.md) | `3c4fa676cf818ad8` | Git `a92756b` |
| 8 | `2026-09-04-backend-v2/evidence/durability.md` | ídem | `8812f9af19b46d1b` | Git `a92756b` |
| 9 | `2026-09-04-backend-v2/evidence/fence.md` | ídem | `0d96d0d6247f81d5` | Git `a92756b` |
| 10 | `2026-09-04-backend-v2/evidence/ledger.md` | ídem | `90a131dc096fbb21` | Git `a92756b` |
| 11 | `2026-09-04-backend-v2/evidence/neutrality.md` | [integraciones](../../architecture/integrations/index.md) | `b1e6a56b230b7c9a` | Git `a92756b` |
| 12 | `2026-09-04-backend-v2/evidence/parity.md` | [estructura §4.3](../../architecture/structure/index.md) | `c65fe4cba4c7a046` | Git `a92756b` |
| 13 | `2026-09-04-backend-v2/evidence/product.md` | [requisitos](../../requirements/index.md) | `38d4a1dd5eaffd5c` | Git `a92756b` |
| 14 | `2026-09-04-backend-v2/evidence/security.md` | [tests §8.1](../../quality/testing/index.md) | `90333da0fd5f18d2` | Git `a92756b` |
| 15 | `2026-09-04-backend-v2/evidence/streaming.md` | [hallazgos §2](../../findings/index.md) | `30595585eb221f9e` | Git `a92756b` |
| 16 | `2026-09-04-backend-v2/evidence/structure.md` | [estructura](../../architecture/structure/index.md) | `df03a97c697d92b5` | Git `a92756b` |
| 17 | `2026-09-04-backend-v2/evidence/tests.md` | [tests](../../quality/testing/index.md) | `a15b1618b81b821f` | Git `a92756b` |
| 18 | `2026-09-04-backend-v2/evidence/wiring.md` | [hallazgos §9](../../findings/index.md) | `ebf8d05ec20a153d` | Git `a92756b` |
| 19 | `2026-09-08-provider-neutrality/README.md` | [índice](../../README.md) | `252f66f491e27c6e` | **sólo backup**: no rastreado |
| 20 | `2026-09-08-provider-neutrality/findings/index.md` | [hallazgos](../../findings/index.md) | `5237199a1a592854` | **sólo backup** |
| 21 | `2026-09-08-provider-neutrality/architecture/index.md` | [arquitectura](../../architecture/index.md), [integraciones](../../architecture/integrations/index.md) | `14dbf8ac5227b16d` | **sólo backup** |
| 22 | `2026-09-08-provider-neutrality/roadmap/index.md` | [roadmap](../../roadmap/index.md) | `6cb2d8dbabdb67ed` | **sólo backup** |
| 23 | `2026-09-08-provider-neutrality/coverage/index.md` | [requisitos](../../requirements/index.md) | `7466d6ad7a069bf3` | **sólo backup**: además estaba ignorado por `.gitignore:15` |
| 24 | `2026-09-08-provider-neutrality/decisions/index.md` | [decisiones](../../decisions/index.md) | `35dc653f546fbb37` | **sólo backup** |
| 25 | `2026-09-08-provider-neutrality/evidence/index.md` | [evidencia](../../evidence/index.md) | `035fd820558c7038` | **sólo backup** |

### 4.4 Reglas de la retirada

- **El backup ES una fuente de restauración**, no un adorno. Para los tres archivos
  modificados y para los siete no rastreados, Git por sí solo **no** alcanza: esos
  contenidos existen únicamente en el archivo verificado de
  [evidencia §6.2](../../evidence/index.md).
- **Nada se borra sin que su contenido esté enlazado desde el documento dueño.** La
  comprobación es mecánica: cada fila de arriba nombra su destino.
- El futuro packet de admisión actualiza los literales contra el árbol consolidado
  de esta ronda. Hasta entonces, la retirada deja referencias históricas en la
  compuerta: no se proclama conformidad ni se cambia código para ocultarlo. El
  commit de admisión incluye la retirada y la sustitución de rutas como un único
  cambio revisado; no debe publicarse un estado intermedio como certificado.
- La retirada la ejecuta el root, tras validar los veintitrés canónicos y verificar
  el backup. **Este writer no borra nada.**

---

## 5. Dieta de la compuerta

No forma parte del puente, pero es su vecino y conviene separarlos:

- El script está en 22.984 líneas. Su costo por cambio es real y está medido en
  [hallazgos](../../findings/index.md).
- La dieta —leyes como datos, historia fuera del script, imports por análisis
  sintáctico— es un packet propio, de M13, y **no** se mezcla con la admisión de
  esta documentación.
- Mientras tanto se conserva lo que funciona: la matriz del hook de publicación, la
  numeración contigua de decisiones, el inventario de objetos de esquema que
  detecta triggers borrados, y las leyes de forma de dominio.

---

## 6. Lo que este puente no hace

- **No autoriza P9 ni ningún cutover.** Siguen diferidos y requieren un acto
  separado del owner.
- **No habilita publicación.** La política de publicación no cambia.
- **No convierte esta especificación en autoridad operativa por sí sola.** Eso lo
  decide el owner en el paso 5 de §3 y queda registrado en
  [decisiones](../../decisions/index.md).
- **No presenta esta documentación como admitida.** Mientras el packet no esté
  commiteado y verificado, la respuesta correcta a «¿está admitida?» es **no**.
