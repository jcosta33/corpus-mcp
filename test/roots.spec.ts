import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { confine_path, is_safe_segment, task_stem } from '../src/roots.ts';

let root: string;
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-mcp-roots-')));
    mkdirSync(join(root, 'specs', 'a'), { recursive: true });
    writeFileSync(join(root, 'specs', 'a', 'spec.md'), '# spec');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('confine_path', () => {
    it('accepts a path inside the root and returns it workspace-relative', () => {
        expect(confine_path(root, 'specs/a/spec.md')).toBe('specs/a/spec.md');
    });

    it('accepts a not-yet-existing path inside the root (lexical)', () => {
        expect(confine_path(root, 'reviews/new.md')).toBe('reviews/new.md');
    });

    it('rejects `..` traversal', () => {
        expect(confine_path(root, '../../../etc/passwd')).toBeNull();
    });

    it('rejects an absolute path outside the root', () => {
        expect(confine_path(root, '/etc/passwd')).toBeNull();
    });

    it('rejects the root itself (not a file)', () => {
        expect(confine_path(root, '.')).toBeNull();
    });

    it('rejects a flag-shaped path (leading `-`, which the CLI would parse as an option)', () => {
        expect(confine_path(root, '-rf.md')).toBeNull();
        expect(confine_path(root, '--output')).toBeNull();
    });

    it('rejects a symlink that escapes the root', () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-mcp-outside-')));
        writeFileSync(join(outside, 'secret.md'), 'x');
        symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));
        try {
            expect(confine_path(root, 'link.md')).toBeNull();
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });
});

describe('is_safe_segment', () => {
    it('accepts a plain stem', () => {
        expect(is_safe_segment('001-app-setup')).toBe(true);
    });
    it('rejects separators and traversal', () => {
        expect(is_safe_segment('a/b')).toBe(false);
        expect(is_safe_segment('..')).toBe(false);
        expect(is_safe_segment('.')).toBe(false);
        expect(is_safe_segment('a b')).toBe(false);
        expect(is_safe_segment('')).toBe(false);
    });
    it('rejects a flag-shaped stem (leading `-`)', () => {
        expect(is_safe_segment('--help')).toBe(false);
        expect(is_safe_segment('-base')).toBe(false);
    });
});

describe('task_stem', () => {
    it('strips a leading TASK- and lower-cases (mirrors the CLI review_slug)', () => {
        expect(task_stem('TASK-001-App-Setup')).toBe('001-app-setup');
        expect(task_stem('baseline-cleanup')).toBe('baseline-cleanup');
    });
});
