# Composición: selección compatible antes de ejecutar

[Integraciones](../index.md) · [Comparativa](../market/index.md) · [Contratos](../../contracts/index.md) · [Packets](../../../implementation/packets/index.md)

Dueño de la **política de solapamientos**. Diseño documental, no validador
implementado ni autorización de gasto. Amplía descriptores y packs respetando
[contratos §9](../../contracts/index.md). La traducción a schemas y persistencia
queda especificada en [contratos](contracts/index.md), [algoritmo y pruebas](validation/index.md)
y [diccionario de execution](../../database/execution/composition/index.md).
H-5 cierra como diseño adjudicado; la implementación y conformidad siguen pendientes.

## 1. Regla central

**Elegimos responsabilidades y alcances, no casillas de marcas.** Dos integraciones
instaladas no son dos integraciones ejecutándose. Cada plan resuelve qué utiliza
la iniciativa, la tarea y cada subpaso; el conflicto se evalúa en ese grafo, no
sobre toda la máquina.

Un framework ofrece varias funciones. Sólo activa las del perfil de su adapter,
con límites efectivos. Declarar «retry desactivado» sin comprobarlo no basta.

## 2. Formas de composición

| Forma | Regla | Ejemplo conceptual |
| --- | --- | --- |
| Exclusiva | un propietario activo por responsabilidad y scope | un driver gobierna scheduling y recuperación del mismo run |
| Delegada | un padre entrega un subtrabajo identificado y acotado, conservando autoridad y límites | harness dentro de un subpaso durable |
| Pipeline | operaciones distintas, con entradas/salidas y orden explícitos | retrieval → reranking → modelo |
| Observación | consumidores reciben hechos sin autoridad de ejecución | exporter de trazas desacoplado |

Se pueden usar modelos distintos por rol y motores distintos para tareas
independientes. Comparar dos modelos deliberadamente requiere dos efectos
identificados y presupuestados, no una ejecución accidental duplicada.

Responsabilidades que necesitan dueño:

- Planificar, despachar y recuperar el run y sus subtrabajos.
- Reintentar cada **efecto lógico**, incluidos retries ocultos del SDK/gateway/harness.
- Seleccionar modelo/cuenta y autorizar gasto. Un fallback delegado queda acotado
  y devuelve identidad/uso reales; no convierte una suscripción en gasto API sin permiso.
- Mantener cada tipo de estado: ledger, journal, memoria e índice son distintos.
- Aplicar permisos, cancelación, herramientas y publicación; ningún hijo amplía autoridad.

El padre puede reintentar **entrega o consulta** de un subtrabajo con identidad
estable, no volver a ejecutarlo como nuevo al perder un acuse. La incertidumbre
sigue [contratos §7](../../contracts/index.md).

## 3. Datos de la política

Se extienden los descriptores de [integraciones §4](../index.md), sin duplicar
ratings/precios del registry de modelos. La política necesita:

| Información | Para qué |
| --- | --- |
| Adapter, versión, perfil y digest de descriptor | fijar la implementación y funciones efectivas |
| Operaciones ofrecidas/requeridas, versiones y límites | detectar dependencias ausentes o incompatibles |
| Responsabilidades reclamadas/delegables y scopes | detectar doble ownership y herencia indebida |
| Retry, fallback, cancelación y checkpoint efectivos | descubrir comportamientos que se pisan aunque cambie la marca |
| Reglas versionadas y evidencia de composición | distinguir soporte, incompatibilidad y desconocimiento |
| Permisos, consumo y flujo de datos | impedir ampliar egress, autoridad o gasto |

Reglas generales por operación/responsabilidad; excepciones por adapter, versión,
perfil, motivo y evidencia. Nada de `if` de marcas esparcidos por el dominio. Los
IDs siguen abiertos; el vocabulario contractual, validado y exhaustivo.

No se prueba todo el producto cartesiano del mercado. Se certifican perfiles.
Conformidad individual no prueba delegación: interacciones de ownership, retry y
cancelación requieren drills de la pareja concreta.

## 4. Preflight antes del trabajo

Un mismo servicio de aplicación sirve a CLI, API y futura UI:

1. Leer revisiones concretas de plan, instalación, registry y política. Completar
   sólo defaults declarados; no instalar ni sustituir una selección explícita.
2. Resolver versiones/perfiles y dependencias/scopes. Detectar ciclos, capacidades
   ausentes y contratos incompatibles.
3. Asignar responsables y validar exclusividad, delegación, permisos, datos y
   presupuesto en **todas las capas**.
4. Emitir diagnóstico determinista, **sin LLM**: regla, participantes, scope,
   motivo y corrección. Incompatibilidad y falta de evidencia son resultados
   distintos; ninguno se oculta como un error genérico de cuenta.
5. Si es admisible, producir snapshot inmutable y digest de composición vinculado
   a la revisión/política autorizadas y al intento/segmento pertinente. Sin
   credenciales ni prompts. No modifica la preimagen del envelope ni mete allí
   la cuenta resuelta, cuya identidad es separada.
6. Al despachar, revalidar snapshot y adquirir reservas/leases existentes. **Un
   preflight verde no es un lock.** Cambios relevantes de versión, permisos,
   selección o evidencia invalidan el plan; cuota y ownership se verifican vivos.
   Un cambio ajeno al perfil no invalida todo el sistema.

Una selección incompatible o no comprobada no inicia efectos de proveedores,
herramientas ni cobros. El diagnóstico puede persistirse como estado interno.
Una integración opcional se omite sólo si el perfil permite su ausencia y la tarea
no la requiere. No hay degradación silenciosa.

Cambiar la composición durante un run requiere frontera segura y el protocolo
existente de continuidad; cambiar un checkbox no autoriza migración en vivo.

## 5. Ejemplos

Decisiones de diseño condicionadas a perfiles certificados, **no soporte actual**.

| Selección | Decisión propuesta | Motivo/corrección |
| --- | --- | --- |
| Restate + Temporal gobernando el mismo run | bloquear | elegir uno; el otro puede quedar instalado o servir a otra tarea |
| Restate + LangGraph como harness acotado | sólo con perfil probado | identidad, journal, cancelación, presupuesto y retry delimitados; sin delegación compatible, rechazar |
| CrewAI + otro framework coordinando el mismo equipo | bloquear | elegir coordinador; equipo hijo sólo con delegación probada |
| ACP elige modelo y LiteLLM aplica fallback oculto | bloquear | desactivarlo o declararlo/acotarlo; identidad y costo corresponden al destino real |
| LlamaIndex + Qdrant | complementarios bajo compatibilidad comprobada | pipeline y backend de retrieval; no compiten por el ledger |
| MCP + A2A + AG-UI | sin exclusión por nombre | distintas fronteras; validar permisos y contratos de cada una |
| Phoenix + otro receptor de telemetría | uno por defecto; fanout explícito | controlar egress, colas y costos; evitar doble ingesta y doble conteo |
| Memoria del framework + servicio de memoria | depende de rol/scope | memoria de trabajo y persistente pueden coexistir; dos autoridades del mismo estado sin reconciliación, no |
| Dos modelos para roles diferentes | permitir dentro de recursos y autoridad | pertenecer a la misma familia no crea conflicto |

## 6. Experiencia de selección

Perfiles iniciales claros evitan pedir quince decisiones para una tarea sencilla.
El modo avanzado muestra responsabilidades y motivos. En la futura UI, una opción
excluida aparece deshabilitada **con explicación** y posibilidad de reemplazo, no
desaparece. CLI/API devuelven el mismo diagnóstico; no se implementa UI ahora.

Se distingue: disponible para instalar, instalado, seleccionable para esta tarea
y soportado/probado bajo este perfil. No cambiar la selección por el usuario.

## 7. Incorporación al plan

Concreta X01/X06/X12 en M7/P-23 y certificación P-39. No agrega frameworks
obligatorios. La identidad lógica y continuidad mínima pertenecen a P-18/M4:
no deben esperar al solver. La comprobación pura compartida de garantías se
entrega en P-23/garantías antes de presupuesto y equipos; el solver de grafo
completo conserva su cierre propio. Ver [orden y concurrencia](../../../roadmap/parallelism/index.md).
Pruebas: [tests §3.1](../../../quality/testing/index.md) y [negativos de composición](validation/index.md).

El run V1 usa invocationId único por tarea/revisión/intento; no es un ID interno
de Restate/Temporal ni un wrapper de varias tareas. La identidad lógica de un
efecto sobrevive al handoff sin alterar su effect_id inicial. No se implementa
migración en caliente del journal ni expansión dinámica de la autoridad.

Una CLI opaca puede ejecutar una invocación básica probada: no se exige observar
cada llamada LLM interna. Lo que no puede probarse permanece UNKNOWN y no se
anuncia como presupuesto duro o no-duplicación interna. Una garantía requerida
sin evidencia bloquea ese pedido; no prohíbe toda la familia ni se convierte en soft.

## 8. Responsabilidades y estructura objetivo

Rutas bajo packages/: propuestas de destino, no archivos creados ni write-set
autorizado. Se concretan contra el preestado al asignar el packet.

| Responsabilidad | Dueño y forma |
| --- | --- |
| Contratos persistidos y vocabularios | kernel/contracts/src/schemas/composition/{vocabulary,types,schema}/index.ts |
| Política determinista y consulta de preflight | domains/planning/src/model/composition/policy/index.ts y usecases/queries/composition/preflight/index.ts |
| Interfaces de lectura/evaluación | ports/composition/index.ts del contexto; tipos internos en model/composition/types/index.ts |
| Binding y consumo antes de despacho | domains/runtime/src/usecases/mutations/composition/{record,bind}/index.ts |
| Migraciones, folds y consultas normalizadas | persistence/ledger/src/log/migrations/index.ts y projections/composition/&lt;concepto&gt;/index.ts |
| Prueba del SDK y configuración efectiva | edge de cada familia; ningún SDK en kernel o dominios |
| Inyección, no lógica ni nueva autoridad | composition root del daemon y puertas existentes |

Planning no importa runtime/persistence; runtime recibe el puerto de evaluación
conectado por el root. Schemas/códigos tienen un solo dueño compartido. Accounts
mantiene el catálogo de modelos/capacidades; economy, precios y gasto. El perfil
de integración no duplica ratings, credenciales ni elegibilidad.
Tipos/interfaces van en types/ o ports/, vocabularios en vocabulary/, conducta
separada. Tests bajo test/ replican la ruta relativa y terminan en index.test.ts.
No añadir un archivo gigante ni un segundo registry para resolver esta extensión.
