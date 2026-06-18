// The ONE subprocess edge. swarm-mcp never imports swarm-cli's internals — it shells out to the
// `swarm` CLI's `--json` contract with a FIXED argv array (never a shell string, never a client-injected
// flag). The verb is checked against a closed allow-list; positional args are pre-validated by the
// caller (a file path confined to roots, or a task stem). `--json` is always appended; v0 never passes a
// write flag. This keeps swarm-cli at its 2-dep footprint and couples the two repos only through the
// public, tested JSON interface ("many libraries, not a framework").

import { spawnSync } from 'node:child_process';

export type SwarmEnv = Readonly<{
    bin: string; // the `swarm` binary (env SWARM_BIN, else 'swarm' on PATH)
    cwd: string; // the workspace root — every invocation runs here (root-confinement, defense in depth)
}>;

// The only verbs swarm-mcp may invoke. All are read-only / reconcile-only.
const ALLOWED_VERBS = new Set(['status', 'check', 'review', 'show']);

export type SwarmInvocation = Readonly<{
    command: string; // the human-readable command line, for the envelope's provenance
    exitCode: number;
}>;

// The CLI emits one JSON object to stdout in BOTH the success case and the structured-error case
// (e.g. `{"error":"Usage","message":"no worktree found …"}` with exit 2). So a parsed object with an
// `error` field is a *structured* failure (surfaced to the agent as a fact), distinct from a launch
// failure (binary missing / non-JSON output), which is an adapter error.
export type SwarmResult =
    | Readonly<{ kind: 'ok'; invocation: SwarmInvocation; data: unknown }>
    | Readonly<{ kind: 'structured-error'; invocation: SwarmInvocation; error: { error: string; message: string } }>
    | Readonly<{ kind: 'launch-error'; invocation: SwarmInvocation; message: string }>;

function has_error_field(value: unknown): value is { error: string; message: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>).error === 'string' &&
        typeof (value as Record<string, unknown>).message === 'string'
    );
}

export function invoke_swarm(
    env: SwarmEnv,
    verb: string,
    positional: readonly string[] = [],
    opts: { base?: string } = {}
): SwarmResult {
    if (!ALLOWED_VERBS.has(verb)) {
        // Defense in depth — the tools only ever pass allow-listed verbs; this catches a programming slip.
        throw new Error(`swarm-mcp: refusing to invoke a non-allow-listed swarm verb: "${verb}"`);
    }
    const args = [verb, ...positional];
    if (typeof opts.base === 'string' && opts.base.length > 0) {
        args.push('--base', opts.base);
    }
    args.push('--json');
    const command = `swarm ${args.join(' ')}`;

    // A bounded timeout so a hung `swarm` cannot hang the tool call forever (the read/reconcile commands
    // are local and fast; a timeout surfaces as result.error → a launch-error below).
    const result = spawnSync(env.bin, args, { cwd: env.cwd, encoding: 'utf8', timeout: 30_000 });
    if (result.error) {
        return {
            kind: 'launch-error',
            invocation: { command, exitCode: result.status ?? 1 },
            message: `could not launch \`${env.bin}\`: ${result.error.message}`,
        };
    }
    const exitCode = result.status ?? 1;
    const invocation: SwarmInvocation = { command, exitCode };
    const stdout = (result.stdout ?? '').trim();

    let parsed: unknown;
    try {
        parsed = stdout.length > 0 ? JSON.parse(stdout) : undefined;
    } catch {
        parsed = undefined;
    }
    if (parsed === undefined) {
        const stderr = (result.stderr ?? '').trim();
        return {
            kind: 'launch-error',
            invocation,
            message: `\`${command}\` produced no parseable JSON (exit ${exitCode})${stderr ? `: ${stderr}` : ''}`,
        };
    }
    if (has_error_field(parsed)) {
        return { kind: 'structured-error', invocation, error: parsed };
    }
    return { kind: 'ok', invocation, data: parsed };
}
