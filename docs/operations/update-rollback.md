# Updating and rolling back

## What "update" means in this repository

There is no release channel. The repository is published, but publication is
one-way and manual: `.githooks/pre-push` denies by default and permits only an
explicitly authorized fast-forward of `main`, which the fence drives case by
case. Nothing fetches updates into this repository and there is no automatic
release. So an update is not a fetch — it is a deliberate, local change to
pinned versions, followed by the full gate battery.

Every shared version is pinned exactly, in one place, in the workspace catalog.
A range would let a rendering or cache-semantics change arrive unreviewed, which
is the thing the pins exist to prevent.

## Updating a dependency

1. **Check the engine range first, not last.** A dependency whose `engines`
   disagrees with the repository's own Node pin cannot be taken without a
   separate decision:

   ```sh
   cat .nvmrc
   node -e 'console.log(require("./package.json").engines)'
   pnpm view jsdom engines.node
   ```

   `jsdom` is a real dependency of this workspace and a real example of the
   problem: that command prints `^22.22.2 || ^24.15.0 || >=26.0.0`, which the
   repository's own floor of `22.17.0` does **not** satisfy — which is why the
   pin here is an older jsdom. Substitute the package you are actually
   updating. (Workspace-internal packages such as `@acp/contracts` are private
   and never published, so `pnpm view` cannot answer for them — read their
   `package.json` directly instead.)

   `.nvmrc` is `22.17.0` and the manifest declares `>=22.17.0 <23`. If the new
   version needs more than that, **stop**: raising the floor the repository
   states it runs on is a decision about the whole workspace, not a side effect
   of installing a tool. Pin the newest version the declared floor satisfies, and
   record why beside the pin.

2. **Edit the pin**, in `pnpm-workspace.yaml`'s catalog for a shared version, or
   in the owning package's manifest.

3. **Install, and read what arrived:**

   ```sh
   pnpm install
   git diff pnpm-lock.yaml | grep '^+' | head -40
   ```

4. **Check what the new graph wants to run at install time.** pnpm does not run
   dependency build scripts by default: `onlyBuiltDependencies` in
   `pnpm-workspace.yaml` is the allow-list of packages *permitted* to run them,
   and it is exactly one name — `better-sqlite3`, the ledger engine, and only as
   a source-build fallback on a platform without a prebuild. The architecture
   fence asserts that list stays exactly that.

   So a package that **declares** `preinstall`/`install`/`postinstall` is not
   thereby running anything — its script is ignored unless someone puts the name
   on the list. What the following command gives you is the *inventory* of
   declared hooks, which is the input to a decision, not a verdict:

   ```sh
   node -e '
   const { readdirSync, existsSync, readFileSync } = require("node:fs");
   const base = "node_modules/.pnpm";
   const declared = new Set();
   for (const dir of readdirSync(base)) {
     const inner = base + "/" + dir + "/node_modules";
     if (!existsSync(inner)) continue;
     for (const name of readdirSync(inner)) {
       const file = inner + "/" + name + "/package.json";
       if (!existsSync(file)) continue;
       let pkg; try { pkg = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
       const s = pkg.scripts || {};
       for (const hook of ["preinstall", "install", "postinstall"]) {
         if (s[hook]) declared.add(pkg.name + " (" + hook + ")");
       }
     }
   }
   console.log([...declared].sort().join("\n") || "(none declare install hooks)");
   '
   grep -A3 "^onlyBuiltDependencies:" pnpm-workspace.yaml
   ```

   On the current tree the inventory lists `esbuild (postinstall)` and the
   allow-list holds only `better-sqlite3` — meaning esbuild's script is **not
   run**. That is the expected, healthy state.

   The question to answer after an update is therefore: *did anything new appear
   in that inventory, and does anything now need to be on the allow-list?*
   **Adding a name is an owner decision with a written reason**, never a step
   someone takes to make an install quieter. If a package genuinely needs its
   build script, that is a decision to raise.

   Note that `prepare` and `prepack` are **not** install hooks for a registry
   install — they run on git installs and when packing a tarball. Only
   `preinstall`/`install`/`postinstall` are what the allow-list governs, which is
   why the command looks for exactly those three.

5. **Run the whole battery, and read real exit codes:**

   ```sh
   pnpm check
   echo "exit: $?"
   ```

   This assumes the two one-off prerequisites from the
   [runbook](./runbook.md) are already established in this checkout —
   `git config core.hooksPath .githooks`, and the Restate binary acquired with
   `node scripts/acquire-restate-server.mjs`. Without them `pnpm check` fails on
   setup rather than on your change, which would tell you nothing about the
   update you just made.

## Updating the Restate server pin

The server binary is not an npm dependency — the published package pulls a
postinstall network beacon, so it is acquired externally with platform and
SHA-256 verification. The pin is `scripts/restate-server.pin.json` (currently
version `1.7.7`), and it records the release, the asset host, the path prefix
and per-platform digests.

Changing it means editing the pin, acquiring against the new pin, and checking
the result:

```sh
node scripts/acquire-restate-server.mjs
node scripts/acquire-restate-server.mjs --verify-only
```

The first fetches and verifies; the second only reports. `--verify-only` never
fetches — on a machine without the binary it says so and exits 1, which is an
answer, not a failure to acquire.

Never point the acquisition at a host or path the pin does not name. The
verification is the whole value of the mechanism.

## Rolling back

**Rollback here is fix-forward, and it is never destructive.** The repository's
own laws forbid the destructive shortcuts outright: no `git checkout --` or
`git restore` over a directory, no `git reset --hard`, no `stash`, no `clean`.
Those rules exist because they were once broken and a week of work went with
them.

### Rolling back a dependency

Put the previous pin back, `pnpm install`, `pnpm check`. That is the whole
procedure, and it leaves a record of both moves.

### Rolling back running state

Stop the processes, restore the ledger from a backup, and prove it — see
[backup and restore](./backup-restore.md). The proof is `integrity` plus a clean
start against the restored file, in that order.

### Rolling back committed code

The repository is local-only and every commit is deliberate, so the honest move
is a new commit that undoes the change, not a rewrite of history that has
already been recorded. If you believe a checkout or reset is genuinely required,
**that is a decision to raise, not a command to run** — the rules above are not
advisory, and a working tree with uncommitted work is exactly where those
commands do their damage.

Before anything of this kind:

```sh
git status --porcelain
git log --oneline -5
```

An empty porcelain means there is nothing uncommitted to lose. A non-empty one
means commit or record it first.

### Inspecting a previous state without moving the tree

You can read history without touching the working tree at all:

```sh
git show 66b1153fb7e5c8eeac45d5aa4f1b232fe28c5c10:docs/ROADMAP.md | head -40
git diff 66b1153fb7e5c8eeac45d5aa4f1b232fe28c5c10 -- packages/entrypoints/gateway/src
```

This answers "what did it look like then" without a checkout, which is almost
always the actual question.

That hash is a real commit in this history, chosen so the two lines run as
printed and return something worth looking at. **It is an example, not your
target** — get the one you want from `git log --oneline` above and use that.
Do not write `<commit>` literally: your shell reads `<` as input redirection
and will fail before Git is ever invoked.

## What is not on this page

Nothing here adopts the plane into real operation, promotes anything to a
product, or performs a cutover. That step is separate, is not authorised, and is
deliberately absent from every operational page.
