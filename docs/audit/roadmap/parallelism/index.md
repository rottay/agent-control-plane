# Paralelización: olas, conflictos y writer único

Dueño de la planificación de concurrencia, no de las dependencias ni del permiso.

[Roadmap](../index.md) · [Packets](../../implementation/packets/index.md) · [Entrega y paradas](../../implementation/index.md)

Estado: **planificación**. No cambia readiness, no autoriza ejecución ni worktrees.
El inventario conserva 39 IDs; los sufijos de packets §1.8 son entregas internas,
no hitos adicionales ni porcentajes nuevos.

La asignación vigente de agentes y el protocolo de consulta viven en
[coordinación](../../kickoff.md); esta página sólo
define dependencias de integración, conflictos y paralelismo permitido.

## 1. Olas de preparación e integración

Cada ola admite preparación RO paralela; su columna de integración es **serial**.
Dependencias, condiciones de habilitación y entregas internas mandan desde
[packets §1](../../implementation/packets/index.md). Un packet arrancado no es un
predecesor aceptado. H-5 está cerrado de diseño; P-23 todavía debe implementar y
probar conformidad. Un fallo de esa conformidad bloquea sus consumidores y release,
sin reabrir M2 ni detener trabajo independiente de la composición nueva.

| Ola | Orden serial propuesto, una vez autorizado | Preparación RO útil / condición de salida |
| --- | --- | --- |
| 0 | P-01 → P-03 → P-02 → P-04 | Destinos de escritura, literales y runners; aislamiento antes de suite y puente antes de código de producto. |
| 1 | P-09/log → P-10 → P-08 → P-05 → P-11 → P-12 → P-13 | CAS, identidad, errores y mapas de imports. P-09 cierra sus comprobaciones completas, no sólo el nombre /log. |
| 2 | P-18/protocolo → P-36/local → P-14 → P-32/captura → P-33/catalogo → P-06 → P-07 | Acceso privado y bootstrap reales; fuentes/políticas antes de consumo. No se anuncia GC, portabilidad o M11 completos. |
| 3 | P-15 → P-16 → P-17/efecto → P-18/recuperación → habilitación de P-17 | Smoke sólo con perfil/cuenta/límite autorizados; matriz de crash y ownership antes de escritura operativa. |
| 4 | P-19 → P-21 → P-22 → P-23/garantías → P-34/admisión → P-20 → P-24 → P-25 | Reservas, control de hijos, continuidad y herramientas; sandbox efectivo o ausencia declarada. |
| 5 | P-26 → P-27 → P-28 → P-29 | Políticas DAG/aprobación y consulta durable; M9 ejecutable sólo tras M3/M5/M6. |
| 6 | P-30 → P-31; cierre completo de P-23 según perfil | Telemetría/stream acotados y composición del perfil; no vender conformidad individual como delegación probada. |
| 7 | P-32 completo → P-33 completo → P-34 → P-35 | Oráculos de rangos/racionales y productor de evaluación; gasto del runner/juez detrás del presupuesto. |
| 8 | P-36 completo → remanente de P-37 | Backup/restore, retención y contratos portables; cierre de anatomía sobre consumidores finales. |
| 9 | P-38 → P-39 | Instalación/perfil fijados y snapshot de certificación, sin writer mutándolo. |

Una extracción necesaria de P-37 puede preceder a su consumidor, con mapa de
paths/imports/exports/tests cerrado y sin mezclar movimiento con nueva semántica.
P-26/P-27 puros pueden adelantarse; eso no activa un scheduler ni cierra M9.
P-23/garantías entrega la primitiva compartida antes de P-34/admisión; el solver
de composición completo permanece en P-23/M7. P-34/admisión precede a equipos M9, sin esperar costo agregado ni desempeño de
M11. Desarrollo del scheduler no habilita concurrencia con gasto antes de ese corte.
No hay obligación de ocupar todos los agentes. No se cuenta dos veces un corte
temprano cuando después se cierra su packet.

## 2. Grafo de conflictos al congelar el scope

El brief fija R(p) (entradas/autoridad), W(p) (escrituras canónicas), O(p)
(outputs/temporales) y E(p) (bases, stores, procesos, sockets, puertos, cuentas).
Definir Q(p) = W(p) ∪ O(p). Existe arista p — q si:

```text
Q(p) ∩ (R(q) ∪ Q(q)) ≠ ∅
o Q(q) ∩ R(p) ≠ ∅
o hay uso incompatible/no aislado de un mismo recurso E.
```

Las intersecciones son **por solapamiento de scope**, no sólo igualdad de strings:
misma ruta resuelta, o un directorio declarado que contiene la ruta del otro.
Se usa límite de componente (/a/b no contiene /a/bc), reglas del filesystem y
destinos de symlink; un prefijo no concede permiso de escribir rutas no listadas.
Incluir exports, project references, entradas de generadores y outputs indirectos.
La fórmula cubre W–W, W–R, O–W, O–O y O–R en ambas direcciones.

Cada fila siguiente es una hiperarista: los escritores y lectores de esa versión
comparten el recurso, aunque sus archivos de implementación sean distintos.
Son anclas para resolver paths al abrir el packet, **no write-sets autorizados**.

| Recurso compartido | Packets especialmente afectados | Regla de integración |
| --- | --- | --- |
| Autoridad, fence, fixtures, digests | P-01/02/03/04/37/38; lectores: todos | Checker/AGENTS/ROADMAP/ADR y manifest literal se cambian con dueño único; fixture no repinea la autoridad viva. |
| Contratos, schemas, barrels, declaraciones públicas | P-05/06/07/11/14/16/18/19/22/23/24/28/31/32/34/36/37 | Versionar primero el contrato; consumidores/negativos exhaustivos en el mismo scope. Ningún default para ocultar un caso nuevo. |
| Migraciones, append, heads, folds | P-05/08/09/10/14/16/17/18/19/20/21/22/23/26/27/28/29/32/33/35/36/37 | El registro de migraciones y la próxima versión se asignan serialmente; un único fold vivo/rebuild. No editar checksums aplicados. |
| Artefactos, pins, credenciales y coordinación | P-06/07/16/17/18/19/20/21/22/25/35/36 | No compartir base, blob tree, PID ni token entre drills. Ledger y arbiters separados no ganan transacción común. |
| Runtime y composición del daemon | P-05/06/07/13/14/15/16/17/18/19/20/21/22/23/24/25/29/34/36/37/38 | P-13 precede al gran cableado; después de extracción se vuelve a resolver el read-set, no se aplican offsets viejos. |
| CLI/API, consultas, stream, telemetry | P-06/07/10/12/14/15/22/26/28/29/30/31/37 | Proyecciones públicas y cursor/hello con dueño; privacidad de resultados no se prueba contra la misma función en ambas puertas. |
| Registry, asignaciones, cuotas, uso/precios | P-14/19/20/23/26/27/28/29/32/33/34/35 | Un solo registry; fuentes/cortes versionados, no lecturas de “lo último” ni telemetría usada para facturar. |
| Git, receipts y snapshot de evidencia | P-16/17/18/28/35/39 | Cambio de base/tree/read-set material invalida el receipt correspondiente. La certificación no observa main en movimiento. |
| Manifests, lockfile, tsconfig, exports, pins y CI | P-04/13/23/25/35/36/37/38 y toda extracción entre paquetes | Lock de integración global; no installs paralelos ni renombrados que dejan roto un consumidor. |
| Outputs de compilación/tests y recursos de proceso | Todo comando que genere archivos o use E | Declarar dist, .d.ts, tsbuildinfo, caches, coverage, logs, sqlite/WAL, artefactos, puertos y sockets. “Sólo comprobar tipos” no demuestra cero escrituras. |

Ejemplos: P-08—P-09—P-10 compiten por migraciones; P-13—P-15—P-21 por
composición; P-17—P-18—P-22 por ownership/Git; P-32—P-33—P-34 por fuentes/cortes;
P-37 invalida el read-set de cualquier consumidor que mueva. El grafo ordena
cambios y revela invalidaciones; **main sigue teniendo un writer incluso si no
hay arista**. RO sobre snapshot inmutable puede correr en paralelo, pero sólo
afirma resultados sobre sus digests; una lectura de un recurso E vivo no es
automáticamente independiente.

## 3. Capacidad del agente y responsabilidad de integración

Integrador es una responsabilidad de coherencia y ownership, **no una obligación
de usar el modelo de mayor capacidad para cada edición**. El coordinador clasifica
el trabajo y elige capacidad proporcional, con las leyes vigentes como límite.

| Trabajo | Reparto |
| --- | --- |
| Fixtures, mapping cerrado, P-11/P-12, paginación, imports según mapa aprobado | Preparación mecánica; no inventa campos, algoritmos, errores, paths ni oráculos. |
| Identidad, DDL/CAS, autoridad, credenciales, fencing, recuperación, VCS o composición compartida | Responsable de integración decide la frontera y revisa el diseño; lo repetitivo puede descomponerse bajo un brief cerrado. |
| Verificación | Worker independiente de quienes redactaron/aplicaron el cambio, incluso si un modelo mecánico propuso el patch. |
| Auditoría | Lectura y dictamen; no edita fixtures para obtener verde ni se convierte en writer. |

**La asignación vigente del writer canónico se respeta.** Un futuro relevo a otro
worker/modelo necesita autorización explícita del owner o delegación que alcance
ese cambio, compatible con la autoridad vigente; este documento no la modifica.
Protocolo del relevo, nunca dos writers:

1. Detener nuevas escrituras del saliente; checkpoint, diff y outputs inventariados,
   sin procesos mutantes pendientes ni ownership incierto.
2. Fijar snapshot de HEAD más cambios tracked/untracked, read/write-set, digests,
   checks/receipt del estado transferido y siguiente acción segura.
3. Liberar y acusar el lease/ownership anterior; conceder explícitamente el único
   lease al entrante. Si falta quiescencia/acuse, no hay relevo.
4. El entrante revalida prestate, autorización y scope antes de escribir. Un
   handoff no amplía el write-set ni hace válido un receipt para otro tree.
5. Mantener verificador distinto. El receipt de transferencia no autoriza commit
   por sí mismo; se conserva el protocolo de [entrega §3](../../implementation/index.md).

Hasta ese acto, los demás agentes sólo investigan/proponen en lectura. No se
crean worktrees, ramas ni permisos alternativos para “aprovechar” paralelismo.

## 4. Brief, evidencia y salida del ciclo

Usar la [plantilla de packet](../../implementation/packets/index.md#6-plantilla-de-un-packet),
añadiendo R/W/O/E, hashes de predecesores, perfil, exclusiones y qué permanece
deshabilitado. Ninguna lista de paths final se inventa antes del prestate.
Comandos/positivos/negativos se fijan desde el runner real; verificación en copia
descartable autorizada, no en checkout vivo. Registrar destinos de escritura,
exit codes, conteos, semillas y outputs; una corrida truncada o ambiental no es PASS.

Stops, receipt y límites de revisión siguen [entrega §2–4](../../implementation/index.md).
Tras REJECT, adjudicar una corrección concreta y comprobar su efecto, sin repetir
la auditoría completa de 39 packets por cada edición. Un defecto de composición
detiene su consumidor, no fabrica readiness ni vuelve a cero lo ya acreditado.

Rollback no es reset/clean: patch inverso acotado para código, corrección aditiva o
restore íntegro autorizado para datos, reconciliación/compensación para efectos.
Nunca reescribir eventos, reanclar hashes, revivir fence viejo ni reintentar un
OUTCOME_UNKNOWN. El handoff final informa gates cerradas, evidencia, capacidad
aún apagada y una siguiente acción segura; nada autoriza publicación o P9.
