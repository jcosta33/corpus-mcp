// Root-confinement for a shell-out adapter. Three untrusted inputs reach the CLI: a file PATH (for
// check_file / file resources), a task STEM / spec id (for review / show), and a git BASE ref. All are
// validated here before any subprocess runs, so a malicious client cannot make `swarm` read outside the
// workspace, inject a flag, or break the spawn.

import { resolve, isAbsolute, relative, dirname } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

// True if the string contains any ASCII control character (NUL … US). A NUL byte throws inside
// spawnSync; control chars are never part of a valid workspace path / ref. (Checked by code point so
// the source carries no literal control bytes.)
function has_control_char(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        if (value.charCodeAt(i) < 0x20) {
            return true;
        }
    }
    return false;
}

// Resolve the workspace root to a canonical absolute path (following any symlink on the root itself).
export function resolve_root(root: string): string {
    return existsSync(root) ? realpathSync(root) : resolve(root);
}

// Validate a client-supplied path resolves INSIDE the workspace root; return it workspace-RELATIVE
// (safe to pass to a `swarm` invoked with cwd=root), or null if it escapes. Rejects: control chars (a
// NUL byte breaks spawn), `..` traversal, absolute escapes, the root itself (not a file), flag-shaped
// paths, and symlink escapes — including a symlinked PARENT directory even when the leaf does not exist
// yet (so the guard is correct for the loader/write verbs landing in later slices, not just today's read
// verb whose "file not found" happens to backstop it).
export function confine_path(root: string, candidate: string): string | null {
    if (has_control_char(candidate)) {
        return null;
    }
    const rootReal = resolve_root(root);
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(rootReal, candidate);
    if (!inside_root(relative(rootReal, resolved))) {
        return null; // lexical `..` / absolute / flag-shaped escape
    }
    // Resolve the deepest EXISTING ancestor through any symlinks; require it to stay inside root. This
    // catches a symlinked parent dir whether or not the leaf exists.
    let existing = resolved;
    while (!existsSync(existing) && dirname(existing) !== existing) {
        existing = dirname(existing);
    }
    const realExisting = existsSync(existing) ? realpathSync(existing) : existing;
    const ancestorRel = relative(rootReal, realExisting);
    if (ancestorRel.startsWith('..') || isAbsolute(ancestorRel)) {
        return null; // an existing ancestor (or a symlink on it) resolves outside root
    }
    // Canonicalize the full path when it exists (catches a leaf that is itself a symlink), else lexical.
    const finalRel = relative(rootReal, existsSync(resolved) ? realpathSync(resolved) : resolved);
    return inside_root(finalRel) ? finalRel : null;
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
    return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-');
}

// A git base ref legitimately contains `/`, `~`, `^`, `@`, `.` (e.g. `origin/main`, `HEAD~1`), so it is
// NOT a single safe segment. It must only never be flag-shaped (leading `-`), empty, or carry
// whitespace/control characters — anything else is passed through to the CLI's own `--base` guard. An
// invalid base is rejected, never silently dropped (which would diff against the wrong base).
export function is_safe_base(base: string): boolean {
    return base.length > 0 && !base.startsWith('-') && !/\s/.test(base) && !has_control_char(base);
}

// The reviewable token for a task is its id minus a leading `TASK-`, lower-cased (mirrors the CLI's
// `review_slug`); the board reports the id, the CLI reads `tasks/<stem>.md`.
export function task_stem(taskIdOrStem: string): string {
    return taskIdOrStem.replace(/^TASK-/i, '').toLowerCase();
}
