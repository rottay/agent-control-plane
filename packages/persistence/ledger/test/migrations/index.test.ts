import { describe, expect, it } from "vitest";

import {
  DERIVED_TABLES,
  EXPECTED_SCHEMA_OBJECTS,
  INITIATIVE_PROJECTION_NAMES,
  INITIATIVE_STREAM,
  MIGRATIONS,
  PROJECTION_NAMES,
  PROJECTION_SOURCES,
  TASK_STREAM,
  checkMigrationConformance,
} from "../../src/migrations/index.js";
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
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
    ]);
  });

  it("is the only migration that creates the watermark table", () => {
    // Migration 9 seeds two rows into it, which is what a migration that adds
    // a projection does; it does not create, alter or drop the table.
    const creating = MIGRATIONS.filter((migration) =>
      migration.sql.includes("CREATE TABLE projection_watermark"),
    );
    expect(creating.map((migration) => migration.version)).toEqual([7]);
    const naming = MIGRATIONS.filter((migration) =>
      migration.sql.includes("projection_watermark"),
    );
    expect(naming.map((migration) => migration.version)).toEqual([7, 9]);
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
      "initiative_read_model@initiative_events",
      "roadmap_version_read_model@initiative_events",
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
    // start, and it recreates these two triggers to widen the vocabulary. What
    // is asserted is that no migration BEFORE 8 could have declared them.
    const naming = MIGRATIONS.filter((migration) =>
      migration.sql.includes("causation_stream"),
    );
    expect(naming.map((migration) => migration.version)).toEqual([8, 9]);
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

  it("inventories every trigger named by the §3.2 convention, and there are five", () => {
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
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("is the only migration that creates the registry stream", () => {
    const creating = MIGRATIONS.filter((migration) =>
      migration.sql.includes("CREATE TABLE registry_events"),
    );
    expect(creating.map((migration) => migration.version)).toEqual([9]);
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
    expect(PROJECTION_SOURCES).toHaveLength(7);
  });

  it("still does not claim the account stream (D3)", () => {
    expect(
      PROJECTION_SOURCES.some((source) => source.sourceStream === "account_events"),
    ).toBe(false);
  });
});
