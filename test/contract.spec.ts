import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DerivedBoardSchema,
    WorkspaceCheckSchema,
    FileCheckSchema,
    ReviewReportSchema,
    SwarmErrorSchema,
} from '../src/swarm/contract.ts';

// The DRIFT TRIPWIRE. These fixtures were captured from the REAL `swarm … --json`. If swarm-cli changes
// a shape swarm-mcp consumes, these parses fail loudly here instead of the adapter producing wrong output.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

describe('contract schemas parse the real --json shapes (drift tripwire)', () => {
    it('status --json → DerivedBoard', () => {
        const parsed = DerivedBoardSchema.safeParse(fixture('status.json'));
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.specs.length).toBeGreaterThan(0);
            expect(Array.isArray(parsed.data.specs[0].tasks)).toBe(true);
        }
    });

    it('check --json (workspace) → WorkspaceCheck', () => {
        expect(WorkspaceCheckSchema.safeParse(fixture('check-workspace.json')).success).toBe(true);
    });

    it('check <file> --json → FileCheck', () => {
        expect(FileCheckSchema.safeParse(fixture('check-file.json')).success).toBe(true);
    });

    it('review --json → ReviewReport (the consumed shape)', () => {
        const parsed = ReviewReportSchema.safeParse(fixture('review-report.json'));
        expect(parsed.success).toBe(true);
    });

    it('the structured error body parses', () => {
        expect(SwarmErrorSchema.safeParse({ error: 'Usage', message: 'no worktree found' }).success).toBe(true);
    });

    it('a board task with reviewStatus:null parses (the unreviewed-task case the old schema rejected)', () => {
        const board = {
            level: 'clean',
            specs: [{ id: 'S', status: 'ready', tasks: [{ id: 'T', status: 'ready', hasReview: false, reviewStatus: null }] }],
        };
        expect(DerivedBoardSchema.safeParse(board).success).toBe(true);
    });

    it('the tripwire FAILS if a consumed field is renamed/dropped (verifyBinding.message)', () => {
        const drifted = JSON.parse(readFileSync(join(here, 'fixtures', 'review-report.json'), 'utf8'));
        drifted.verifyBinding = [{ id: 'AC-001', kind: 'x' /* message dropped */ }];
        expect(ReviewReportSchema.safeParse(drifted).success).toBe(false);
    });
});
