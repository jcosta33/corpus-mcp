import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheckReportSchema,
  FileSetReportSchema,
  CheckOutputSchema,
  UncheckedArtifactSchema,
  CheckFileSchema,
  CheckLineSchema,
  ContractSchema,
  SuspecErrorSchema,
} from "../src/suspec/contract.ts";

// The DRIFT TRIPWIRE has two halves that together pin stub → contract → reality:
//   (1) the captured fixtures were recorded from the REAL `suspec check … --json` (a scratch dir of
//       artifacts, relative paths). Parsing them proves the CONTRACT matches reality; a suspec-cli
//       rename or dropped field fails the parse here instead of the adapter silently producing wrong
//       output.
//   (2) the test STUB (the binary the integration tests run against) is parsed through the SAME
//       schemas, so the stub cannot drift from the contract the fixtures define — closing the gap
//       where the stub, the fixtures, and the CLI were three separate truths and the tests stayed
//       green on a divergence.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const stubBin = join(here, "fixtures", "stub-suspec.mjs");

function runStub(args: string[]): { data: unknown; exit: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "suspec-mcp-contract-"));
  try {
    writeFileSync(
      join(dir, "spec.md"),
      "---\ntype: spec\nid: SPEC-x\n---\n\n## Requirements\n",
    );
    writeFileSync(
      join(dir, "task.md"),
      "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-x\nscope: [AC-001]\n---\n",
    );
    writeFileSync(
      join(dir, "audit.md"),
      "---\ntype: audit\nid: AUDIT-x\n---\n",
    );
    writeFileSync(
      join(dir, "campaign.md"),
      "---\ntype: campaign\nid: CAMPAIGN-x\nstatus: ready\nledger: https://example.test/issues/1\nsources: [https://example.test/spec.md]\n---\n",
    );
    writeFileSync(
      join(dir, "wrong-source-task.md"),
      "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-other\nscope: [AC-001]\n---\n",
    );
    writeFileSync(
      join(dir, "not-a-spec.md"),
      "---\ntype: task\nid: SPEC-x\n---\n",
    );
    writeFileSync(
      join(dir, "task-quoted-bom.md"),
      '\ufeff---\ntype: "task"\nid: TASK-normalized\nsource:\n  - SPEC-x\nscope: [AC-001]\nstatus: ready\n---\n',
    );
    writeFileSync(
      join(dir, "review.md"),
      "---\ntype: review\nid: REVIEW-x\n---\n",
    );
    const res = spawnSync(stubBin, [...args, "--json"], {
      cwd: dir,
      encoding: "utf8",
    });
    return { data: JSON.parse(res.stdout.trim()), exit: res.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the contract matches the real --json shapes (captured fixtures)", () => {
  it("check <spec> --json → a clean CheckReport", () => {
    const parsed = CheckReportSchema.safeParse(fixture("check-spec.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.level).toBe("clean");
      expect(parsed.data.diagnostics).toEqual([]);
    }
  });

  it("check <task> --spec --json → a deterministic CheckReport", () => {
    const parsed = CheckReportSchema.safeParse(fixture("check-task.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.path).toBe("task-demo.md");
    }
  });

  it("check <campaign> --json → a clean CheckReport", () => {
    const parsed = CheckReportSchema.safeParse(fixture("check-campaign.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("campaign");
      expect(parsed.data.level).toBe("clean");
    }
  });

  it("a diagnostic-carrying task report pins the diagnostic fields (code/severity/message/line)", () => {
    const parsed = CheckReportSchema.safeParse(
      fixture("check-task-diagnostics.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.diagnostics.length).toBeGreaterThan(0);
      expect(parsed.data.diagnostics.map((d) => d.code)).toContain("C022");
      expect(parsed.data.level).toBe("blocking");
    }
  });

  it("check on an artifact type with no check face → UncheckedArtifact (checked:false, exit-0 shape)", () => {
    const parsed = UncheckedArtifactSchema.safeParse(
      fixture("check-unchecked.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("audit");
      expect(parsed.data.checked).toBe(false);
    }
  });

  it("accepts only the four recognized unchecked artifact types", () => {
    for (const type of ["inventory", "audit", "research"]) {
      expect(
        UncheckedArtifactSchema.safeParse({
          level: "clean",
          path: `${type}.md`,
          type,
          checked: false,
        }).success,
      ).toBe(true);
    }
    for (const type of [
      "spec",
      "task",
      "change-plan",
      "campaign",
      "inspection",
      "review",
    ]) {
      expect(
        UncheckedArtifactSchema.safeParse({
          level: "clean",
          path: `${type}.md`,
          type,
          checked: false,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps checked reports and unchecked notices disjoint", () => {
    expect(
      CheckReportSchema.safeParse({
        level: "clean",
        path: "spec.md",
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "clean",
        path: "spec.md",
        diagnostics: [],
        checked: false,
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        level: "blocking",
        path: "audit.md",
        diagnostics: [
          {
            code: "C021",
            name: "intent-present",
            severity: "hard-error",
            message: "spec has no non-empty Intent section",
          },
        ],
        type: "audit",
        checked: false,
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        level: "clean",
        path: "audit.md",
        type: "audit",
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      UncheckedArtifactSchema.safeParse({
        level: "clean",
        path: "audit.md",
        type: "audit",
        checked: false,
        diagnostics: [],
      }).success,
    ).toBe(false);
  });

  it("every check capture parses under the CheckFile union", () => {
    for (const name of [
      "check-spec.json",
      "check-task.json",
      "check-task-diagnostics.json",
      "check-unchecked.json",
    ]) {
      expect(
        CheckFileSchema.safeParse(fixture(name)).success,
        `${name} must parse as a CheckFile`,
      ).toBe(true);
    }
  });

  it("multi-path captures preserve report order and carry an optional C002 file-set report", () => {
    const multiple = fixture("check-multiple.json") as unknown[];
    expect(multiple).toHaveLength(2);
    expect(
      multiple.every((item) => CheckFileSchema.safeParse(item).success),
    ).toBe(true);
    const duplicate = fixture("check-duplicate-id.json") as unknown[];
    expect(duplicate).toHaveLength(3);
    const setReport = FileSetReportSchema.parse(duplicate[2]);
    expect(setReport.path).toBe("(file set)");
    expect(setReport.diagnostics.map((item) => item.code)).toContain("C002");
  });

  it("keeps file-set reports distinct from artifact reports", () => {
    const diagnostic = {
      code: "C002",
      severity: "hard-error",
      message: "duplicate id",
    } as const;
    expect(
      FileSetReportSchema.safeParse({
        path: "(file set)",
        level: "blocking",
        diagnostics: [diagnostic],
        type: "spec",
      }).success,
    ).toBe(false);
    expect(
      CheckOutputSchema.safeParse({
        path: "(file set)",
        level: "blocking",
        diagnostics: [diagnostic],
        type: "spec",
      }).success,
    ).toBe(false);
    expect(
      FileSetReportSchema.safeParse({
        path: "(file set)",
        level: "blocking",
        diagnostics: [{ ...diagnostic, code: "C021" }],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        path: "spec.md",
        level: "blocking",
        diagnostics: [diagnostic],
        type: "spec",
      }).success,
    ).toBe(false);
  });

  it("check --contract --json → Contract (version + the core checks)", () => {
    const parsed = ContractSchema.safeParse(fixture("contract.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe("0.27.0");
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      for (const check of parsed.data.checks) {
        expect(check.id).toMatch(/^C\d{3}$/);
      }
    }
  });

  it.each([
    ["empty", (contract: { checks: unknown[] }) => contract.checks.splice(0)],
    ["partial", (contract: { checks: unknown[] }) => contract.checks.splice(1)],
    [
      "duplicate ID",
      (contract: { checks: unknown[] }) =>
        contract.checks.push(contract.checks[0]),
    ],
    [
      "unknown ID",
      (contract: { checks: { id: string }[] }) => {
        contract.checks[0].id = "C999";
      },
    ],
    [
      "corrupted name",
      (contract: { checks: { name: string }[] }) => {
        contract.checks[0].name = "renamed";
      },
    ],
    [
      "corrupted severity",
      (contract: { checks: { severity: string }[] }) => {
        contract.checks[0].severity = "warning";
      },
    ],
  ])("rejects a %s 0.27.0 checks table", (_case, mutate) => {
    const contract = structuredClone(fixture("contract.json")) as {
      checks: { id: string; name: string; severity: string }[];
    };
    mutate(contract);
    expect(ContractSchema.safeParse(contract).success).toBe(false);
  });

  it("a task checked with NO --spec is a structured error (missing --spec)", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-missing-spec.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/missing --spec/);
    }
  });

  it("--spec on a non-task artifact is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-spec-on-non-task.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/--spec accompanies task paths/);
    }
  });

  it("a handed companion path missing on disk is a structured error (file not found)", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-companion-not-found.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/--spec file not found/);
    }
  });

  it("a task that does not name the handed spec is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-task-wrong-source.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/does not name handed spec/);
    }
  });

  it("a non-spec --spec companion is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-spec-wrong-type.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/fails deterministic checks: .*C025/);
    }
  });

  it("a quoted BOM-prefixed task with no spec is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-quoted-bom-missing-spec.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.message).toMatch(/missing --spec/);
  });

  it("the tripwire FAILS if a consumed field is renamed/dropped (a diagnostic's message; the contract's checks)", () => {
    const report = JSON.parse(
      readFileSync(
        join(here, "fixtures", "check-task-diagnostics.json"),
        "utf8",
      ),
    );
    delete report.diagnostics[0].message;
    expect(CheckReportSchema.safeParse(report).success).toBe(false);
    const contract = JSON.parse(
      readFileSync(join(here, "fixtures", "contract.json"), "utf8"),
    );
    delete contract.checks;
    expect(ContractSchema.safeParse(contract).success).toBe(false);
  });

  it("the runtime line schema accepts reports and structured errors but rejects unknown documents", () => {
    expect(CheckLineSchema.safeParse(fixture("check-spec.json")).success).toBe(
      true,
    );
    expect(
      CheckLineSchema.safeParse(fixture("error-missing-spec.json")).success,
    ).toBe(true);
    expect(CheckLineSchema.safeParse({ malformed: true }).success).toBe(false);
  });

  it("rejects unknown report levels and diagnostic severities", () => {
    const report = JSON.parse(
      readFileSync(
        join(here, "fixtures", "check-task-diagnostics.json"),
        "utf8",
      ),
    );
    report.level = "a-new-level-class";
    report.diagnostics[0].severity = "a-new-severity-class";
    expect(CheckReportSchema.safeParse(report).success).toBe(false);
    report.level = "blocking";
    expect(CheckReportSchema.safeParse(report).success).toBe(false);
    report.diagnostics[0].severity = "hard-error";
    expect(CheckReportSchema.safeParse(report).success).toBe(true);
  });

  it("binds diagnostic codes, severities, and report levels to the supported checks table", () => {
    const diagnostic = {
      code: "C021",
      severity: "warning",
      message: "intent missing",
      line: null,
    };
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "warning",
        path: "spec.md",
        diagnostics: [diagnostic],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "warning",
        path: "spec.md",
        diagnostics: [{ ...diagnostic, code: "C999" }],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "review",
        level: "blocking",
        path: "review.md",
        diagnostics: [
          { ...diagnostic, code: "C022", severity: "hard-error" },
        ],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "clean",
        path: "spec.md",
        diagnostics: [{ ...diagnostic, code: "C004", severity: "hard-error" }],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "blocking",
        path: "spec.md",
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "blocking",
        path: "spec.md",
        diagnostics: [{ ...diagnostic, code: "C004", severity: "hard-error" }],
      }).success,
    ).toBe(true);
  });
});

describe("the test stub conforms to the SAME contract as the real captured output", () => {
  it("stub check <spec> output parses against CheckReportSchema (exit 1: a warning report)", () => {
    const { data, exit } = runStub(["check", "spec.md"]);
    expect(CheckReportSchema.safeParse(data).success).toBe(true);
    expect(exit).toBe(1);
  });

  it("stub check on a no-check-face type parses against UncheckedArtifactSchema (exit 0)", () => {
    const { data, exit } = runStub(["check", "audit.md"]);
    expect(UncheckedArtifactSchema.safeParse(data).success).toBe(true);
    expect(exit).toBe(0);
  });

  it("stub check --contract parses against ContractSchema", () => {
    const { data } = runStub(["check", "--contract"]);
    expect(ContractSchema.safeParse(data).success).toBe(true);
  });

  it("stub refuses a retired review type as unknown", () => {
    const { data, exit } = runStub(["check", "review.md"]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/unknown type `review`/);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses --spec on a non-task artifact exactly like the real CLI", () => {
    const { data, exit } = runStub(["check", "spec.md", "--spec", "spec.md"]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const real = SuspecErrorSchema.parse(
        fixture("error-spec-on-non-task.json"),
      );
      expect(parsed.data.message).toBe(real.message);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses a task checked with NO --spec exactly like the real CLI (exit 2, same message)", () => {
    const { data, exit } = runStub(["check", "task.md"]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const real = SuspecErrorSchema.parse(fixture("error-missing-spec.json"));
      expect(parsed.data.message).toBe(real.message);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses a companion path missing on disk exactly like the real CLI (exit 2, same message shape)", () => {
    const { data, exit } = runStub([
      "check",
      "task.md",
      "--spec",
      "no-such-spec.md",
    ]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toBe(
        "--spec file not found: no-such-spec.md",
      );
      const real = SuspecErrorSchema.parse(
        fixture("error-companion-not-found.json"),
      );
      expect(real.message).toMatch(/--spec file not found/);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses a task that does not name the handed spec like the real CLI", () => {
    const { data, exit } = runStub([
      "check",
      "wrong-source-task.md",
      "--spec",
      "spec.md",
    ]);
    const parsed = SuspecErrorSchema.parse(data);
    const real = SuspecErrorSchema.parse(
      fixture("error-task-wrong-source.json"),
    );
    expect(parsed.message).toMatch(/does not name handed spec/);
    expect(real.message).toMatch(/does not name handed spec/);
    expect(exit).toBe(2);
  });

  it("stub refuses a non-spec --spec companion like the real CLI", () => {
    const { data, exit } = runStub([
      "check",
      "task.md",
      "--spec",
      "not-a-spec.md",
    ]);
    const parsed = SuspecErrorSchema.parse(data);
    const real = SuspecErrorSchema.parse(fixture("error-spec-wrong-type.json"));
    expect(parsed.message).toBe(real.message);
    expect(exit).toBe(2);
  });

  it("stub recognizes a quoted BOM-prefixed task like the real CLI", () => {
    const { data, exit } = runStub(["check", "task-quoted-bom.md"]);
    const parsed = SuspecErrorSchema.parse(data);
    const real = SuspecErrorSchema.parse(
      fixture("error-quoted-bom-missing-spec.json"),
    );
    expect(parsed.message).toBe(real.message);
    expect(exit).toBe(2);
  });
});
