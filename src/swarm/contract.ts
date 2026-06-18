// zod schemas mirroring the swarm CLI's real `--json` shapes (verified against the binary). These are
// the DRIFT TRIPWIRE: swarm-mcp parses every CLI payload through them, so if swarm-cli renames or drops
// a field swarm-mcp consumes (e.g. ReviewReport.coverage), the parse fails loudly in a test rather than
// silently producing wrong tool output. `.passthrough()` keeps unknown extra fields (additive CLI
// changes don't break us); the named fields are the ones swarm-mcp actually reads.

import { z } from 'zod';

// --- swarm status --json  → DerivedBoard ----------------------------------------------------------
const BoardTask = z
    .object({ id: z.string(), status: z.string(), hasReview: z.boolean(), reviewStatus: z.string().optional() })
    .passthrough();
const BoardSpec = z.object({ id: z.string(), status: z.string(), tasks: z.array(BoardTask) }).passthrough();
export const DerivedBoardSchema = z.object({ level: z.string(), specs: z.array(BoardSpec) }).passthrough();
export type DerivedBoard = z.infer<typeof DerivedBoardSchema>;

// --- swarm check [file] --json --------------------------------------------------------------------
const Diagnostic = z
    .object({
        code: z.string(),
        severity: z.string(),
        message: z.string(),
        line: z.number().nullable().optional(),
    })
    .passthrough();
export const FileCheckSchema = z
    .object({ level: z.string(), path: z.string(), diagnostics: z.array(Diagnostic) })
    .passthrough();
export type FileCheck = z.infer<typeof FileCheckSchema>;

const WorkspaceSpecCheck = z
    .object({ path: z.string(), level: z.string(), diagnostics: z.array(Diagnostic) })
    .passthrough();
export const WorkspaceCheckSchema = z
    .object({ level: z.string(), specs: z.array(WorkspaceSpecCheck) })
    .passthrough(); // also carries `verdict` (the check outcome, NOT a review verdict) + change-plan rows
export type WorkspaceCheck = z.infer<typeof WorkspaceCheckSchema>;

// --- swarm review <stem> --json  → ReviewReport ---------------------------------------------------
const CoverageFinding = z.object({ id: z.string(), kind: z.string(), message: z.string() }).passthrough();
const SelfReport = z
    .object({
        claimedNotInDiff: z.array(z.string()),
        inDiffNotClaimed: z.array(z.string()),
        outsideScope: z.array(z.string()),
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
        level: z.string(),
        task: z.string(),
        diffChangedFiles: z.array(z.string()),
        coverage: z.array(CoverageFinding),
        verifyBinding: z.array(z.record(z.string(), z.unknown())),
        scopeDivergence: z.array(z.string()),
        selfReport: SelfReport,
        emptyEvidencePassRows: z.array(z.string()),
        packetStructural: PacketStructural,
        hasReviewPacket: z.boolean(),
    })
    .passthrough();
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

// The CLI's structured-error stdout body (e.g. the no-worktree case): `{error, message}` + exit 2.
export const SwarmErrorSchema = z.object({ error: z.string(), message: z.string() }).passthrough();
export type SwarmError = z.infer<typeof SwarmErrorSchema>;
