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
    if (!inside_root(lexical)) {
        return null;
    }
    if (existsSync(resolved)) {
        const real = realpathSync(resolved);
        const realRel = relative(rootReal, real);
        if (!inside_root(realRel)) {
            return null; // a symlink inside root pointing outside it
        }
        return realRel;
    }
    return lexical;
}

// A workspace-relative path is safe to hand the CLI iff it stays inside root AND is not flag-shaped: a
// path whose FIRST character is `-` would be parsed by the CLI as an option, not a positional.
function inside_root(rel: string): boolean {
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith('-');
}

// A task stem / spec id is interpolated by the CLI into `tasks/<stem>.md` etc. — it must be a single
// safe path segment, never a separator or traversal token.
export function is_safe_segment(segment: string): boolean {
    // Reject separators, traversal, and a leading `-` (a flag-shaped stem like `--help` would be parsed
    // by the CLI as an option, not the task to review).
    return (
        /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-')
    );
}

// The reviewable token for a task is its id minus a leading `TASK-`, lower-cased (mirrors the CLI's
// `review_slug`); the board reports the id, the CLI reads `tasks/<stem>.md`.
export function task_stem(taskIdOrStem: string): string {
    return taskIdOrStem.replace(/^TASK-/i, '').toLowerCase();
}
