// Root-confinement for a shell-out adapter. Two untrusted inputs reach the CLI: a file PATH (for
// check_file / file resources) and a task STEM / spec id (for review / show). Both are validated here
// before any subprocess runs, so a malicious client cannot make `swarm` read outside the workspace.

import { resolve, isAbsolute, relative } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

// Resolve the workspace root to a canonical absolute path (following any symlink on the root itself).
export function resolve_root(root: string): string {
    return existsSync(root) ? realpathSync(root) : resolve(root);
}

// Validate a client-supplied path resolves INSIDE the workspace root; return it workspace-RELATIVE
// (safe to pass to a `swarm` invoked with cwd=root), or null if it escapes. Rejects `..` traversal,
// absolute escapes, the root itself (not a file), and symlink escapes (when the target exists).
export function confine_path(root: string, candidate: string): string | null {
    const rootReal = resolve_root(root);
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(rootReal, candidate);

    const lexical = relative(rootReal, resolved);
    if (lexical === '' || lexical.startsWith('..') || isAbsolute(lexical)) {
        return null;
    }
    if (existsSync(resolved)) {
        const real = realpathSync(resolved);
        const realRel = relative(rootReal, real);
        if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
            return null; // a symlink inside root pointing outside it
        }
        return realRel;
    }
    return lexical;
}

// A task stem / spec id is interpolated by the CLI into `tasks/<stem>.md` etc. — it must be a single
// safe path segment, never a separator or traversal token.
export function is_safe_segment(segment: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..';
}

// The reviewable token for a task is its id minus a leading `TASK-`, lower-cased (mirrors the CLI's
// `review_slug`); the board reports the id, the CLI reads `tasks/<stem>.md`.
export function task_stem(taskIdOrStem: string): string {
    return taskIdOrStem.replace(/^TASK-/i, '').toLowerCase();
}
