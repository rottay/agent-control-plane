import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DIR_MODE, FILE_MODE } from "../../constants/index.js";
import type { LaunchdVerdict } from "../validate/index.js";
import { ACCEPTED, parseFixedPlist, refuse, validatePlist, validateTemplate } from "../validate/index.js";

/**
 * Rendering is a pure function; writing is a separate, narrower one.
 *
 * The split is deliberate. It means the interesting properties — determinism,
 * substitution safety, inertness of the result — can all be proven without a
 * destination existing at all, and it means there is exactly one function in
 * this package that touches the filesystem for launchd purposes.
 *
 * Nothing here installs, loads, copies or schedules anything. The output is a
 * file under an ignored local directory; making it take effect is a manual act
 * a human performs, documented in `packages/daemon/launchd/README.md`.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

/** Where renders may go, and nowhere else. */
export const RENDER_DIR_SEGMENTS: readonly string[] = Object.freeze([".acp-local", "launchd"]);

/** The tracked template's filename. */
export const TEMPLATE_NAME = "com.rottay.agent-control-plane.plist.template";

export interface LaunchAgentValues {
  readonly label: string;
  readonly programPath: string;
  readonly configPath: string;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/** The placeholder for each supplied value. */
export const PLACEHOLDERS: Readonly<Record<keyof LaunchAgentValues, string>> = Object.freeze({
  label: "LABEL",
  programPath: "PROGRAM_PATH",
  configPath: "CONFIG_PATH",
  workingDirectory: "WORKING_DIRECTORY",
  stdoutPath: "STDOUT_PATH",
  stderrPath: "STDERR_PATH",
});

const PLACEHOLDER_PATTERN = new RegExp("\\{\\{([A-Za-z0-9_]*)\\}\\}", "g");
const PLACEHOLDER_NAME = new RegExp("^[A-Z][A-Z0-9_]{0,63}$");
/** Separator-safe reverse DNS: no leading digit, no dot run, no trailing dot. */
const LABEL_GRAMMAR = new RegExp("^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$");
/**
 * Control characters, tested by code point rather than by a character class.
 *
 * A regular expression containing literal control characters is itself hard to
 * review, and linters object to it for that reason. Comparing code points says
 * the same thing in a form a reader can check.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Every placeholder the template actually contains. */
export function placeholdersIn(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? "";
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Check the supplied values on their own terms, before any path is touched.
 *
 * `VALUE_REINJECTS` deserves the explanation: substitution is single pass, so a
 * value containing `{{` could not be expanded anyway. It is refused at the door
 * regardless, because relying on "we only substitute once" makes the safety of
 * the function depend on a property a later refactor could quietly change.
 */
export function checkValues(values: LaunchAgentValues): LaunchdVerdict {
  if (!LABEL_GRAMMAR.test(values.label)) {
    return refuse("BAD_LABEL", "the label must be separator-safe reverse DNS");
  }
  const fields: (keyof LaunchAgentValues)[] = [
    "label",
    "programPath",
    "configPath",
    "workingDirectory",
    "stdoutPath",
    "stderrPath",
  ];
  for (const field of fields) {
    const value = values[field];
    if (hasControlCharacter(value)) {
      return refuse("VALUE_CONTROL_CHAR", field + " carries a control character");
    }
    if (value.includes("{{") || value.includes("}}")) {
      return refuse("VALUE_REINJECTS", field + " carries a placeholder delimiter");
    }
    if (value.includes("<") || value.includes(">") || value.includes("&")) {
      return refuse("VALUE_NOT_XML_SAFE", field + " carries markup");
    }
  }
  return ACCEPTED;
}

/**
 * Substitute, once, with every mismatch refused.
 *
 * `UNUSED_VALUE` matters as much as `UNKNOWN_PLACEHOLDER`: a value silently
 * dropped because the template stopped referring to it is how a rendered agent
 * ends up pointing at the wrong binary while every other check still passes.
 */
export function renderLaunchAgent(
  template: string,
  values: LaunchAgentValues,
): { readonly ok: true; readonly document: string } | { readonly ok: false; readonly reason: string; readonly detail: string } {
  const valueCheck = checkValues(values);
  if (!valueCheck.ok) return { ok: false, reason: valueCheck.reason, detail: valueCheck.detail };

  const known = new Map<string, string>();
  for (const [field, placeholder] of Object.entries(PLACEHOLDERS)) {
    known.set(placeholder, values[field as keyof LaunchAgentValues]);
  }

  const present = placeholdersIn(template);
  for (const name of present) {
    if (!PLACEHOLDER_NAME.test(name)) {
      return { ok: false, reason: "UNKNOWN_PLACEHOLDER", detail: "malformed placeholder name" };
    }
    if (!known.has(name)) return { ok: false, reason: "UNKNOWN_PLACEHOLDER", detail: name };
  }
  for (const [placeholder] of known) {
    if (!present.includes(placeholder)) {
      return { ok: false, reason: "UNUSED_VALUE", detail: placeholder };
    }
  }

  // Single pass: each match is replaced from the map, never rescanned.
  const document = template.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => {
    return known.get(name) ?? "";
  });

  if (document.includes("{{") || document.includes("}}")) {
    return { ok: false, reason: "UNSUBSTITUTED", detail: "a delimiter survived rendering" };
  }

  const verdict = validatePlist(document);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail };

  // Read back what was produced and confirm it says what was asked for.
  // Substitution is textual, and a template whose placeholders sit under the
  // wrong keys would render a perfectly valid document that quietly means
  // something else. Checking the parsed result closes that gap without trusting
  // the template's layout.
  const parsed = parseFixedPlist(document);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };

  const expected: readonly [string, string][] = [
    ["Label", values.label],
    ["Program", values.programPath],
    ["WorkingDirectory", values.workingDirectory],
    ["StandardOutPath", values.stdoutPath],
    ["StandardErrorPath", values.stderrPath],
  ];
  for (const [key, want] of expected) {
    const got = parsed.entries.get(key);
    if (got?.kind !== "string" || got.value !== want) {
      return { ok: false, reason: "ARGUMENT_MISMATCH", detail: key + " did not render to its value" };
    }
  }
  const args = parsed.entries.get("ProgramArguments");
  if (
    args?.kind !== "array" ||
    args.value.length !== 2 ||
    args.value[0] !== values.programPath ||
    args.value[1] !== values.configPath
  ) {
    return { ok: false, reason: "ARGUMENT_MISMATCH", detail: "ProgramArguments did not render to [program, config]" };
  }

  return { ok: true, document };
}

/**
 * The per-field path law.
 *
 * Not one blanket rule, because one blanket rule cannot be right. "Must exist
 * and its realpath must equal the supplied path" is correct for a program and
 * a config, and wrong for a log destination: launchd creates those, and
 * `realpathSync` throws on a path that is not there yet. A single rule would
 * therefore force operators to pre-create log files, or push the
 * implementation into an unstated exception. Each field gets the rule that
 * fits what it is.
 */

function shapeChecks(field: string, value: string): LaunchdVerdict {
  if (!isAbsolute(value)) return refuse("PATH_NOT_ABSOLUTE", field);
  if (value.split(sep).includes("..")) return refuse("PATH_NOT_ABSOLUTE", field + " contains ..");
  return ACCEPTED;
}

function canonical(field: string, value: string): LaunchdVerdict {
  // A symlinked component means the path a reviewer reads is not the path that
  // will be opened, which is the entire risk this check exists for.
  if (realpathSync(value) !== value) return refuse("PATH_NOT_CANONICAL", field);
  return ACCEPTED;
}

function ownedAndSafe(field: string, value: string): LaunchdVerdict {
  const stats = statSync(value);
  if (stats.uid !== process.getuid?.()) return refuse("PATH_NOT_OWNED", field);
  // A launch agent whose program or directory anyone can rewrite is a
  // persistence mechanism. Writing one by accident is precisely what this
  // phase must not do.
  if ((stats.mode & 0o022) !== 0) return refuse("UNSAFE_PERMISSIONS", field);
  return ACCEPTED;
}

/** A program or a config: must be there now, and must be exactly what it says. */
function checkExistingFile(field: string, value: string, executable: boolean): LaunchdVerdict {
  const shape = shapeChecks(field, value);
  if (!shape.ok) return shape;
  if (!existsSync(value)) return refuse("PATH_MISSING", field);
  const canon = canonical(field, value);
  if (!canon.ok) return canon;
  const stats = statSync(value);
  if (!stats.isFile()) return refuse("PATH_NOT_REGULAR_FILE", field);
  const owned = ownedAndSafe(field, value);
  if (!owned.ok) return owned;
  if (executable && (stats.mode & 0o100) === 0) return refuse("PATH_NOT_EXECUTABLE", field);
  return ACCEPTED;
}

/** A working directory: must be there now, and must be a directory. */
function checkExistingDirectory(field: string, value: string): LaunchdVerdict {
  const shape = shapeChecks(field, value);
  if (!shape.ok) return shape;
  if (!existsSync(value)) return refuse("PATH_MISSING", field);
  const canon = canonical(field, value);
  if (!canon.ok) return canon;
  if (!statSync(value).isDirectory()) return refuse("PATH_NOT_DIRECTORY", field);
  return ownedAndSafe(field, value);
}

/**
 * A log destination: may not exist yet, so the guarantee moves up one level.
 *
 * The parent directory must exist and be safe and owned, because that is what
 * determines where the file can appear. When the file is already there it is
 * held to the file rules as well.
 */
function checkLogTarget(field: string, value: string): LaunchdVerdict {
  const shape = shapeChecks(field, value);
  if (!shape.ok) return shape;

  const parent = dirname(value);
  if (!existsSync(parent)) return refuse("PATH_MISSING", field + " parent directory");
  const parentCanon = canonical(field + " parent", parent);
  if (!parentCanon.ok) return parentCanon;
  if (!statSync(parent).isDirectory()) return refuse("PATH_NOT_DIRECTORY", field + " parent");
  const parentOwned = ownedAndSafe(field + " parent", parent);
  if (!parentOwned.ok) return parentOwned;

  if (existsSync(value)) {
    const canon = canonical(field, value);
    if (!canon.ok) return canon;
    if (!statSync(value).isFile()) return refuse("PATH_NOT_REGULAR_FILE", field);
    return ownedAndSafe(field, value);
  }
  return ACCEPTED;
}

/** Every referenced path, each under the rule that fits it. */
export function checkReferencedPaths(values: LaunchAgentValues): LaunchdVerdict {
  const program = checkExistingFile("programPath", values.programPath, true);
  if (!program.ok) return program;
  const config = checkExistingFile("configPath", values.configPath, false);
  if (!config.ok) return config;
  const workdir = checkExistingDirectory("workingDirectory", values.workingDirectory);
  if (!workdir.ok) return workdir;
  const out = checkLogTarget("stdoutPath", values.stdoutPath);
  if (!out.ok) return out;
  return checkLogTarget("stderrPath", values.stderrPath);
}

/** The only directory a render may land in. */
export function renderDir(): string {
  return join(REPO_ROOT, ...RENDER_DIR_SEGMENTS);
}

/**
 * Write a rendered agent under the ignored local root, and nowhere else.
 *
 * `~/Library/LaunchAgents` is not a fallback, an option or a flag. Nothing in
 * this repository writes there, and the fence asserts it repository-wide rather
 * than trusting this comment.
 */
/**
 * Resolve the render directory, creating it without ever traversing a symlink.
 *
 * The previous version called recursive `mkdirSync` and *then* checked
 * containment. If `.acp-local` were a symlink pointing outside the repository,
 * that created a directory out there before refusing — so "refused, nothing
 * written" was not true. Each ancestor is now resolved and verified before
 * anything is created, so the refusal happens before the first mutation.
 */
function resolveRenderDirectory(
  repoRoot: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string; readonly detail: string } {
  let current: string;
  try {
    current = realpathSync(repoRoot);
  } catch {
    return { ok: false, reason: "DESTINATION_OUTSIDE_LOCAL", detail: "the repository root is unreadable" };
  }

  for (const segment of RENDER_DIR_SEGMENTS) {
    const next = join(current, segment);
    if (existsSync(next)) {
      // lstat, not stat: the question is whether this component IS a link, and
      // stat would answer about whatever it points at.
      const link = lstatSync(next);
      if (link.isSymbolicLink()) {
        return {
          ok: false,
          reason: "DESTINATION_OUTSIDE_LOCAL",
          detail: segment + " is a symlink; the render path may not traverse one",
        };
      }
      if (!link.isDirectory()) {
        return { ok: false, reason: "DESTINATION_OUTSIDE_LOCAL", detail: segment + " is not a directory" };
      }
      if (link.uid !== process.getuid?.()) {
        return { ok: false, reason: "PATH_NOT_OWNED", detail: segment };
      }
    } else {
      // Non recursive: the parent has already been verified, and every
      // component is created only after the one above it was checked.
      mkdirSync(next, { mode: DIR_MODE });
    }
    current = next;
  }

  const mode = statSync(current).mode & 0o777;
  if (mode !== DIR_MODE) {
    return { ok: false, reason: "UNSAFE_PERMISSIONS", detail: "render directory is not 0700" };
  }
  if (current !== join(realpathSync(repoRoot), ...RENDER_DIR_SEGMENTS)) {
    return { ok: false, reason: "DESTINATION_OUTSIDE_LOCAL", detail: "the render directory moved" };
  }
  return { ok: true, path: current };
}

/**
 * Write the tracked template, rendered, under the ignored local root.
 *
 * Takes **no template argument**. The public effect has to be bound to the
 * tracked artifact: a signature that accepted a caller's template meant the
 * reviewed, fenced template was not the authority on what actually gets
 * written, and a caller could supply a different otherwise-valid document. The
 * template is loaded and validated here instead, so a tampered caller template
 * cannot reach the writer at all — there is nowhere to put it.
 */
export function writeLaunchAgent(
  values: LaunchAgentValues,
): { readonly ok: true; readonly path: string; readonly bytes: number } | { readonly ok: false; readonly reason: string; readonly detail: string } {
  return writeLaunchAgentAt(REPO_ROOT, values);
}

/**
 * The drill seam, module-private on purpose.
 *
 * `writeLaunchAgent(values)` is the public effect and takes nothing else. A
 * defaulted second parameter would still have been public signature — the fence
 * pins export names, not arity — so a future caller could have aimed the
 * destination at any `<root>/.acp-local/launchd/`. The seam exists only so the
 * drills can point at a disposable tree; it is not exported from the package
 * entry point, and the tests reach it by relative path exactly as they do for
 * the parser internals.
 */
export function writeLaunchAgentAt(
  repoRoot: string,
  values: LaunchAgentValues,
): { readonly ok: true; readonly path: string; readonly bytes: number } | { readonly ok: false; readonly reason: string; readonly detail: string } {
  const paths = checkReferencedPaths(values);
  if (!paths.ok) return { ok: false, reason: paths.reason, detail: paths.detail };

  let template: string;
  try {
    template = readFileSync(trackedTemplatePath(), "utf8");
  } catch {
    return { ok: false, reason: "MALFORMED_PLIST", detail: "the tracked template is unreadable" };
  }
  const templateVerdict = validateTemplate(template);
  if (!templateVerdict.ok) {
    return { ok: false, reason: templateVerdict.reason, detail: templateVerdict.detail };
  }

  const rendered = renderLaunchAgent(template, values);
  if (!rendered.ok) return rendered;

  const directory = resolveRenderDirectory(repoRoot);
  if (!directory.ok) return directory;

  const target = join(directory.path, values.label + ".plist");
  if (dirname(target) !== directory.path) {
    return { ok: false, reason: "DESTINATION_OUTSIDE_LOCAL", detail: "the label escaped its directory" };
  }

  return writeAtomically(target, directory.path, rendered.document);
}

/** Where the tracked template lives. */
export function trackedTemplatePath(): string {
  return join(REPO_ROOT, "packages", "daemon", "launchd", TEMPLATE_NAME);
}

/**
 * Write, then rename, with nothing to hijack in between.
 *
 * The previous version opened a predictable `<target>.tmp` with `"w"`, which
 * follows an existing symlink: a sentinel outside the repository could be
 * truncated before the rename ever happened. It also proved no complete write,
 * fsynced nothing, and left residue if the rename failed.
 *
 * So the temporary name is unique, the open is exclusive and refuses to follow
 * a link, the descriptor's owner and mode are verified after opening, every
 * byte is written and fsynced before the rename, and the exact temporary is
 * removed in `finally` on every failure path.
 */
function writeAtomically(
  target: string,
  directory: string,
  document: string,
): { readonly ok: true; readonly path: string; readonly bytes: number } | { readonly ok: false; readonly reason: string; readonly detail: string } {
  const bytes = Buffer.from(document, "utf8");
  // Unique: a predictable name is a name something else can prepare in advance.
  const temporary = join(directory, "." + basename(target) + "." + randomBytes(8).toString("hex") + ".tmp");

  let handle: number | null = null;
  let renamed = false;
  try {
    // O_EXCL refuses an existing path, O_NOFOLLOW refuses a symlink. Together
    // they mean this open either creates our file or fails.
    handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);

    const opened = fstatSync(handle);
    if (opened.uid !== process.getuid?.()) {
      return { ok: false, reason: "PATH_NOT_OWNED", detail: "the temporary file is not ours" };
    }
    if ((opened.mode & 0o777) !== FILE_MODE) {
      return { ok: false, reason: "UNSAFE_PERMISSIONS", detail: "the temporary file is not 0600" };
    }

    let written = 0;
    while (written < bytes.length) {
      written += writeSync(handle, bytes, written, bytes.length - written);
    }
    if (written !== bytes.length) {
      return { ok: false, reason: "MALFORMED_PLIST", detail: "the document was not written in full" };
    }
    fsyncSync(handle);
    closeSync(handle);
    handle = null;

    renameSync(temporary, target);
    renamed = true;
  } catch (error: unknown) {
    return {
      ok: false,
      reason: "DESTINATION_OUTSIDE_LOCAL",
      detail: "the render could not be written safely: " + classifyIoError(error),
    };
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // the descriptor is going away with the process anyway
      }
    }
    if (!renamed) {
      // The exact temporary, and only it.
      try {
        unlinkSync(temporary);
      } catch {
        // never created, or already gone
      }
    }
  }

  return { ok: true, path: target, bytes: bytes.length };
}

/** A classified code, never a rendered exception carrying paths. */
function classifyIoError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "UNKNOWN";
}
