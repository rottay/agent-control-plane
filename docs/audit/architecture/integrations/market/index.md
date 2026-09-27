# Ecosistema de agentes: comparativa y encaje

[Integraciones](../index.md) · [Composición](../composition/index.md) · [Índice](../../../README.md)

Dueño de la **comparativa externa** discutida con el owner. No es una lista de
dependencias por instalar. El estado del repositorio y las garantías de soporte
viven únicamente en [integraciones §2–3](../index.md).

## 1. Posicionamiento

ACP busca operar equipos de agentes: recibir objetivos, distribuir responsabilidades,
elegir modelos y cuentas, aplicar permisos y presupuestos, continuar tras fallos,
verificar resultados y conservar evidencia. Los frameworks pueden ejecutar partes
del trabajo bajo contratos propios del plane.

La diferenciación buscada combina suscripciones CLI, API y modelos locales con
continuidad, cuentas, gobernanza y resultados medidos. No son capacidades exclusivas:
varias herramientas ya incluyen planificación, memoria, permisos o evaluación.
**ACP no reemplaza la suma de todas ellas.** Debe demostrar interoperabilidad real,
no una colección de logos o interfaces sin consumidor.

## 2. Comparativa

Agrupaciones por necesidad, no nuevas familias contractuales ni un catálogo
exhaustivo de marcas. «Encaje» referencia las diecinueve de
[integraciones §3](../index.md). Comparativa ampliada documentalmente el 2026-09-26
con fuentes oficiales enlazadas; no constituye revalidación de versiones instaladas
ni de cada producto en esa fecha. Fijar fuente/fecha, versión, operación, transporte
y perfil al evaluar un adapter. La muestra laboral de §3 conserva su fecha y alcance.
Producto alojado, protocolo, librería y servicio no son todos «frameworks».
Incluir un nombre no lo selecciona, instala ni demuestra soporte en ACP.

| Área | Ejemplos y fuentes | Función | Encaje previsto y posible solapamiento |
| --- | --- | --- | --- |
| Fuente y transporte del modelo | CLIs de suscripción, API y endpoints locales; [Ollama](https://docs.ollama.com/), [vLLM](https://docs.vllm.ai/en/latest/) | acceder al modelo por una cuenta/ruta concreta | familias 1–2/12: cuenta no es modelo ni harness; una suscripción no concede API/SDK ni fallback pagado; ubicación y capacidades se verifican por perfil |
| Construcción de agentes | [LangChain](https://docs.langchain.com/oss/python/langchain/overview), [Pydantic AI](https://pydantic.dev/docs/ai/overview/), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | modelos, herramientas, salidas estructuradas y bucles de agente | familias 1–3: harness/adapter opcional, sin tipos del SDK en el dominio; transporte, tracing y herramientas requieren perfil explícito |
| Grafos y equipos | [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview), [CrewAI](https://docs.crewai.com/), [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/) | flujos, coordinación, estado y equipos multiagente | familias 3–5: solapamiento real; delimitar quién coordina el run y los subpasos |
| Ejecución durable | [Restate](https://docs.restate.dev/), [Temporal](https://docs.temporal.io/workflow-execution), [DBOS](https://docs.dbos.dev/) | progreso persistente, recuperación, timers y coordinación bajo contratos distintos | familia 4: un driver seleccionado por run; no dos dueños de su recuperación |
| Eventos, jobs y colas | [Inngest](https://www.inngest.com/docs), [Trigger.dev](https://trigger.dev/docs/introduction), [Hatchet](https://docs.hatchet.run/home), [BullMQ](https://docs.bullmq.io/) | disparar y repartir trabajo con garantías diferentes | familias 4/18 y trabajo delegado: cola no equivale a motor durable completo; delimitar retry, deduplicación y efectos |
| Pipelines de datos | [Prefect](https://docs.prefect.io/v3/get-started), [Dagster](https://docs.dagster.io/) | ingestión, transformación y linaje | familias 4/10: pueden reconstruir un corpus en alcance separado; no segundo dueño del run de agentes |
| Durabilidad gestionada | [Cloudflare Workflows](https://developers.cloudflare.com/workflows/), [Vercel Workflows](https://vercel.com/docs/workflows), [AWS durable execution](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-sdk.html), [Azure Durable Task](https://learn.microsoft.com/en-us/azure/durable-task/scheduler/durable-task-scheduler) | ejecución durable ligada a una plataforma | familia 4: evaluar región, retención, operación y costo; no portabilidad automática ni adapter seleccionado |
| Despliegue de agentes | [LangSmith Deployment](https://docs.langchain.com/langsmith/deployment) | entorno de servicio con hilos/runs propios | familias 3–5: mapear identidad/continuidad al historial ACP, no importar su autoridad |
| RAG y conocimiento | [LlamaIndex](https://developers.llamaindex.ai/python/framework/), [Haystack](https://docs.haystack.deepset.ai/docs/intro) | ingestión, retrieval y respuestas apoyadas en documentos | familia 10: pack opcional; un checkpoint no es RAG |
| Búsqueda vectorial y grafos | [pgvector](https://github.com/pgvector/pgvector), [Qdrant](https://qdrant.tech/documentation/overview/), [Pinecone](https://docs.pinecone.io/guides/index-data/indexing-overview), [Weaviate](https://docs.weaviate.io/weaviate), [Neo4j](https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/vector-indexes/) | índices semánticos, híbridos o relaciones para retrieval | familia 10: backends de conocimiento, no sustitutos automáticos del ledger; acceso al índice no concede acceso al documento |
| Memoria | [Mem0](https://docs.mem0.ai/introduction), [Graphiti/Zep](https://help.getzep.com/graphiti/getting-started/overview) y alternativas | recuerdos reutilizables con selección y alcance | familias 9–10: distinguir memoria, historial, artefactos e índices; aislamiento por iniciativa, no almacenar aquí aprobaciones ni ledger |
| Gateway de modelos | [LiteLLM](https://docs.litellm.ai/), [OpenRouter](https://openrouter.ai/docs/guides/routing/provider-selection) | proxy o servicio alojado de acceso a APIs/routing | familias 1–2 y 13: transporte posible; evitar una segunda selección/fallback/contabilidad oculta |
| Selección y optimización | [Jev/TypeSafe](https://docs.typesafe.ai/introduction), [Laya](https://huggingface.co/convaiinnovations/laya), reglas/manual; [DSPy](https://dspy.ai/current/) para programas/prompts | elegir candidato admisible o, por otro contrato, optimizar con dataset/métrica | familias 13/15: [Jev/Laya §8](../index.md#8-decisiones-delegadas) conservan sus gates; DSPy no es planner universal ni reemplaza autoridad; costo de decidir separado del de trabajar |
| Serving local o propio | Ollama, [vLLM](https://docs.vllm.ai/en/latest/); O2 | servir modelos en infraestructura elegida | familias 1–2: ejecución local/self-hosted, no entrenamiento de modelos |
| Observabilidad | [LangSmith](https://docs.langchain.com/langsmith/home), [Langfuse](https://langfuse.com/docs), [Phoenix](https://arize.com/docs/phoenix), [Braintrust](https://www.braintrust.dev/docs); [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/), [GenAI](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md), [OpenInference](https://github.com/Arize-ai/openinference); Logfire pendiente de verificación específica | esquemas/instrumentación y receptores de trazas/métricas; varias plataformas ofrecen prompts/evals | familia 14: no son equivalentes; fijar versión de esquema; Phoenix inicial opcional no se sustituye por esta lista; fanout/egress explícitos, no doble ledger |
| Evaluación y red-team | [Inspect](https://inspect.aisi.org.uk/), [Promptfoo](https://www.promptfoo.dev/docs/intro/), [Ragas](https://docs.ragas.io/en/stable/), [DeepEval](https://deepeval.com/docs/getting-started), [TruLens](https://www.trulens.org/) | medir calidad, comparar comportamiento y probar ataques con casos/jueces distintos | familia 15: dataset, incertidumbre, modelo juez y costo; evidencia no es aprobación automática ni otro registry |
| Protocolos | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), [A2A](https://a2a-protocol.org/latest/specification/), [AG-UI](https://docs.ag-ui.com/introduction) | herramientas/datos, agente-agente y agente-interfaz, respectivamente | familias 6–7 y superficies: complementarios, implementar uno no implementa los demás |
| Automatización de negocio | [n8n](https://n8n.io/); O7 | flujos visuales, conectores y automatizaciones | entrada/salida externa o subtrabajo delegado; competencia parcial, no clonar todo su catálogo |
| Interfaces de IA | [Vercel AI SDK](https://ai-sdk.dev/), AG-UI | interacción y streaming; AI SDK también tiene funciones servidor | superficies y, según uso, ejecución de modelos; UI posterior, no autoridad de permisos |
| Voz y tiempo real | [LiveKit Agents](https://docs.livekit.io/agents/), [Pipecat](https://docs.pipecat.ai/), [Vapi](https://docs.vapi.ai/), [Retell](https://docs.retellai.com/); [Deepgram](https://developers.deepgram.com/docs), [ElevenLabs](https://elevenlabs.io/docs) | orquestación de sesiones, plataformas alojadas y componentes STT/TTS con scopes diferentes | familia 19: sólo [captura/STT/texto](../index.md#52-captura-y-transcripción-de-voz-seleccionadas) seleccionado planificadamente; lista no selecciona proveedor, TTS ni realtime; no intercambiables uno a uno |
| Guardrails | [NeMo Guardrails](https://docs.nvidia.com/nemo/guardrails/about-nemo-guardrails-library/overview) y políticas equivalentes | controles conversacionales y de contenido | familias 3, 6 y 16: complementan permisos y sandbox efectivos, no los sustituyen |
| Aislamiento | [gVisor](https://gvisor.dev/docs/), [E2B](https://e2b.dev/docs), [Modal Sandboxes](https://modal.com/docs/guide/sandbox) | aislamiento o entornos de ejecución con garantías distintas | familia 16: probar red, secretos, recursos y recovery del perfil concreto; elegir un nombre no confina ACP |

También se contemplan [Google ADK](https://adk.dev/), [Mastra](https://mastra.ai/docs)
y [Agno](https://docs.agno.com/) como alternativas de construcción/orquestación.
Mencionarlas no afirma demanda laboral equivalente. AutoGen y Semantic Kernel
aparecen en búsquedas y código existente; Microsoft presenta Agent Framework como
su sucesor en la fuente oficial enlazada. LangChain distingue además framework,
runtime LangGraph, harness Deep Agents y plataforma LangSmith: no son sinónimos.

## 3. Evidencia de mercado

Muestra pública consultada el **2026-09-08**, no un censo ni una medición de
frecuencia. La fecha es metadata de evidencia; se actualiza esta página sin crear
otra carpeta fechada. Las ofertas pueden desaparecer.

| Ref | Fuente del empleador | Qué sustenta |
| --- | --- | --- |
| O1 | [Acquia — Staff AI Engineer](https://job-boards.greenhouse.io/acquia/jobs/8134340) | LangGraph, Temporal, Pydantic, Langfuse, frameworks y fiabilidad |
| O2 | [Axle — Agentic AI Systems](https://job-boards.greenhouse.io/axle/jobs/5222609007) | frameworks, MCP, observabilidad, Ollama, vLLM y LiteLLM |
| O3 | [Instructure — evaluaciones](https://jobs.ashbyhq.com/instructure/22f68cff-1a65-4c41-a336-0cf203b0cac5) | LangSmith, Braintrust, Ragas y Promptfoo |
| O4 | [Tekion — evaluación de IA](https://jobs.ashbyhq.com/tekion/23d808f1-cbb4-4134-9da7-c344671975c4) | Ragas, DeepEval, LangSmith, TruLens, Promptfoo y seguimiento experimental |
| O5 | [Lynx Analytics](https://job-boards.greenhouse.io/lynxanalytics/jobs/8647264002) | RAG, GraphRAG, Neo4j y búsqueda vectorial |
| O6 | [Ombud](https://job-boards.greenhouse.io/ombud/jobs/8599080002) | Qdrant, Pinecone y Weaviate |
| O7 | [8th Light](https://job-boards.greenhouse.io/8thlightrebuild/jobs/7807567003) | frameworks de agentes y n8n |
| O8 | [Arbor](https://jobs.ashbyhq.com/findarbor/ef6674a7-dd1e-4a3e-ab4b-58bd05a2cf98), [Jupus](https://jobs.ashbyhq.com/jupus/e1036acc-a0fe-4b2f-a95f-744c51175e1d) | LiveKit, Pipecat, Deepgram, ElevenLabs, Vapi y Retell |

Las ofertas sustentan presencia en búsquedas; las fuentes oficiales, funcionalidad.
**Ninguna prueba que ACP ya lo tenga implementado.** También se piden lenguajes,
cloud, SQL, contenedores, CI y fundamentos de sistemas: las integraciones no
sustituyen esas capacidades ni convierten MLOps o entrenamiento en alcance automático.

## 4. Uso para planificación

Partir del caso de uso, mapear operaciones al contrato existente y examinar la
[composición](../composition/index.md). Elegir una primera integración real;
una segunda requiere beneficio concreto y pruebas. Publicar soporte por versión,
operación, transporte y perfil, no una casilla universal «integrado».

La promesa es **elegir entre integraciones soportadas**, no «todo está integrado
porque existe una abstracción». Revisar capacidades al actualizar adapters no
requiere repetir automáticamente toda la investigación del mercado.

La guía parte de cuenta/fuente y modelo, distingue harness, driver durable,
decision provider, RAG/índice, tools y calidad, y termina en proyecto → equipo →
feature/paso → costo/evidencia. Hereda defaults con procedencia y autorización
fresca, sin exigir agregar un framework a la ruta mínima que no lo necesita.
Las familias e IDs de adapters son extensibles; operaciones, errores y schemas
permanecen cerrados/versionados. No se promete adapter para cada marca.

Separar información de mercado, selección propuesta, adapter instalado y perfil
operativo verificado. Comparar «ya incluido», complemento, alternativa, conflicto
comprobado, requisito/adapter faltante y no verificado. LangChain/LangGraph no se
piden como dos requisitos independientes; RAG más índice no exige dos vector
stores; MCP/A2A/AG-UI no se habilitan mutuamente. Dos dueños del mismo
retry/checkpoint/efecto requieren delegación probada; misma familia permite scopes
independientes. No inferir ACL ausente, exclusividad por vendor o compatibilidad
universal del silencio de una fuente.

Uso/cuota de suscripción, API, infraestructura, decisión/optimización, evaluación
y telemetría se muestran separados; UNKNOWN no es cero. Exportar un costo no lo
suma otra vez al ledger. Ahorro/velocidad/rigor son alternativas con supuestos,
no garantías. El catálogo no sustituye la propuesta concreta, su diff ni los gates
de soporte; planner amplio y voz real requieren sus contratos antes de código.
