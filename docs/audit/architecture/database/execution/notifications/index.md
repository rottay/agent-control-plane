# Notificaciones: decisión y bandeja local reconstruibles

Dueño del diccionario físico de avisos de observation. El protocolo vive en
[interacción §2](../../../contracts/interaction/index.md); entrega/CAS/encarnaciones
siguen en [coordinación §6](../../coordination/index.md). Esta hoja no crea otra outbox.

## 1. notification_read_model

Nueva, no existe en el baseline. Es proyección de NOTIFICATION_DECISION_RECORDED
y de los tres eventos B3 del mismo stream/sujeto real. El registry sólo aporta
policy y causalidad; no aloja intenciones operativas. Particiones por owner_stream, con causalidad de los cuatro streams y sidecar
de cuentas verificado; su regla de publicación se fija en §2.1.

El SQL siguiente es completo para las tablas nuevas, sin defaults implícitos.
Los CHECK de fecha fijan representación; el schema de admisión exige además que
parsear y volver a serializar produzca exactamente la misma fecha UTC válida.
Cada referencia a policy exige documento/version/digest/artefacto coincidentes.
FK sólo entre tablas de la misma cohorte; las referencias cross-stream/artefactos
son tipadas y se validan antes del append y durante rebuild. No FK al outbox.
No se ejecuta este DDL contra el checkout vivo ni se reescriben migraciones aplicadas.

```sql
CREATE TABLE notification_read_model (
  notice_id TEXT NOT NULL CONSTRAINT ck_notification_read_model__notice_id CHECK (length(notice_id) = 64 AND notice_id NOT GLOB '*[^0-9a-f]*'),
  owner_stream TEXT NOT NULL CONSTRAINT ck_notification_read_model__owner_stream CHECK (owner_stream IN ('control_plane_events','initiative_events','account_events')),
  subject_kind TEXT NOT NULL CONSTRAINT ck_notification_read_model__subject_kind CHECK (subject_kind IN ('TASK','INITIATIVE','ACCOUNT')),
  subject_id TEXT NOT NULL CONSTRAINT ck_notification_read_model__subject_id CHECK (length(subject_id) > 0),
  recipient_operator_id TEXT NOT NULL CONSTRAINT ck_notification_read_model__recipient_operator_id CHECK (length(recipient_operator_id) > 0),
  rule_id TEXT NOT NULL CONSTRAINT ck_notification_read_model__rule_id CHECK (length(rule_id) > 0),
  kind TEXT NOT NULL CONSTRAINT ck_notification_read_model__kind CHECK (kind IN ('TASK_TERMINAL','APPROVAL_REQUIRED','ACCOUNT_QUOTA_LOW','QUOTA_UNKNOWN','BUDGET_EXPOSURE_HIGH','EXPOSURE_UNKNOWN','ANOMALY_DETECTED')),
  decision TEXT NOT NULL CONSTRAINT ck_notification_read_model__decision CHECK (decision IN ('QUEUED','SUPPRESSED_RATE','NOT_TRIGGERED','UNKNOWN_SOURCE','DISABLED')),
  reason_code TEXT NOT NULL CONSTRAINT ck_notification_read_model__reason_code CHECK (reason_code IN ('MATCHED','NOT_MATCHED','VALUE_UNKNOWN','VALUE_ESTIMATED','RATE_LIMITED','POLICY_DISABLED')),
  source_stream TEXT NOT NULL CONSTRAINT ck_notification_read_model__source_stream CHECK (source_stream IN ('control_plane_events','initiative_events','account_events','registry_events')),
  source_sequence INTEGER NOT NULL CONSTRAINT ck_notification_read_model__source_sequence CHECK (typeof(source_sequence) = 'integer' AND source_sequence >= 1),
  source_sha256 TEXT NOT NULL CONSTRAINT ck_notification_read_model__source_sha256 CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_document_id TEXT NOT NULL CONSTRAINT ck_notification_read_model__policy_document_id CHECK (length(policy_document_id) > 0),
  policy_version INTEGER NOT NULL CONSTRAINT ck_notification_read_model__policy_version CHECK (typeof(policy_version) = 'integer' AND policy_version >= 1),
  policy_sha256 TEXT NOT NULL CONSTRAINT ck_notification_read_model__policy_sha256 CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_artifact_reference_id TEXT NOT NULL CONSTRAINT ck_notification_read_model__policy_artifact_reference_id CHECK (length(policy_artifact_reference_id) > 0),
  evaluated_at TEXT NOT NULL CONSTRAINT ck_notification_read_model__evaluated_at CHECK (length(evaluated_at) = 24 AND evaluated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  rate_identity_sha256 TEXT NOT NULL CONSTRAINT ck_notification_read_model__rate_identity_sha256 CHECK (length(rate_identity_sha256) = 64 AND rate_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
  window_start_at TEXT NOT NULL CONSTRAINT ck_notification_read_model__window_start_at CHECK (length(window_start_at) = 24 AND window_start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  window_end_at TEXT NOT NULL CONSTRAINT ck_notification_read_model__window_end_at CHECK (length(window_end_at) = 24 AND window_end_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  account_id TEXT CONSTRAINT ck_notification_read_model__account_id CHECK (account_id IS NULL OR (length(account_id) > 0)),
  model_version_id TEXT CONSTRAINT ck_notification_read_model__model_version_id CHECK (model_version_id IS NULL OR (length(model_version_id) > 0)),
  command_id TEXT CONSTRAINT ck_notification_read_model__command_id CHECK (command_id IS NULL OR (length(command_id) > 0)),
  delivery_state TEXT CONSTRAINT ck_notification_read_model__delivery_state CHECK (delivery_state IS NULL OR (delivery_state IN ('PENDING','INFLIGHT','RECONCILING','DELIVERED','FAILED_RETRYABLE','FAILED_TERMINAL','ABANDONED'))),
  available_at TEXT CONSTRAINT ck_notification_read_model__available_at CHECK (available_at IS NULL OR (length(available_at) = 24 AND available_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')),
  sequence INTEGER NOT NULL CONSTRAINT ck_notification_read_model__sequence CHECK (typeof(sequence) = 'integer' AND sequence >= 1),
  CONSTRAINT pk_notification_read_model PRIMARY KEY (notice_id),
  CONSTRAINT ux_notification_read_model__origin UNIQUE (owner_stream,subject_id,source_stream,source_sequence,rule_id,recipient_operator_id),
  CONSTRAINT ck_notification_read_model__owner CHECK ((owner_stream='control_plane_events' AND subject_kind='TASK') OR (owner_stream='initiative_events' AND subject_kind='INITIATIVE') OR (owner_stream='account_events' AND subject_kind='ACCOUNT')),
  CONSTRAINT ck_notification_read_model__command CHECK (((decision='QUEUED') = (command_id IS NOT NULL)) AND ((command_id IS NULL) = (delivery_state IS NULL))),
  CONSTRAINT ck_notification_read_model__available CHECK (((delivery_state='DELIVERED') = (available_at IS NOT NULL)) IS TRUE OR (delivery_state IS NULL AND available_at IS NULL)),
  CONSTRAINT ck_notification_read_model__reason CHECK ((decision='QUEUED' AND reason_code='MATCHED') OR (decision='SUPPRESSED_RATE' AND reason_code='RATE_LIMITED') OR (decision='NOT_TRIGGERED' AND reason_code='NOT_MATCHED') OR (decision='UNKNOWN_SOURCE' AND reason_code IN ('VALUE_UNKNOWN','VALUE_ESTIMATED')) OR (decision='DISABLED' AND reason_code='POLICY_DISABLED')),
  CONSTRAINT ck_notification_read_model__window CHECK (window_start_at <= evaluated_at AND evaluated_at < window_end_at)
);
CREATE UNIQUE INDEX ux_notification_read_model__command ON notification_read_model(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX ix_notification_read_model__rate ON notification_read_model(rate_identity_sha256,evaluated_at,decision);
CREATE INDEX ix_notification_read_model__recipient ON notification_read_model(recipient_operator_id,available_at,notice_id);
CREATE INDEX ix_notification_read_model__clock ON notification_read_model(owner_stream,subject_id,evaluated_at);
```

## 2. Significado, transacción y rebuild

- owner_stream/subject_kind/subject_id identifican dónde se registró la decisión;
  source_stream/sequence/sha identifican el hecho causal. No son intercambiables.
- notice_id y rate_identity_sha256 tienen las preimágenes exactas del protocolo.
  account_id/model_version_id son las dimensiones reales o NULL explícito; no se
  adivinan desde una ruta actual. Se validan contra la fuente pinneada.
- policy_* son el pin elegido, no un duplicado de los valores de policy.
  El artefacto se publica antes de referenciarlo; acceso privado y retención
  siguen artifacts. Campos métricos se leen del hecho/corte fuente, no se
  inventa una segunda observación de cuota/costo en esta tabla.
- evaluated_at, window_start_at y window_end_at se fijan en la decisión y no
  cambian por entrega/retry. Contar rate por identidad e intervalo de evaluated_at,
  no por policy, bucket o estado del outbox. El índice de rate sostiene esa consulta.
- Dentro de BEGIN IMMEDIATE: CAS del sujeto, lectura de cota temporal, predicado,
  conteo y decisión; si QUEUED, intención B3 en ese mismo appendBatch. El fold
  asigna command_id y delivery_state=PENDING al crear comando. Las otras
  decisiones no tienen comando ni estado de entrega.
- delivery_state sólo sigue eventos B3 validados por command/notice/recipient.
  DELIVERED y available_at nacen juntos al aceptar LOCAL_INBOX; available_at es
  el instante registrado del acuse. No significa leído por una persona.
- sequence es el último evento aplicado de owner_stream, no la secuencia causal
  ni una cabeza global; la fila jamás cambia de owner_stream/sujeto.
- Las actualizaciones de delivery conservan toda la identidad/policy/decisión
  original. Distinto contenido bajo el mismo notice o command rechaza.
- Rebuild a un vector de cabezas verifica fuente/policy/causalidad y aplica
  decisiones ya registradas; no reevalúa el reloj, rate ni entrega nada.
  Pérdida del outbox reconstruye B3: intento sin desenlace sigue RECONCILING.
- Cota temporal: MAX(evaluated_at) por owner_stream/subject_id, derivada de
  decisiones durables, incluso ocultas por retención de la vista. Si now<cota
  se rechaza; no se sintetiza tiempo con MAX. El ledger histórico no se borra
  para disminuir el contador o la cota.
- No hay FK física a registry, source_event, account o outbox desde esta cohorte
  multi-stream. Su vínculo tipado, el CHECK de propietario y los watermarks son
  obligatorios; no un cast por ID.

### 2.1 Cohortes y watermarks: tres particiones, no mezcla implícita

La misma tabla tiene tres particiones canónicas disjuntas por owner_stream.
source_stream es **la fuente causal**, no decide la partición; owner_stream es
el origen autoritativo del evento de decisión/entrega. Esta distinción es parte
del schema, no se infiere por un número de secuencia.

| owner_stream de la partición | projection_name en projection_watermark | Filas canónicas |
| --- | --- | --- |
| control_plane_events | notification_control_read_model | WHERE owner_stream='control_plane_events' |
| initiative_events | notification_initiative_read_model | WHERE owner_stream='initiative_events' |
| account_events | notification_account_read_model | WHERE owner_stream='account_events' |

Esos nombres son identidades **lógicas** de projector; no crean otras tablas ni
otra autoridad. Cada identidad registra cuatro filas de watermark (una por
stream), con projector_version=1 y hashes al corte. El vector H de lectura debe
ser causalmente cerrado: toda referencia de fuente/policy usada está <= H de su
stream y conserva su hash; si no, SOURCE_CUT_UNAVAILABLE, no una FK ficticia.

Fold de una decisión/entrega sólo modifica la partición cuyo owner_stream coincide
con el evento, conservando notice_id y sujeto. Nunca busca por source_sequence
sin stream ni elimina filas vecinas. Un registry event no recalcula avisos
anteriores ni cambia su policy; sólo puede avanzar el componente de watermark.

Publicación incremental: el append y folds dejan las tres identidades lógicas
al **mismo vector H**, en una transacción del ledger, aunque algunas particiones
no cambien filas. Avanzar su watermark certifica haber consumido o descartado
semánticamente ese evento, no que se haya procesado una policy nueva sobre pasado.
No se expone una bandeja certificada que combine particiones con vectores distintos.

Rebuild completo: fijar H, construir las tres particiones en un destino nuevo
descartable, consumir cada owner_stream en su orden, validar referencias contra H
y publicar las doce filas de watermark junto con el rowset. Rebuild parcial:
reemplazar exclusivamente WHERE owner_stream=<su literal>; publicar su vector
sólo después de verificarlo. Las otras particiones/marks permanecen intactas;
hasta que las tres coincidan con H, la consulta combinada rehúsa como no preparada.
Nada convierte el progreso parcial en una cabeza global. Comparación canónica:
cada rowset filtrado se ordena por notice_id, sin rowid ni reloj de rebuild.

## 3. Negativos del dato

Dos productores sobre el último cupo sólo confirman una decisión QUEUED.
Cambiar la ventana/policy cuenta filas previas del intervalo y no reinicia cupo.
delivery_state=NULL con available_at presente, QUEUED sin command, evento de otro
sujeto/command o SHA de fuente alterado rechazan. Replay/restore no agrega avisos,
y una fila histórica oculta no desaparece del rate ni de la cota temporal.
