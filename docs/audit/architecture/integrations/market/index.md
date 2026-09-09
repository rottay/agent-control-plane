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

Son quince agrupaciones de mercado, no quince nuevas familias internas. «Encaje»
referencia las diecinueve de [integraciones §3](../index.md). Los ejemplos no son
exhaustivos ni un ranking de popularidad; tampoco están todos implementados en ACP.

| Área | Ejemplos y fuentes | Función | Encaje previsto y posible solapamiento |
| --- | --- | --- | --- |
| Construcción de agentes | [LangChain](https://docs.langchain.com/oss/python/langchain/overview), [Pydantic AI](https://pydantic.dev/docs/ai/overview/), SDKs de proveedores | modelos, herramientas, salidas estructuradas y bucles de agente | familias 1–3: harness/adapter opcional, sin tipos del SDK en el dominio |
| Grafos y equipos | [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview), [CrewAI](https://docs.crewai.com/), [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/) | flujos, coordinación, estado y equipos multiagente | familias 3–5: solapamiento real; delimitar quién coordina el run y los subpasos |
| Ejecución durable | [Restate](https://docs.restate.dev/), [Temporal](https://docs.temporal.io/workflow-execution) | progreso persistente, recuperación, timers y coordinación | familia 4: un driver seleccionado por run; no dos dueños de su recuperación |
| RAG y conocimiento | [LlamaIndex](https://developers.llamaindex.ai/python/framework/), [Haystack](https://docs.haystack.deepset.ai/docs/intro) | ingestión, retrieval y respuestas apoyadas en documentos | familia 10: pack opcional; un checkpoint no es RAG |
| Búsqueda vectorial y grafos | pgvector, Qdrant, Pinecone, Weaviate, Neo4j; ofertas O5–O6 | índices semánticos, híbridos o relaciones para retrieval | familia 10: backends de conocimiento, no sustitutos automáticos del ledger transaccional |
| Memoria | [Mem0](https://docs.mem0.ai/introduction) y alternativas | recuerdos reutilizables con selección y alcance | familias 9–10: distinguir memoria, historial, artefactos e índices; aislamiento por iniciativa |
| Gateway de modelos | [LiteLLM](https://docs.litellm.ai/) | acceso a APIs, routing y controles operativos | familias 1–2 y 13: transporte posible; evitar una segunda selección/fallback/contabilidad oculta |
| Serving local o propio | Ollama, [vLLM](https://docs.vllm.ai/en/latest/); O2 | servir modelos en infraestructura elegida | familias 1–2: ejecución local/self-hosted, no entrenamiento de modelos |
| Observabilidad | LangSmith, Langfuse, Phoenix, Braintrust, Logfire; [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/); O1–O4 | trazas, métricas y diagnóstico; varias plataformas también ofrecen prompts/evals | familia 14: formato neutral, Phoenix inicial opcional; no todas sus funciones son equivalentes |
| Evaluación y red-team | [Promptfoo](https://www.promptfoo.dev/docs/intro/), Ragas, DeepEval, TruLens; O3–O4 | medir calidad, comparar comportamiento y probar ataques | familia 15: evaluadores externos publican evidencia, no otro registry de modelos |
| Protocolos | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), [A2A](https://a2a-protocol.org/latest/specification/), [AG-UI](https://docs.ag-ui.com/introduction) | herramientas/datos, agente-agente y agente-interfaz, respectivamente | familias 6–7 y superficies: complementarios, implementar uno no implementa los demás |
| Automatización de negocio | [n8n](https://n8n.io/); O7 | flujos visuales, conectores y automatizaciones | entrada/salida externa o subtrabajo delegado; competencia parcial, no clonar todo su catálogo |
| Interfaces de IA | [Vercel AI SDK](https://ai-sdk.dev/), AG-UI | interacción y streaming; AI SDK también tiene funciones servidor | superficies y, según uso, ejecución de modelos; UI posterior, no autoridad de permisos |
| Voz y tiempo real | LiveKit, Pipecat, Deepgram, ElevenLabs, Vapi, Retell; O8 | sesiones de audio, STT, TTS y agentes de voz | familia 19: pack propio; no todos son intercambiables uno a uno |
| Guardrails | [NeMo Guardrails](https://docs.nvidia.com/nemo/guardrails/about-nemo-guardrails-library/overview) y políticas equivalentes | controles conversacionales y de contenido | familias 3, 6 y 16: complementan permisos y sandbox efectivos, no los sustituyen |

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
