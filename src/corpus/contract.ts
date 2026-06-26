// zod schemas mirroring the corpus CLI's real `--json` shapes (verified against the binary). These are
// the DRIFT TRIPWIRE: corpus-mcp parses every CLI payload through them, so if corpus-cli renames or drops
// a field corpus-mcp consumes (e.g. ReviewReport.coverage), the parse fails loudly in a test rather than
// silently producing wrong tool output. `.passthrough()` keeps unknown extra fields (additive CLI
// changes don't break us); the named fields are the ones corpus-mcp actually reads, modelled as the CLI
// types them — closed sets as `z.enum` (a new/renamed enum value trips the wire) and the always-present
// top-level lists as required (a dropped list trips the wire).

import { z } from "zod";

// The three exit classes an engine success carries (unixOutcome.ts `OutcomeLevel`). NOT a review
// result — it is the CLI's advisory severity (clean = exit 0, warning = 1, blocking = 2).
const OutcomeLevel = z.enum(["clean", "warning", "blocking"]);
// A check diagnostic's severity (checksContract.ts `CheckSeverity`).
const CheckSeverity = z.enum(["hard-error", "warning"]);

// --- corpus status --json  → DerivedBoard (deriveBoard.ts) -----------------------------------------
const BoardTask = z
  .object({
    id: z.string(),
    status: z.string(),
    hasReview: z.boolean(),
    reviewStatus: z.string().nullable(),
  })
  .passthrough(); // reviewStatus is `string | null` (deriveBoard.ts) — null for an unreviewed task; status is free-form frontmatter
const BoardSpec = z
  .object({ id: z.string(), status: z.string(), tasks: z.array(BoardTask) })
  .passthrough();
export const DerivedBoardSchema = z
  .object({
    level: OutcomeLevel,
    specs: z.array(BoardSpec),
    // The board's two headline triage lists (deriveBoard.ts) — review-ready tasks with no packet,
    // and tasks whose review status reads needs-human/blocked. Always emitted; modelled so a drop trips.
    tasksWithoutReview: z.array(z.string()),
    needsHuman: z.array(z.string()),
  })
  .passthrough();
export type DerivedBoard = z.infer<typeof DerivedBoardSchema>;

// --- corpus check [file] --json (checkSpec.ts / checkWorkspace.ts) ---------------------------------
const Diagnostic = z
  .object({
    code: z.string(),
    severity: CheckSeverity,
    message: z.string(),
    line: z.number().nullable().optional(),
  })
  .passthrough();
export const FileCheckSchema = z
  .object({
    level: OutcomeLevel,
    path: z.string(),
    diagnostics: z.array(Diagnostic),
  })
  .passthrough();
export type FileCheck = z.infer<typeof FileCheckSchema>;

const WorkspaceSpecCheck = z
  .object({
    path: z.string(),
    level: OutcomeLevel,
    diagnostics: z.array(Diagnostic),
  })
  .passthrough();
// A workspace-level finding (checkWorkspace.ts `WorkspaceFinding`) — a C002/C017 collision, a kit-
// validity problem (placeholder / missing-template / agents-oversize), or one of the reconcile-only
// advisories (supersede-* / duplicate-content / unpromoted-finding / incomplete-execution-digest). These
// live OUTSIDE any spec's diagnostics, so an agent reading only `specs[]` would miss them; the closed
// `code` set is the drift tripwire — a new/renamed CLI finding code trips a contract test (kept in sync
// with checkWorkspace.ts `WorkspaceFinding`).
const WorkspaceFinding = z
  .object({
    code: z.enum([
      "C002",
      "C017",
      "placeholder",
      "missing-template",
      "agents-oversize",
      "supersede-unresolved",
      "supersede-missing-pointer",
      "duplicate-content",
      "unpromoted-finding",
      "incomplete-execution-digest",
    ]),
    message: z.string(),
  })
  .passthrough();
export const WorkspaceCheckSchema = z
  .object({
    level: OutcomeLevel,
    // The check outcome (NOT a review verdict): the merge-gate result the CLI computes for the repo.
    verdict: z.enum(["clean", "blocking"]),
    specs: z.array(WorkspaceSpecCheck),
    // The change-plan files' check results, same shape as a spec result (checkWorkspace.ts).
    changePlans: z.array(WorkspaceSpecCheck),
    workspaceFindings: z.array(WorkspaceFinding),
  })
  .passthrough();
export type WorkspaceCheck = z.infer<typeof WorkspaceCheckSchema>;

// --- corpus review <stem> --json  → ReviewReport (reconcileReview.ts) ------------------------------
// kind is the C012 coverage class; modelled as the closed set so a new/renamed kind trips the wire.
const CoverageFinding = z
  .object({
    id: z.string(),
    kind: z.enum(["uncovered", "orphan"]),
    message: z.string(),
  })
  .passthrough();
// The C013 verify-evidence-binding consistency classes (checksContract.ts `VerifyBindingFinding`).
const VerifyBindingReport = z
  .object({
    id: z.string(),
    kind: z.enum([
      "cmd-mismatch",
      "result-fail",
      "malformed",
      "duplicate",
      "free-form-only",
    ]),
    message: z.string(),
  })
  .passthrough();
const SelfReport = z
  .object({
    claimedNotInDiff: z.array(z.string()),
    inDiffNotClaimed: z.array(z.string()),
    outsideScope: z.array(z.string()),
    // A prose Run summary with no machine-checkable file paths (corpus-cli #44): the inDiffNotClaimed
    // flood is suppressed and this is surfaced once. Optional for back-compat with an older CLI.
    runSummaryUnparsed: z.boolean().optional(),
  })
  .passthrough();
const PacketStructural = z
  .object({
    badResultCells: z.array(z.string()),
    badStatus: z.string().nullable(),
    statusPassContradicted: z.boolean(),
    missingSections: z.array(z.string()),
  })
  .passthrough();
export const ReviewReportSchema = z
  .object({
    level: OutcomeLevel,
    task: z.string(),
    diffChangedFiles: z.array(z.string()),
    // The adapter derives human-attention from `.message` on each of these — a rename/drop trips the wire.
    coverage: z.array(CoverageFinding),
    verifyBinding: z.array(VerifyBindingReport),
    scopeDivergence: z.array(z.string()),
    selfReport: SelfReport,
    // Changed files matching a task's `## Do not change` entry (C014, ADR-0086) — distinct from
    // selfReport.outsideScope; the adapter derives a human-attention item from it.
    doNotChangeTouched: z.array(z.string()),
    emptyEvidencePassRows: z.array(z.string()),
    packetStructural: PacketStructural,
    hasReviewPacket: z.boolean(),
  })
  .passthrough();
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

// --- corpus show <kind> [ref] --json  → ShowResult (showArtifact.ts) -------------------------------
// The loader projections corpus-mcp's get_* tools surface. Same drift-tripwire intent as the schemas
// above: a renamed/dropped field the adapter relies on trips a parse in the contract tests. Each is the
// uniform `{ level: 'clean', kind, value }` envelope (show never warns; a lookup failure is exit 2).
const showEnvelope = <T extends z.ZodTypeAny>(kind: string, value: T) =>
  z
    .object({ level: z.literal("clean"), kind: z.literal(kind), value })
    .passthrough();

// corpus show checks → the contract version + the core checks (id/name/severity).
export const ShowChecksSchema = showEnvelope(
  "checks",
  z
    .object({
      version: z.string(),
      checks: z.array(
        z
          .object({ id: z.string(), name: z.string(), severity: CheckSeverity })
          .passthrough(),
      ),
    })
    .passthrough(),
);
export type ShowChecks = z.infer<typeof ShowChecksSchema>;

// corpus show task → the task packet's frontmatter + scope/areas + the ADR-0100 cross-root embedded slice.
export const ShowTaskSchema = showEnvelope(
  "task",
  z
    .object({
      id: z.string().nullable(),
      source: z.string().nullable(),
      status: z.string().nullable(),
      scope: z.array(z.string()),
      affectedAreas: z.array(z.string()),
      doNotChange: z.array(z.string()),
      claimedChangedFiles: z.array(z.string()),
      // The embedded `## Spec snapshot` slice — null id + [] for the co-located case (ADR-0100).
      embeddedSpecId: z.string().nullable(),
      embeddedRequirements: z.array(
        z
          .object({ id: z.string(), verifyCommand: z.string().nullable() })
          .passthrough(),
      ),
    })
    .passthrough(),
);
export type ShowTask = z.infer<typeof ShowTaskSchema>;

// corpus show spec → frontmatter (incl. the additive living-spec fields), requirements, and the
// append-only `## Execution` run-record (ADR-0103/0104 — the durable record once tasks are ephemeral).
export const ShowSpecSchema = showEnvelope(
  "spec",
  z
    .object({
      frontmatter: z
        .object({
          type: z.string(),
          id: z.string(),
          status: z.string(),
          // ADR-0108 living-spec additions; nullable/optional so an older spec without them still parses.
          supersededBy: z.string().nullable().optional(),
          snapshot: z.string().nullable().optional(),
        })
        .passthrough(),
      requirements: z.array(
        z
          .object({
            id: z.string(),
            line: z.number(),
            verifyCommand: z.string().nullable(),
          })
          .passthrough(),
      ),
      sectionTitles: z.array(z.string()),
      openQuestionsPresent: z.boolean(),
      execution: z.string().nullable(),
    })
    .passthrough(),
);
export type ShowSpec = z.infer<typeof ShowSpecSchema>;

// corpus show review → the parsed packet PLUS the identity/staleness frontmatter projection: which
// spec/task it reviews (review-to-spec `spec:`, ADR-0103) and the fast-track pins (ADR-0107).
export const ShowReviewSchema = showEnvelope(
  "review",
  z
    .object({
      status: z.string().nullable(),
      sectionTitles: z.array(z.string()),
      coverageRows: z.array(
        z
          .object({
            id: z.string(),
            result: z.string(),
            evidence: z.string(),
          })
          .passthrough(),
      ),
      verifyBlocks: z.array(
        z
          .object({
            id: z.string().nullable(),
            cmd: z.string().nullable(),
            result: z.enum(["pass", "fail"]).nullable(),
            malformed: z.boolean(),
          })
          .passthrough(),
      ),
      frontmatter: z
        .object({
          status: z.string().nullable(),
          spec: z.string().nullable(),
          task: z.string().nullable(),
          pr: z.string().nullable(),
          reviewedSha: z.string().nullable(),
          evidenceHash: z.string().nullable(),
        })
        .passthrough(),
    })
    .passthrough(),
);
export type ShowReview = z.infer<typeof ShowReviewSchema>;

// The CLI's structured-error stdout body (unixOutcome.ts `emit_error`): `{error, message}` + exit 2.
export const CorpusErrorSchema = z
  .object({ error: z.string(), message: z.string() })
  .passthrough();
export type CorpusError = z.infer<typeof CorpusErrorSchema>;
