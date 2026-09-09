# Evidencia: baseline, método, procedencia y límites

Dueño único del concepto **evidencia**: qué se inspeccionó, qué se ejecutó, con
qué resultado, qué hashes lo anclan y qué **no** se hizo.

[Índice](../README.md) · [Hallazgos](../findings/index.md) · [Calidad](../quality/index.md) · [Tests](../quality/testing/index.md) · [Decisiones](../decisions/index.md) · [Migración](../implementation/migration/index.md)

Regla de esta página: **la prosa de un writer no es evidencia**. Lo que sostiene
una afirmación es un comando con su salida, un hash, o una línea de código citada.
Todo lo demás se marca como no verificado.

---

## 1. Baseline

- HEAD inspeccionado: `a92756bec0397d4354b07fee13b281dabf9f18d7`.
- Referencia local de `origin/main`: el mismo SHA. **No** se hizo fetch ni se
  comprobó el estado remoto actual.
- Rama `main`, un solo writer documental.
- Tres documentos del paquete histórico ya estaban modificados al iniciar la ronda
  anterior. **No** son cambios de esta documentación; se preservan con estos
  digests:

| Ruta | SHA-256 del contenido |
| --- | --- |
| `docs/audit/2026-09-04-backend-v2/README.md` | `1a1d78673727031992b3832a63f12539784004d8b5b9c86f54e194f157f0e51d` |
| `docs/audit/2026-09-04-backend-v2/architecture-decision.md` | `bcef306b7139f9b48b337a07e4230584efea49fd402bac13cb7b2c93659495a3` |
| `docs/audit/2026-09-04-backend-v2/use-cases.md` | `a58600fc5de4ea1a9b8f3946667d5ac24cdf4cebbaf1b50168ecac0d47a8e19c` |

---

## 2. Los nueve commits y sus recibos

Cada diff se obtuvo con `git diff <commit>^ <commit>`, y su SHA-256 se comparó
contra el receipt emitido por un verificador independiente. Las rutas se
enumeraron con `git diff-tree --no-commit-id --name-only -r <commit>`. Todos los
recibos declaran autorización y fijan el padre correcto.

| Packet | Commit | Rutas | SHA-256 del diff aceptado y commiteado |
| --- | --- | --- | --- |
| R6 | `571aa6e` | 13 | `48ebd6115fa84c7d5ceead19f72bbbe1f608d760ba9ed1b1b3840e94eef4f9d1` |
| R17 | `fb82d18` | 2 | `f727ba3308d415e61969a7b5b93bf0551925ef0125d1e40febd5fc2faed09d4a` |
| R1b | `c5f4b06` | 6 | `d6a1fe84d9ea1ffeb1aa4432972a9040e962d6ab6f758a45750a24882b9e5830` |
| R9b | `24a80bd` | 9 | `2e93d8fefb763d0bad73d898b60413bb53cc818dd323e094d6a716bd064ab8b1` |
| R11 | `86fc98e` | 27 | `3b5fc49b05f768892c56733aebde2a830166d1028b16ef2d5f3ce5c6273e5d7e` |
| R15 | `f6102a7` | 9 | `ac43b23abfeb8c76c105669dcf6591bd8e2ebb8f57b93d212c88631d1b96ec55` |
| R18 | `9b876a3` | 7 | `4be8c0dd19aaedfa83e6d0b886d3913e0e20041aa987e19df8a0caf6cf984a5d` |
| R19 | `38c2464` | 5 | `74885eed14152988ee131a10c21a3bb2eeff7f43975fd7fcd3ab3b7f508a9ebf` |
| R19b | `a92756b` | 5 | `043a200022ffbc1f9557559a38ead452f548d25e6ae01e0f725cbddbc24aa4b2` |

Cero rutas de más y cero de menos, tras resolver los marcadores de nombre de dos
ADR contra el conjunto explícito del receipt. **No** se afirma igualdad literal de
los briefs que todavía llevaban un marcador sin resolver.

Lo que el hash **sí** demuestra: que el contenido aceptado es el contenido
commiteado. Lo que **no** demuestra: una cronología inmutable de autorización. Los
reportes locales son mutables; ocho timestamps de copias son posteriores a su
commit, lo cual no prueba emisión tardía. Dos packets tienen excepciones
documentadas por muerte del writer antes del cierre, con verificación independiente
posterior del conjunto. Uno no tiene preauditoría dedicada dentro del espejo
inspeccionado; no se agotaron los almacenes externos de sesiones y **no se presume
que nunca existió**.

### 2.1 Recibos históricos ausentes

Siete recibos anteriores siguen sin aparecer. **No se recrean**: se revalidan
retrospectivamente o se exceptúan de forma explícita y nombrada, y esa decisión es
del owner. Fabricar un timestamp anterior a un commit es exactamente el defecto
que este producto existe para impedir.

---

## 3. Qué se ejecutó, y qué no

| Prueba | Resultado y alcance |
| --- | --- |
| HEAD, estado, historia, hashes y write-sets | read-only; los nueve commits coinciden con los diffs aceptados |
| Compuerta de arquitectura, antes de crear documentos nuevos | salida cero; 7/7 criterios, 39 punteros, 5 disclosures. **No** equivale a la suite completa |
| Escáner de TypeScript sobre las 39 anclas actuales | las 39 resuelven sin comentarios; ninguna vacía |
| Sección real del gate evaluada con superposición de archivos **en memoria** | baseline pasa; 39 anclas vacías pasan **indebidamente**; un ancla sólo dentro de un bloque de comentario pasa **indebidamente**; los controles negativos rechazan |
| Reproducción histórica de la misma sección en la ronda anterior | el vacío y la eliminación pasan indebidamente; sin checkout ni escrituras |
| Sumisión con objetivo y autoridad distintos | ambos aceptados con el mismo digest; import del `dist` existente y corroboración en la fuente, sin build |
| Cliente falso de API y local que captura la petición | sin instrucciones, aun con el stream completado; sin HTTP ni proveedor real |
| Guardia de payload, cliente MCP y productor de evaluaciones | fuente transpilada sólo en memoria, protocolo falso; salidas cero |
| Estructura del árbol: conteo de paquetes, archivos, carpetas y líneas | read-only, con `find` y `wc` |
| Ubicación de puertos, barrels y helpers duplicados | read-only, con búsqueda de patrones |
| Esquema del ledger: migraciones, índices, triggers, pragmas | read-only, leído del código fuente de migraciones |
| `git check-ignore` sobre las rutas del paquete documental | ejecutado; resultado en §6 |
| **Suite completa, builds y procesos reales** | **NO EJECUTADOS** |
| **Proveedor real, benchmark pagado, CI hosted, motor durable o receptor de telemetría vivos** | **NO EJECUTADOS** |

El `dist` existente no se recompiló y no se comprobó equivalencia integral entre
fuente y artefacto. Los defectos de API, local e identidad están corroborados por
las líneas fuente citadas en [hallazgos](../findings/index.md). Ninguna sonda
sustituye a una suite de regresión ni a la aceptación de un proveedor real.

**Por qué no se corrió la suite completa:** se localizaron tests que escriben el
checkout vivo, incluido `docs/ROADMAP.md`. Correrlos habría puesto en riesgo
trabajo del owner para auditar. El aislamiento de esos drills es el primer packet
([packets](../implementation/packets/index.md)).

---

## 4. Reproducciones seguras

Las sondas se invocaron desde la raíz del repositorio, sin escribir archivos ni
llamar servicios externos. §4.1 depende de fuentes; §4.2 tiene una precondición de
artefactos construidos y no es reproducible en un checkout fresco sin ellos.

### 4.1 Vacuidad de la certificación

Evalúa la sección real de la compuerta con cadenas en memoria. Es un
contraejemplo del checker, no un cambio al producto.

```sh
node --input-type=module <<'NODE'
import {readFileSync,existsSync} from 'node:fs';
const s=readFileSync('scripts/check-architecture.mjs','utf8');
const fn=n=>s.match(new RegExp('^function '+n+'\\([^]*?^\\}','m'))[0];
const section=s.slice(s.indexOf('const BE_RECORD_PATH = '),
  s.indexOf('// --- 23. STRUCTURAL_TOPOLOGY_CERTIFIED'));
const path='docs/certification/v2-backend-certification.md';
const original=readFileSync(path,'utf8');
const run=new Function('record','overrides','read','exists',`
const failures=[],notes=[],certificationBackend={};
const fail=x=>failures.push(x);
const readIfPresent=p=>p===${JSON.stringify(path)}?record:
  overrides[p]??(exists(p)?read(p,"utf8"):null);
const literalPathResolves=exists;
${fn('flatten')}
${fn('codeBeforeLineComment')}
${section}
return {failures,certificationBackend};
`);
const admission='packages/edges/tools/src/admission/index.ts';
const blank=original.replace(
  /^(\|\s*\x60BE-[^|]+\|[^|]+\|)[^|]+(\|)$/gm,'$1  $2');
const commentOnly=readFileSync(admission,'utf8')
  .replaceAll('TOOL_LOOPBACK_HOSTS','REPLACED_HOSTS')
  +'\n/*\nTOOL_LOOPBACK_HOSTS\n*/\n';
for(const [label,record,overrides] of [
  ['baseline',original,{}],
  ['all anchors empty',blank,{}],
  ['anchor only in block comment',original,{[admission]:commentOnly}],
  ['broken anchor',original.replace('| `TOOL_LOOPBACK_HOSTS` |',
    '| `TOOL_LOOPBACK_HOSTX` |'),{}],
  ['missing owed row',original.split('\n').filter(l=>
    !l.startsWith('| `OWED-R15-BENCHMARK-CUT` |')).join('\n'),{}]
]) console.log(label,JSON.stringify(run(record,overrides,readFileSync,existsSync)));
NODE
```

Resultados observados:

- baseline: sin fallos, 39 punteros resolviendo, 7/7, 5 deudas.
- todas las anclas vacías: idéntico, **incorrectamente**.
- ancla sólo dentro de un bloque de comentario: idéntico, **incorrectamente**.
- ancla rota: rechazo con el criterio nombrado y sin certificado de punteros.
- fila de deuda ausente: rechazo nombrando la deuda y sin certificado.

El checker conserva el conteo de criterios en algunos rechazos parciales pero
acumula fallos. Esa estructura intermedia no es una salida exitosa del fence
completo.

### 4.2 API y local sin instrucción

**Evidencia histórica condicionada al `dist` presente durante la sonda.** Requiere
`packages/edges/providers/dist/execution-port/index.js` y sus dependencias
construidas compatibles. No se recompilaron ni se pineó el digest de ese `dist`:
esta salida no certifica el HEAD fuente. En un checkout fresco, primero aislar
los tests mutantes, construir bajo el packet autorizado y registrar los digests;
no se ordena construir nada durante esta revisión documental.

```sh
node --input-type=module <<'NODE'
import {createExecutionPort} from './packages/edges/providers/dist/execution-port/index.js';
const seen=[];
const client={
  provider:'audit-provider',models:['audit-model'],
  async *stream(request){
    seen.push(Object.keys(request));
    yield {kind:'started',resolvedModel:'audit-model',protocolVersion:'audit'};
    yield {kind:'text',delta:'audit-response'};
  }
};
const request={
  taskId:'00000000-0000-4000-8000-000000000001',
  attempt:1,identity:'audit-provider/audit-model/consultant/01',
  instructions:'AUDIT-SENTINEL-CONTENT',reattach:null
};
for(const transportKind of ['API_KEY','LOCAL_OR_SELF_HOSTED']){
  const route={
    provider:client.provider,model:client.models[0],accountId:'audit-account',
    transportKind,capabilityPolicyVersion:'audit-v1',
    resolvedAt:'2026-09-08T12:00:00.000Z'
  };
  const port=createExecutionPort({
    bindings:new Map(),apiBindings:new Map([['audit-account',{client}]]),
    localBindings:new Map([['audit-account',{client}]])
  });
  const session=await port.start(route,request);
  if(!session.ok) throw Error(JSON.stringify(session));
  const events=[];
  for await(const event of session.events())events.push(event.kind);
  console.log(JSON.stringify({transportKind,clientRequestKeys:seen.at(-1),events}));
}
NODE
```

En los dos transportes, las claves recibidas por el cliente son `model`, `taskId`,
`attempt` e `identity`, y los eventos terminan en completado. Sin llamadas
externas.

---

## 5. Otras sondas y lo que acotan

- **Identidad de sumisión.** El parser de configuración del hijo se aplicó dos veces
  a una configuración de supervisor local, con la misma sumisión y el envelope
  alterado sólo en objetivo y autoridad. Ambos aceptados, mismo digest, objetivos
  distintos, autoridad cambiada. **No se abrió el daemon.**
- **MCP.** El cliente fuente se inicializó contra respuestas en memoria con versión
  de protocolo correcta pero sin capacidades ni versión de servidor; la llamada
  devolvió un error de herramienta y el resultado fue exitoso. **La negociación de
  versión sí existe**: no se afirma que el handshake no valide nada.
- **Guardia de payload.** Un JWT aislado y un secreto en un valor fueron detectados;
  un JWT en prosa, un prompt bajo una clave inocente y un secreto como **nombre de
  clave** no lo fueron. Datos sintéticos; **no se leyó ni se registró ninguna
  credencial real**. Este resultado corrige una afirmación obsoleta de la auditoría
  anterior sobre el caso del valor.
- **Productor de evaluaciones.** Lista de modelos vacía, fechas no parseables,
  proveedor ajeno, transporte mal escrito, tokens fraccionarios y llamadas en cero
  devuelven éxito. **No ejecuta modelos**: el defecto es de validación de artefacto
  y de contabilidad, no de gasto.
- **Esquema del ledger.** Migraciones 1 a 6 con checksum; doce declaraciones
  `STRICT`; dieciocho índices y seis triggers con la nomenclatura histórica; el
  índice del stream de cuentas **no** es único; los pragmas de apertura fijan WAL y
  sincronización normal.

---

## 6. Procedencia del paquete documental

### 6.1 De dónde viene este contenido

| Fuente | Qué aportó | Estado |
| --- | --- | --- |
| `docs/audit/2026-09-04-backend-v2/` | catálogo de 99 casos, inventario de entidades del DER, rúbrica de 71 criterios, doce reportes de evidencia, decisiones del owner sobre el stack | consolidado; carpeta retirada tras comparación íntegra con backup (§6.2) |
| `docs/audit/2026-09-08-provider-neutrality/` | catorce hallazgos, 22 criterios transversales, familias de integración, hitos M0–M14, nueve commits y sus recibos | consolidado; recuperable en el mismo backup, incluido el contenido antes ignorado |
| Árbol en `a92756b` | todas las medidas de estructura, esquema y hotspots de esta ronda | fuente primaria |
| Revisiones cruzadas de esta ronda | hallazgos estructurales S01–S11 y de datos DB01–DB08, decisiones de normalización y separación de tipos | nuevo |

**Ninguna nota obsoleta se transcribe como hecho actual.** En particular, la nota
global ponderada de la rúbrica de 2026-09-04 fue medida sobre otro snapshot con
otro instrumento: se conserva como dato histórico y **no** se presenta como estado
actual ([calidad §6](../quality/index.md)).

### 6.2 Copia de resguardo del material de origen

Antes de escribir esta documentación se creó un archivo íntegro del contenido
previo, con digest verificado, fuera del área operativa:

```
.acp-local/documentation-backups/source.doAQ0g/audit-before.tgz
SHA-256 5c8d12820b278f2ff9d23b4bbb2b6d249d581cb706958964965738639c47d53f
```

Contiene los tres archivos modificados del owner y todos los documentos previos.
**Es la fuente de restauración del contenido previo modificado y no rastreado**:
Git por sí solo no contiene esas versiones. No se restaura automáticamente ni se
sobrescriben archivos; una recuperación selecciona las rutas necesarias y compara
sus hashes antes de aplicar cambios. La historia Git preserva además las versiones
rastreadas, sin reemplazar esta copia íntegra.

### 6.3 Rutas del paquete y su visibilidad para Git

Comprobado con `git check-ignore` sobre cada ruta. Un resultado importante:

| Ruta | Rastreable |
| --- | --- |
| `docs/audit/README.md` y los demás índices de este paquete | sí |
| `docs/audit/architecture/database/index.md` y todas sus hojas subordinadas | sí |
| `.acp-local/documentation-source-ready.md` | no, por diseño: `.acp-local/` es local |

**Ningún documento canónico de este paquete queda invisible para Git.**

Ese resultado costó una corrección. El nombre `data/` estaba capturado por
`.gitignore:27`, comprobado con
`git check-ignore -v docs/audit/architecture/data/index.md`. Era el mismo defecto
que ya había ocurrido con el nombre `coverage/` en el paquete anterior, capturado
por `.gitignore:15`, donde un documento entero quedó fuera de la historia sin que
nadie lo notara.

La corrección adoptada fue **renombrar el destino canónico a
`docs/audit/architecture/database/`**, no tocar `.gitignore`: un archivo de
ignorados existe para proteger artefactos locales, y ensancharlo para acomodar un
nombre de documento cambia una regla de seguridad por conveniencia editorial.
`data-model.md` se conserva únicamente como nombre histórico dentro del paquete de
evidencia previo.

Regla que queda para el futuro: **toda ruta de documentación nueva se comprueba
con `git check-ignore` antes de escribir en ella.** Está incorporada a la
verificación de §7.

---

## 7. Verificación del paquete documental

Lo que se comprobó sobre estos documentos, y con qué:

| Comprobación | Método |
| --- | --- |
| Existencia de cada ruta del write-set | `stat` sobre cada archivo declarado |
| Enlaces internos resolubles | resolución de cada destino relativo con `stat`, no con búsqueda de texto |
| Los 99 IDs `A1`–`J6` exactamente preservados | conteo de filas por patrón sobre [requisitos](../requirements/index.md) |
| Los 22 criterios `X01`–`X22` presentes | idem |
| Los 71 criterios de la rúbrica anterior trazados | conteo de filas de la tabla de [calidad §5](../quality/index.md) |
| Ausencia de enlaces a los directorios fechados, salvo como procedencia | búsqueda de patrones sobre el paquete |
| Visibilidad para Git de cada ruta | `git check-ignore` |
| Estado del índice y de HEAD sin cambios | `git status`, sin `add`, sin `commit` |

El resultado exacto de cada comprobación, con sus conteos, está en el informe local
`.acp-local/documentation-source-ready.md`.

### 7.1 Checkpoint histórico de consolidación documental

Root integró la redacción delegada a Claude y los controles de tres agentes
paralelos sobre arquitectura/rúbrica, requisitos/contratos y preparación de la
implementación. Los rechazos concretos de tablas se corrigieron antes de la
consolidación: no se tomó el `SOURCE_READY` del writer como aprobación.

- **23 documentos**, 99 casos de uso, 22 criterios transversales; los 71 criterios
  históricos conservan su mapeo a la rúbrica actual de 89 criterios.
- **39 packets** inventariados. La aprobación documental no concede
  `SCOPE_FROZEN` ni autoriza ejecutar el primero.
- Enlaces de archivos y referencias numeradas a secciones comprobados; ninguna
  ruta canónica ignorada ni enlace activo a los directorios retirados.
- Los agentes probaron restricciones de aprobación y de referencias/generaciones
  en SQLite en memoria. Root además extrajo los CHECK de aprobación de la hoja
  final y verificó **144 combinaciones: 6 admitidas y 138 rechazadas**, exit 0.
  Es una sonda de las restricciones documentadas, no una prueba del producto.
- **25/25 originales comparados byte a byte** con el backup antes de retirar las
  dos carpetas fechadas. HEAD e índice sin cambios; no hubo edición de código,
  commit, push ni intervención en repositorios de producto.

La validación es de consistencia, trazabilidad y preparación del plan. **No es una
garantía de ausencia de defectos ni la certificación del backend.** Los criterios
`UNKNOWN` siguen requiriendo las pruebas descritas en la rúbrica.

**Estas comprobaciones son documentales.** No son la compuerta de arquitectura, no
son la suite de tests y no validan ninguna implementación.

---

### 7.2 Reconsulta independiente del diseño consolidado

Después de aquel checkpoint se incorporaron la comparativa, la política de
composición y la [revisión externa K3 con tres lanes](review/index.md).
Ese documento conserva snapshot, modelos comprobados, veredicto, adjudicación
y límites. El conteo de 23 de §7.1 corresponde al checkpoint anterior, no a la
cantidad actual de archivos. Los documentos nuevos amplían el mismo canon;
no son un programa o una auditoría paralela que pueda gobernar por separado.

## 8. Límites declarados

- No se validó con ejecución cada uno de los 99 casos: se mapearon todos al plan.
- No se auditó ningún repositorio de producto, ningún módulo privado y ninguna
  credencial.
- No hay capturas nuevas ni calificación de interfaz visual.
- No se afirma «cero bugs», ni garantía universal de exactamente una ejecución, ni
  disponibilidad real de cuotas.
- No se ejecutó un smoke de proveedor mediante el producto auditado. Sí se
  utilizaron agentes de auditoría y redacción: esa actividad consume sus cuotas
  y no constituye evidencia de ejecución del Agent Control Plane.
- Esta documentación **no está admitida** por la lista exacta de rutas de la
  compuerta de arquitectura. Su admisión es un packet propio y explícito
  ([migración](../implementation/migration/index.md)); **no se modificó el checker
  para autoaprobarla**. La salida cero registrada en §3 es **anterior** a estos
  documentos y no se presenta como una comprobación posterior a la edición.
