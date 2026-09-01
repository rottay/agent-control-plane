import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkReferencedPaths,
  checkValues,
  placeholdersIn,
  renderLaunchAgent,
} from "../../../src/launchd/render/index.js";
import type { LaunchAgentValues } from "../../../src/launchd/render/index.js";
import { TEMPLATE_PATH } from "../validate/index.test.js";
import { validatePlist } from "../../../src/launchd/validate/index.js";

const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");
const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A directory this test owns, with a program, a config and a log parent. */
function fixture(): { dir: string; values: LaunchAgentValues } {
  // Resolved through realpath deliberately: on Darwin `tmpdir()` is itself a
  // symlink (`/var` to `/private/var`), so a fixture built on the raw path
  // would be refused as non-canonical — correctly. The check is right and the
  // naive fixture was wrong, which is worth saying out loud because the easy
  // reading is the opposite one.
  const created = mkdtempSync(join(tmpdir(), "acp-launchd-"));
  temporaries.push(created);
  const dir = realpathSync(created);
  const programPath = join(dir, "daemon");
  const configPath = join(dir, "config.json");
  writeFileSync(programPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(configPath, "{}", { mode: 0o600 });
  chmodSync(dir, 0o700);
  return {
    dir,
    values: {
      label: "com.rottay.agent-control-plane",
      programPath,
      configPath,
      workingDirectory: dir,
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
    },
  };
}

describe("rendering", () => {
  it("is deterministic: identical input, byte-identical output", () => {
    const { values } = fixture();
    const first = renderLaunchAgent(TEMPLATE, values);
    const second = renderLaunchAgent(TEMPLATE, values);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.document).toBe(second.document);
  });

  it("produces an inert document", () => {
    const { values } = fixture();
    const rendered = renderLaunchAgent(TEMPLATE, values);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(validatePlist(rendered.document)).toEqual({ ok: true });
      expect(rendered.document).toContain(values.programPath);
      expect(rendered.document).not.toContain("{{");
    }
  });

  it("knows exactly which placeholders the template carries", () => {
    expect(placeholdersIn(TEMPLATE).sort()).toEqual([
      "CONFIG_PATH",
      "LABEL",
      "PROGRAM_PATH",
      "STDERR_PATH",
      "STDOUT_PATH",
      "WORKING_DIRECTORY",
    ]);
  });

  it("refuses an unknown placeholder", () => {
    const { values } = fixture();
    const tampered = TEMPLATE.replace("{{LABEL}}", "{{SOMETHING_ELSE}}");
    expect(renderLaunchAgent(tampered, values)).toMatchObject({ reason: "UNKNOWN_PLACEHOLDER" });
  });

  it("refuses a value the template no longer uses", () => {
    // A value silently dropped because the template stopped referring to it is
    // how a rendered agent ends up pointing at the wrong binary while every
    // other check still passes.
    const { values } = fixture();
    const tampered = TEMPLATE.replace("{{CONFIG_PATH}}", "/etc/somewhere");
    expect(renderLaunchAgent(tampered, values)).toMatchObject({ reason: "UNUSED_VALUE" });
  });

  it("refuses a value that carries a placeholder delimiter", () => {
    const { values } = fixture();
    const hostile = { ...values, label: "com.rottay.{{LABEL}}" };
    expect(renderLaunchAgent(TEMPLATE, hostile)).toMatchObject({ reason: "BAD_LABEL" });
    const hostilePath = { ...values, stdoutPath: "/tmp/{{PROGRAM_PATH}}" };
    expect(renderLaunchAgent(TEMPLATE, hostilePath)).toMatchObject({ reason: "VALUE_REINJECTS" });
  });

  it("refuses markup and control characters in a value", () => {
    const { values } = fixture();
    expect(renderLaunchAgent(TEMPLATE, { ...values, stdoutPath: "/tmp/<x>" })).toMatchObject({
      reason: "VALUE_NOT_XML_SAFE",
    });
    expect(renderLaunchAgent(TEMPLATE, { ...values, stdoutPath: "/tmp/a\nb" })).toMatchObject({
      reason: "VALUE_CONTROL_CHAR",
    });
  });

  it("refuses a label that is not separator-safe reverse DNS", () => {
    const { values } = fixture();
    for (const label of ["com.rottay.", ".com.rottay", "com..rottay", "Com.Rottay", "rottay", "com.rottay/x", "1com.rottay"]) {
      expect(renderLaunchAgent(TEMPLATE, { ...values, label })).toMatchObject({
        reason: "BAD_LABEL",
      });
    }
  });

  it("writes nothing", () => {
    // Rendering is pure. The separation is what lets every property above be
    // proven with no destination existing at all.
    const { dir, values } = fixture();
    const before = readFileSync(values.configPath, "utf8");
    renderLaunchAgent(TEMPLATE, values);
    expect(readFileSync(values.configPath, "utf8")).toBe(before);
    expect(() => readFileSync(join(dir, values.label + ".plist"))).toThrow();
  });
});

describe("the per-field path law", () => {
  it("accepts a well-formed fixture", () => {
    const { values } = fixture();
    expect(checkReferencedPaths(values)).toEqual({ ok: true });
  });

  it("accepts absent log files, because launchd creates them", () => {
    // A blanket "must exist" rule would force operators to pre-create logs, so
    // the guarantee moves up one level: the parent directory is what decides
    // where the file can appear.
    const { values } = fixture();
    expect(checkReferencedPaths({ ...values, stdoutPath: join(values.workingDirectory, "fresh.log") })).toEqual({
      ok: true,
    });
  });

  it("holds an existing log file to the file rules", () => {
    const { dir, values } = fixture();
    const existing = join(dir, "existing.log");
    writeFileSync(existing, "");
    // chmod explicitly: the mode argument to writeFileSync is masked by the
    // process umask, so asking for 0666 usually lands on 0644 and the negative
    // would quietly test nothing.
    chmodSync(existing, 0o666);
    expect(checkReferencedPaths({ ...values, stdoutPath: existing })).toMatchObject({
      reason: "UNSAFE_PERMISSIONS",
    });
  });

  it("refuses a log path whose parent does not exist", () => {
    const { dir, values } = fixture();
    expect(
      checkReferencedPaths({ ...values, stderrPath: join(dir, "nope", "err.log") }),
    ).toMatchObject({ reason: "PATH_MISSING" });
  });

  it("refuses a relative path or one containing ..", () => {
    const { values } = fixture();
    expect(checkReferencedPaths({ ...values, programPath: "bin/daemon" })).toMatchObject({
      reason: "PATH_NOT_ABSOLUTE",
    });
    expect(checkReferencedPaths({ ...values, configPath: "/tmp/../etc/hosts" })).toMatchObject({
      reason: "PATH_NOT_ABSOLUTE",
    });
  });

  it("refuses a missing program or config", () => {
    const { dir, values } = fixture();
    expect(checkReferencedPaths({ ...values, programPath: join(dir, "gone") })).toMatchObject({
      reason: "PATH_MISSING",
    });
  });

  it("refuses a program that is not executable", () => {
    const { dir, values } = fixture();
    const plain = join(dir, "plain");
    writeFileSync(plain, "", { mode: 0o600 });
    expect(checkReferencedPaths({ ...values, programPath: plain })).toMatchObject({
      reason: "PATH_NOT_EXECUTABLE",
    });
  });

  it("refuses a symlinked component", () => {
    // The path a reviewer reads is then not the path that gets opened, which is
    // the entire risk the check exists for.
    const { dir, values } = fixture();
    const link = join(dir, "link-to-daemon");
    symlinkSync(values.programPath, link);
    expect(checkReferencedPaths({ ...values, programPath: link })).toMatchObject({
      reason: "PATH_NOT_CANONICAL",
    });
  });

  it("refuses a group- or world-writable program", () => {
    const { values } = fixture();
    chmodSync(values.programPath, 0o777);
    expect(checkReferencedPaths(values)).toMatchObject({ reason: "UNSAFE_PERMISSIONS" });
  });

  it("refuses a program owned by another account, without needing privilege", () => {
    // Root-owned system files are the privilege-free fixture: deterministic on
    // the pinned platform, and no chown is required to produce the condition.
    const { values } = fixture();
    expect(checkReferencedPaths({ ...values, programPath: "/bin/ls" })).toMatchObject({
      reason: "PATH_NOT_OWNED",
    });
    // /private/etc/hosts, not /etc/hosts: /etc is itself a symlink, which the
    // canonical check refuses first and for a different reason.
    expect(checkReferencedPaths({ ...values, configPath: "/private/etc/hosts" })).toMatchObject({
      reason: "PATH_NOT_OWNED",
    });
  });

  it("refuses a working directory that is a file, or not owned", () => {
    const { values } = fixture();
    expect(checkReferencedPaths({ ...values, workingDirectory: values.configPath })).toMatchObject({
      reason: "PATH_NOT_DIRECTORY",
    });
    expect(checkReferencedPaths({ ...values, workingDirectory: "/usr" })).toMatchObject({
      reason: "PATH_NOT_OWNED",
    });
  });
});

describe("value checks on their own terms", () => {
  it("passes a clean set", () => {
    const { values } = fixture();
    expect(checkValues(values)).toEqual({ ok: true });
  });
});
