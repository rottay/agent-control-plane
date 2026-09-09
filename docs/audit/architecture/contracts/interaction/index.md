# Interacción V1: avisos, espera, duelo y anomalías

Dueño del protocolo de H-6/H-8/H-9/H-11. La representación física vive en
[notifications](../../database/execution/notifications/index.md), [planning](../../database/planning/index.md)
y [execution](../../database/execution/index.md). Es diseño de P-30/P-28/P-35/P-34,
no evidencia de implementación ni autorización de gasto.

## 1. Tipos y políticas cerradas

Todos los objetos son estrictos, sin campos extra. v1 significa interaction_contract_version=1 en el payload; se conserva contract_version del envelope de evento y su cohorte.
Digest/fecha/entero/ref usan los tipos de base de datos: SHA canónico, UTC milisegundos e int64; los racionales se calculan con BigInt, no Number.
Una referencia autorizada a artefacto no se reemplaza por un digest. Policies usan POLICY_DOCUMENT; solicitudes/inputs y evidencia de esta familia usan PLAN_DOCUMENT/EVIDENCE, dentro del scope real admitido. Nada sensible aparece en trazas/SSE.

Un PolicyPinV1 contiene document_id, document_version INTEGER>=1, content_sha256, artifact_reference_id y registry_event (stream registry_events, sequence>0,sha256). Se valida contra ese documento y artefacto, no contra “latest”.
Cuatro document_kind nuevos del registry único: NOTIFICATION_POLICY, APPROVAL_WAIT_POLICY, DUEL_POLICY, ANOMALY_POLICY. Los posee observation/planning/planning/economy respectivamente. No son sinónimos de CAPABILITY_POLICY ni de ESTIMATION_POLICY.
Publicación y aprobación de policy mantienen autoridad/OCC del registry. La configuración pinneada gobierna la solicitud completa; una revisión posterior no modifica trabajo en vuelo. Los siguientes defaults sólo existen si el perfil publica una policy que los adopte explícitamente.

| Policy | Campos específicos V1 y límites | Perfil propuesto/adjudicado |
| --- | --- | --- |
| NOTIFICATION_POLICY | enabled boolean; recipient_operator_id de la identidad local del owner; adapter_id/version; rate_window_ms 1000..86400000; max_deliveries_per_window 1..1000; delivery_ttl_ms 1..86400000; rules 1..7 filas únicas por rule_id y kind; cada una enabled boolean, kind, quota_threshold_percent/exposure_threshold_percent nullable según kind; quota metric/unit o currency requeridas sólo para su regla | LOCAL_INBOX; ventana 60000; máximo1; TTL300000; umbrales cuota10/exposición80. Percentiles 0..100, no porcentajes de precisión inventada |
| APPROVAL_WAIT_POLICY | wait_timeout_ms INTEGER 1..2592000000 o NULL explícito; on_timeout literal CLOSE_WAIT; notification_rule_id nullable | timeout86400000; ninguna concesión automática |
| DUEL_POLICY | decision_mode literal QUALITY_ONLY; candidate_deadline_ms 1000..86400000; adjudicator_deadline_ms 1000..86400000; max_candidates literal2; max_attempts_per_candidate literal1; criteria_artifact_reference_id y criteria_sha256 | 300000/60000 ms; exactamente dos candidatos READ_ONLY y árbitro nativo independiente. QUALITY_AND_COST_REQUIRED no está admitido en V1 |
| ANOMALY_POLICY | metric, currency iff costo, CohortV1, window_ms>0, freshness_ms>0, min_samples>0, max_samples>=min_samples y <=10000, multiplier_numerator/denominator INTEGER>0, absolute_delta racional>=0, requested_action NOTIFY o PAUSE | ventana30d, frescura7d, mínimo20, máximo200, multiplier3/1, delta0, NOTIFY |

NoticeKindV1 = TASK_TERMINAL, APPROVAL_REQUIRED, ACCOUNT_QUOTA_LOW, QUOTA_UNKNOWN, BUDGET_EXPOSURE_HIGH, EXPOSURE_UNKNOWN, ANOMALY_DETECTED.
ActionHintV1 se deriva, no se configura con prosa: VIEW_RESULT, REVIEW_APPROVAL, REFRESH_QUOTA, REVIEW_BUDGET o VIEW_ANOMALY según kind. Plantilla versionada por adapter; no texto de modelo/error remoto crudo.
ACCOUNT_QUOTA_LOW exige quota_threshold_percent y quota metric/unit, exposure_threshold_percent/currency NULL. QUOTA_UNKNOWN exige metric/unit pero ambos thresholds/currency NULL. BUDGET_EXPOSURE_HIGH exige exposure_threshold_percent/currency, quota_threshold_percent/metric/unit NULL. EXPOSURE_UNKNOWN exige currency y los demás NULL. Las otras reglas tienen ambos thresholds y dimensiones NULL. Las de cuota fijan metric/unit de una misma observación; las de exposición fijan currency y la medida del reclamo admitido de P-34. Nunca mezclar monedas o REAL/EQUIVALENT.

## 2. H-6: decidir y entregar un aviso local

Único adapter funcional V1: LOCAL_INBOX, bandeja privada consultable por CLI/API local autenticada. No correo, webhook, escritorio ni nueva consola. DELIVERED significa durablemente disponible para ese owner, no visto/leído por una persona.
El renderer de terminal consume esa misma bandeja y no decide entrega. Su caída no cambia tareas, permisos, cuentas ni planes.

### 2.1 Predicados e identidad

ACCOUNT_QUOTA_LOW exige limit/remaining presentes y KNOWN en la misma observación/dimensión. Comparar 100*remaining <= threshold*limit con BigInt. limit=remaining=0 es agotamiento conocido sin dividir.
ESTIMATED/UNKNOWN no cumplen esa regla exacta. QUOTA_UNKNOWN es un diagnóstico propio del status real, no cuota cero ni auth fallida.
BUDGET_EXPOSURE_HIGH exige admitted_limit, spent_known y reserved_upper_bound comparables/conocidos; comparar 100*(spent_known+reserved_upper_bound) >= threshold*admitted_limit. Es exposición admitida, no facturación. UNKNOWN sólo puede disparar EXPOSURE_UNKNOWN.
Los otros kinds consumen su hecho durable exacto: terminal de tarea, solicitud de aprobación o anomalía. Una fuente corrupta/inexistente rechaza; no se convierte en diagnóstico válido.

Entrada NoticeInputV1: owner_stream/subject_kind/subject_id, recipient_operator_id, rule_id, kind, source_event (tripleta), PolicyPinV1 y account_id/model_version_id nullable. Se verifica pertenencia de la fuente al sujeto/dimensión real.
notice_id = SHA256(tuple("notice:v1",owner_stream,subject_id,source_stream,source_sequence,source_sha256,rule_id,recipient_operator_id)).
rate_identity_sha256 = SHA256(tuple("notice-rate:v1",owner_stream,subject_id,recipient_operator_id,rule_id,account_id,model_version_id)); NULL es JSON null canónico, no sentinel ni PK nullable.
Tuplas usan la canonicalización versionada del maestro. Misma identidad/payload → replay; distinta semántica bajo la misma clave → CONFLICT. No reexaminar eventos viejos con defaults nuevos sin una solicitud causal nueva explícita.

### 2.2 Transacción y rate, sin reset al cambiar policy

Dentro de BEGIN IMMEDIATE, comprobar expected head del sujeto, fuente, policy y autoridad; leer now del reloj local. Exigir now >= la cota durable MAX(evaluated_at) de notificaciones V1 del mismo owner_stream/subject_id. Si retrocede, NOTICE_CLOCK_UNTRUSTED; no inventar now=max(now,cota).
Registrar evaluated_at=now; window_start=floor(now_ms/rate_window_ms)*rate_window_ms, window_end=window_start+rate_window_ms.
Contar decisiones QUEUED de la misma rate_identity_sha256 con window_start <= evaluated_at < window_end, **independientemente** del bucket/policy que originó cada fila. Cambiar versión o ventana no reinicia ese conteo. Índice y lectura van al mismo watermark transaccional.
decision = DISABLED, NOT_TRIGGERED, UNKNOWN_SOURCE, SUPPRESSED_RATE o QUEUED según enabled, predicado y cupo. UNKNOWN_SOURCE en la regla numérica no impide que la regla diagnóstica distinta sobre esa fuente válida resulte QUEUED.
Persistir NOTIFICATION_DECISION_RECORDED. Sólo QUEUED agrega OUTBOX_COMMAND_INTENDED en el mismo appendBatch, con causalidad a la decisión. No hay un grant de rate guardado sólo en memoria.

El payload de decisión contiene exactamente NoticeInputV1 + notice_id, evaluated_at, window_start_at/window_end_at, rate_identity_sha256, decision, reason_code y command_id nullable; los enums/nulidades son los de notifications. reason_code se determina por la decisión, no es texto libre.
En account_events es una acción de máquina same-state, con CAS por versión, sidecar/cabeza/folds juntos. No autoriza DRAIN/login ni otra decisión del owner.

### 2.3 Reutilización exacta de B3

saga_id=notice_id; phase=NOTIFY; command_kind=NOTIFY; target_kind=LOCAL_INBOX; target_id=recipient_operator_id. command_id conserva la fórmula de [coordinación §6.2](../../database/coordination/index.md).
Payload específico del comando: notice_id, decision_event tripleta y PolicyPinV1, nada más. Intento/observación, row_version, encarnación, deadline y estados son B3, sin otra outbox.

LOCAL_INBOX llama al caso de uso acceptLocalNotification, que valida command/notice/recipient/hash y registra una única OUTBOX_DELIVERY_OBSERVED DELIVERED; ese mismo fold hace disponible la fila de notifications. Devuelve referencia durable del acuse. El relay reconoce ese acuse, no agrega otro con identidad/contenido distintos.
Tras ACK perdido, lookup por command_id/notice_id. Repetir no crea otro aviso ni cambia contenido. No se crea un inbox SQLite adicional: la bandeja es una consulta de la proyección del ledger.
Retry: máximo dos a 250/1000 ms, dentro de deadline, sólo si no-despacho o idempotencia del destino está comprobado. Unknown permanece RECONCILING; TTL no hace reintentable ni abandona una entrega incierta.
La tarea no espera al aviso. Una referencia privada se autoriza de nuevo al leer. Retención puede ocultar una fila en la vista, pero no borrar la evidencia/rate/cota temporal que el ledger reconstruye.

## 3. H-11: espera humana y primer hecho válido

WaitRequestV1: approval_id, sujeto/digest exactos y PolicyPinV1. Sólo crea una espera nueva sobre aprobación PENDING; una clave repetida devuelve la original.
wait_id = SHA256(tuple("approval-wait:v1",approval_id,subject_revision_sha256)).
deadline=min(requested_at+wait_timeout,owner_approval.expires_at) entre valores presentes; NULL sólo si ambos faltan explícitamente. Overflow o rango de fecha inválido rechaza.
timer_id = SHA256(tuple("approval-timer:v1",wait_id,deadline_at)), NULL iff deadline NULL.
APPROVAL_WAIT_REQUESTED incluye esos campos, iniciativa, evaluated_at/requested_at, deadline y timer_id. Estado inicial WAITING.

### 3.1 Orden durable, no reloj remoto

Dentro de BEGIN IMMEDIATE de iniciativa, now se compara con MAX(evaluated_at) de las esperas V1 de esa iniciativa, incluyendo las ya resueltas. Esa cota deriva de eventos y sobrevive rebuild/restart; no se crea una autoridad temporal global.
now<cota o reloj local no confiable → WAIT_CLOCK_UNTRUSTED. No usar max para inventar hora. Guardar evaluated_at=now con la decisión; no confiar en timestamp del caller.
Ese instante de admisión serializada es la frontera temporal. El ACK sale después del commit. No se promete el instante físico de fsync ni un reloj externo perfecto.
Grant y deny requieren approval PENDING, wait WAITING, sujeto/revisión/autoridad exactos, expected_version vigente y (deadline NULL o evaluated_at<deadline). Igualdad ya es tarde.
Timer requiere mismos wait/timer/deadline, WAITING y evaluated_at>=deadline. Tick temprano no vence nada. Gana el primer append válido en ese orden, no la señal que alega timestamp anterior.

### 3.2 Transiciones, replay y consumo

Solicitud de aprobación/espera se registra atómicamente. Driver P-22 reconstruye el timer durable desde ese hecho si pierde su cache.
GRANT/DENY y APPROVAL_WAIT_RESOLVED se anexan juntos con CAS de iniciativa; resolución GRANTED/DENIED. Timer ganador lleva aprobación pendiente a EXPIRED y wait a TIMED_OUT. Cancelación autorizada de ambas pendientes produce CANCELLED en ambas.
Payload RESOLVED: wait_id, approval_id, subject_revision_sha256, resolution GRANTED|DENIED|CANCELLED|TIMED_OUT, evaluated_at y source_event tripleta de la decisión/timer/cancelación; timer_id nullable según causa. No contiene permisos nuevos.
Después de grant, revocación usa REVOKED en owner_approval, preserva grant y wait terminal. El consumo vuelve a comprobar vigencia/revisión/autoridad. Un wait GRANTED no equivale a tarea ejecutada.
Misma clave/payload devuelve la decisión previa aun después del plazo; otra decisión bajo esa clave es conflicto. Rebuild aplica lo registrado sin reloj nuevo.
La señal sólo despierta un consumidor correlacionado por wait/approval/revisión. Cursor durable y catch-up encuentran resolución tras señal perdida; el scheduler reevalúa READY, presupuesto, revocación y checkpoint antes de dispatch. No agregar RESUME al enum de outbox.
Aviso tardío muestra estado vigente/histórico al leer; no reabre espera. Timeout/cancelación no borran checkpoint ni conceden nuevo ownership.

## 4. H-8: duelo técnico de dos modelos

DuelRequestV1: client_scope/key, iniciativa, shared_input_artifact_reference_id/hash, snapshot de autoridad/read-set/base, dos envelopes completos de candidato, PolicyPinV1, criteria ref/hash y adjudicator_identity. Todo artefacto es privado/autorizado.
V1 exige workspace_mode=READ_ONLY, commit_policy=NO_COMMIT, write-set vacío y tools read-only comprobadas. No crea worktrees ni escritura implícita. Los dos modelos/versiones resueltos deben ser distintos y no cambian por fallback/handoff silencioso.
Autorización de consumo y P-34/admisión cubren ambos candidatos y el árbitro. No hay monto monetario default; HARD_COST_BOUND sólo si es requerido y probado. Un perfil básico explícito puede admitir costo UNKNOWN, nunca anunciar un cap ficticio.
Árbitro nativo: worker distinto de ambos candidatos, ejecuta los checks pinneados; no requiere LLM. Compartir proveedor sólo produce recomendación, no elimina independencia de identidad.
CriteriaV1: lista 1..64 de check_id únicos, descriptor/version/digest del check ejecutable admitido, weight INTEGER>0 y required boolean. No código/predicado arbitrario dentro de policy. Todo check contribuye al score; UNDETERMINED nunca puntúa cero.

duel_id=SHA256(tuple("model-duel:v1",client_scope,client_request_key)); la solicitud completa se hashea/persiste por referencia. Replay igual/conflicto distinto siguen la sumisión normal.
Crear dos tareas reales de la misma iniciativa con claves derivadas (duel_id,1)/(duel_id,2). MODEL_DUEL_REQUESTED incluye header y ambas coordenadas task/revision, PolicyPinV1, criteria y source heads pinneados.
Header/candidatos/tareas e intenciones de presupuesto se anexan por appendBatch/CAS; los arbiters conceden luego por la saga. Fallo de una rama no libera débitos inciertos.
MODEL_DUEL_STARTED referencia aceptación durable del primer worker real de la operación; encolar no afirma RUNNING.
MODEL_DUEL_ADJUDICATION_STARTED registra la aceptación real del árbitro y adjudicator_deadline_at=su instante+timeout; se permite tras terminales de ambos candidatos o vencimiento candidato, sin relanzar faltantes.

### 4.1 Algoritmo QUALITY_ONLY

1. Esperar ambos terminales o deadline. Conservar resultados/checkpoints y consumo; cada candidato tiene un intento, sin retries ocultos.
2. Árbitro ejecuta exactamente la lista de checks para ambos resultados, o registra UNDETERMINED con evidencia de la imposibilidad. Cada check puntuable debe estar determinado; cualquier UNDETERMINED, resultado no recuperable o conformance/identidad no probada → INCONCLUSIVE.
3. Elegible = todos los required PASS. score=suma BigInt de weight de checks PASS. Overflow de salida int64 rechaza explícitamente.
4. Un solo elegible gana. Dos elegibles: score mayor gana; igualdad TIE. Ningún elegible: INCONCLUSIVE.
5. Recomputar scores desde evidencia pinneada antes de aceptar el veredicto. winner_task_id sólo puede ser uno de los dos candidatos.
6. Costo UNKNOWN **no** bloquea un ganador técnico QUALITY_ONLY si la admisión fue honesta/autorizada. Se conserva como UNKNOWN/exposición, nunca cero; no desempata, ni justifica recomendación económica o un límite que no se probó.
7. Checks, adjudicación y duelo SETTLED se vinculan por eventos; el append de adjudicación y SETTLED es atómico. Replay no reejecuta árbitro ni selecciona otro ganador.
8. Ganar no aplica un patch de la respuesta, no publica policy de routing y no ejecuta un plan nuevo. Cada una conserva su propia autorización.

MODEL_DUEL_CHECKS_RECORDED lleva duel_id, adjudicator_identity, criteria_sha256 y exactamente dos filas por check (candidate_number,check_id,weight,required,outcome,evidence_ref/hash). El header es autoridad de criterios; pesos adulterados o un tercer candidato rechazan.
MODEL_DUEL_RESOLVED referencia adjudication_id y su evento; el veredicto/ganador viven en adjudication_read_model, no se duplican en el header. Adjudicación INCONCLUSIVE también exige árbitro real/identidad/evidencia; un árbitro ausente deja el duelo sin resolver, no simula veredicto.

## 5. H-9: anomalía de consumo

Se reutiliza exclusivamente [CohortV1, fuentes, selección y upperRankQuantile](../estimation/index.md#3-fuentes-unidad-y-primitiva-compartida-con-h-9).
ANOMALY_POLICY fija sus parámetros/umbral, no redefine estadísticas. Cohorte/moneda/pines ausentes o mezclados no se adivinan. Observación actual puede ser parcial acumulada, pero asentada/atribuible; no se usa como muestra histórica terminada.
Métricas físicas TOTAL_TOKENS/EQUIVALENT_COST_NANOS/ACTIVE_WORK_SECONDS corresponden exactamente a total_tokens/equivalent_cost_nanos/active_work_seconds de esa primitiva. Costo usa racional exacto, no número redondeado.
Fuente/corte y evaluated_at se fijan antes del cálculo; ninguna lectura de “latest” durante rebuild. Elegir muestras según esa primitiva, excluyendo tarea sujeto; moneda sólo para costo.

AnomalyInputsV1: task/revision/attempt, metric/unit/currency, PolicyPinV1, cuatro source_heads, observed status/racional y proof_ref/hash, miembros seleccionados (ordinal,task/revision,value racional,completed_at,sample_proof_ref/hash), evaluated_at. Es un artefacto EVIDENCE autorizado; las partes consultables se proyectan en filas normalizadas.
source_cut_sha256=SHA256(tuple("anomaly-inputs:v1",contenido canónico íntegro de AnomalyInputsV1)); arrays en orden fijo de streams del maestro y ordinal de muestra; campos NULL explícitos. sample_proof se valida con la primitiva de estimación, no por confiar en su valor declarado.
anomaly_id=SHA256(tuple("anomaly:v1",task_id,revision_number,attempt_number,metric,policy_sha256,source_cut_sha256)).
Misma identidad/digest → replay; distinto resultado para esa identidad → conflicto.

### 5.1 Cálculo y acción

Si observado UNKNOWN, n<min_samples, fuente más reciente fuera de freshness, cohorte no disponible o unidad incompatible: UNDETERMINED, razón tipada, sin acción. No fabricar baseline cero.
baseline=upper median según la primitiva. threshold=baseline*multiplier_num/multiplier_den+absolute_delta. Comparar observed>threshold por racionales exactos; igualdad es NORMAL. Baseline conocido cero es válido y distinto de ausencia.
ANOMALY_EVALUATED incluye exactamente los campos del header, heads y muestras de execution, con referencias de inputs/policy; sampled values no se convierten en una autoridad de uso/costo.
action_key=SHA256(tuple("anomaly-action:v1",task_id,revision_number,attempt_number,metric,policy_document_id)). Una acción automática máxima por clave a través de cortes/versiones; no contador RAM. Un DETECTED posterior puede registrar requested_action=NONE porque la acción anterior ya existe.
DETECTED+acción nueva se admite bajo BEGIN IMMEDIATE del ledger con guard único. NOTIFY crea su decisión/comando H-6/B3 en el mismo append. PAUSE exige autoridad y capacidad comprobadas P-22; intención antes del pedido, no “PAUSED” antes del ack.
requested_action NONE|NOTIFY|PAUSE y action_state NOT_REQUESTED|REQUESTED|CONFIRMED|UNKNOWN son hechos distintos. ANOMALY_ACTION_OBSERVED lleva anomaly_id/action_key, estado y confirmation_event tripleta nullable. CONFIRMED sólo con evento que prueba aceptación local del aviso o quiescencia efectiva del intento correcto.
Unknown exige reconciliación; otra observación no reintenta ciegamente. PAUSE no soportado/denegado no cambia silenciosamente a NOTIFY. Reanudar, cambiar modelo/cuenta o ampliar presupuesto quedan fuera del detector.

## 6. Rechazos y negativos

Estos códigos nuevos son contextuales ADMISSION/PREFLIGHT/NOT_DISPATCHED; no agregan refusal_class:
REQUEST_INVALID/NONE: NOTICE_POLICY_INVALID, DUEL_REQUEST_INVALID, ANOMALY_POLICY_INVALID, WAIT_REQUEST_INVALID.
AUTHORITY_REFUSED/NONE: NOTICE_RECIPIENT_FORBIDDEN, DUEL_WRITE_FORBIDDEN, ANOMALY_ACTION_FORBIDDEN.
CAPABILITY_UNSUPPORTED/NONE: NOTICE_CHANNEL_UNSUPPORTED, DUEL_READ_ONLY_UNPROVEN, ANOMALY_PAUSE_UNPROVEN.
PRECONDITION_FAILED/WAIT_CONDITION: WAIT_CLOCK_UNTRUSTED, NOTICE_CLOCK_UNTRUSTED, SOURCE_CUT_UNAVAILABLE.
CAS/clave obsoleta usan conflictos existentes. Entrega/acción ya incierta conserva clase/fase/RECONCILE de contratos §16/B3, no se reetiqueta PREFLIGHT.
UNKNOWN_SOURCE/UNDETERMINED son resultados explícitos de cálculo; nunca auth fallida, costo cero o éxito.

| Negativo | Resultado exigido |
| --- | --- |
| Mismo aviso/payload o ACK perdido | lookup/replay del mismo notice; digest distinto CONFLICT |
| Último cupo concurrente; policy/ventana cambiada | contar el intervalo por identidad semántica, sin reset por versión/bucket; sólo admisiones dentro del cupo |
| Fuente de cuota incierta | diagnóstico real; no cifra exacta ni cambio administrativo |
| Adapter/render local ausente o aviso tardío | tarea y permiso no cambian; estado de entrega visible |
| Grant vs timer/cancelación | primer append válido; igualdad de deadline ya es tarde |
| ACK perdido de grant y retry tardío | grant original, no otro permiso |
| Reloj retrocede tras restart | rechazo contra cota durable; no MAX que invente hora |
| Rebuild de wait/notices | no reloj nuevo ni reenvío automático de inciertos |
| Revocación tras grant | historial preservado y dispatch rechazado al revalidar |
| Duelo con write-set, tool mutable, tercero o árbitro repetido | rechazo antes de efectos/adjudicación |
| Check opcional/puntuable UNDETERMINED | INCONCLUSIVE; no cero ni tie fabricado |
| Empate técnico con costos conocidos distintos | TIE, no desempate económico |
| Ganador técnico con costos UNKNOWN | ganador sólo QUALITY_ONLY con exposición visible; no cap/recomendación económica inventados |
| Árbitro no ejecutado | duelo no resuelto; no adjudicación PLAIN |
| Baseline ausente/insuficiente o mezcla de fuentes | UNDETERMINED sin acción |
| Baseline conocido cero o observed=threshold | comparación exacta; cero conocido no ausencia, igualdad no dispara |
| Repetir corte/anomalía o perder ack de acción | mismo guard; no repausa ni reenvío ciego |
| PAUSE sin autoridad/capacidad/ack | denegación/UNKNOWN, no PAUSED ficticio |

La entrega de diseño exige también los DDL y transacciones de las hojas dueñas; la implementación se prueba con procesos y gates del perfil, sin atribuir soporte a un mock.
