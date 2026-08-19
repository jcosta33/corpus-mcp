#!/usr/bin/env node
// Regenerate contract fixtures from the real `suspec` binary. The fixtures in
// test/fixtures/*.json are the drift tripwire's ground truth:
// contract.spec.ts parses each through the contract schemas, so a fixture that drifts from reality
// (or a schema that drifts from the fixture) fails a test instead of suspec-mcp silently producing
// wrong output. They MUST be generated, not hand-edited — this script is the generator, and
// test/generated-fixtures.spec.ts re-runs it into a temp dir and asserts the checked-in fixtures
// still match (so a stale fixture trips CI).
//
// It builds a deterministic, self-contained scratch dir of artifacts (a spec, a task packet, a
// campaign, an unchecked audit) and captures EVERY `--json` shape the adapter consumes: the
// per-file check report, the unchecked-artifact notice, the checks contract, and the structured
// errors the task `--spec` companion rule emits. Paths are passed relative to scratch. The CLI
// resolves them before reporting, so capture strips only that scratch root.
//
// Usage:  node scripts/generate-fixtures.mjs [--out <dir>] [--suspec-bin <path>]
//   --out        where to write the fixtures (default: test/fixtures next to this script's repo)
//   --suspec-bin the `suspec` binary (default: SUSPEC_BIN env, else any sibling checkout whose
//                package name is "suspec-cli" — the folder name is irrelevant; see resolve-suspec-bin.mjs)

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectSuspecBin, resolveSuspecBin } from "./resolve-suspec-bin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : fallback;
}

let outDir;
let suspecBin;
let provenance;

const EXIT_BY_CLASS = {
  contract: 0,
  clean: 0,
  warning: 1,
  blocking: 2,
  "structured-error": 2,
};
const REPORT_LEVELS = ["clean", "warning", "blocking"];

function documentClass(document) {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    return "unknown";
  }
  if (
    typeof document.error === "string" &&
    typeof document.message === "string"
  ) {
    return "structured-error";
  }
  if (typeof document.version === "string" && Array.isArray(document.checks)) {
    return "contract";
  }
  return REPORT_LEVELS.includes(document.level) ? document.level : "unknown";
}

export function assertCaptureExpectation(
  stdout,
  status,
  { format, exitClass, expectedStatus },
  label = "capture",
) {
  if (format !== "json" && format !== "jsonl") {
    throw new Error(`${label} must declare format json or jsonl`);
  }
  if (!Object.hasOwn(EXIT_BY_CLASS, exitClass)) {
    throw new Error(`${label} must declare a known exit class`);
  }
  if (expectedStatus !== EXIT_BY_CLASS[exitClass]) {
    throw new Error(
      `${label} declares inconsistent ${exitClass}/exit ${String(expectedStatus)}`,
    );
  }
  if (status !== expectedStatus) {
    throw new Error(
      `${label} expected ${exitClass}/exit ${expectedStatus}, received exit ${String(status)}`,
    );
  }

  const documents =
    format === "jsonl"
      ? stdout
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : [JSON.parse(stdout)];
  const classes = documents.map(documentClass);
  let actualClass;
  if (
    classes.length > 0 &&
    classes.every((value) => REPORT_LEVELS.includes(value))
  ) {
    actualClass =
      REPORT_LEVELS[
        Math.max(...classes.map((value) => REPORT_LEVELS.indexOf(value)))
      ];
  } else if (
    classes.length > 0 &&
    classes.every((value) => value === "structured-error")
  ) {
    actualClass = "structured-error";
  } else if (classes.length === 1 && classes[0] === "contract") {
    actualClass = "contract";
  } else {
    actualClass = `mixed/unknown (${classes.join(", ") || "empty"})`;
  }
  if (actualClass !== exitClass) {
    throw new Error(
      `${label} expected ${exitClass}/exit ${expectedStatus}, received ${actualClass}/exit ${String(status)}`,
    );
  }
  return format === "jsonl" ? documents : documents[0];
}

export function normalizeCapturePaths(document, cwd) {
  const roots = new Set([resolve(cwd)]);
  try {
    roots.add(realpathSync(cwd));
  } catch {
    // The subprocess already proved cwd existed; retain the lexical root if it vanishes afterward.
  }
  const prefixes = [...roots].sort((a, b) => b.length - a.length);

  const normalize = (value) => {
    if (typeof value === "string") {
      let normalized = value;
      for (const prefix of prefixes) {
        if (normalized === prefix) normalized = ".";
        normalized = normalized
          .split(`${prefix}/`)
          .join("")
          .split(`${prefix}\\`)
          .join("");
      }
      return normalized;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, normalize(child)]),
      );
    }
    return value;
  };

  return normalize(document);
}

export function assertCleanProvenance(value) {
  if (value.worktreeDirty) {
    throw new Error(
      "fixture generation requires a clean suspec-cli worktree; commit or discard its changes first",
    );
  }
}

// Run `suspec <args> --json` in `cwd`; every caller must name the expected wire format, payload
// class, and process status before the subprocess runs.
function suspecOutput(cwd, args, expectation) {
  const res = spawnSync(process.execPath, [suspecBin, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = (res.stdout ?? "").trim();
  if (stdout.length === 0) {
    throw new Error(
      `suspec ${args.join(" ")} produced no JSON (exit ${res.status}): ${(res.stderr ?? "").trim()}`,
    );
  }
  return normalizeCapturePaths(
    assertCaptureExpectation(
      stdout,
      res.status,
      expectation,
      `suspec ${args.join(" ")}`,
    ),
    cwd,
  );
}

function suspec(cwd, args, exitClass, expectedStatus) {
  return suspecOutput(cwd, args, {
    format: "json",
    exitClass,
    expectedStatus,
  });
}

function suspecJsonl(cwd, args, exitClass, expectedStatus) {
  return suspecOutput(cwd, args, {
    format: "jsonl",
    exitClass,
    expectedStatus,
  });
}

function write(name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(outDir, `${name}.json`), text);
  process.stderr.write(`  wrote ${name}.json\n`);
}

// A complete, ready 2-AC spec — a clean spec check subject and the task `--spec` companion.
const SPEC = [
  "---",
  "type: spec",
  "id: SPEC-demo-feature",
  "title: Demo feature",
  "status: ready",
  "owner: fixtures",
  "base_sha: null",
  "sources:",
  "  - self",
  "---",
  "",
  "# Demo feature",
  "",
  "## Intent",
  "",
  "Add a demo feature so the fixtures exercise a real check.",
  "",
  "## Non-goals",
  "",
  "- It changes nothing in production.",
  "",
  "## Requirements",
  "",
  "### AC-001 — first",
  "",
  "- When: a request arrives",
  "- Then: the service MUST respond",
  "- Verify with: `git --version`",
  "",
  "### AC-002 — second",
  "",
  "- When: a second request arrives",
  "- Then: the service MUST respond",
  "- Verify with: `second test`",
  "",
  "## Open questions",
  "",
  "- none",
  "",
  "## Affected areas",
  "",
  "- `src-file.txt`",
  "",
  "## Dropped from sources",
  "",
  "- none",
  "",
].join("\n");

const TASK = [
  "---",
  "type: task",
  "id: TASK-demo",
  "source:",
  "  - SPEC-demo-feature",
  "scope: [AC-001]",
  "status: review-ready",
  "---",
  "",
  "# Task",
  "",
  "## Source",
  "",
  "SPEC-demo-feature",
  "",
  "## Scope",
  "",
  "AC-001",
  "",
  "## Do not change",
  "",
  "None.",
  "",
  "## Affected areas",
  "",
  "src-file.txt",
  "",
  "## Verify",
  "",
  "Exit status: 0",
  "",
  "```text",
  "PASS demo task (1 test)",
  "```",
  "",
  "## Agent instructions",
  "",
  "Implement AC-001.",
  "",
  "## Run order",
  "",
  "- This packet: TASK-demo",
  "- Starts after: None",
  "- May run with: None",
  "",
  "## Findings",
  "",
  "None.",
  "",
  "## Run summary",
  "",
  "Evidence is recorded under Verify.",
  "",
].join("\n");

const AUDIT = [
  "---",
  "type: audit",
  "id: AUDIT-demo",
  "---",
  "",
  "# Audit",
  "",
].join("\n");

const CAMPAIGN = [
  "---",
  "type: campaign",
  "id: CAMPAIGN-demo",
  "status: ready",
  "ledger: https://example.test/issues/1",
  "sources:",
  "  - https://example.test/spec.md",
  "---",
  "",
  "## Objective",
  "",
  "Finish the governed delivery.",
  "",
  "## Completion contract",
  "",
  "Current main satisfies every governing obligation.",
  "",
  "## Authorities",
  "",
  "The named sources and ledger govern.",
  "",
  "## Operating loop",
  "",
  "Read, reconcile, select, execute, verify, record, and repeat.",
  "",
  "## Stops",
  "",
  "Stop at completion or a named human decision.",
  "",
].join("\n");

const SPEC_SECOND = SPEC.replaceAll(
  "SPEC-demo-feature",
  "SPEC-demo-second",
).replace("# Demo feature", "# Second demo feature");
const SPEC_DUPLICATE = SPEC.replace(
  "# Demo feature",
  "# Duplicate demo feature",
);

const TASK_EMPTY_SCOPE = [
  "---",
  "type: task",
  "id: TASK-demo",
  "source:",
  "  - SPEC-demo-feature",
  "status: ready",
  "---",
  "",
  "# Scope-less task",
  "",
].join("\n");

const TASK_WRONG_SOURCE = TASK.replace(
  "  - SPEC-demo-feature",
  "  - SPEC-other",
);

const NOT_A_SPEC = [
  "---",
  "type: task",
  "id: SPEC-demo-feature",
  "status: ready",
  "---",
  "",
  "# Not a spec",
  "",
].join("\n");

const TASK_QUOTED_BOM = [
  "\ufeff---",
  'type: "task"',
  "id: TASK-demo-quoted-bom",
  "source:",
  "  - SPEC-demo-feature",
  "scope: [AC-001]",
  "status: ready",
  "---",
  "",
  "# Quoted BOM task",
  "",
].join("\n");

function main() {
  outDir = resolve(arg("--out", join(repoRoot, "test", "fixtures")));
  const suspecBinArg = arg("--suspec-bin", null);
  suspecBin = suspecBinArg ? resolve(suspecBinArg) : resolveSuspecBin(repoRoot);
  if (!suspecBin) {
    console.error(
      "generate-fixtures: cannot find the suspec binary. Pass --suspec-bin <path>, set SUSPEC_BIN, " +
        "or check out suspec-cli as a sibling (any folder name; package name must be suspec-cli).",
    );
    process.exit(2);
  }
  provenance = inspectSuspecBin(suspecBin);
  if (process.env.ALLOW_DIRTY_SUSPEC_CLI === "1") {
    if (provenance.worktreeDirty) {
      process.stderr.write(
        "generate-fixtures: allowing dirty suspec-cli worktree\n",
      );
    }
  } else {
    assertCleanProvenance(provenance);
  }
  process.stderr.write(
    `suspec-cli provenance: root=${resolve(suspecBin, "../..")}, head=${provenance.gitHead}, dirty=${provenance.worktreeDirty}, worktree=${provenance.worktreeSha256}, binary=${provenance.binarySha256}\n`,
  );
  mkdirSync(outDir, { recursive: true });
  write("provenance", provenance);
  const scratch = mkdtempSync(join(tmpdir(), "suspec-mcp-fixtures-"));
  try {
    process.stderr.write(`generating fixtures in ${scratch}\n`);
    writeFileSync(join(scratch, "spec-demo.md"), SPEC);
    writeFileSync(join(scratch, "task-demo.md"), TASK);
    writeFileSync(join(scratch, "audit-demo.md"), AUDIT);
    writeFileSync(join(scratch, "campaign-demo.md"), CAMPAIGN);
    writeFileSync(join(scratch, "spec-second.md"), SPEC_SECOND);
    writeFileSync(join(scratch, "spec-duplicate.md"), SPEC_DUPLICATE);
    writeFileSync(join(scratch, "task-empty-scope.md"), TASK_EMPTY_SCOPE);
    writeFileSync(join(scratch, "task-wrong-source.md"), TASK_WRONG_SOURCE);
    writeFileSync(join(scratch, "not-a-spec.md"), NOT_A_SPEC);
    writeFileSync(join(scratch, "task-quoted-bom.md"), TASK_QUOTED_BOM);

    write("check-spec", suspec(scratch, ["check", "spec-demo.md"], "clean", 0));
    write(
      "check-campaign",
      suspec(scratch, ["check", "campaign-demo.md"], "clean", 0),
    );
    write(
      "check-task",
      suspec(
        scratch,
        ["check", "task-demo.md", "--spec", "spec-demo.md"],
        "clean",
        0,
      ),
    );
    write(
      "check-task-diagnostics",
      suspec(
        scratch,
        ["check", "task-empty-scope.md", "--spec", "spec-demo.md"],
        "blocking",
        2,
      ),
    );
    write(
      "check-multiple",
      suspecJsonl(
        scratch,
        ["check", "spec-demo.md", "spec-second.md"],
        "clean",
        0,
      ),
    );
    write(
      "check-duplicate-id",
      suspecJsonl(
        scratch,
        ["check", "spec-demo.md", "spec-duplicate.md"],
        "blocking",
        2,
      ),
    );
    write(
      "check-unchecked",
      suspec(scratch, ["check", "audit-demo.md"], "clean", 0),
    );
    write("contract", suspec(scratch, ["check", "--contract"], "contract", 0));
    write(
      "error-missing-spec",
      suspec(scratch, ["check", "task-demo.md"], "structured-error", 2),
    );
    write(
      "error-spec-on-non-task",
      suspec(
        scratch,
        ["check", "spec-demo.md", "--spec", "spec-demo.md"],
        "structured-error",
        2,
      ),
    );
    write(
      "error-companion-not-found",
      suspec(
        scratch,
        ["check", "task-demo.md", "--spec", "no-such-spec.md"],
        "structured-error",
        2,
      ),
    );
    write(
      "error-task-wrong-source",
      suspec(
        scratch,
        [
          "check",
          "task-wrong-source.md",
          "--spec",
          "spec-demo.md",
        ],
        "structured-error",
        2,
      ),
    );
    write(
      "error-spec-wrong-type",
      suspec(
        scratch,
        ["check", "task-demo.md", "--spec", "not-a-spec.md"],
        "structured-error",
        2,
      ),
    );
    write(
      "error-quoted-bom-missing-spec",
      suspec(scratch, ["check", "task-quoted-bom.md"], "structured-error", 2),
    );
    process.stderr.write(`done. fixtures in ${outDir}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
