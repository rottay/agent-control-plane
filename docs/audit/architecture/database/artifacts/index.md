# Artefactos: blobs, referencias, pins y recolección

Diccionario físico de los objetos que guardan bytes y de los que gobiernan su
acceso y su ciclo de vida. Las reglas transversales —clases de objeto,
normalización, tipos, causalidad, saga— viven en el [maestro](../index.md) y no se
repiten aquí.

---

## 1. Qué posee esta hoja

| Objeto | Clase |
| --- | --- |
| `artifact_blob_read_model` | read model |
| `artifact_reference_read_model` | read model |
| `artifact_pin_read_model` | read model |
| `artifact_tombstone_read_model` | read model |
| `artifact_blob_lease` | coordination store |
| El árbol de archivos bajo `artifacts/` | blob |

**Identidad de bytes e identidad de acceso son cosas distintas.** El digest
identifica contenido; la referencia identifica un acceso con dueño, scope, política
y retención. Dos referencias al mismo blob con políticas distintas son legítimas, y
por eso **no existe** una restricción de unicidad sobre `(scope, digest,
producer)`.

### 1.1 Dónde viven los eventos de artefacto

Un artefacto puede no tener tarea: un catálogo de precios, un documento de política
o un artefacto de sistema no pertenecen a ninguna. Por eso **los eventos de ciclo
de vida, referencia, pin y tombstone de artefactos viven en `registry_events`**, con
`subject_kind = 'ARTIFACT'` y el identificador del recurso como sujeto.

- **No** se crea un quinto stream.
- **No** hay clave foránea obligatoria hacia el stream de tareas, y **no** se
  inventa una tarea ni una iniciativa falsa para un artefacto de sistema.
- Los eventos de tarea, de iniciativa y de cuenta **enlazan** un registro de
  artefacto por **causalidad tipada con digest** ([maestro §5](../index.md)).
- Los metadatos de scope de acceso viven en la referencia (§4), aparte del ciclo de
  vida del blob.
- La proyección lleva `registry_events` en su vector de watermarks. Cuando un fold
  toca dos streams del **mismo archivo de ledger**, la escritura por lote los cubre
  a los dos en una transacción.
- **Los bytes privados nunca están en la base**, en ningún stream.

Consecuencia de secuencia: **el mínimo de M1 exige crear el stream de registry y los
metadatos de artefacto antes del primer prompt**. Si alguna dependencia local los
colocaba después, se reordena.

---

## 2. Vocabularios

| Vocabulario | Valores | Notas |
| --- | --- | --- |
| `artifact_class` | `TASK_ENVELOPE`, `PROMPT`, `RESPONSE`, `TOOL_ARGUMENT`, `TOOL_RESULT`, `CHECKPOINT`, `RECEIPT`, `EVIDENCE`, `PLAN_DOCUMENT`, `POLICY_DOCUMENT`, `PRICE_CATALOG`, `EXPORT` | cerrado, versión 1; una clase nueva es una versión de contrato. **El atributo se llama `artifact_class`**: no existe un `kind` ambiguo |
| `artifact_classification` | `PUBLIC_SAFE`, `INTERNAL`, `SENSITIVE`, `SECRET_BEARING` | `SECRET_BEARING` nunca se publica en el stream ni en trazas |
| `encryption_status` | `PLAINTEXT`, `ENCRYPTED_AT_REST` | |
| `retention_class` | `EPHEMERAL`, `STANDARD`, `EXTENDED`, `PERMANENT` | fija el período de gracia y el vencimiento por defecto |
| `reference_scope_kind` | `INITIATIVE`, `TASK`, `ACCOUNT`, `SYSTEM` | |
| `blob_lifecycle_state` | `STAGED`, `PUBLISHED`, `PUBLICATION_ABANDONED`, `RECLAIM_INTENDED`, `RECLAIMED` | estado del **blob**, no de una referencia |
| `blob_lease_operation` | `PUBLISH`, `RECLAIM` | qué se está haciendo bajo la generación exclusiva |
| `tombstone_reason` | `POLICY_EXPIRY`, `OWNER_REQUEST`, `LEGAL_HOLD_RELEASE`, `CORRUPTION` | |
| `artifact_event_kind` | `PUBLICATION_INTENDED`, `PUBLICATION_SUCCEEDED`, `PUBLICATION_ABANDONED`, `REFERENCE_RECORDED`, `PIN_ACQUIRED`, `PIN_RELEASED`, `RECLAIM_INTENDED`, `RECLAIM_COMPLETED`, `REFERENCE_TOMBSTONED` | en `registry_events`, con `subject_kind = 'ARTIFACT'` |

---

## 3. `artifact_blob_read_model`

Metadatos **de los bytes**. No lleva dueño, ni scope, ni permiso.

| Columna | Tipo | NULL / default / check | Clave | Fuente y semántica |
| --- | --- | --- | --- | --- |
| `content_sha256` | `TEXT` | `NOT NULL`; `ck_artifact_blob_read_model__content_sha256_hex`: `length = 64 AND NOT GLOB '*[^0-9a-f]*'` | `pk_artifact_blob_read_model` (con `blob_generation`) | digest del contenido **en claro**; identifica los bytes, no una publicación |
| `blob_generation` | `INTEGER` | `NOT NULL`; default `1`; `ck_..__blob_generation_positive`: `> 0` | `pk_artifact_blob_read_model` | avanza en cada republicación tras un reclamo. El mismo contenido publicado dos veces son dos generaciones, y su historia de eliminación no se confunde |
| `media_type` | `TEXT` | `NOT NULL`; sin default | — | declarado por el productor y validado contra la clase del bloque |
| `size_bytes` | `INTEGER` | `NOT NULL`; `ck_..__size_bytes_non_negative`: `>= 0` | — | tamaño exacto en bytes |
| `lifecycle_state` | `TEXT` | `NOT NULL`; sin default; `ck_..__lifecycle_state_enum` | — | `blob_lifecycle_state` |
| `encryption_status` | `TEXT` | `NOT NULL`; sin default; `ck_..__encryption_status_enum` | — | `PLAINTEXT` o `ENCRYPTED_AT_REST` |
| `key_reference` | `TEXT` | **`NULL` si y sólo si** `encryption_status = 'PLAINTEXT'`; `ck_..__key_reference_matches_encryption` | — | referencia opaca a la clave; **jamás la clave** |
| `first_published_sequence` | `INTEGER` | `NULL` si esta generación nunca se publicó; si existe, `> 0`; pareja coherente con `first_published_at` (§8.1) | `fk_..__registry_events` | secuencia del evento que publicó la primera referencia |
| `first_published_at` | `TEXT` | `NULL` si y sólo si `first_published_sequence` es `NULL` (§8.1) | — | instante del evento, no del reloj de reconstrucción |
| `reclaim_id` | `TEXT` | `NULL` salvo en `RECLAIM_INTENDED` o `RECLAIMED` | `ux_artifact_blob_read_model__reclaim_id` parcial | identifica **esa** eliminación física |
| `reclaimed_at` | `TEXT` | `NULL` salvo en `RECLAIMED` | — | instante del evento de reclamo |
| `grace_started_at` | `TEXT` | `NOT NULL`; sin default | — | instante del primer `PUBLICATION_INTENDED` de esta generación; publicación, abandono y recuperación lo conservan; no reinician la gracia |
| `encryption_profile` | `TEXT` | `NOT NULL`; sin default | — | perfil de cifrado del blob. **No cambia por deduplicación**: un conflicto de política se rechaza con un error nombrado, o exige una migración de cifrado explícita |
| `applied_sequence` | `INTEGER` | `NOT NULL`; `>= 0` | — | posición del fold que produjo esta fila |

Índices: `ix_artifact_blob_read_model__lifecycle_state`,
`ix_artifact_blob_read_model__first_published_sequence`.

Un índice único parcial sobre `content_sha256` donde `lifecycle_state <> 'RECLAIMED'`
permite **una sola generación física no reclamada** por contenido. No hay unicidad
global sobre el digest: las generaciones históricas permanecen. Una referencia o
un pin siempre fija la PK compuesta, y la recolección comprueba esa generación.

Fold: eventos de publicación, referencia, pin, tombstone y reclamo de
`registry_events`, con `subject_kind = 'ARTIFACT'`. Reconstruible desde cero al
watermark de ese stream; ninguna secuencia de esta hoja referencia el stream de
tareas.

---

## 4. `artifact_reference_read_model`

El acceso. **Aquí vive el permiso.**

| Columna | Tipo | NULL / default / check | Clave | Fuente y semántica |
| --- | --- | --- | --- | --- |
| `artifact_reference_id` | `TEXT` | `NOT NULL` | `pk_artifact_reference_read_model` | identificador propio; **no** es el digest |
| `content_sha256` | `TEXT` | `NOT NULL`; dominio heredado de §3 | FK compuesta con `blob_generation`, `ON DELETE RESTRICT` | a qué contenido apunta |
| `blob_generation` | `INTEGER` | `NOT NULL`; `> 0` | `fk_artifact_reference_read_model__artifact_blob_read_model`: `(content_sha256, blob_generation)` → PK del blob | generación exacta autorizada por esta referencia |
| `artifact_class` | `TEXT` | `NOT NULL`; sin default; `ck_..__artifact_class_enum` | — | `artifact_class` |
| `classification` | `TEXT` | `NOT NULL`; sin default; `ck_..__classification_enum` | — | decide qué canal puede transportarla |
| `scope_kind` | `TEXT` | `NOT NULL`; sin default; `ck_..__scope_kind_enum` | — | `reference_scope_kind` |
| `scope_id` | `TEXT` | `NULL` **sólo** si `scope_kind = 'SYSTEM'`; `ck_..__scope_id_matches_scope_kind` | — | iniciativa, tarea o cuenta dueña |
| `producer_identity` | `TEXT` | `NOT NULL` | — | quién la produjo, en la identidad uniforme de worker |
| `access_policy_id` | `TEXT` | `NOT NULL`; sin default | `fk_..__access_policy_read_model` | política de acceso versionada; **no** una lista embebida |
| `retention_class` | `TEXT` | `NOT NULL`; sin default; `ck_..__retention_class_enum` | — | `retention_class` |
| `expires_at` | `TEXT` | `NULL` cuando `retention_class = 'PERMANENT'`; en los demás casos `NOT NULL` | — | **vencer no revoca permiso por sí solo** (§8) |
| `tombstoned_at` | `TEXT` | `NULL` si y sólo si no se registró `REFERENCE_TOMBSTONED` para esta referencia | — | instante de revocación irreversible del acceso; independiente de la presencia física de los bytes |
| `tombstone_reason` | `TEXT` | `NULL` si y sólo si `tombstoned_at` es `NULL`; `ck_..__tombstone_reason_matches` | — | `tombstone_reason` |
| `created_sequence` | `INTEGER` | `NOT NULL`; `> 0` | `fk_..__registry_events` | evento que la creó |
| `applied_sequence` | `INTEGER` | `NOT NULL`; `>= 0` | — | posición del fold |

Índices:

| Índice | Columnas | Para qué |
| --- | --- | --- |
| `ix_artifact_reference_read_model__content_sha256` | `content_sha256` | contar referencias vivas de un blob |
| `ix_artifact_reference_read_model__scope_kind_scope_id` | `scope_kind, scope_id` | listar lo que una iniciativa o una tarea puede leer |
| `ix_artifact_reference_read_model__expires_at` | `expires_at` | barrido de vencimientos |

Clave única auxiliar `ux_artifact_reference_read_model__id_content_generation`
sobre `(artifact_reference_id, content_sha256, blob_generation)`: permite que el
tombstone referencie la identidad y generación exactas de la referencia con una
FK compuesta. No impide crear otras referencias al mismo contenido.

**No hay** `ux_artifact_reference_read_model__scope_id_content_sha256_producer_identity`:
dos referencias al mismo blob, del mismo productor y en el mismo scope, con
políticas o retenciones distintas, son legítimas.

**Compartir un digest no concede permiso.** El acceso se resuelve por
`artifact_reference_id` y su política; conocer el digest no habilita nada. Un
envelope privado se lee por referencia autorizada, no por su `envelope_sha256`.

---

## 5. `artifact_pin_read_model`

Un pin protege un blob de la recolección mientras dura una operación o una
obligación.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `artifact_pin_id` | `TEXT` | `NOT NULL` | `pk_artifact_pin_read_model` | identificador del pin |
| `content_sha256` | `TEXT` | `NOT NULL`; dominio heredado de §3 | FK compuesta con `blob_generation`, `ON DELETE RESTRICT` | contenido protegido |
| `blob_generation` | `INTEGER` | `NOT NULL`; `> 0` | `fk_artifact_pin_read_model__artifact_blob_read_model`: `(content_sha256, blob_generation)` → PK del blob | generación exacta protegida |
| `pin_holder_kind` | `TEXT` | `NOT NULL`; `ck_..__pin_holder_kind_enum`: `PUBLICATION`, `TASK`, `BACKUP`, `LEGAL_HOLD` | — | por qué existe |
| `pin_holder_id` | `TEXT` | `NOT NULL` | — | quién lo sostiene |
| `acquired_sequence` | `INTEGER` | `NOT NULL`; `> 0` | `fk_..__registry_events` | evento que lo tomó |
| `released_sequence` | `INTEGER` | `NULL` mientras el pin siga vivo; `> 0` | `fk_..__registry_events` | evento que lo soltó |
| `applied_sequence` | `INTEGER` | `NOT NULL`; `>= 0` | — | posición del fold |

Índice único parcial:
`ux_artifact_pin_read_model__content_sha256_holder__live`
sobre `(content_sha256, blob_generation, pin_holder_kind, pin_holder_id)`
`WHERE released_sequence IS NULL`. Un mismo holder no toma dos pins vivos del mismo
blob; tomarlo de nuevo es idempotente.

---

## 6. `artifact_tombstone_read_model`

**El tombstone es de la referencia, no del blob**, y es **irreversible**.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `artifact_reference_id` | `TEXT` | `NOT NULL` | `pk_artifact_tombstone_read_model`; FK hacia la referencia, `ON DELETE RESTRICT` | la referencia revocada. **No** el digest; su digest y generación deben coincidir con los de esa referencia |
| `content_sha256` | `TEXT` | `NOT NULL`; dominio heredado de §3 | FK compuesta con `blob_generation`, `ON DELETE RESTRICT` | contenido al que apuntaba; trazabilidad, no identidad |
| `blob_generation` | `INTEGER` | `NOT NULL`; `> 0` | FK compuesta al blob y `fk_artifact_tombstone_read_model__artifact_reference_read_model`: `(artifact_reference_id, content_sha256, blob_generation)` → clave única de la referencia, `ON DELETE RESTRICT` | generación original; nunca se redirige a una republicación |
| `reason` | `TEXT` | `NOT NULL`; `ck_..__reason_enum` | — | `tombstone_reason` |
| `decided_by` | `TEXT` | `NOT NULL` | — | quién lo decidió |
| `authority_sha256` | `TEXT` | `NOT NULL`; dominio heredado de §3 | — | bajo qué autoridad |
| `recorded_sequence` | `INTEGER` | `NOT NULL`; `> 0` | `fk_..__registry_events` | evento que lo registró |
| `applied_sequence` | `INTEGER` | `NOT NULL`; `>= 0` | — | posición del fold |

Un tombstone **no borra la fila de la referencia y no reescribe historia**: la
referencia sobrevive y pasa a devolver **contenido eliminado**, y lo sigue haciendo
**aunque los mismos bytes se republiquen** más tarde.

La eliminación **física** de bytes es otra cosa y se identifica por `reclaim_id`, o
por el par `(content_sha256, blob_generation)`. **Nunca por el digest solo**: el
mismo contenido puede publicarse, reclamarse y volver a publicarse, y esas son tres
cosas distintas. **Republicar tras un reclamo crea una referencia nueva y una generación nueva**;
no revive referencias viejas ni levanta sus tombstones.

La recolección exige **cero referencias vivas y cero pins vivos** (§9).

---

## 7. `artifact_blob_lease` — coordination store

Archivo separado, sin historia, con generación monótona. **No es un read model**.
Su metadata `coordination_store_meta` y su recuperación siguen
[coordinación §8](../coordination/index.md), también para este archivo: congelar
admisión, reconciliar, demostrar quiescencia, persistir una encarnación nueva y
acusar sus tokens antes de admitir. Si la quiescencia es incierta, no se recrea un
store vacío operativo. Sólo bajo esa barrera la pérdida cuesta vivacidad y no
se pierde evidencia del ledger.

| Columna | Tipo | NULL / default / check | Clave | Semántica |
| --- | --- | --- | --- | --- |
| `content_sha256` | `TEXT` | `NOT NULL` | `pk_artifact_blob_lease` | blob bajo operación exclusiva |
| `generation` | `INTEGER` | `NOT NULL`; `ck_..__generation_positive`: `> 0` | — | fence de operación, distinto de `blob_generation`: nuevo grant/revocación avanza exactamente uno; actualización ordinaria/liberación lo conserva |
| `store_incarnation_id` | `TEXT` | `NOT NULL`; UUID de `coordination_store_meta`; validado en INSERT y UPDATE | — | token efectivo `(store_incarnation_id, generation)`, además de la identidad del holder |
| `operation` | `TEXT` | `NULL` cuando no hay operación en curso; `ck_..__operation_enum` | — | `blob_lease_operation` |
| `operation_id` | `TEXT` | `NULL` si y sólo si `operation` es `NULL` | — | correlaciona con la intención registrada en el ledger |
| `holder` | `TEXT` | `NULL` si y sólo si `operation` es `NULL` | — | quién la sostiene |
| `holder_pid` | `INTEGER` | `NULL` si y sólo si `operation` es `NULL` | — | para la comprobación de vivacidad |
| `acquired_at` | `TEXT` | `NULL` si y sólo si `operation` es `NULL` | — | |
| `expires_at` | `TEXT` | `NULL` si y sólo si `operation` es `NULL` | — | vencer **no** concede el blob a otro: habilita reconciliar |

Índice único parcial: `ux_artifact_blob_lease__operation_id` `WHERE operation_id IS
NOT NULL`.

---

## 8. Publicación

**La exclusión se adquiere primero, y cubre toda mutación de pin, de referencia y
del filesystem para ese blob.** No es una comparación puntual: es una generación
exclusiva que se sostiene durante toda la operación.

```
1. arbiter: CAS sobre artifact_blob_lease, operation = 'PUBLISH'
     → generación exclusiva EFECTIVA antes de cualquier otra cosa
2. registry_events: PUBLICATION_INTENDED
     produce, en la MISMA transacción de append y fold:
       · el blob en estado STAGED si es una generación nueva;
         si se deduplica una generación PUBLISHED, se conserva esa fila
       · el pin de clase PUBLICATION ligado a la PK compuesta exacta
     así la clave foránea del pin hacia el blob está resuelta al escribirse
3. filesystem, en este orden y sin atajos:
     escribir en staging → verificar el hash de lo escrito
     → fsync(archivo) → rename atómico al destino final
     → fsync(directorio destino)
4. registry_events: PUBLICATION_SUCCEEDED
     produce, atómicamente: la referencia registrada Y la liberación del pin
5. arbiter: soltar la generación
```

- **La referencia se escribe después de que los bytes están publicados**, nunca
  antes.
- Directorios `0700`, archivos `0600`.
- **Una publicación exitosa no deja pins filtrados**: el paso 4 los libera en el
  mismo append que registra la referencia.
- Si el proceso muere entre 3 y 4 **con los bytes válidos en su destino**, la
  reconciliación **puede completar la referencia original**: los bytes son correctos
  y su digest lo demuestra. Si los bytes están **ausentes o no verifican**, no hay
  éxito: se registra `PUBLICATION_ABANDONED`, que libera el pin **conservando la
  fecha de gracia original** del blob, de modo que el reloj de la recolección no se
  reinicia.
- Si muere después de 1 pero antes de 2, hay exclusión tomada sin intención: se
  reconcilia el holder y sólo se libera tras quiescencia probada. Si muere después
  de 2 y antes de 3, hay intención y pin sin bytes: la reconciliación lo detecta
  por el `command_id` y reintenta o abandona. El lease conserva su `operation_id`
  vinculado a ese comando. **La clave de idempotencia es la misma**, así que un
  reintento no duplica.

### 8.1 Evento a proyección

| Evento | Blob | Referencia | Pin | Tombstone |
| --- | --- | --- | --- | --- |
| `PUBLICATION_INTENDED` | generación nueva en `STAGED` si no existe contenido publicado; una generación `PUBLISHED` deduplicada se conserva sin reiniciar su historia | — | fila nueva, clase `PUBLICATION`, dirigida a la generación exacta | — |
| `PUBLICATION_SUCCEEDED` | pasa a `PUBLISHED` | fila nueva | `released_sequence` poblado | — |
| `PUBLICATION_ABANDONED` | la generación nueva no publicada pasa a `PUBLICATION_ABANDONED`; una generación ya `PUBLISHED` conserva su estado | — | `released_sequence` poblado | — |
| `REFERENCE_RECORDED` | — | fila nueva | — | — |
| `PIN_ACQUIRED` / `PIN_RELEASED` | — | — | alta / `released_sequence` | — |
| `RECLAIM_INTENDED` | pasa a `RECLAIM_INTENDED` | — | — | — |
| `RECLAIM_COMPLETED` | pasa a `RECLAIMED` | — | — | — |
| `REFERENCE_TOMBSTONED` | — | `tombstoned_at` y razón poblados | — | fila nueva |

Restricciones y folds de nulidad, explícitos:

- `first_published_sequence` y `first_published_at` son ambos `NULL` o ambos
  `NOT NULL`. `STAGED` y `PUBLICATION_ABANDONED` exigen ambos `NULL`;
  `PUBLISHED` exige ambos `NOT NULL`. `RECLAIM_INTENDED` y `RECLAIMED` admiten
  cualquiera de las dos parejas: preservan exactamente el valor previo. Reclamar
  un huérfano nunca publicado no inventa una publicación. El primer éxito fija
  la pareja y los eventos posteriores no la modifican.
- `released_sequence` es `NULL` antes de `PIN_RELEASED` o del éxito/abandono que
  libera ese pin; después es positiva y no menor que `acquired_sequence`.
- `reclaim_id` es `NOT NULL` si y sólo si el estado es `RECLAIM_INTENDED` o
  `RECLAIMED`; `reclaimed_at` es `NOT NULL` si y sólo si es `RECLAIMED`.
- `tombstone_reason` es `NOT NULL` si y sólo si `tombstoned_at` lo es. El evento
  de revocación, no la presencia física del blob, produce ambos. La referencia
  conserva digest y generación para siempre, también cuando se republican bytes.
- El fold y sus eventos fijan generación, secuencias y `grace_started_at`;
  reconstruir no consulta el filesystem ni el reloj. Todas las secuencias aquí
  citadas pertenecen a `registry_events`.

---

## 9. Recolección

**No se apoya en «mientras haya una transacción abierta»: una transacción de SQLite
no cruza al filesystem.** El protocolo es explícito y su recuperación ante crash
también.

```
adquisición   CAS sobre artifact_blob_lease con operation = 'RECLAIM'.
              Se adquiere ANTES de mirar las referencias, y se sostiene desde
              la comprobación hasta el unlink y su acuse.
              Si otro tiene la generación, no se recolecta.
intención     registry_events: RECLAIM_INTENDED, con el command_id
recomprobación bajo la generación exclusiva y contra la CABEZA de eventos:
              comando ligado a (content_sha256, blob_generation, reclaim_id);
              si ya está RECLAIMED, replay del acuse SIN volver a hacer unlink;
              nunca borrar una ruta que ahora pertenece a otra generación
              cero referencias vivas, cero pins vivos, y superado el período
              de gracia de su clase de retención
borrado       unlink del archivo → fsync(directorio)
acuse         registry_events: RECLAIM_COMPLETED
liberación    arbiter: soltar la generación
```

Recuperación ante crash, punto por punto:

| Muere después de | Estado observable | Qué hace la reconciliación |
| --- | --- | --- |
| adquirir | generación tomada, sin intención | TTL sólo habilita reconciliar; otro ejecutor adquiere después de probar muerte y reap/quiescencia del anterior o revocación efectiva por el backend; si es incierto, se bloquea |
| la intención | intención sin borrado | recomprueba **de nuevo** contra la cabeza actual: si apareció una referencia, **abandona** |
| recomprobar | idéntico al anterior | idem: la recomprobación se repite siempre, nunca se asume vigente |
| el borrado | bytes ausentes, sin acuse | el acuse se apendea con la misma clave de idempotencia; el estado converge |
| el acuse | consistente | soltar la generación |

**La recomprobación siempre se repite tras recuperar.** Una decisión de recolectar
tomada antes del crash no se considera vigente después.

**Vencer el TTL de la generación habilita reconciliar, no transferir.** Para que
otro ejecutor tome la generación hace falta una de dos: quiescencia probada del
anterior —muerte comprobada y reap— o un backend que **efectivamente rechace** un
fence viejo. Si queda incierto, el procedimiento **se detiene** y no hay admisión
automática. **Una comparación puntual no alcanza.**

Dos negativos que esta exclusión debe hacer imposibles:

1. Recolector comprueba referencias → publicador toma un pin → recolector hace
   unlink. Bajo la generación exclusiva, la secuencia no puede ocurrir.
2. Un ejecutor viejo que se reanuda **no tiene permitido ningún acceso al
   filesystem** para ese blob.

---

## 10. Vencimiento, permiso y rutas

- **Vencer no revoca permiso por sí solo.** `expires_at` habilita a la política a
  actuar; la revocación es una decisión registrada, no un efecto del reloj.
- **Las rutas se derivan del digest**, con partición por sus dos primeros
  caracteres hexadecimales. Ninguna ruta se construye a partir de una referencia no
  confiable.
- La raíz se resuelve una sola vez y toda ruta se comprueba contra ella; **los
  symlinks se rechazan al abrir**.
- Un artefacto `SECRET_BEARING` no aparece en el stream público, ni en el DOM, ni
  en una traza, bajo ninguna circunstancia. **Y no es un permiso para almacenar
  credenciales**: designa material que exige revisión y bloqueo. Las credenciales
  viven **sólo** en el resolver de credenciales, según el perfil de sinks de
  [tests §8.1](../../../quality/testing/index.md).

### 10.1 Cifrado y digest

- El `content_sha256` es siempre el digest del **contenido en claro**. Leer un
  archivo cifrado valida el descifrado **y** el digest.
- **El perfil de cifrado y la referencia de clave de un blob no cambian por una
  deduplicación silenciosa.** Un conflicto de política de cifrado se **rechaza con
  un error nombrado** en el perfil inicial, o exige una operación explícita de
  migración de cifrado, bloqueada durante toda su duración.
- **Nunca** se convierte un blob privado en texto plano porque una referencia nueva
  lo clasifique como públicamente seguro.

---

## 11. Backup y restore

El ledger, su journal de escritura adelantada y el árbol de artefactos se copian
bajo **la misma ventana**. Un restore formal escribe un identificador de restore
nuevo y aleatorio **antes de admitir trabajo** ([maestro §12](../index.md)), y una
referencia cuyo blob no aparece tras el restore se reporta como contenido ausente,
de forma explícita: nunca como una fila vacía.

---

## 12. Negativos de esta hoja

1. Referencia viva y blob ausente → error explícito.
2. Blob conocido por digest desde otra iniciativa → acceso denegado.
3. Recolección con una referencia viva → no borra.
4. Recolección con un pin vivo → no borra.
5. Crash en cada uno de los cinco puntos de §9 → sin bytes borrados de más y sin
   estado divergente.
6. Dos recolectores compitiendo → uno solo obtiene la generación.
7. Ruta con `..` o symlink → rechazada al abrir.
8. Referencia vencida sin decisión de política → **sigue autorizada**.
9. `key_reference` no nulo con `encryption_status = 'PLAINTEXT'` → rechazado por la
   restricción.
10. Tombstone → la referencia sobrevive y devuelve contenido eliminado.
