#!/usr/bin/env node
// A stub `suspec` binary for deterministic, offline suspec-mcp tests — the path-explicit check
// surface. Records every invocation's argv to STUB_LOG (so tests can assert which subprocesses ran /
// that no mutation flag was ever passed) and emits JSON to stdout mirroring the real CLI's --json
// shapes. Like the real CLI, it reads the checked file itself: the kind sniff comes from the file's
// frontmatter `type:`. Tasks require --spec. Companions must exist on disk, so the adapter's plumbing
// is exercised end to end.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { validContract } from "./valid-contract.mjs";

const argv = process.argv.slice(2);
if (process.env.STUB_LOG) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
}
// Make the no-write test non-circular: if a mutation/dispatch-shaped flag is EVER passed, drop a marker
// into the subprocess cwd. The test then asserts the marker never appears — a real failure if the
// adapter leaks such a flag, not a tautology about a non-writing stub.
if (
  argv.some(
    (a) =>
      a === "--write" || a === "--force" || a === "--agent" || a === "--launch",
  )
) {
  appendFileSync(join(process.cwd(), "WRITE-FLAG-SEEN"), "1");
}

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const fail = (message) => {
  emit({ error: "Usage", message });
  process.exit(2);
};
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const frontmatter = (text) => {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if (lines[0] !== "---") return "";
  const end = lines.indexOf("---", 1);
  return end < 0 ? "" : lines.slice(1, end).join("\n");
};
const normalizeScalar = (raw) => {
  let inSingle = false;
  let inDouble = false;
  let value = raw;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (
      char === "#" &&
      !inSingle &&
      !inDouble &&
      (i === 0 || /\s/.test(raw[i - 1]))
    ) {
      value = raw.slice(0, i);
      break;
    }
  }
  value = value.trim();
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
};
const scalar = (head, name) => {
  const raw = new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m").exec(head)?.[1];
  return raw === undefined ? undefined : normalizeScalar(raw);
};
const isBlockList = (head, name) =>
  new RegExp(`^${name}:\\s*$\\n\\s*-\\s+`, "m").test(head);
const list = (head, name) => {
  const lines = head.split("\n");
  const index = lines.findIndex((line) => new RegExp(`^${name}:`).test(line));
  if (index < 0) return [];
  const inline = lines[index].replace(new RegExp(`^${name}:\\s*`), "").trim();
  if (inline.length > 0) {
    return normalizeScalar(inline)
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map(normalizeScalar)
      .filter(Boolean);
  }
  const values = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const item = /^\s*-\s+(.+?)\s*$/.exec(lines[i]);
    if (item === null) break;
    values.push(normalizeScalar(item[1]));
  }
  return values;
};

const verb = argv[0];
if (verb !== "check") {
  fail(`unknown verb: ${verb}`);
}

if (argv.includes("--contract")) {
  emit(validContract);
  process.exit(0);
}

const VALUED = new Set(["--spec"]);
const positionals = [];
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (token.startsWith("--")) {
    if (token !== "--json" && token !== "--contract" && !VALUED.has(token)) {
      fail(`unknown option: ${token}`);
    }
    if (VALUED.has(token)) {
      i += 1;
    }
    continue;
  }
  positionals.push(token);
}
if (positionals.length === 0) {
  fail("no artifact named — usage: suspec check <artifact> [<artifact>...]");
}
const seen = new Set();
const distinctPositionals = positionals.filter((file) => {
  let identity;
  try {
    const stats = statSync(file, { bigint: true });
    identity = `${stats.dev}:${stats.ino}`;
  } catch {
    identity = resolve(file);
  }
  if (seen.has(identity)) return false;
  seen.add(identity);
  return true;
});
const artifacts = distinctPositionals.map((file) => {
  if (!existsSync(file)) {
    fail(`file not found: ${file}`);
  }
  if (statSync(file).isDirectory()) {
    fail(
      `not an artifact file (it is a directory): ${file} — point at the file inside it`,
    );
  }
  const source = readFileSync(file, "utf8");
  const head = frontmatter(source);
  return { file, source, head, type: scalar(head, "type") ?? null };
});
const CHECKED = new Set(["spec", "task", "change-plan", "campaign"]);
const UNCHECKED = new Set(["inventory", "audit", "research", "panel"]);
for (const artifact of artifacts) {
  if (
    artifact.type !== null &&
    !CHECKED.has(artifact.type) &&
    !UNCHECKED.has(artifact.type)
  ) {
    fail(
      `artifact \`${artifact.file}\` declares unknown type \`${artifact.type}\``,
    );
  }
}
const tasks = artifacts.filter((artifact) => artifact.type === "task");
if (tasks.length === 0 && flag("--spec") !== undefined) {
  fail("--spec accompanies task paths");
}
if (tasks.length > 0 && flag("--spec") === undefined) {
  fail(
    "task checks need their source spec: missing --spec — usage: suspec check <task-path> [<task-path>...] --spec <spec-path>",
  );
}
if (tasks.length > 0) {
  const spec = flag("--spec");
  if (!existsSync(spec)) fail(`--spec file not found: ${spec}`);
  const specHead = frontmatter(readFileSync(spec, "utf8"));
  if (isBlockList(specHead, "type")) {
    fail("--spec `type:` must be a single scalar, not a list");
  }
  if (isBlockList(specHead, "id")) {
    fail("--spec `id:` must be a single scalar, not a list");
  }
  const specType = scalar(specHead, "type");
  if (specType !== undefined && specType !== "spec") {
    fail("--spec companion fails deterministic checks: C021, C025, C008");
  }
  const specId = scalar(specHead, "id");
  if (specId === undefined) {
    fail("--spec companion must name its artifact in `id:`");
  }
  for (const task of tasks) {
    if (!list(task.head, "source").includes(specId)) {
      fail(
        `task \`${task.file}\` does not name handed spec \`${specId}\` in \`source:\``,
      );
    }
  }
}

let status = 0;
for (const artifact of artifacts) {
  if (UNCHECKED.has(artifact.type)) {
    emit({
      level: "clean",
      path: artifact.file,
      type: artifact.type,
      checked: false,
    });
    continue;
  }
  emit({
    type: artifact.type,
    level: "warning",
    path: artifact.file,
    diagnostics: [
      { code: "C008", severity: "warning", message: "demo", line: 1 },
    ],
  });
  status = Math.max(status, 1);
}

const firstPathById = new Map();
const duplicateDiagnostics = [];
for (const artifact of artifacts) {
  const id = scalar(artifact.head, "id");
  if (id === undefined) continue;
  const first = firstPathById.get(id);
  if (first !== undefined) {
    duplicateDiagnostics.push({
      code: "C002",
      severity: "hard-error",
      message: `artifact id ${id} is reused by ${first} and ${artifact.file}`,
      line: null,
    });
  } else {
    firstPathById.set(id, artifact.file);
  }
}
if (duplicateDiagnostics.length > 0) {
  emit({
    path: "(file set)",
    level: "blocking",
    diagnostics: duplicateDiagnostics,
  });
  status = 2;
}
process.exit(status);
