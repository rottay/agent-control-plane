import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CLASSES,
  ARTIFACT_CLASSIFICATIONS,
  ARTIFACT_EVENT_KINDS,
  BLOB_LIFECYCLE_STATES,
  ENCRYPTION_STATUSES,
  PIN_HOLDER_KINDS,
  REFERENCE_SCOPE_KINDS,
  RETENTION_CLASSES,
} from "@acp/contracts";

import {
  ARTIFACT_BLOB_PROJECTION,
  ARTIFACT_PIN_PROJECTION,
  ARTIFACT_REFERENCE_PROJECTION,
  ARTIFACT_REGISTRY_MIGRATION,
  ARTIFACT_TOMBSTONE_PROJECTION,
  DERIVED_TABLES,
  EXPECTED_SCHEMA_OBJECTS,
  INITIATIVE_PROJECTION_NAMES,
  INITIATIVE_STREAM,
  MIGRATIONS,
  INITIATIVE_REGISTRATION_MIGRATION,
  MODEL_VERSION_PROJECTION,
  MODEL_VERSION_REGISTRY_MIGRATION,
  PROJECTION_NAMES,
  PROJECTION_SOURCES,
  REGISTRY_PROJECTION_NAMES,
  REGISTRY_STREAM,
  DISPATCH_ATTEMPT_PROJECTION,
  EXECUTION_OCCURRENCE_MIGRATION,
  PROMPT_OCCURRENCE_PROJECTION,
  RESPONSE_OCCURRENCE_PROJECTION,
  TASK_ATTEMPT_MIGRATION,
  TASK_ATTEMPT_PROJECTION,
  TASK_REVISION_ENVELOPE_REFERENCE_MIGRATION,
  TASK_REVISION_MIGRATION,
  TASK_REVISION_PROJECTION,
  TASK_SUBMISSION_MIGRATION,
  TASK_SUBMISSION_PROJECTION,
  TASK_STREAM,
  checkMigrationConformance,
} from "../../src/migrations/index.js";
import { PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS } from "../../src/projection/index.js";
import { DOCUMENT_KINDS } from "../../src/types/index.js";
import type { AppliedMigration } from "../../src/types/index.js";
import { forAll, intBetween, pick } from "../canonical-json/helpers/index.js";

/**
 * Migration conformance, asserted by name (P8-T G9, the structural residual).
 *
 * `checkMigrationConformance` is a decision function one level below
 * `decideRoadmapVersion`: it compares what a database has applied against what
 * this build defines and returns a verdict every open of the ledger acts on.
 * Until now it was exercised only incidentally, through the open path — so a
 * change to its refusal reasoning would have surfaced, if at all, as some other
 * test's confusing failure. This class asserts its own contract.
 *
 * The two-field verdict is the whole contract, and both halves matter:
 * `problems` is fatal in every mode, `missing` is the recoverable tail — and
 * the rule binding them is that a divergent prefix must suppress the tail
 * entirely, because applying new migrations on top of a divergent history
 * compounds the divergence instead of surfacing it.
 */

const ITERATIONS = 120;

/** The applied rows a conforming database of `count` migrations would hold. */
function conformingPrefix(count: number): AppliedMigration[] {
  return MIGRATIONS.slice(0, count).map((migration) => ({
    version: migration.version,
    name: migration.name,
    sha256: migration.sha256,
    appliedAt: "2026-08-27T12:00:00.000Z",
  }));
}

describe("migration conformance grants exactly the conforming prefixes (G9)", () => {
  it("accepts every prefix of this build's own migrations", () => {
    // The generated dimension is how far the database got. Every prefix is
    // legal; what differs is the size of the recoverable tail.
    forAll("conforming prefix", 0x9a17_0001, ITERATIONS, (random) =>
      intBetween(random, 0, MIGRATIONS.length), (count) => {
      const verdict = checkMigrationConformance(conformingPrefix(count));
      expect(verdict.problems).toEqual([]);
      expect(verdict.missing.map((m) => m.version)).toEqual(
        MIGRATIONS.slice(count).map((m) => m.version),
      );
    });
  });

  it("reports nothing missing when the database is fully migrated", () => {
    const verdict = checkMigrationConformance(conformingPrefix(MIGRATIONS.length));
    expect(verdict.problems).toEqual([]);
    expect(verdict.missing).toEqual([]);
  });
});

describe("migration conformance refuses every divergence, and suppresses the tail (G9)", () => {
  it("refuses a mutated row and never offers a recoverable tail", () => {
    // The property that matters operationally: whatever the divergence, the
    // caller must not be handed migrations to apply on top of it.
    forAll("divergence suppresses the tail", 0x9a17_0011, ITERATIONS, (random) => {
      const count = intBetween(random, 1, MIGRATIONS.length);
      const rows = conformingPrefix(count);
      const index = intBetween(random, 0, rows.length - 1);
      const row = rows[index];
      if (row === undefined) throw new Error("empty prefix");
      const mutation = pick(random, ["version", "name", "sha256"] as const);
      rows[index] =
        mutation === "version"
          ? { ...row, version: row.version + 1000 }
          : mutation === "name"
            ? { ...row, name: row.name + "-drifted" }
            : { ...row, sha256: "f".repeat(64) };
      return { rows, mutation, index };
    }, ({ rows, mutation }) => {
      const verdict = checkMigrationConformance(rows);
      expect(verdict.problems.length, mutation).toBeGreaterThan(0);
      // The load-bearing half: a divergent prefix yields NO missing tail.
      expect(verdict.missing, mutation).toEqual([]);
    });
  });

  it("refuses rows this build does not define at all", () => {
    forAll("unknown trailing migrations", 0x9a17_0021, ITERATIONS, (random) => {
      const extra = intBetween(random, 1, 3);
      const rows = conformingPrefix(MIGRATIONS.length);
      for (let i = 0; i < extra; i += 1) {
        rows.push({
          version: MIGRATIONS.length + 1 + i,
          name: "from-a-newer-build-" + String(i),
          sha256: "a".repeat(64),
          appliedAt: "2026-08-27T12:00:00.000Z",
        });
      }
      return { rows, extra };
    }, ({ rows, extra }) => {
      const verdict = checkMigrationConformance(rows);
      // One problem per unknown row: a database from a newer build is named
      // row by row rather than summarised, so the operator sees which.
      expect(verdict.problems.length).toBe(extra);
      expect(verdict.missing).toEqual([]);
    });
  });

  it("never throws, whatever it is handed", () => {
    // A conformance check that threw would turn a recoverable divergence into
    // a crash on open. It returns a verdict for every input or it is not a
    // verdict function.
    forAll("totality", 0x9a17_0031, ITERATIONS, (random) => {
      const rows = conformingPrefix(intBetween(random, 0, MIGRATIONS.length));
      const damage = intBetween(random, 0, 3);
      for (let i = 0; i < damage; i += 1) {
        const at = intBetween(random, 0, Math.max(0, rows.length - 1));
        const row = rows[at];
        if (row === undefined) continue;
        rows[at] = { ...row, version: intBetween(random, -50, 5000), sha256: "b".repeat(64) };
      }
      return rows;
    }, (rows) => {
      const verdict = checkMigrationConformance(rows);
      expect(Array.isArray(verdict.problems)).toBe(true);
      expect(Array.isArray(verdict.missing)).toBe(true);
    });
  });
});

/**
 * Migration 7 and the watermark vocabulary (P-09/log-A).
 *
 * These are structural assertions on the migration set itself, not on a
 * database: the migration source is append-only by checksum, so the shape of
 * the tail and the closed set of `(projection, stream)` pairs it seeds are
 * decided here, once, and every open compares against them.
 */
describe("migration 7 appends the watermark table without touching the applied six", () => {
  const SEVENTH = MIGRATIONS[6];

  it("sits at position seven of a set whose order is fixed", () => {
    expect(SEVENTH?.version).toBe(7);
    expect(SEVENTH?.name).toBe("projection_watermark");
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(MIGRATIONS.map((migration) => migration.name)).toEqual([
      "control_plane_events",
      "read_models",
      "ledger_and_projection_meta",
      "initiative_stream",
      "account_events",
      "execution_route_read_model",
      "projection_watermark",
      "causation_triplet",
      "registry_stream",
      "account_event_integrity",
      "task_revision_identity",
      "task_attempt_identity",
      "execution_effect_identity",
      "execution_occurrences",
      "artifact_registry",
      "task_revision_envelope_reference",
      "model_version_registry",
      "initiative_registration_detail",
      "task_submission",
    ]);
  });

  it("is the only migration that creates the watermark table", () => {
    // Migrations 9, 11, 12, 13, 14, 15, 17 and 19 seed rows into it, which is what a
    // migration that adds a projection does; none of them creates, alters or
    // drops the table.
    const creating = MIGRATIONS.filter((migration) =>
      migration.sql.includes("CREATE TABLE projection_watermark"),
    );
    expect(creating.map((migration) => migration.version)).toEqual([7]);
    const naming = MIGRATIONS.filter((migration) =>
      migration.sql.includes("projection_watermark"),
    );
    expect(naming.map((migration) => migration.version)).toEqual([7, 9, 11, 12, 13, 14, 15, 17, 19]);
  });

  it("declares the table STRICT and names its constraints by the §3.2 convention", () => {
    const sql = SEVENTH?.sql ?? "";
    expect(sql).toContain("CREATE TABLE projection_watermark");
    expect(sql).toContain(") STRICT;");
    expect(sql).toContain(
      "CONSTRAINT pk_projection_watermark PRIMARY KEY (projection_name, source_stream)",
    );
    for (const rule of [
      "ck_projection_watermark__source_stream",
      "ck_projection_watermark__projector_version",
      "ck_projection_watermark__applied_sequence",
      "ck_projection_watermark__event_count",
      "ck_projection_watermark__source_head_sha256",
    ]) {
      expect(sql, rule).toContain("CONSTRAINT " + rule);
    }
  });

  it("admits all four contract streams in the CHECK, not only the two under discipline", () => {
    // A CHECK cannot be widened without rewriting the table, and rewriting an
    // applied migration is the one thing this file forbids. So the domain is
    // the contract's four streams from the start; that only two of them carry a
    // certified watermark today is a fact about the code's closed set, below.
    const sql = SEVENTH?.sql ?? "";
    for (const stream of [
      "control_plane_events",
      "initiative_events",
      "account_events",
      "registry_events",
    ]) {
      expect(sql, stream).toContain("'" + stream + "'");
    }
  });

  it("seeds from the heads it finds, on each stream's own meta keys", () => {
    const sql = SEVENTH?.sql ?? "";
    // Never a literal zero seed: a row frozen at zero behind a non-zero head is
    // what verifyIntegrity reports as corruption.
    for (const key of [
      "'head_sequence'",
      "'event_count'",
      "'head_event_sha256'",
      "'initiative_head_sequence'",
      "'initiative_event_count'",
      "'initiative_head_event_sha256'",
    ]) {
      expect(sql, key).toContain(key);
    }
  });

  it("inventories the new table, and adds no index or trigger to the schema shape", () => {
    const added = EXPECTED_SCHEMA_OBJECTS.filter((object) =>
      object.name.startsWith("projection_watermark"),
    );
    expect(added).toEqual([{ type: "table", name: "projection_watermark" }]);
  });
});

describe("the closed set of watermark rows is exactly the streams under discipline", () => {
  it("pairs every projection with the stream or streams it folds", () => {
    expect(
      PROJECTION_SOURCES.map((source) => source.projectionName + "@" + source.sourceStream),
    ).toEqual([
      "task_read_model@control_plane_events",
      "worker_read_model@control_plane_events",
      "execution_route_read_model@control_plane_events",
      "task_revision_read_model@control_plane_events",
      "task_attempt_read_model@control_plane_events",
      "execution_route_segment_read_model@control_plane_events",
      "effect_read_model@control_plane_events",
      "dispatch_attempt_read_model@control_plane_events",
      "prompt_occurrence_read_model@control_plane_events",
      "response_occurrence_read_model@control_plane_events",
      "task_submission_read_model@control_plane_events",
      "initiative_read_model@initiative_events",
      "roadmap_version_read_model@initiative_events",
      "artifact_blob_read_model@registry_events",
      "artifact_reference_read_model@registry_events",
      "artifact_pin_read_model@registry_events",
      "artifact_tombstone_read_model@registry_events",
      "model_version_read_model@registry_events",
      "routing_assignment_read_model@registry_events",
      "routing_assignment_read_model@initiative_events",
    ]);
  });

  it("covers both single-source name lists exactly, with nothing left over", () => {
    // The two lists are each stream's own roster, and the two-source projection
    // is in neither: it is level with two chains, so putting it in either would
    // claim it follows one of them.
    //
    // The subset is derived here rather than read from a `migrations` export.
    // That export existed only so the status DTO could omit the projection it
    // could not describe; P-09/log-D gave the DTO a vector of heads, every pair
    // is published, and a second list in the source of which pairs are real
    // would now be a second source of truth about the first.
    const singleSourceNamesOf = (stream: string): string[] =>
      PROJECTION_SOURCES.filter(
        (source) =>
          source.sourceStream === stream &&
          PROJECTION_SOURCES.filter((other) => other.projectionName === source.projectionName)
            .length === 1,
      ).map((source) => source.projectionName);

    expect(singleSourceNamesOf(TASK_STREAM)).toEqual([...PROJECTION_NAMES]);
    expect(singleSourceNamesOf(INITIATIVE_STREAM)).toEqual([...INITIATIVE_PROJECTION_NAMES]);
    expect(singleSourceNamesOf(REGISTRY_STREAM)).toEqual([...REGISTRY_PROJECTION_NAMES]);
  });

  it("does not claim the account stream (D3)", () => {
    // The account stream has no hash chain of its own, so no watermark of it is
    // published as certified. Its absence here is the whole mechanism.
    expect(
      PROJECTION_SOURCES.some((source) => source.sourceStream === "account_events"),
    ).toBe(false);
  });
});

/**
 * Migration 8 and the causal triple (P-09/log-B).
 *
 * The same kind of structural assertion as migration 7's: what the tail of the
 * append-only migration set says is decided here, once. Two facts carry real
 * weight and are asserted rather than described.
 *
 * The triple lands on the two streams that carry a hash chain and on no other,
 * because a reference whose digest nobody can check is the weak link the
 * contract refuses. And the trigger never names a table this build does not
 * create: SQLite compiles a trigger body when it prepares an INSERT on the
 * table, not when the trigger is created, so a branch naming a table that does
 * not exist would break *every* append rather than lying dormant.
 */
describe("migration 8 types causality without touching the applied seven", () => {
  const EIGHTH = MIGRATIONS[7];

  it("is the migration that introduces the triple on the streams that had none", () => {
    expect(EIGHTH?.version).toBe(8);
    expect(EIGHTH?.name).toBe("causation_triplet");
    // Migration 9 names the columns too: its own table declares them from the
    // start, and it recreates these two triggers to widen the vocabulary.
    // Migration 15 names them again, because it rebuilds that table and
    // recreates the same two triggers byte for byte. What is asserted is that no
    // migration BEFORE 8 could have declared them.
    const naming = MIGRATIONS.filter((migration) =>
      migration.sql.includes("causation_stream"),
    );
    expect(naming.map((migration) => migration.version)).toEqual([8, 9, 15]);
    const altering = MIGRATIONS.filter((migration) =>
      migration.sql.includes("ADD COLUMN causation_stream"),
    );
    expect(altering.map((migration) => migration.version)).toEqual([8]);
  });

  it("adds three nullable columns to each stream that carries a chain", () => {
    const sql = EIGHTH?.sql ?? "";
    for (const table of ["control_plane_events", "initiative_events"]) {
      for (const column of ["causation_stream", "causation_sequence", "causation_sha256"]) {
        expect(sql, table + "." + column).toContain(
          "ALTER TABLE " + table + "\n  ADD COLUMN " + column,
        );
      }
    }
  });

  it("leaves the account stream out entirely (contract §3)", () => {
    // `account_events` carries no `causation_*` by contract: it has no
    // `event_sha256`, so it can neither be referenced verifiably nor hold a
    // reference under the same rule. Adding it is a separate migration, for the
    // packet that gives it a chain.
    expect(EIGHTH?.name, "the migration under test must exist").toBe("causation_triplet");
    expect(EIGHTH?.sql ?? "").not.toContain("account_events");
  });

  it("never names a table this build does not create", () => {
    // `registry_events` is P-09/log-C. A branch naming it would be compiled on
    // every INSERT into these tables and would break all of them.
    expect(EIGHTH?.name, "the migration under test must exist").toBe("causation_triplet");
    expect(EIGHTH?.sql ?? "").not.toContain("registry_events");
  });

  it("admits exactly the two verifiable streams as a causal source", () => {
    const sql = EIGHTH?.sql ?? "";
    expect(sql).toContain("NOT IN ('control_plane_events', 'initiative_events')");
  });

  it("imposes shape, the pair, the position and the digest in one trigger per stream", () => {
    const sql = EIGHTH?.sql ?? "";
    for (const table of ["control_plane_events", "initiative_events"]) {
      expect(sql, table).toContain(
        "CREATE TRIGGER tr_" + table + "__validate_new_rows\nBEFORE INSERT ON " + table,
      );
    }
    // The four guards the contract asks of this trigger, plus the digest
    // resolution the map's negative 5 asks of the packet.
    expect(sql).toContain("length(NEW.event_sha256) <> 64");
    expect(sql).toContain("length(NEW.previous_sha256) <> 64");
    expect(sql).toContain("length(NEW.causation_sha256) <> 64");
    expect(sql).toContain("(NEW.causation_stream IS NULL) <> (NEW.causation_sequence IS NULL)");
    expect(sql).toContain("(NEW.causation_stream IS NULL) <> (NEW.causation_sha256 IS NULL)");
    expect(sql).toContain("NEW.causation_sequence < 1");
    expect((sql.match(/NOT EXISTS/g) ?? []).length).toBe(4);
  });

  it("does not touch the v2 coordinate trigger, which is another packet's", () => {
    expect(EIGHTH?.name, "the migration under test must exist").toBe("causation_triplet");
    expect(EIGHTH?.sql ?? "").not.toContain("validate_v2_coordinate");
  });

  it("inventories every trigger named by the §3.2 convention, and there are nine", () => {
    // Without the inventory, dropping a trigger would leave `schema_migrations`
    // untouched and no check would notice. Migration 9 recreates the first two
    // under the same names, so the inventory does not move for them; the other
    // three are the registry stream's own, and its append-only pair is here
    // rather than under the legacy `<table>_deny_*` because that convention is
    // frozen in the applied migrations that coined it, not inherited by a
    // stream created after it stopped governing.
    const added = EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("tr_"));
    expect(added).toEqual([
      { type: "trigger", name: "tr_control_plane_events__validate_new_rows" },
      { type: "trigger", name: "tr_initiative_events__validate_new_rows" },
      { type: "trigger", name: "tr_registry_events__deny_update" },
      { type: "trigger", name: "tr_registry_events__deny_delete" },
      { type: "trigger", name: "tr_registry_events__validate_new_rows" },
      // P-08/A2: the account sidecar's append-only pair, named by the same
      // convention for the same reason — it was created after migration 7,
      // so it does not inherit the legacy shape its neighbour carries.
      { type: "trigger", name: "tr_account_event_integrity__deny_update" },
      { type: "trigger", name: "tr_account_event_integrity__deny_delete" },
      // P-05/B: the V2 coordinate's pairing rule. Not an append-only pair — it
      // is a shape check on insert, like the two `__validate_new_rows` above,
      // and it exists because SQLite cannot add a CHECK to an applied table.
      { type: "trigger", name: "tr_control_plane_events__validate_v2_coordinate" },
      // P-36/local D: the envelope reference's cohort rule. A shape check on
      // insert for the reason the one above is — SQLite cannot add a CHECK to
      // an applied table, and migration 16 adds a column to one.
      { type: "trigger", name: "tr_task_revision_read_model__validate_envelope_reference" },
    ]);
    // And the legacy prefix still names exactly the three streams that coined
    // it, so the rename did not quietly move one of theirs.
    const legacy = EXPECTED_SCHEMA_OBJECTS.filter((object) =>
      object.name.endsWith("_deny_update") || object.name.endsWith("_deny_delete"),
    ).map((object) => object.name);
    expect(legacy).toEqual([
      "control_plane_events_deny_update",
      "control_plane_events_deny_delete",
      "initiative_events_deny_update",
      "initiative_events_deny_delete",
      "account_events_deny_update",
      "account_events_deny_delete",
      "tr_registry_events__deny_update",
      "tr_registry_events__deny_delete",
      "tr_account_event_integrity__deny_update",
      "tr_account_event_integrity__deny_delete",
    ]);
  });

  it("leaves the applied seven unable to declare the columns themselves", () => {
    // Migrations 1 and 4 created these tables and are immutable by checksum, so
    // the columns can only ever arrive by ALTER. If they appeared in a CREATE
    // TABLE, an applied migration had been rewritten.
    for (const migration of MIGRATIONS.slice(0, 7)) {
      expect(migration.sql, migration.name).not.toContain("causation_stream");
      expect(migration.sql, migration.name).not.toContain("validate_new_rows");
    }
  });
});

/**
 * Migration 9, the registry stream and the first two-source projection
 * (P-09/log-C).
 *
 * Three facts carry the weight here. The stream is new, so unlike migrations 1
 * and 4 it implements the contract's common field profile **completely** from
 * its first migration: the chain, the digest shapes and the causal triple are
 * CHECK constraints in the DDL rather than rules imposed forward by a trigger.
 *
 * The causal vocabulary widens to three, and it widens **here**: migration 8 is
 * applied and immutable by checksum, so its two triggers are dropped and
 * recreated under the same names, after `registry_events` exists in this same
 * migration. A branch naming a table that does not exist is compiled on every
 * INSERT into the table it guards and would break all of them, which is exactly
 * why migration 8 could not name it and why this one can.
 *
 * `account_events` stays out. It has no `event_sha256` at all (migration 5 is
 * immutable, and the sidecar that would give it one is P-08), so a reference
 * naming it could be believed but never checked — and completing the vocabulary
 * to four while recreating the trigger is the easiest way this packet could
 * have introduced the weak link the triple exists to rule out.
 */
describe("migration 9 opens the registry stream without touching the applied eight", () => {
  const NINTH = MIGRATIONS[8];

  it("sits at the tail of a set whose order is fixed", () => {
    expect(NINTH?.version).toBe(9);
    expect(NINTH?.name).toBe("registry_stream");
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  it("is the only migration that creates the registry stream", () => {
    const creating = MIGRATIONS.filter((migration) =>
      migration.sql.includes("CREATE TABLE registry_events ("),
    );
    expect(creating.map((migration) => migration.version)).toEqual([9]);
    // Migration 15 REBUILDS it, under a working name renamed into place, and is
    // the only other migration that writes a CREATE TABLE for it at all.
    const rebuilding = MIGRATIONS.filter((migration) =>
      migration.sql.includes("CREATE TABLE registry_events__"),
    );
    expect(rebuilding.map((migration) => migration.version)).toEqual([15]);
  });

  it("declares the table STRICT with the contract's own constraint names", () => {
    const sql = NINTH?.sql ?? "";
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    expect(sql).toContain("CREATE TABLE registry_events");
    for (const rule of [
      "ck_registry_events__document_kind",
      "ck_registry_events__document_version",
      "ck_registry_events__parent_document_version",
      "ck_registry_events__content_digest",
      "ck_registry_events__causation_pair",
      "ck_registry_events__causation_sequence",
      "ck_registry_events__causation_sha256",
      "ck_registry_events__previous_sha256",
      "ck_registry_events__event_sha256",
    ]) {
      expect(sql, rule).toContain("CONSTRAINT " + rule);
    }
  });

  it("closes document_kind at the contract's fourteen names", () => {
    const sql = NINTH?.sql ?? "";
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    const kinds = [
      "CAPABILITY_POLICY",
      "MODEL_VERSION",
      "PRICE_TABLE",
      "MODEL_PERFORMANCE",
      "ROUTING_ASSIGNMENT_GLOBAL",
      "ESTIMATION_POLICY",
      "INTEGRATION_PROFILE",
      "INTEGRATION_INSTALLATION",
      "COMPOSITION_POLICY",
      "COMPOSITION_EVIDENCE",
      "NOTIFICATION_POLICY",
      "APPROVAL_WAIT_POLICY",
      "DUEL_POLICY",
      "ANOMALY_POLICY",
    ];
    for (const kind of kinds) {
      expect(sql, kind).toContain("'" + kind + "'");
    }
    expect(DOCUMENT_KINDS).toEqual(kinds);
  });

  it("creates the three indexes and the three triggers the contract names", () => {
    const sql = NINTH?.sql ?? "";
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    for (const index of [
      "ux_registry_events__document_id__document_version",
      "ix_registry_events__document_kind__document_id__document_version",
      "ix_registry_events__document_id__effective_from",
    ]) {
      expect(sql, index).toContain(index);
    }
    // All three under the §3.2 convention. The first three streams carry the
    // legacy `<table>_deny_*` names because they are frozen inside applied
    // migrations; a stream created from migration 7 onward does not inherit a
    // shape it never had to.
    for (const trigger of [
      "tr_registry_events__deny_update",
      "tr_registry_events__deny_delete",
      "tr_registry_events__validate_new_rows",
    ]) {
      expect(sql, trigger).toContain("CREATE TRIGGER " + trigger);
    }
    expect(sql).not.toContain("CREATE TRIGGER registry_events_deny_");
  });

  it("widens the causal vocabulary to three by recreating migration 8's triggers", () => {
    const sql = NINTH?.sql ?? "";
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    for (const table of ["control_plane_events", "initiative_events"]) {
      expect(sql, table).toContain("DROP TRIGGER tr_" + table + "__validate_new_rows");
      expect(sql, table).toContain(
        "CREATE TRIGGER tr_" + table + "__validate_new_rows\nBEFORE INSERT ON " + table,
      );
    }
    expect(sql).toContain(
      "NOT IN ('control_plane_events', 'initiative_events', 'registry_events')",
    );
    // Three streams resolved in each of three triggers.
    expect((sql.match(/NOT EXISTS/g) ?? []).length).toBe(9);
  });

  it("leaves migration 8's own text exactly as it was applied", () => {
    // Rewriting an applied migration is the one thing the migration file
    // forbids, and every ledger in the field compares its recorded checksum on
    // every open. The widening is a DROP and a CREATE in a NEW migration.
    const EIGHTH = MIGRATIONS[7];
    expect(EIGHTH?.name).toBe("causation_triplet");
    expect(EIGHTH?.sql ?? "").toContain("NOT IN ('control_plane_events', 'initiative_events')");
    expect(EIGHTH?.sql ?? "").not.toContain("registry_events");
    expect((EIGHTH?.sql.match(/NOT EXISTS/g) ?? []).length).toBe(4);
  });

  it("never admits the account stream as a causal value (D3)", () => {
    // Completing the vocabulary to four while the trigger is being recreated is
    // the easiest way this packet could have introduced a reference nobody can
    // check. The account stream gets a digest in P-08, or not at all.
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    expect(NINTH?.sql ?? "").not.toContain("account_events");
  });

  it("creates both routing tables with the partial unique indexes the contract requires", () => {
    const sql = NINTH?.sql ?? "";
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    expect(sql).toContain("CREATE TABLE routing_assignment_read_model");
    // `allowed_fallbacks_json` is forbidden by §3.5 of the database contract:
    // the fallbacks are rows, not a JSON blob in a column.
    expect(sql).toContain("CREATE TABLE routing_assignment_fallback");
    expect(sql).not.toContain("allowed_fallbacks_json");
    expect(sql).toContain("CONSTRAINT ck_routing_assignment_read_model__scope_id_required");
    expect(sql).toContain("CONSTRAINT ck_routing_assignment_read_model__source_scope");
    // A UNIQUE index over a nullable column does not enforce uniqueness by
    // itself (§7.7), which is why both are partial and neither is one index.
    expect(sql).toContain(
      "CREATE UNIQUE INDEX ux_routing_assignment_read_model__global\n" +
        "  ON routing_assignment_read_model (role, slot, version)\n" +
        "  WHERE scope_kind = 'GLOBAL'",
    );
    expect(sql).toContain(
      "CREATE UNIQUE INDEX ux_routing_assignment_read_model__scoped\n" +
        "  ON routing_assignment_read_model (scope_kind, scope_id, role, slot, version)\n" +
        "  WHERE scope_kind <> 'GLOBAL'",
    );
    expect(sql).toContain("ix_routing_assignment_read_model__resolution");
  });

  it("seeds the registry head at genesis and the initiative row from the head it finds", () => {
    const sql = NINTH?.sql ?? "";
    expect(NINTH?.name, "the migration under test must exist").toBe("registry_stream");
    for (const key of [
      "'registry_head_sequence'",
      "'registry_head_event_sha256'",
      "'registry_event_count'",
    ]) {
      expect(sql, key).toContain(key);
    }
    // The registry row may honestly be zero because the stream is born empty in
    // this same migration. The initiative row may not: the fold over an
    // existing history is empty by construction, so the projection is level
    // with that head the moment the table exists, and a row frozen at zero
    // behind a non-zero head is what verifyIntegrity reports as corruption.
    for (const key of [
      "'initiative_head_sequence'",
      "'initiative_event_count'",
      "'initiative_head_event_sha256'",
    ]) {
      expect(sql, key).toContain(key);
    }
  });

  it("inventories every object it creates, and every trigger by prefix", () => {
    const registryObjects = EXPECTED_SCHEMA_OBJECTS.filter((object) =>
      object.name.includes("registry_events"),
    );
    expect(registryObjects).toEqual([
      { type: "table", name: "registry_events" },
      { type: "index", name: "ux_registry_events__document_id__document_version" },
      { type: "index", name: "ix_registry_events__document_kind__document_id__document_version" },
      { type: "index", name: "ix_registry_events__document_id__effective_from" },
      // Migration 15's one addition to the stream's own objects.
      { type: "index", name: "ix_registry_events__subject_kind__document_id" },
      { type: "trigger", name: "tr_registry_events__deny_update" },
      { type: "trigger", name: "tr_registry_events__deny_delete" },
      { type: "trigger", name: "tr_registry_events__validate_new_rows" },
    ]);

    const routingObjects = EXPECTED_SCHEMA_OBJECTS.filter((object) =>
      object.name.includes("routing_assignment"),
    );
    expect(routingObjects).toEqual([
      { type: "table", name: "routing_assignment_read_model" },
      { type: "index", name: "ux_routing_assignment_read_model__global" },
      { type: "index", name: "ux_routing_assignment_read_model__scoped" },
      { type: "index", name: "ix_routing_assignment_read_model__resolution" },
      { type: "table", name: "routing_assignment_fallback" },
    ]);
  });

  it("clears the child of the foreign key before its parent on a rebuild", () => {
    // `foreign_keys` is ON, so the order in DERIVED_TABLES is load-bearing:
    // deleting the assignment rows first would abort on the fallback rows that
    // still reference them.
    const fallbackAt = DERIVED_TABLES.indexOf("routing_assignment_fallback");
    const assignmentAt = DERIVED_TABLES.indexOf("routing_assignment_read_model");
    expect(fallbackAt).toBeGreaterThanOrEqual(0);
    expect(assignmentAt).toBeGreaterThanOrEqual(0);
    expect(fallbackAt).toBeLessThan(assignmentAt);
  });
});

describe("the two-source projection is the only name with two watermark rows", () => {
  it("pairs the routing projection with both of the streams that feed it", () => {
    expect(
      PROJECTION_SOURCES.filter(
        (source) => source.projectionName === "routing_assignment_read_model",
      ).map((source) => source.sourceStream),
    ).toEqual(["registry_events", "initiative_events"]);
  });

  it("leaves every other projection with exactly one source", () => {
    const counts = new Map<string, number>();
    for (const source of PROJECTION_SOURCES) {
      counts.set(source.projectionName, (counts.get(source.projectionName) ?? 0) + 1);
    }
    expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([
      ["routing_assignment_read_model", 2],
    ]);
    expect(PROJECTION_SOURCES).toHaveLength(20);
  });

  it("still does not claim the account stream (D3)", () => {
    expect(
      PROJECTION_SOURCES.some((source) => source.sourceStream === "account_events"),
    ).toBe(false);
  });
});

describe("migration 11 adds the revision coordinate without touching the applied ten", () => {
  const ELEVENTH = MIGRATIONS[10];

  /**
   * The migration's statements with its commentary removed.
   *
   * Every "does not contain" assertion below runs against this rather than the
   * raw SQL, because the header comments explain at length what the migration
   * deliberately does NOT do — and a test that read those sentences as
   * statements would fail on the prose that exists to prevent the very mistake
   * it is checking for.
   */
  const statements = (ELEVENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("sits at the tail of a set whose order is fixed, and rewrites none of it", () => {
    expect(ELEVENTH?.version).toBe(11);
    expect(ELEVENTH?.name).toBe("task_revision_identity");

    // The ten before it are byte-identical to what a ledger in the field
    // already applied. A migration set is checksummed on every open, so a
    // single edited character above would refuse every existing database.
    for (const migration of MIGRATIONS.slice(0, 10)) {
      expect(migration.sha256, migration.name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(statements).not.toContain("DROP TABLE");
    expect(statements).not.toContain("DROP TRIGGER");
  });

  it("adds the two coordinate columns as additive, never as a table rewrite", () => {
    const sql = ELEVENTH?.sql ?? "";
    // `ALTER TABLE ... ADD COLUMN` and nothing else: migration 1 is immutable,
    // so the coordinate arrives beside `attempt` rather than replacing it.
    expect(sql).toContain("ALTER TABLE control_plane_events ADD COLUMN revision_number INTEGER");
    expect(sql).toContain("ALTER TABLE control_plane_events ADD COLUMN attempt_number INTEGER");
    expect(statements).not.toContain("CREATE TABLE control_plane_events");

    // Neither column is NOT NULL, and that is the lawful window: every row
    // written before this migration keeps both empty, for ever.
    expect(statements).not.toContain("ADD COLUMN revision_number INTEGER NOT NULL");
    expect(statements).not.toContain("ADD COLUMN attempt_number INTEGER NOT NULL");
  });

  it("names the revision table's constraints by the §3.2 convention", () => {
    const sql = ELEVENTH?.sql ?? "";
    expect(sql).toContain("CREATE TABLE task_revision_read_model");
    expect(sql).toContain(") STRICT;");
    expect(sql).toContain(
      "CONSTRAINT pk_task_revision_read_model PRIMARY KEY (task_id, revision_number)",
    );
    expect(sql).toContain(
      "CONSTRAINT ck_task_revision_read_model__revision_number CHECK (revision_number >= 1)",
    );
    expect(sql).toContain("CREATE UNIQUE INDEX ux_task_revision_read_model__revision_id");

    // The digest index is deliberately NOT unique: restoring an earlier
    // envelope is a new revision with the same digest (§7.3), and a unique
    // index there would forbid exactly the case the model exists to allow.
    expect(sql).toContain(
      "CREATE INDEX ix_task_revision_read_model__envelope_sha256\n  ON task_revision_read_model (envelope_sha256, task_id, revision_number)",
    );
    expect(statements).not.toContain(
      "CREATE UNIQUE INDEX ix_task_revision_read_model__envelope_sha256",
    );
    expect(statements).not.toContain("UNIQUE (task_id, envelope_sha256)");

    // And the column P-36/local owns is absent rather than nullable-here.
    expect(statements).not.toContain("envelope_artifact_reference_id");
  });

  it("seeds its watermark from the head, never from a literal zero", () => {
    const sql = ELEVENTH?.sql ?? "";
    // The `INSERT ... SELECT` form, which is migration 9's second case: this
    // projection arrives over a stream that may already hold a long history.
    expect(sql).toContain("INSERT INTO projection_watermark");
    expect(sql).toContain("'task_revision_read_model',\n  'control_plane_events',");
    for (const key of ["head_sequence", "event_count", "head_event_sha256"]) {
      expect(sql, key).toContain("WHERE key = '" + key + "'");
    }
    // A literal zero seed would be the shape migrations 6 and 7 carry a comment
    // about: a projection frozen behind a non-zero head, reported as corrupt
    // immediately after a routine upgrade.
    expect(statements).not.toContain("'control_plane_events',\n  1,\n  0,\n  0,");
  });

  it("adds six additive columns to the task projection, all of them nullable", () => {
    const sql = ELEVENTH?.sql ?? "";
    // Three with a producer in this packet, three without. The second group is
    // documented nullity rather than accident: execution §1 authorizes it, and
    // nobody invents a payload key to fill a column.
    for (const column of ["envelope_sha256", "latest_revision_number", "latest_attempt_number"]) {
      expect(sql, column).toContain("ALTER TABLE task_read_model ADD COLUMN " + column);
    }
    for (const column of ["role", "step_id", "commit_policy"]) {
      expect(sql, column).toContain("ALTER TABLE task_read_model ADD COLUMN " + column);
    }
    // `duel_id` and `state_vocabulary` are NOT here: their producers are other
    // packets, and a column with no producer and no CHECK would be a shape the
    // dictionary does not authorize yet.
    expect(statements).not.toContain("duel_id");
    expect(statements).not.toContain("state_vocabulary");
    // No DROP COLUMN anywhere: an applied migration admits none.
    expect(statements).not.toContain("DROP COLUMN");
  });

  it("declares the projection in all four places that have to agree", () => {
    // The name is spelled in the derived-table list, the projection names, the
    // source pairs and the object inventory. A projection missing from any one
    // of them is a projection that a rebuild, a watermark or the schema check
    // silently skips.
    expect(TASK_REVISION_PROJECTION).toBe("task_revision_read_model");
    expect(DERIVED_TABLES).toContain(TASK_REVISION_PROJECTION);
    expect(PROJECTION_NAMES).toContain(TASK_REVISION_PROJECTION);
    expect(
      PROJECTION_SOURCES.filter((source) => source.projectionName === TASK_REVISION_PROJECTION),
    ).toEqual([{ projectionName: TASK_REVISION_PROJECTION, sourceStream: "control_plane_events" }]);
    expect(EXPECTED_SCHEMA_OBJECTS).toContainEqual({
      type: "table",
      name: TASK_REVISION_PROJECTION,
    });

    // It is cleared before `task_read_model`, which is the order the derived
    // list documents: the rebuild clears children before parents.
    expect(DERIVED_TABLES.indexOf(TASK_REVISION_PROJECTION)).toBeLessThan(
      DERIVED_TABLES.indexOf("task_read_model"),
    );

    // And the named migration number matches where the SQL actually sits.
    expect(TASK_REVISION_MIGRATION).toBe(11);
    expect(MIGRATIONS[TASK_REVISION_MIGRATION - 1]?.name).toBe("task_revision_identity");
  });
});

describe("migration 12 adds the attempt's own record without touching the applied eleven", () => {
  const TWELFTH = MIGRATIONS[11];

  /** The migration's statements with its commentary removed — migration 11's helper, verbatim in intent. */
  const statements = (TWELFTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("sits at the tail of a set whose order is fixed, and rewrites none of it", () => {
    expect(TWELFTH?.version).toBe(12);
    expect(TWELFTH?.name).toBe("task_attempt_identity");

    // The eleven before it are byte-identical to what a ledger in the field
    // already applied. A migration set is checksummed on every open, so a
    // single edited character above would refuse every existing database.
    for (const migration of MIGRATIONS.slice(0, 11)) {
      expect(migration.sha256, migration.name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(statements).not.toContain("DROP TABLE");
    expect(statements).not.toContain("DROP TRIGGER");
    expect(statements).not.toContain("ALTER TABLE");
  });

  it("names the attempt table's constraints by the §3.2 convention", () => {
    const sql = TWELFTH?.sql ?? "";
    expect(sql).toContain("CREATE TABLE task_attempt_read_model");
    expect(sql).toContain(") STRICT;");
    for (const rule of [
      "pk_task_attempt_read_model\n    PRIMARY KEY (task_id, revision_number, attempt_number)",
      "fk_task_attempt_read_model__task_revision_read_model",
      "ck_task_attempt_read_model__attempt_number\n    CHECK (attempt_number >= 1)",
      "ck_task_attempt_read_model__legacy_attempt_number\n    CHECK (legacy_attempt_number >= 1)",
      "ck_task_attempt_read_model__outcome_pair\n    CHECK ((ended_at IS NULL) = (outcome IS NULL))",
    ]) {
      expect(sql, rule).toContain("CONSTRAINT " + rule);
    }
    // The outcome vocabulary is `effect_outcome_status`, all four words of it.
    for (const word of ["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]) {
      expect(sql, word).toContain("'" + word + "'");
    }
  });

  it("makes both halves of the bijection unique, and neither one merely indexed", () => {
    const sql = TWELFTH?.sql ?? "";
    // `(task_id, legacy_attempt_number)` is what makes the flat number usable
    // as `control_plane_events.attempt`: two coordinates sharing it would make
    // the legacy column ambiguous for every query written before migration 11.
    expect(sql).toContain(
      "CREATE UNIQUE INDEX ux_task_attempt_read_model__task_id_legacy_attempt_number\n" +
        "  ON task_attempt_read_model (task_id, legacy_attempt_number)",
    );
    // And the invocation is unique GLOBALLY, not per task: with the primary key
    // that is the bijection execution §3 asks for. A per-task uniqueness would
    // let one invocation name attempts of two different tasks.
    expect(sql).toContain(
      "CREATE UNIQUE INDEX ux_task_attempt_read_model__invocation_id\n" +
        "  ON task_attempt_read_model (invocation_id)",
    );
    expect(statements).not.toContain("CREATE INDEX ux_task_attempt_read_model");
    expect(statements).not.toContain("(invocation_id, task_id)");
  });

  it("adds no trigger, which is a decision and not an omission", () => {
    // ADR 0073, §2.5-D of the preaudit. The pairing rule between
    // `payload.legacyAttemptNumber` and the `attempt` column is held by the
    // append door as a typed refusal naming the expected value — something a
    // `BEFORE INSERT` trigger could not do, because the expected value comes
    // from `MAX(attempt)` and the projection. So `tr_` stayed at eight here;
    // the ninth is migration 16's, which is another table's rule.
    expect(statements).not.toContain("CREATE TRIGGER");
    const triggers = EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("tr_"));
    expect(triggers).toHaveLength(9);
    expect(triggers.filter((object) => object.name.startsWith("tr_task_attempt"))).toEqual([]);
  });

  it("seeds its watermark from the head, never from a literal zero", () => {
    const sql = TWELFTH?.sql ?? "";
    // Migration 11's form, which is migration 9's second case: the projection
    // arrives over a stream that may already hold a long history, and the fold
    // over all of it is legitimately empty.
    expect(sql).toContain("INSERT INTO projection_watermark");
    expect(sql).toContain("'task_attempt_read_model',\n  'control_plane_events',");
    for (const key of ["head_sequence", "event_count", "head_event_sha256"]) {
      expect(sql, key).toContain("WHERE key = '" + key + "'");
    }
    // A literal zero seed is what verifyIntegrity reports as corruption on
    // every ledger in the field immediately after a routine upgrade.
    expect(statements).not.toContain("'control_plane_events',\n  1,\n  0,\n  0,");
  });

  it("declares the projection in all four places that have to agree", () => {
    expect(TASK_ATTEMPT_PROJECTION).toBe("task_attempt_read_model");
    expect(DERIVED_TABLES).toContain(TASK_ATTEMPT_PROJECTION);
    expect(PROJECTION_NAMES).toContain(TASK_ATTEMPT_PROJECTION);
    expect(
      PROJECTION_SOURCES.filter((source) => source.projectionName === TASK_ATTEMPT_PROJECTION),
    ).toEqual([{ projectionName: TASK_ATTEMPT_PROJECTION, sourceStream: "control_plane_events" }]);
    expect(EXPECTED_SCHEMA_OBJECTS).toContainEqual({
      type: "table",
      name: TASK_ATTEMPT_PROJECTION,
    });

    // And the named migration number matches where the SQL actually sits.
    expect(TASK_ATTEMPT_MIGRATION).toBe(12);
    expect(MIGRATIONS[TASK_ATTEMPT_MIGRATION - 1]?.name).toBe("task_attempt_identity");
  });

  it("clears the attempt table before the revisions it references", () => {
    // `foreign_keys` is ON, so the order in `DERIVED_TABLES` is load-bearing
    // exactly as it is for `routing_assignment_fallback`: deleting the revision
    // rows first would abort on the attempt rows still pointing at them.
    const attemptAt = DERIVED_TABLES.indexOf(TASK_ATTEMPT_PROJECTION);
    const revisionAt = DERIVED_TABLES.indexOf(TASK_REVISION_PROJECTION);
    expect(attemptAt).toBeGreaterThanOrEqual(0);
    expect(attemptAt).toBeLessThan(revisionAt);
    // And still before `task_read_model`, which the revision already was.
    expect(attemptAt).toBeLessThan(DERIVED_TABLES.indexOf("task_read_model"));
  });

  it("inventories the table and both indexes, and nothing else", () => {
    const added = EXPECTED_SCHEMA_OBJECTS.filter((object) =>
      object.name.includes("task_attempt_read_model"),
    );
    expect(added).toEqual([
      { type: "table", name: "task_attempt_read_model" },
      { type: "index", name: "ux_task_attempt_read_model__task_id_legacy_attempt_number" },
      { type: "index", name: "ux_task_attempt_read_model__invocation_id" },
    ]);
  });
});

describe("migration 14 adds the occurrences without touching the applied thirteen", () => {
  const FOURTEENTH = MIGRATIONS[13];

  /** The migration's statements with its commentary removed, as for 11 and 12. */
  const statements = (FOURTEENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("sits at the tail of a set whose order is fixed, and rewrites none of it", () => {
    expect(FOURTEENTH?.version).toBe(14);
    expect(FOURTEENTH?.name).toBe("execution_occurrences");
    expect(EXECUTION_OCCURRENCE_MIGRATION).toBe(14);
    expect(MIGRATIONS[EXECUTION_OCCURRENCE_MIGRATION - 1]?.name).toBe("execution_occurrences");
    // No longer the tail: migration 15 follows it and holds the length pin.
    expect(statements).not.toContain("DROP TABLE");
    expect(statements).not.toContain("ALTER TABLE");
    // No trigger: every rule of §8 that one row can carry is a CHECK, and the
    // equality between a prompt and its delivery is the fold's and the door's.
    expect(statements).not.toContain("CREATE TRIGGER");
    // Eight when this migration landed; migration 16 adds the ninth.
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("tr_"))).toHaveLength(9);
  });

  it("names both tables' constraints by the §3.2 convention, and §8's pair verbatim", () => {
    const sql = FOURTEENTH?.sql ?? "";
    expect(sql).toContain("CREATE TABLE prompt_occurrence_read_model");
    expect(sql).toContain("CREATE TABLE response_occurrence_read_model");
    expect(sql.match(/\) STRICT;/g)).toHaveLength(2);
    for (const rule of [
      "pk_prompt_occurrence_read_model PRIMARY KEY (occurrence_id)",
      "fk_prompt_occurrence_read_model__execution_route_segment_read_model",
      "fk_prompt_occurrence_read_model__effect_read_model",
      "fk_prompt_occurrence_read_model__dispatch_attempt_read_model",
      "ck_prompt_occurrence_read_model__ordinal\n    CHECK (ordinal >= 0)",
      "ck_prompt_occurrence_read_model__model_resolution_pair\n" +
        "    CHECK ((model_resolution_status = 'RESOLVED') = (model_version_id IS NOT NULL))",
      "ck_prompt_occurrence_read_model__prompt_bytes\n    CHECK (prompt_bytes >= 0)",
      "pk_response_occurrence_read_model PRIMARY KEY (occurrence_id)",
      "fk_response_occurrence_read_model__prompt_occurrence_read_model",
      "ck_response_occurrence_read_model__response_bytes\n    CHECK (response_bytes >= 0)",
      "ck_response_occurrence_read_model__redaction_verdict\n" +
        "    CHECK (redaction_verdict IN ('CLEAN', 'REDACTED'))",
    ]) {
      expect(sql, rule).toContain("CONSTRAINT " + rule);
    }
    // The four foreign keys are deferred, because §8 `:419-420` admits the
    // delivery's intention and its prompt in one `appendBatch`.
    expect(statements.match(/ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(4);
  });

  it("N-P18-18: the digest is indexed and never unique, and the answer is one per prompt", () => {
    // The same bytes sent twice are two occurrences and one blob (§8 `:377-379`,
    // `:394`, `:429`). A unique index here would make the second send
    // unrecordable, which is the legacy defect this table replaces.
    expect(statements).toContain(
      "CREATE INDEX ix_prompt_occurrence_read_model__sha256\n" +
        "  ON prompt_occurrence_read_model (prompt_sha256)",
    );
    expect(statements).not.toContain("UNIQUE INDEX ix_prompt_occurrence_read_model__sha256");
    expect(statements).not.toMatch(/UNIQUE[^;]*prompt_sha256/);
    // Nor is the delivery unique: one delivery may send several prompts (§8 `:387`).
    expect(statements).not.toMatch(/UNIQUE[^;]*dispatch_attempt_id/);
    expect(statements).toContain(
      "CREATE INDEX ix_prompt_occurrence_read_model__segment\n" +
        "  ON prompt_occurrence_read_model (route_segment_id, ordinal)",
    );
    // And one answer per prompt occurrence (§8 `:431`), unique on purpose.
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_response_occurrence_read_model__prompt\n" +
        "  ON response_occurrence_read_model (prompt_occurrence_id)",
    );
  });

  it("holds digests and counts, never bytes, and adds no CHECK §8 does not list", () => {
    // §8 `:433`. No column could hold a prompt or an answer: every TEXT column
    // is an id, a vocabulary word, an instant or a digest.
    for (const column of ["prompt_text", "prompt_body", "response_text", "response_body", " BLOB"]) {
      expect(statements, column).not.toContain(column);
    }
    // The digests carry no shape CHECK — §8 lists none, and the door checks the
    // shape as payload grammar instead (ADR 0077).
    expect(statements).not.toContain("_sha256_shape");
    expect(statements).not.toContain("GLOB");
  });

  it("seeds its two watermarks from the head, never from a literal zero", () => {
    expect(statements).toContain("INSERT INTO projection_watermark");
    expect(statements).toContain("SELECT 'prompt_occurrence_read_model' AS name");
    expect(statements).toContain("UNION ALL SELECT 'response_occurrence_read_model'");
    for (const key of ["head_sequence", "event_count", "head_event_sha256"]) {
      expect(statements, key).toContain("WHERE key = '" + key + "'");
    }
  });

  it("declares both projections in all four places that have to agree", () => {
    for (const name of [PROMPT_OCCURRENCE_PROJECTION, RESPONSE_OCCURRENCE_PROJECTION]) {
      expect(DERIVED_TABLES, name).toContain(name);
      expect(PROJECTION_NAMES, name).toContain(name);
      expect(
        PROJECTION_SOURCES.filter((source) => source.projectionName === name),
      ).toEqual([{ projectionName: name, sourceStream: "control_plane_events" }]);
      expect(EXPECTED_SCHEMA_OBJECTS).toContainEqual({ type: "table", name });
    }
    // Ten when this migration landed; the eleventh is P-14 C's client key.
    expect(PROJECTION_NAMES).toHaveLength(11);
  });

  it("clears the answers before the prompts, and the prompts before the deliveries", () => {
    const responseAt = DERIVED_TABLES.indexOf(RESPONSE_OCCURRENCE_PROJECTION);
    const promptAt = DERIVED_TABLES.indexOf(PROMPT_OCCURRENCE_PROJECTION);
    expect(responseAt).toBeGreaterThanOrEqual(0);
    expect(responseAt).toBeLessThan(promptAt);
    expect(promptAt).toBeLessThan(DERIVED_TABLES.indexOf(DISPATCH_ATTEMPT_PROJECTION));
    expect(promptAt).toBeLessThan(DERIVED_TABLES.indexOf("effect_read_model"));
    expect(promptAt).toBeLessThan(DERIVED_TABLES.indexOf("execution_route_segment_read_model"));
  });

  it("inventories the two tables and three indexes, and nothing else", () => {
    const added = EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.includes("occurrence"));
    expect(added).toEqual([
      { type: "table", name: "prompt_occurrence_read_model" },
      { type: "index", name: "ix_prompt_occurrence_read_model__segment" },
      { type: "index", name: "ix_prompt_occurrence_read_model__sha256" },
      { type: "table", name: "response_occurrence_read_model" },
      { type: "index", name: "ux_response_occurrence_read_model__prompt" },
    ]);
  });
});

/**
 * Migration 15, the registry stream rebuilt with a subject kind and the four
 * artifact read models (P-36/local escalón A, ADR 0081).
 *
 * The weight is on the rebuild's order, which the preaudit probed step by step
 * (H-2): a variant that renamed the table while two triggers on OTHER tables
 * still named it aborted, and a variant that relied on
 * `PRAGMA legacy_alter_table` was discarded. What is asserted here is the text;
 * `test/ledger` asserts what the text does to a ledger that already has a chain.
 */
describe("migration 15 rebuilds the registry stream and adds the artifact plane", () => {
  const FIFTEENTH = MIGRATIONS[14];
  /** The four names this migration seeds, as it spells them. */
  const ARTIFACT_PROJECTIONS = [
    ARTIFACT_BLOB_PROJECTION,
    ARTIFACT_REFERENCE_PROJECTION,
    ARTIFACT_PIN_PROJECTION,
    ARTIFACT_TOMBSTONE_PROJECTION,
  ] as const;
  const NINTH = MIGRATIONS[8];

  /** The statements with the commentary removed, as for 11, 12 and 14. */
  const statements = (FIFTEENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  /** One `CREATE TRIGGER ... END;` body, sliced out of a migration's text. */
  function triggerBody(sql: string, name: string): string {
    const start = sql.indexOf("CREATE TRIGGER " + name + "\n");
    const end = sql.indexOf("END;", start);
    expect(start, name).toBeGreaterThanOrEqual(0);
    expect(end, name).toBeGreaterThan(start);
    return sql.slice(start, end + "END;".length);
  }

  /** The quoted words of one named CHECK, in the order the SQL lists them. */
  function checkWords(sql: string, constraint: string): string[] {
    const start = sql.indexOf("CONSTRAINT " + constraint + " CHECK (");
    expect(start, constraint).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf("\n  )", start);
    return [...sql.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] ?? "");
  }

  it("sits at the tail of a set whose order is fixed", () => {
    expect(FIFTEENTH?.version).toBe(15);
    expect(FIFTEENTH?.name).toBe("artifact_registry");
    expect(ARTIFACT_REGISTRY_MIGRATION).toBe(15);
    expect(MIGRATIONS[ARTIFACT_REGISTRY_MIGRATION - 1]?.name).toBe("artifact_registry");
    // No longer the tail: migration 16 follows it and holds the length pin.
    expect(MIGRATIONS[15]?.version).toBe(16);
  });

  it("rebuilds in the fixed order: create, copy, drop the five triggers, drop, rename, recreate, then the children", () => {
    const at = (fragment: string): number => {
      const index = statements.indexOf(fragment);
      expect(index, fragment).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at("CREATE TABLE registry_events__rebuilt ("),
      at("INSERT INTO registry_events__rebuilt ("),
      at("DROP TRIGGER tr_registry_events__validate_new_rows;"),
      at("DROP TRIGGER tr_control_plane_events__validate_new_rows;"),
      at("DROP TRIGGER tr_initiative_events__validate_new_rows;"),
      at("DROP TABLE registry_events;"),
      at("ALTER TABLE registry_events__rebuilt RENAME TO registry_events;"),
      at("CREATE UNIQUE INDEX ux_registry_events__document_id__document_version"),
      at("CREATE TRIGGER tr_registry_events__validate_new_rows"),
      at("CREATE TRIGGER tr_control_plane_events__validate_new_rows"),
      at("CREATE TRIGGER tr_initiative_events__validate_new_rows"),
      at("CREATE TABLE artifact_blob_read_model ("),
      at("CREATE TABLE artifact_reference_read_model ("),
      at("CREATE TABLE artifact_pin_read_model ("),
      at("CREATE TABLE artifact_tombstone_read_model ("),
      at("INSERT INTO projection_watermark"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The three own triggers go too, before the table they sit on is dropped.
    for (const own of ["tr_registry_events__deny_delete", "tr_registry_events__deny_update"]) {
      expect(order[5] ?? 0).toBeGreaterThan(at("DROP TRIGGER " + own + ";"));
    }
  });

  it("copies every row as it is, in sequence order, and marks each a document", () => {
    expect(statements).toContain(
      "SELECT\n  sequence, event_id, idempotency_key, 'DOCUMENT', document_kind, NULL,",
    );
    expect(statements).toContain("FROM registry_events\nORDER BY sequence;");
    // The chain's two columns are copied, and nothing is recomputed or rewritten.
    expect(statements).toContain("causation_sha256, contract_version, event_json, previous_sha256, event_sha256\nFROM");
    expect(statements).not.toMatch(/^UPDATE /m);
  });

  it("uses no pragma and no legacy rename mode, so nothing about the connection changes", () => {
    expect(statements).not.toMatch(/PRAGMA/i);
    expect(statements).not.toContain("legacy_alter_table");
    expect(statements).not.toContain("foreign_keys");
  });

  it("recreates the two foreign triggers and the stream's own three byte-identical to migration 9", () => {
    for (const name of [
      "tr_control_plane_events__validate_new_rows",
      "tr_initiative_events__validate_new_rows",
      "tr_registry_events__deny_update",
      "tr_registry_events__deny_delete",
      "tr_registry_events__validate_new_rows",
    ]) {
      expect(triggerBody(FIFTEENTH?.sql ?? "", name), name).toBe(triggerBody(NINTH?.sql ?? "", name));
    }
  });

  it("keeps migration 9's constraint names and adds the subject kind with both mirrors", () => {
    for (const rule of [
      "ck_registry_events__subject_kind",
      "ck_registry_events__document_kind",
      "ck_registry_events__artifact_event_kind",
      "ck_registry_events__document_kind_matches_subject",
      "ck_registry_events__artifact_event_kind_matches_subject",
      "ck_registry_events__document_version",
      "ck_registry_events__parent_document_version",
      "ck_registry_events__content_digest",
      "ck_registry_events__causation_pair",
      "ck_registry_events__causation_sequence",
      "ck_registry_events__causation_sha256",
      "ck_registry_events__previous_sha256",
      "ck_registry_events__event_sha256",
    ]) {
      expect(statements, rule).toContain("CONSTRAINT " + rule + " CHECK (");
    }
    expect(statements).toContain("  subject_kind            TEXT    NOT NULL,\n");
    expect(statements).toContain("  document_kind           TEXT,\n");
    expect(statements).toContain("  artifact_event_kind     TEXT,\n");
    // Mirrors as equalities of truth values, never as a disjunction a NULL
    // would satisfy.
    expect(statements).toContain("(subject_kind = 'DOCUMENT') = (document_kind IS NOT NULL)");
    expect(statements).toContain("(subject_kind = 'ARTIFACT') = (artifact_event_kind IS NOT NULL)");
    expect(checkWords(statements, "ck_registry_events__subject_kind")).toEqual(["DOCUMENT", "ARTIFACT"]);
    expect(checkWords(statements, "ck_registry_events__document_kind")).toEqual([...DOCUMENT_KINDS]);
  });

  it("closes artifact_event_kind at the contract's nine names, by equality with the contract", () => {
    // The pin ADR 0081 proposes: the CHECK and `ARTIFACT_EVENT_KINDS` are two
    // declarations of one vocabulary, and a name added to one alone fails here
    // instead of aborting an append.
    expect(checkWords(statements, "ck_registry_events__artifact_event_kind")).toEqual([
      ...ARTIFACT_EVENT_KINDS,
    ]);
    expect(ARTIFACT_EVENT_KINDS).toHaveLength(9);
  });

  it("adds exactly one index to the stream, and leaves migration 9's text as it was applied", () => {
    expect(statements).toContain(
      "CREATE INDEX ix_registry_events__subject_kind__document_id\n" +
        "  ON registry_events (subject_kind, document_id);",
    );
    expect(NINTH?.sql ?? "").toContain("document_kind           TEXT    NOT NULL,");
    expect(NINTH?.sql ?? "").not.toContain("subject_kind");
    for (const migration of MIGRATIONS.slice(0, 14)) {
      expect(migration.sql, migration.name).not.toContain("subject_kind");
      expect(migration.sql, migration.name).not.toContain("artifact_blob_read_model");
    }
  });

  it("names every constraint of the four read models literally (M-7)", () => {
    for (const rule of [
      "pk_artifact_blob_read_model PRIMARY KEY (content_sha256, blob_generation)",
      "fk_artifact_blob_read_model__registry_events",
      "ck_artifact_blob_read_model__content_sha256_hex",
      "ck_artifact_blob_read_model__blob_generation_positive CHECK (blob_generation > 0)",
      "ck_artifact_blob_read_model__size_bytes_non_negative CHECK (size_bytes >= 0)",
      "ck_artifact_blob_read_model__lifecycle_state_enum",
      "ck_artifact_blob_read_model__encryption_status_enum",
      "ck_artifact_blob_read_model__key_reference_matches_encryption",
      "ck_artifact_blob_read_model__first_published_pair",
      "ck_artifact_blob_read_model__first_published_matches_state",
      "pk_artifact_reference_read_model PRIMARY KEY (artifact_reference_id)",
      "fk_artifact_reference_read_model__artifact_blob_read_model",
      "fk_artifact_reference_read_model__registry_events",
      "ck_artifact_reference_read_model__artifact_class_enum",
      "ck_artifact_reference_read_model__classification_enum",
      "ck_artifact_reference_read_model__scope_kind_enum",
      "ck_artifact_reference_read_model__scope_id_matches_scope_kind",
      "ck_artifact_reference_read_model__retention_class_enum",
      "ck_artifact_reference_read_model__expires_at_matches_retention_class",
      "ck_artifact_reference_read_model__tombstone_reason_matches",
      "pk_artifact_pin_read_model PRIMARY KEY (artifact_pin_id)",
      "fk_artifact_pin_read_model__artifact_blob_read_model",
      "ck_artifact_pin_read_model__pin_holder_kind_enum",
      "pk_artifact_tombstone_read_model PRIMARY KEY (artifact_reference_id)",
      "fk_artifact_tombstone_read_model__artifact_reference_read_model",
      "fk_artifact_tombstone_read_model__artifact_blob_read_model",
      "fk_artifact_tombstone_read_model__registry_events",
      "ck_artifact_tombstone_read_model__reason_enum",
    ]) {
      expect(statements, rule).toContain("CONSTRAINT " + rule);
    }
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_artifact_blob_read_model__content_sha256__unreclaimed\n" +
        "  ON artifact_blob_read_model (content_sha256)\n" +
        "  WHERE lifecycle_state <> 'RECLAIMED';",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_artifact_blob_read_model__reclaim_id\n" +
        "  ON artifact_blob_read_model (reclaim_id)\n" +
        "  WHERE reclaim_id IS NOT NULL;",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_artifact_reference_read_model__id_content_generation\n" +
        "  ON artifact_reference_read_model (artifact_reference_id, content_sha256, blob_generation);",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_artifact_pin_read_model__content_sha256_holder__live\n" +
        "  ON artifact_pin_read_model (content_sha256, blob_generation, pin_holder_kind, pin_holder_id)\n" +
        "  WHERE released_sequence IS NULL;",
    );
    // Every foreign key restricts, and a rebuild clears children by order.
    expect(statements.match(/ON DELETE RESTRICT/g)).toHaveLength(9);
    expect(statements).not.toContain("CASCADE");
  });

  it("holds every vocabulary CHECK equal to the contract's list", () => {
    expect(checkWords(statements, "ck_artifact_blob_read_model__lifecycle_state_enum")).toEqual([
      ...BLOB_LIFECYCLE_STATES,
    ]);
    expect(checkWords(statements, "ck_artifact_blob_read_model__encryption_status_enum")).toEqual([
      ...ENCRYPTION_STATUSES,
    ]);
    expect(checkWords(statements, "ck_artifact_reference_read_model__artifact_class_enum")).toEqual([
      ...ARTIFACT_CLASSES,
    ]);
    expect(checkWords(statements, "ck_artifact_reference_read_model__classification_enum")).toEqual([
      ...ARTIFACT_CLASSIFICATIONS,
    ]);
    expect(checkWords(statements, "ck_artifact_reference_read_model__scope_kind_enum")).toEqual([
      ...REFERENCE_SCOPE_KINDS,
    ]);
    expect(checkWords(statements, "ck_artifact_reference_read_model__retention_class_enum")).toEqual([
      ...RETENTION_CLASSES,
    ]);
    expect(checkWords(statements, "ck_artifact_pin_read_model__pin_holder_kind_enum")).toEqual([
      ...PIN_HOLDER_KINDS,
    ]);
  });

  it("gives the policy no foreign key and the scope, digest and producer no uniqueness", () => {
    // Decision 59: the policy is an identifier closed in code, and the table §4
    // names has no dictionary. Artifacts §1 and §4: two references to one blob
    // from one producer in one scope are legitimate.
    expect(statements).not.toContain("access_policy_read_model");
    expect(statements).not.toContain("REFERENCES access_policy");
    expect(statements).not.toMatch(/UNIQUE[^;]*producer_identity/);
    expect(statements).not.toContain("ux_artifact_reference_read_model__scope_id_content_sha256_producer_identity");
    // And nothing in the plane can hold bytes.
    expect(statements).not.toContain(" BLOB");
  });

  it("seeds its four watermarks from the registry head, never from a literal zero", () => {
    expect(statements).toContain("INSERT INTO projection_watermark");
    expect(statements).toContain("  'registry_events',\n  1,\n  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_head_sequence') AS INTEGER),");
    for (const key of ["registry_head_sequence", "registry_event_count", "registry_head_event_sha256"]) {
      expect(statements, key).toContain("WHERE key = '" + key + "'");
    }
    for (const name of ARTIFACT_PROJECTIONS) {
      expect(statements, name).toContain("SELECT '" + name + "'");
    }
    expect(statements).not.toContain("'registry_events',\n  1,\n  0,\n  0,");
  });

  it("declares the four projections in all four places that have to agree", () => {
    // The registry roster's first four; migration 17 appends the fifth.
    expect(REGISTRY_PROJECTION_NAMES.slice(0, 4)).toEqual([...ARTIFACT_PROJECTIONS]);
    for (const name of ARTIFACT_PROJECTIONS) {
      expect(DERIVED_TABLES, name).toContain(name);
      expect(PROJECTION_NAMES, name).not.toContain(name);
      expect(PROJECTION_SOURCES.filter((source) => source.projectionName === name)).toEqual([
        { projectionName: name, sourceStream: "registry_events" },
      ]);
      expect(EXPECTED_SCHEMA_OBJECTS).toContainEqual({ type: "table", name });
    }
  });

  it("clears the children before the blob they name", () => {
    const tombstoneAt = DERIVED_TABLES.indexOf(ARTIFACT_TOMBSTONE_PROJECTION);
    const pinAt = DERIVED_TABLES.indexOf(ARTIFACT_PIN_PROJECTION);
    const referenceAt = DERIVED_TABLES.indexOf(ARTIFACT_REFERENCE_PROJECTION);
    const blobAt = DERIVED_TABLES.indexOf(ARTIFACT_BLOB_PROJECTION);
    expect(tombstoneAt).toBeGreaterThanOrEqual(0);
    expect(tombstoneAt).toBeLessThan(referenceAt);
    expect(pinAt).toBeLessThan(blobAt);
    expect(referenceAt).toBeLessThan(blobAt);
  });

  it("inventories four tables and nine indexes, and no trigger of its own", () => {
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("artifact_") || object.name.includes("_artifact_"))).toEqual([
      { type: "table", name: "artifact_blob_read_model" },
      { type: "index", name: "ix_artifact_blob_read_model__lifecycle_state" },
      { type: "index", name: "ix_artifact_blob_read_model__first_published_sequence" },
      { type: "index", name: "ux_artifact_blob_read_model__reclaim_id" },
      { type: "index", name: "ux_artifact_blob_read_model__content_sha256__unreclaimed" },
      { type: "table", name: "artifact_reference_read_model" },
      { type: "index", name: "ix_artifact_reference_read_model__content_sha256" },
      { type: "index", name: "ix_artifact_reference_read_model__scope_kind_scope_id" },
      { type: "index", name: "ix_artifact_reference_read_model__expires_at" },
      { type: "index", name: "ux_artifact_reference_read_model__id_content_generation" },
      { type: "table", name: "artifact_pin_read_model" },
      { type: "index", name: "ux_artifact_pin_read_model__content_sha256_holder__live" },
      { type: "table", name: "artifact_tombstone_read_model" },
    ]);
    // Eight when this migration landed; the ninth is migration 16's.
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("tr_"))).toHaveLength(9);
    expect(statements).not.toMatch(/CREATE TRIGGER tr_artifact/);
  });
});

/**
 * Migration 16, the envelope reference of a revision by cohort (P-36/local D,
 * decision 41, ADR 0084).
 *
 * What is asserted here is the text: additive, two-sided, a closed list rather
 * than a comparison, and nothing that reaches across to the registry stream.
 * `test/ledger` asserts what the text does to a ledger that already has
 * revisions of every earlier cohort.
 */
describe("migration 16 names a revision's envelope by reference, by cohort, never by digest", () => {
  const SIXTEENTH = MIGRATIONS[15];
  const ELEVENTH = MIGRATIONS[10];

  /** The statements with the commentary removed, as for 11, 12, 14 and 15. */
  const statements = (SIXTEENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("sits at the tail of a set whose order is fixed", () => {
    expect(SIXTEENTH?.version).toBe(16);
    expect(SIXTEENTH?.name).toBe("task_revision_envelope_reference");
    expect(TASK_REVISION_ENVELOPE_REFERENCE_MIGRATION).toBe(16);
    expect(MIGRATIONS[TASK_REVISION_ENVELOPE_REFERENCE_MIGRATION - 1]?.name).toBe(
      "task_revision_envelope_reference",
    );
    // Sixteen when this migration landed; the seventeenth is P-14 A's, the
    // eighteenth P-14 B's and the nineteenth P-14 C's.
    expect(MIGRATIONS).toHaveLength(19);
    expect(MIGRATIONS[TASK_REVISION_ENVELOPE_REFERENCE_MIGRATION]?.name).toBe("model_version_registry");
  });

  it("N-P36D-8: adds the column in place and rebuilds, drops and seeds nothing", () => {
    expect(statements).toContain(
      "ALTER TABLE task_revision_read_model ADD COLUMN envelope_artifact_reference_id TEXT;",
    );
    // Nullable, with no default: the one shape `ADD COLUMN` admits in place,
    // and `NULL` on every existing row is exactly the cohort before.
    expect(statements).not.toMatch(/envelope_artifact_reference_id TEXT\s+NOT NULL/);
    expect(statements).not.toMatch(/DEFAULT/);
    expect(statements).not.toContain("CREATE TABLE");
    expect(statements).not.toContain("DROP ");
    expect(statements).not.toContain("RENAME");
    expect(statements).not.toContain("UPDATE ");
    // No watermark row: no projection is added, and the one this column belongs
    // to is level with its stream the moment the column exists.
    expect(statements).not.toContain("projection_watermark");
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(1);
    // And migration 11, applied and immutable, still creates the table without
    // the column — the deferral is what decision 41 records.
    expect(ELEVENTH?.sql ?? "").not.toMatch(/^\s+envelope_artifact_reference_id/m);
  });

  it("N-P36D-5: one BEFORE INSERT trigger refuses both crossings of the cohort", () => {
    expect(statements.match(/CREATE TRIGGER/g)).toHaveLength(1);
    expect(statements).toContain(
      "CREATE TRIGGER tr_task_revision_read_model__validate_envelope_reference\n" +
        "BEFORE INSERT ON task_revision_read_model\n",
    );
    // Backward: the cohort before, holding a reference.
    expect(statements).toContain(
      "WHERE NEW.contract_version IN ('2.2.0', '2.3.0', '2.4.0')\n" +
        "    AND NEW.envelope_artifact_reference_id IS NOT NULL;",
    );
    // Forward: every later version, holding none or an empty one.
    expect(statements).toContain(
      "WHERE NEW.contract_version NOT IN ('2.2.0', '2.3.0', '2.4.0')\n" +
        "    AND (NEW.envelope_artifact_reference_id IS NULL OR NEW.envelope_artifact_reference_id = '');",
    );
    expect(EXPECTED_SCHEMA_OBJECTS).toContainEqual({
      type: "trigger",
      name: "tr_task_revision_read_model__validate_envelope_reference",
    });
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("tr_"))).toHaveLength(9);
  });

  it("freezes the cohort as a closed list, spelled as the fold spells it, and never compares versions", () => {
    // M-5.2. A comparison of version strings would put `2.10.0` before `2.4.0`
    // and would read a future bump through a rule nobody wrote for it.
    const lists = [...statements.matchAll(/IN \(([^)]*)\)/g)].map((match) => match[1] ?? "");
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect([...list.matchAll(/'([^']*)'/g)].map((match) => match[1])).toEqual([
        ...PRE_ENVELOPE_REFERENCE_CONTRACT_VERSIONS,
      ]);
    }
    expect(statements).not.toMatch(/contract_version\s*(<|>|<=|>=|BETWEEN|GLOB|LIKE)/);
  });

  it("N-P36D-4: reaches nothing on the registry stream and derives nothing from a digest", () => {
    // M-5.3. Existence is the door's question: a trigger or a foreign key onto
    // `artifact_reference_read_model` would make a rebuild depend on the order
    // it folds the streams in.
    const beyondTheColumn = statements.replaceAll("envelope_artifact_reference_id", "");
    expect(beyondTheColumn).not.toContain("artifact_");
    expect(statements).not.toContain("REFERENCES");
    expect(statements).not.toContain("SELECT artifact");
    expect(statements).not.toContain("envelope_sha256");
    expect(DERIVED_TABLES).toContain(TASK_REVISION_PROJECTION);
  });
});

/**
 * Migration 17, the model version registry (P-14 A, accounts §6, ADR 0085).
 *
 * The text: three STRICT tables with the dictionary's constraints under the §3.2
 * names, three indexes, no trigger, no foreign key outside its own parent, and one
 * watermark seeded from the registry head. `test/ledger` asserts what the text
 * and the retroactive fold do to a ledger that already holds model versions.
 */
describe("migration 17 folds the model version registry from the registry stream", () => {
  const SEVENTEENTH = MIGRATIONS[16];

  const statements = (SEVENTEENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("N-P14A-18: sits at the position a set whose order is fixed gave it", () => {
    expect(SEVENTEENTH?.version).toBe(17);
    expect(SEVENTEENTH?.name).toBe("model_version_registry");
    expect(MODEL_VERSION_REGISTRY_MIGRATION).toBe(17);
    expect(MIGRATIONS[MODEL_VERSION_REGISTRY_MIGRATION - 1]?.name).toBe("model_version_registry");
    // Seventeen when this migration landed; the eighteenth is P-14 B's and the
    // nineteenth P-14 C's.
    expect(MIGRATIONS).toHaveLength(19);
    expect(MIGRATIONS[MODEL_VERSION_REGISTRY_MIGRATION]?.name).toBe("initiative_registration_detail");
  });

  it("creates the three tables of accounts §6 STRICT, with the dictionary's checks", () => {
    for (const table of ["model_version_read_model", "model_version_eligible_role", "model_version_transport"]) {
      expect(statements, table).toMatch(new RegExp("CREATE TABLE " + table + " \\([^;]*\\) STRICT;"));
    }
    for (const rule of [
      "CONSTRAINT pk_model_version_read_model PRIMARY KEY (model_version_id)",
      "CONSTRAINT ck_model_version_read_model__status CHECK (\n    status IN ('ACTIVE', 'DEPRECATED', 'RETIRED')\n  )",
      "CONSTRAINT ck_model_version_read_model__context_tokens CHECK (context_tokens >= 0)",
      "CONSTRAINT ck_model_version_read_model__deprecated_pair CHECK (\n    (status = 'ACTIVE') = (deprecated_at IS NULL)\n  )",
      "CONSTRAINT pk_model_version_eligible_role PRIMARY KEY (model_version_id, ordinal)",
      "CONSTRAINT ck_model_version_eligible_role__ordinal CHECK (ordinal >= 0)",
      "CONSTRAINT pk_model_version_transport PRIMARY KEY (model_version_id, ordinal)",
      "CONSTRAINT ck_model_version_transport__ordinal CHECK (ordinal >= 0)",
    ]) {
      expect(statements, rule).toContain(rule);
    }
    // `latest_performance_window` is a nullable column with no producer here:
    // economy's snapshot is what it references.
    expect(statements).toMatch(/latest_performance_window TEXT,/);
  });

  it("indexes by status and declares each role and transport once", () => {
    expect(statements).toContain(
      "CREATE INDEX ix_model_version_read_model__status\n  ON model_version_read_model (status, provider, model);",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_model_version_eligible_role__role\n  ON model_version_eligible_role (model_version_id, role);",
    );
    expect(statements).toContain(
      "CREATE UNIQUE INDEX ux_model_version_transport__transport\n  ON model_version_transport (model_version_id, transport_kind);",
    );
  });

  it("names no table but its own in a foreign key, and adds no trigger", () => {
    // A foreign key into `registry_events` or the routing tables would make a
    // rebuild depend on fold order; the check an assignment needs is the door's.
    const references = [...statements.matchAll(/REFERENCES (\w+)/g)].map((match) => match[1]);
    expect(references).toEqual(["model_version_read_model", "model_version_read_model"]);
    expect(statements).toContain("CONSTRAINT fk_model_version_eligible_role__model_version_read_model");
    expect(statements).toContain("CONSTRAINT fk_model_version_transport__model_version_read_model");
    expect(statements).not.toContain("CREATE TRIGGER");
    expect(statements).not.toContain("DROP ");
    expect(statements).not.toContain("ALTER TABLE");
  });

  it("seeds its one watermark from the registry head, never from a literal zero", () => {
    expect(statements.match(/INSERT INTO projection_watermark/g)).toHaveLength(1);
    expect(statements).toContain(
      "  'model_version_read_model',\n  'registry_events',\n  1,\n" +
        "  CAST((SELECT value FROM ledger_meta WHERE key = 'registry_head_sequence') AS INTEGER),",
    );
    for (const key of ["registry_head_sequence", "registry_event_count", "registry_head_event_sha256"]) {
      expect(statements, key).toContain("WHERE key = '" + key + "'");
    }
    expect(statements).not.toContain("'registry_events',\n  1,\n  0,\n  0,");
  });

  it("declares the projection in all four places that have to agree, children cleared first", () => {
    expect(MODEL_VERSION_PROJECTION).toBe("model_version_read_model");
    expect(REGISTRY_PROJECTION_NAMES).toEqual([
      ARTIFACT_BLOB_PROJECTION,
      ARTIFACT_REFERENCE_PROJECTION,
      ARTIFACT_PIN_PROJECTION,
      ARTIFACT_TOMBSTONE_PROJECTION,
      MODEL_VERSION_PROJECTION,
    ]);
    expect(PROJECTION_NAMES).not.toContain(MODEL_VERSION_PROJECTION);
    expect(PROJECTION_SOURCES.filter((source) => source.projectionName === MODEL_VERSION_PROJECTION)).toEqual([
      { projectionName: MODEL_VERSION_PROJECTION, sourceStream: "registry_events" },
    ]);
    // One watermark for three tables: the children are not projections of their own.
    expect(PROJECTION_SOURCES.some((source) => source.projectionName.startsWith("model_version_") && source.projectionName !== MODEL_VERSION_PROJECTION)).toBe(false);
    const transportAt = DERIVED_TABLES.indexOf("model_version_transport");
    const roleAt = DERIVED_TABLES.indexOf("model_version_eligible_role");
    const versionAt = DERIVED_TABLES.indexOf(MODEL_VERSION_PROJECTION);
    expect(transportAt).toBeGreaterThanOrEqual(0);
    expect(roleAt).toBeGreaterThanOrEqual(0);
    expect(transportAt).toBeLessThan(versionAt);
    expect(roleAt).toBeLessThan(versionAt);
  });

  it("N-P14A-16: inventories three tables and three indexes, and no trigger of its own", () => {
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.includes("model_version_"))).toEqual([
      { type: "table", name: "model_version_read_model" },
      { type: "index", name: "ix_model_version_read_model__status" },
      { type: "table", name: "model_version_eligible_role" },
      { type: "index", name: "ux_model_version_eligible_role__role" },
      { type: "table", name: "model_version_transport" },
      { type: "index", name: "ux_model_version_transport__transport" },
    ]);
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.startsWith("tr_"))).toHaveLength(9);
  });
});

/**
 * Migration 18, the initiative projection's registration columns (P-14 B, ADR
 * 0086).
 *
 * The text: three nullable `ADD COLUMN`s in place, planning §1's names, and
 * nothing else — no CHECK, no trigger, no index, no watermark, no rebuild.
 * `test/ledger` asserts what the text and the retroactive fold do to a ledger
 * that already holds registrations.
 */
describe("migration 18 adds the initiative projection's three columns and nothing else", () => {
  const EIGHTEENTH = MIGRATIONS[17];

  const statements = (EIGHTEENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("sits at the position a set whose order is fixed gave it", () => {
    expect(EIGHTEENTH?.version).toBe(18);
    expect(EIGHTEENTH?.name).toBe("initiative_registration_detail");
    expect(INITIATIVE_REGISTRATION_MIGRATION).toBe(18);
    expect(MIGRATIONS[INITIATIVE_REGISTRATION_MIGRATION - 1]?.name).toBe("initiative_registration_detail");
    // Eighteen when this migration landed; the nineteenth is P-14 C's.
    expect(MIGRATIONS).toHaveLength(19);
    expect(MIGRATIONS[INITIATIVE_REGISTRATION_MIGRATION]?.name).toBe("task_submission");
  });

  it("N-P14B-8: adds planning's three columns in place, nullable and with no default", () => {
    expect(statements.trim().split("\n")).toEqual([
      "ALTER TABLE initiative_read_model ADD COLUMN title TEXT;",
      "ALTER TABLE initiative_read_model ADD COLUMN objective_sha256 TEXT;",
      "ALTER TABLE initiative_read_model ADD COLUMN repository_sha256 TEXT;",
    ]);
    expect(statements).not.toMatch(/NOT NULL|DEFAULT|CHECK|TRIGGER|INDEX|projection_watermark|DROP /);
  });

  it("inventories no schema object and declares no projection of its own", () => {
    // Three columns are not an object: the inventory, the derived tables and the
    // watermark pairs are what they were at seventeen.
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.includes("initiative_read_model"))).toEqual([
      { type: "table", name: "initiative_read_model" },
      { type: "index", name: "initiative_read_model_by_status" },
    ]);
    expect(PROJECTION_SOURCES.filter((source) => source.projectionName === "initiative_read_model")).toEqual([
      { projectionName: "initiative_read_model", sourceStream: INITIATIVE_STREAM },
    ]);
    expect(INITIATIVE_PROJECTION_NAMES).toContain("initiative_read_model");
  });
});

/**
 * Migration 19, the task's client key (P-14 C, ADR 0087).
 *
 * The text: one STRICT table with contracts §15's unique pair, the checks the
 * dictionary states, and one watermark seeded at the task head — no trigger, no
 * foreign key, no index of its own name. `test/ledger` asserts what the fold, the
 * door and the retroactive fold do with it.
 */
describe("migration 19 gives a task's client key its one home", () => {
  const NINETEENTH = MIGRATIONS[18];

  const statements = (NINETEENTH?.sql ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("sits at the tail of a set whose order is fixed", () => {
    expect(NINETEENTH?.version).toBe(19);
    expect(NINETEENTH?.name).toBe("task_submission");
    expect(TASK_SUBMISSION_MIGRATION).toBe(19);
    expect(MIGRATIONS[TASK_SUBMISSION_MIGRATION - 1]?.name).toBe("task_submission");
    expect(MIGRATIONS).toHaveLength(19);
  });

  it("creates the table STRICT, unique on the client key and on nothing else", () => {
    expect(statements).toContain("CREATE TABLE task_submission_read_model (");
    expect(statements).toContain(") STRICT;");
    expect(statements).toContain(
      "CONSTRAINT ux_task_submission_read_model__request UNIQUE (client_scope, client_request_key)",
    );
    for (const column of [
      "client_scope       TEXT    NOT NULL",
      "client_request_key TEXT    NOT NULL",
      "task_id            TEXT    NOT NULL",
      "revision_number    INTEGER NOT NULL",
      "envelope_sha256    TEXT    NOT NULL",
      "sequence           INTEGER NOT NULL",
      "created_at         TEXT    NOT NULL",
    ]) {
      expect(statements, column).toContain(column);
    }
    expect(statements.match(/UNIQUE/g)).toHaveLength(1);
    expect(statements).not.toMatch(/PRIMARY KEY|FOREIGN KEY|TRIGGER|CREATE INDEX|CREATE UNIQUE INDEX|DROP |ALTER |ON CONFLICT/);
  });

  it("seeds its one watermark from the task head, never from a literal zero", () => {
    expect(statements).toContain("'task_submission_read_model',");
    expect(statements).toContain("'control_plane_events',");
    for (const key of ["head_sequence", "event_count", "head_event_sha256"]) {
      expect(statements, key).toContain("WHERE key = '" + key + "'");
    }
  });

  it("declares the projection in all four places that have to agree", () => {
    expect(TASK_SUBMISSION_PROJECTION).toBe("task_submission_read_model");
    expect(DERIVED_TABLES).toContain(TASK_SUBMISSION_PROJECTION);
    expect(PROJECTION_NAMES).toContain(TASK_SUBMISSION_PROJECTION);
    expect(PROJECTION_SOURCES.filter((source) => source.projectionName === TASK_SUBMISSION_PROJECTION)).toEqual([
      { projectionName: TASK_SUBMISSION_PROJECTION, sourceStream: "control_plane_events" },
    ]);
    expect(EXPECTED_SCHEMA_OBJECTS.filter((object) => object.name.includes(TASK_SUBMISSION_PROJECTION))).toEqual([
      { type: "table", name: TASK_SUBMISSION_PROJECTION },
    ]);
  });
});
