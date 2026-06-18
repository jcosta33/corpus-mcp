import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build_envelope, respond, tool_error } from '../src/envelope.ts';
import type { SwarmResult } from '../src/swarm/invoke.ts';

const here = dirname(fileURLToPath(import.meta.url));
const reviewData = JSON.parse(readFileSync(join(here, 'fixtures', 'review-report.json'), 'utf8'));

const okResult = (data: unknown): SwarmResult => ({
    kind: 'ok',
    invocation: { command: 'swarm x --json', exitCode: 0 },
    data,
});

describe('build_envelope', () => {
    it('always sets noVerdictIssued:true and carries no verdict field of its own', () => {
        const env = build_envelope(okResult({ level: 'clean', verdict: 'clean' }));
        expect(env.noVerdictIssued).toBe(true);
        // swarm-mcp's OWN keys never include a verdict/approval (the CLI's data.verdict is exempt — passthrough)
        for (const key of ['verdict', 'pass', 'fail', 'merge', 'decision', 'approved']) {
            expect(Object.keys(env)).not.toContain(key);
        }
    });

    it('passes the CLI data through verbatim (including the CLI`s own verdict outcome)', () => {
        const env = build_envelope(okResult({ level: 'clean', verdict: 'clean' }));
        expect(env.data).toEqual({ level: 'clean', verdict: 'clean' });
    });

    it('derives a human-attention list from the real ReviewReport facts', () => {
        const env = build_envelope(okResult(reviewData), 'review');
        const attention = env.derived?.humanAttention ?? [];
        expect(env.derived?.derivedFrom).toBe('ReviewReport facts');
        expect(attention.some((a) => a.includes('AC-002'))).toBe(true); // uncovered coverage finding
        expect(attention.some((a) => a.includes('package-lock.json'))).toBe(true); // out-of-scope / not-claimed
        expect(attention.some((a) => a.includes('AC-004') && a.includes('Unverified'))).toBe(true); // empty-evidence Pass
    });

    it('surfaces a structured CLI error (no worktree) as ok:false with a note, not a throw', () => {
        const env = build_envelope(
            { kind: 'structured-error', invocation: { command: 'swarm review x --json', exitCode: 2 }, error: { error: 'Usage', message: 'no worktree found for x' } },
            'review'
        );
        expect(env.ok).toBe(false);
        expect(env.noVerdictIssued).toBe(true);
        expect(env.note).toMatch(/no live run|worktree/i);
        expect(env.data).toEqual({ error: 'Usage', message: 'no worktree found for x' });
    });
});

describe('respond', () => {
    it('turns a launch-error into a tool error (isError), not an envelope', () => {
        const result = respond({
            kind: 'launch-error',
            invocation: { command: 'swarm status --json', exitCode: 1 },
            message: 'could not launch `swarm`',
        });
        expect('isError' in result && result.isError).toBe(true);
        expect('structuredContent' in result).toBe(false);
    });

    it('turns an ok result into a tool_result carrying the envelope', () => {
        const result = respond(okResult({ level: 'clean' }));
        expect('structuredContent' in result).toBe(true);
        if ('structuredContent' in result) {
            expect(result.structuredContent.noVerdictIssued).toBe(true);
        }
    });
});

describe('tool_error', () => {
    it('carries isError and no structuredContent (so it cannot violate the success outputSchema)', () => {
        const e = tool_error('refusing a path outside the workspace root');
        expect(e.isError).toBe(true);
        expect('structuredContent' in e).toBe(false);
        expect(e.content[0].text).toContain('refusing a path');
    });
});
