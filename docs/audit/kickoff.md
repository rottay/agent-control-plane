# Coordinación de agentes: reparto vigente y contrato histórico de kickoff

Dueño del reparto de agentes y del prompt de kickoff. Describe la organización
aprobada por el owner; no es otro roadmap ni reemplaza los contratos del producto.

[Entrega](implementation/index.md) · [Packets](implementation/packets/index.md) · [Paralelismo](roadmap/parallelism/index.md) · [Decisiones](decisions/index.md)

## 0. Reparto vigente desde el 2026-09-22 (orden del owner)

Kimi (`kimi/k3/coordinator/01`) deja de ser el DT el 2026-09-22. Todo lo que este
documento dice de Kimi como coordinador es histórico; no se reescribe, queda
superseded por esta sección.

Por la misma orden, las menciones de staffing de `docs/ROADMAP.md` —Kimi como DT,
los checkpoints de Codex por fase, la terna Kimi/Fable/Codex del fallo de debrief
del 2026-08-31 y la línea de staffing de P9— son históricas y no gobiernan el
reparto; quién conduce el debrief futuro queda pendiente de confirmación del
owner. El roadmap sigue siendo canónico en alcance, secuencia y gates, y sus bytes
no se editan: el fence los fija.

| Agente | Rol vigente |
| --- | --- |
| Claude en la cuenta claude-admin, `claude/opus/coordinator/01` | DT y único coordinador. Modelo verificado en la metadata de la sesión, no en el título de la terminal. Planifica packets dentro del alcance autorizado, delega implementación y verificación, adjudica hallazgos y gestiona staging, receipts, commits locales y checkpoints; sigue en forma autónoma tras cada entrega aceptada. No es el writer habitual ni aprueba cambios propios |
| Claude Opus en claude-admin, `claude/opus/implementer/01` | Único writer canónico sobre `main`, uno por vez; puede ser un subagente o una sesión de terminal que el DT lanza bajo claude-admin. Otros Opus mapean, proponen o verifican read-only con salidas disjuntas. Nunca se cae a los perfiles de Daniel (`claude-daniel`) ni a otra cuenta, y menos en silencio |
| Fable en claude-admin, `claude/fable/reviewer/01` | Auditor estrictamente read-only, convocado a criterio técnico del DT: hitos importantes, cambios de contrato o arquitectura, recuperación, credenciales, efectos Git o controversias relevantes. No hace falta en cada commit |
| Codex | Consultor ocasional a través del owner; no es supervisor permanente ni requisito de ningún commit |

Toda entrega necesita verificación independiente de alguien distinto del writer.
Para un lote común alcanza con otro subagente independiente; Fable no se vuelve un
cuello de botella ritual. Ningún writer certifica su propio cambio.

El título anterior fue reemplazado y se conserva citado aquí: «Kimi dirige, Opus
implementa, Codex revisa». Quedan superseded, sin borrar su texto:

- §1–§2 en todo lo que asignan a Kimi o a Codex;
- §3 entera: las ediciones propias del DT pasan a un verificador independiente
  (otro agente) antes del commit, no a Codex; los hitos de §3.2 reciben una
  auditoría read-only de Fable cuando el DT juzga que el riesgo lo amerita, y
  Codex puede consultarse a través del owner. Si Fable no está disponible, su
  revisión nunca se simula: ese cierre queda pendiente;
- en §5, la titularidad de los commits: los gestiona el DT vigente;
- §6, el prompt de kickoff para Kimi, que queda como artefacto histórico.

En §4 y en el resto de §5, donde dice Kimi se lee «el DT»; lo que esas secciones
dicen de Codex cede ante esta.

Sin cambios: se trabaja directamente sobre `main`, sin ramas ni worktrees nuevos;
un solo writer; no push (las autorizaciones de publicación anteriores están
consumidas); sin UI; sin P9 ni cutover; sin otros repositorios; sin stash, clean,
resets destructivos ni force; sin secretos. Autorizar agentes de desarrollo en
claude-admin **no** autoriza smokes de producto que consuman proveedores reales:
esos requieren perfil, modelo y límites explícitos. El alcance funcional del
roadmap no cambia.

El resto de esta página es el contrato de kickoff tal como se aprobó para Kimi.

## 1. Mandato y límites

Kimi K3 es el DT, coordinador de commits locales y auditor habitual. Claude Opus
implementa. Codex interviene cuando Kimi modifica archivos personalmente y en
hitos importantes. El objetivo es avanzar en comportamiento verificable con
delegación, sin duplicar coordinación ni consumir Codex mediante polling.

La creación de este documento **no inicia agentes ni autoriza implementación**.
Al recibir la orden de kickoff del owner, Kimi verifica el programa autorizado,
su alcance y sus límites; luego puede abrir y cerrar los packets comprendidos sin
pedir otra confirmación humana por cada paso. Gastos, accesos o ampliaciones fuera
de esa delegación siguen requiriendo autorización.

Hay textos operativos anteriores con Sonnet/Fable, worktrees y ownership distintos.
No significan que deba recrearse esa flota. El mandato de roles de esta página se
debe conciliar explícitamente en el [puente de autoridad](implementation/migration/index.md).
No se ignora el fence, no se lo relaja para pasar y no se cambia código de producto
antes de resolver la admisión. Bootstrap y orden siguen el inventario P-01–P-04.

## 2. Responsabilidades

| Agente | Hace | No hace |
| --- | --- | --- |
| Kimi K3, coordinator | Elige paquetes por dependencias, congela briefs y R/W/O/E, dirige workers, verifica entregas, adjudica correcciones dentro del diseño, mantiene continuidad y gestiona commits locales | No se convierte en writer habitual ni aprueba cambios propios; no altera silenciosamente alcance, contratos, gates o porcentajes |
| Claude Opus, implementer | Código, tests y actualización documental de su packet; un Opus integrador es el único writer canónico | No amplía write-set, no se verifica a sí mismo, no comitea ni publica por iniciativa propia |
| Worker independiente, verifier/reviewer | Ejecuta comprobaciones autorizadas, registra resultados y revisa el diff; Kimi puede cubrirlo si no es autor | No modifica el cambio para obtener verde, no fabrica receipts ni confunde salida truncada con PASS |
| Codex, consultant/reviewer | Revisa cambios propios de Kimi, hitos significativos y decisiones que excedan la especificación | No dirige la operación diaria, no necesita aprobar cada cambio de Opus ni mantenerse consultando terminales |

Para un segundo verificador se puede usar otro Opus read-only; no hace falta una
flota permanente adicional. Identidades de worker distintas y roles explícitos,
aunque compartan proveedor/modelo. El integrador conserva contratos, migraciones,
composición y otros recursos compartidos; aplicar un patch de otro worker no borra
la autoría de ese worker a efectos de independencia.

Modelo y cuenta deben comprobarse en metadata real al iniciar o retomar cada
sesión, no por el título de la sesión de terminal: Kimi `kimi-code/k3`, Claude
`opus` resuelto a la versión efectiva. Para Claude se usa el perfil normal/admin
indicado por el owner, `claude`, **no `claude-daniel` ni la cuenta personal de
Daniel**. No leer ni copiar credenciales para comprobarlo. Si el modelo/cuenta no
se puede verificar, informar la incertidumbre antes de consumo adicional; no
sustituir modelo en silencio.

## 3. Cuándo consulta Kimi a Codex

### 3.1 Cambios propios de Kimi

**Cualquier edición de archivos que Kimi haga personalmente** —código, tests,
scripts, configuración o documentación, incluido el roadmap— debe pasar por
Codex. Se agrupa por packet/diff, no por línea.

1. Antes de escribir, consultar necesidad, propuesta, alcance exacto y alternativa
   de delegarlo a Opus. Pedir conformidad sobre esa intervención acotada.
2. Para escribir, obtener el relevo explícito del único writer: Opus detenido en
   un checkpoint y sin procesos mutantes. Nunca editar simultáneamente.
3. Después, enviar el diff exacto y las pruebas a Codex. Si el cambio ya ocurrió,
   preservarlo y declararlo pendiente de revisión; no ocultarlo ni autoaprobarlo.
4. No integrar como aceptado, emitir auto-receipt ni commitear ese cambio hasta
   dictamen favorable de Codex y verificación independiente. Una aprobación de
   propuesta no es aceptación de un diff todavía inexistente.

Kimi puede delegar a Opus el asiento factual de avances para no generar una
consulta por cada edición administrativa. Pero un cambio de diseño, secuencia,
gate, alcance o criterio **decidido por Kimi** también se consulta a Codex aunque
Opus sea quien lo transcriba. No se evade revisión cambiando quién teclea.
Enviar prompts, leer, auditar código ajeno y hacer un commit verificado de Opus
no son por sí solos autoría de archivos de producto de Kimi.

### 3.2 Hitos importantes, aunque todo lo haya escrito Opus

Codex revisa antes de declararlos cerrados:

- M0: puente de autoridad y base de pruebas segura.
- M2: primera tarea útil real por CLI/API.
- M4: recuperación, ownership e incertidumbre de efectos.
- M5: cuentas, cuotas y continuidad.
- M7: composición y sustituciones realmente anunciadas.
- M11: economía, evaluaciones y routing sustentado por evidencia.
- M14: certificación final del backend.

Kimi puede hacer commits parciales ya verificados antes del cierre del hito;
no necesita acumular una semana de cambios. Eso no adelanta aceptación del hito.
Para packets críticos se conserva además el nivel de revisión de
[entrega §4](implementation/index.md#4-límites-de-auditoría), sin agregar rondas ilimitadas.

### 3.3 Protocolo de consulta y ausencia de respuesta

Una consulta acotada contiene: ID y motivo, pregunta concreta, HEAD/base/tree,
autores e identidades, R/W/O/E, diff o artefacto accesible por digest, decisiones
afectadas, comandos/exit codes, pruebas positivas/negativas, límites y propuesta
de Kimi. No enviar toda la conversación ni secretos; tampoco un resumen sin diff.

Codex devuelve ACCEPT, ACCEPT_WITH_CHANGES o REJECT con alcance y motivos. Un
ACCEPT_WITH_CHANGES no equivale a aceptar correcciones aún no verificadas: se
comprueba el delta señalado sin reauditar todo el producto. Registrar el dictamen
y su snapshot en el paquete de evidencia; si el preestado relevante cambia, no
reutilizar el dictamen como si correspondiera al árbol nuevo.

Verificar al kickoff el canal real para consultar a Codex. No inventar nombre de
sesión, ID, disponibilidad ni ACK. Si no hay canal accesible, entregar al owner un
brief que pueda reenviar y marcar WAITING_CODEX. Silencio o timeout no es ACCEPT.
Se detiene sólo lo dependiente: puede seguir preparación RO independiente. No
mutar el snapshot que está esperando auditoría para mantener agentes ocupados.

## 4. Paralelismo y ritmo económico

La fórmula de conflictos, las olas y el relevo tienen un único dueño en
[paralelismo](roadmap/parallelism/index.md); no se duplican aquí.

- Un writer integra directamente sobre main. No crear ramas ni worktrees nuevos.
- Otros Opus preparan mapas, propuestas temporales y oráculos o verifican snapshots
  autorizados. Scope disjunto incluye archivos, outputs y recursos, no sólo carpetas.
- Kimi emite briefs pequeños y cerrados. Cada worker lee los documentos de su packet,
  no las 121 filas ni todo el historial en cada turno.
- Resultado durable + señal de SOURCE_READY, NEEDS_DECISION o BLOCKED al DT.
  Preferir eventos. Si no existe notificación fiable, una comprobación breve cada
  diez minutos; no bucles de segundos. Codex no participa de ese monitoreo rutinario.
- Cuota/modelo indisponibles: checkpoint y un único reintento a los treinta minutos
  o al reset conocido, sin solicitudes duplicadas ni cambio silencioso de cuenta.
- Tras un cierre, abrir el siguiente packet elegible dentro del programa autorizado;
  no quedar idle por haber anunciado un hito. Si está pendiente Codex, respetar §3.3.

No optimizar por cantidad de agentes, commits o líneas. Priorizar primero el flujo
útil, después recuperación, cuentas/coordinación y certificación según el roadmap.
No producir scripts genéricos si el packet no demuestra qué garantía aportan.
La prioridad vinculante está en [casos de uso antes que integraciones](roadmap/index.md#11-casos-de-uso-antes-que-catálogo-de-integraciones):
Kimi debe mostrar entregas completas y justificar sus dependencias, no dedicar
workers a incorporar herramientas sin necesidad del perfil aprobado.

## 5. Commits y continuidad

Kimi gestiona los commits, siguiendo [entrega §3](implementation/index.md#3-evidencia-y-commit-por-packet).
En la ventana de commit se suspende toda mutación de Opus y de verificadores con
outputs compartidos. Kimi comprueba base, tree, staged/unstaged/untracked y receipt;
staging sólo de rutas exactas, nunca git add global. Incluye consultas Codex cuando
corresponden. No incorpora cambios preexistentes ajenos ni cierra por prosa.

Después registra SHA, checks posteriores proporcionales y siguiente acción. Un
fallo postcommit no se oculta ni se corrige con reset/force; se abre corrección
acotada. No push ni cambio de remotes; la autorización de commit no publica.

El roadmap admitido conserva el estado de ejecución. Los contratos/diseño siguen
en sus documentos dueños bajo docs/audit, sin una segunda cronología paralela.
Cada checkpoint registra packet, HEAD, diff pendiente, read/write digests,
workers/modelos/cuenta por referencia no secreta, checks, receipts, consultas
pendientes, consumo conocido/UNKNOWN y una siguiente acción segura. No depende
exclusivamente del scroll de la terminal ni de archivos temporales.

Reporte al owner al cerrar hito o ante bloqueo/desviación: qué funciona nuevo,
prueba o demostración, commit, qué falta y si necesita una decisión. Porcentajes
separados con denominador fijo según [roadmap §1](roadmap/index.md); no
convertir documentación o DESIGN_READY en porcentaje de producto. Sin tiempos
medidos, las fechas son estimaciones, no compromisos certificados.

## 6. Prompt de kickoff para Kimi

Copiar este bloque al entregar la orden de inicio. Este documento completo es el
contrato de coordinación; el bloque no crea una segunda versión resumida de él.

```text
Asumí el rol de DT del Agent Control Plane con Kimi K3.
Repositorio: /Users/daniel/Developer/Rottay/agent-control-plane.

Tu contrato de coordinación es:
docs/audit/kickoff.md
Leelo completo. Claude Opus implementa; vos coordinás, verificás y gestionás
commits locales. Codex revisa cambios propios tuyos e hitos importantes según
ese contrato. No hay otro DT. No implementes UI ni P9, no hagas push ni toques
repositorios de producto ni ningún otro repositorio. No crees ramas/worktrees
nuevos.

Contexto: la reconsulta K3 y tres agentes dio ACCEPT_WITH_CHANGES; Codex integró
correcciones en docs/audit. Son especificación, no código certificado. Se
conservan 99 casos + 22 criterios transversales, 39 paquetes y la rúbrica de 89
criterios. No reinicies el proyecto ni vuelvas a auditarlo completo. La misión
es convertir ese plan en comportamiento real con arquitectura neutral,
datos normalizados, contratos por dueño y pruebas independientes.

Priorizá los casos de uso y demostraciones de roadmap §1.1. Arquitectura flexible
no significa implementar todo el catálogo: entregá el mínimo de integraciones
reales que cubra el perfil, con dependencias reemplazables y conformidad. No
agregues puertos vacíos ni renuncies a las garantías para acelerar una demo.

Antes de escribir:
1. Leé AGENTS.md, CLAUDE.md y el estado/mandatos vigentes de docs/ROADMAP.md.
2. Leé docs/audit/README.md, decisions/index.md, implementation/index.md,
   implementation/migration/index.md, roadmap/index.md,
   implementation/packets/index.md y roadmap/parallelism/index.md
   (todas las últimas rutas relativas a docs/audit).
3. Verificá branch/HEAD/estado dirty/index, autoridad, sesiones del proyecto
   permitidas y leases. No cierres ni reutilices sesiones ajenas. Conservá los
   cambios documentales pendientes y el backup indicado en evidence/index.md;
   no los sobrescribas con una copia histórica.
4. Comprobá la autorización de kickoff/programa y los límites de consumo. El
   reparto de roles está aprobado; el puente documental no se presume cerrado.
   Si falta autoridad para bootstrap/producto, exponé exactamente qué falta,
   sin ejecutar tests peligrosos ni inventar permisos.
5. Verificá K3 y Opus efectivos, perfil Claude admin normal, canal de consulta
   Codex y continuidad de workers. No uses claude-daniel. No copies credenciales.

Primer checkpoint: informá concisamente HEAD, estado real del puente, primer
packet elegible, plan de workers/R-W-O-E y bloqueos concretos. Tras confirmar
autorización y scope, delegá la implementación; no te quedes esperando otra
confirmación por cada packet que ya esté cubierto por la delegación.

Arranque esperado si el árbol conserva el preestado de la especificación:
P-01 (aislamiento de tests), P-03 (anclas), P-02 (puente) y P-04 (plataformas).
No asumas que siguen pendientes: contrastá evidencia contra HEAD. No ejecutes
la suite completa hasta cumplir el aislamiento de P-01. Incluí en el puente
la conciliación de roles, commits y main de este documento; no reedites
silenciosamente el ADR histórico ni autoapruebes cambios de autoridad.

Luego seguí las olas y cortes aceptados, no sólo números de paquete. Cada brief
fija DESIGN_READY, SCOPE_FROZEN, fuentes/digests, R/W/O/E, invariantes, pruebas
positivas/negativas, salida y límites. Leé sólo los contratos/datos/requisitos
que consume ese packet. Paralelizá preparación y verificación compatibles;
un solo Opus escribe/integrará main. El writer nunca es su propio verificador.

Terminá cada packet con evidencia, revisión independiente y commit local
autorizado. Actualizá el estado durable sin duplicar documentación; delegá a
Opus esas ediciones cuando corresponda. Si vos modificás archivos, consultá
a Codex antes y someté el diff final a su revisión: no te autoapruebes.
Consultalo también en los hitos establecidos y ante cambios al plan aprobado.

No prometas soporte por tener un puerto: proveedor/framework funcional requiere
ejecución real y conformidad; intercambiabilidad exige dos implementaciones
conformes. UNKNOWN no es cero ni éxito; efectos inciertos se reconcilian,
no se reintentan ciegamente. La UI queda para un diseño posterior.

Trabajá autónomamente dentro de la autorización recibida, con entregables
verificables. Avisá hitos, bloqueos o decisiones reales; no gastes contexto
en polling continuo ni conviertas auditorías en el entregable principal.
```
