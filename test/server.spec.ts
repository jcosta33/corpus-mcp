import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
    mkdtempSync,
    rmSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    readdirSync,
    statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { create_server } from '../src/server.ts';

// The server is driven over an in-memory transport against a STUB `swarm` binary (deterministic +
// offline). The stub logs every argv to STUB_LOG so we can assert which subprocesses ran (or didn't).
const stubBin = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-swarm.mjs');

const FORBIDDEN_VERDICT_KEYS = ['verdict', 'pass', 'fail', 'merge', 'decision', 'approved', 'mergeAllowed'];

let root: string;
let logPath: string;

async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = create_server({ env: { bin: stubBin, cwd: root }, root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

function invocations(): string[][] {
    if (!existsSync(logPath)) {
        return [];
    }
    return readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
}

function snapshot(dir: string): string {
    const entries: string[] = [];
    const walk = (d: string): void => {
        for (const name of readdirSync(d).sort()) {
            const full = join(d, name);
            const s = statSync(full);
            if (s.isDirectory()) {
                walk(full);
            } else {
                entries.push(`${relative(dir, full)}\t${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
            }
        }
    };
    walk(dir);
    return entries.sort().join('\n');
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'swarm-mcp-srv-'));
    mkdirSync(join(root, 'specs', 'a'), { recursive: true });
    writeFileSync(join(root, 'specs', 'a', 'spec.md'), '# spec');
    logPath = `${root}.log`;
    process.env.STUB_LOG = logPath;
});
afterEach(() => {
    delete process.env.STUB_LOG;
    rmSync(root, { recursive: true, force: true });
    if (existsSync(logPath)) {
        rmSync(logPath);
    }
});

const ALL_TOOL_CALLS = [
    { name: 'swarm_get_status', arguments: {} },
    { name: 'swarm_check_workspace', arguments: {} },
    { name: 'swarm_check_file', arguments: { path: 'specs/a/spec.md' } },
    { name: 'swarm_scan_task', arguments: { task: 'feat' } },
    { name: 'swarm_reconcile_review', arguments: { task: 'feat' } },
    { name: 'swarm_validate_review_packet', arguments: { review: 'specs/a/spec.md' } },
];

describe('swarm-mcp server', () => {
    it('lists the v0 read/reconcile tools and resources', async () => {
        const { client, close } = await connectClient();
        try {
            const tools = (await client.listTools()).tools.map((t) => t.name).sort();
            expect(tools).toEqual(
                [
                    'swarm_check_file',
                    'swarm_check_workspace',
                    'swarm_get_status',
                    'swarm_reconcile_review',
                    'swarm_scan_task',
                    'swarm_validate_review_packet',
                ].sort()
            );
            const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
            expect(resources).toEqual(['swarm://status', 'swarm://workspace']);
        } finally {
            await close();
        }
    });

    it('every tool result carries noVerdictIssued:true and adds no verdict field of its own', async () => {
        const { client, close } = await connectClient();
        try {
            for (const call of ALL_TOOL_CALLS) {
                const result = (await client.callTool(call)) as { structuredContent?: Record<string, unknown> };
                const sc = result.structuredContent;
                expect(sc, `${call.name} must return structuredContent`).toBeDefined();
                expect(sc?.noVerdictIssued, `${call.name} noVerdictIssued`).toBe(true);
                for (const key of FORBIDDEN_VERDICT_KEYS) {
                    expect(Object.keys(sc ?? {}), `${call.name} must not add a "${key}" field`).not.toContain(key);
                }
            }
        } finally {
            await close();
        }
    });

    it('get_status surfaces the board', async () => {
        const { client, close } = await connectClient();
        try {
            const r = (await client.callTool({ name: 'swarm_get_status', arguments: {} })) as {
                structuredContent: { ok: boolean; data: { specs: unknown[] } };
            };
            expect(r.structuredContent.ok).toBe(true);
            expect(r.structuredContent.data.specs.length).toBeGreaterThan(0);
        } finally {
            await close();
        }
    });

    it('scan_task on a task with no worktree returns a structured not-runnable result, not an error', async () => {
        const { client, close } = await connectClient();
        try {
            const r = (await client.callTool({ name: 'swarm_scan_task', arguments: { task: 'noworktree' } })) as {
                isError?: boolean;
                structuredContent: { ok: boolean; note?: string };
            };
            expect(r.isError).toBeFalsy();
            expect(r.structuredContent.ok).toBe(false);
            expect(r.structuredContent.note).toMatch(/no live run|worktree/i);
        } finally {
            await close();
        }
    });

    it('reconcile_review derives a human-attention list from the reconcile facts', async () => {
        const { client, close } = await connectClient();
        try {
            const r = (await client.callTool({ name: 'swarm_reconcile_review', arguments: { task: 'feat' } })) as {
                structuredContent: { derived?: { humanAttention: string[] } };
            };
            const attention = r.structuredContent.derived?.humanAttention ?? [];
            expect(attention.length).toBeGreaterThan(0);
            expect(attention.some((a) => a.includes('AC-002'))).toBe(true);
        } finally {
            await close();
        }
    });

    it('rejects a path outside the root with isError and runs NO subprocess', async () => {
        const { client, close } = await connectClient();
        try {
            const r = (await client.callTool({
                name: 'swarm_check_file',
                arguments: { path: '../../../etc/passwd' },
            })) as { isError?: boolean; content: { text: string }[] };
            expect(r.isError).toBe(true);
            expect(r.content[0].text).toMatch(/outside the workspace root/);
            // No `swarm` subprocess was spawned for the rejected path.
            expect(invocations()).toEqual([]);
        } finally {
            await close();
        }
    });

    it('writes nothing durable and never passes a write flag (read-only, reconcile-only)', async () => {
        const { client, close } = await connectClient();
        try {
            const before = snapshot(root);
            for (const call of ALL_TOOL_CALLS) {
                await client.callTool(call);
            }
            expect(snapshot(root)).toBe(before); // the workspace is byte-identical after a full tool sweep
            // non-circular: the stub drops WRITE-FLAG-SEEN iff it ever receives a write flag — it didn't.
            expect(existsSync(join(root, 'WRITE-FLAG-SEEN'))).toBe(false);
            // and no invocation ever carried a mutation flag
            const flags = invocations().flat();
            for (const forbidden of ['--write', '--force', '--agent']) {
                expect(flags).not.toContain(forbidden);
            }
            // every invocation appended `--json` (the only flag the adapter adds)
            expect(invocations().every((argv) => argv.includes('--json'))).toBe(true);
        } finally {
            await close();
        }
    });

    it('passes a valid --base (with a slash) to the CLI and rejects a flag-shaped base (AC/INV-004)', async () => {
        const { client, close } = await connectClient();
        try {
            // A valid base ref containing `/` reaches the CLI as `--base origin/main` (not silently dropped).
            await client.callTool({ name: 'swarm_scan_task', arguments: { task: 'feat', base: 'origin/main' } });
            const reviewCall = invocations().find((a) => a[0] === 'review');
            expect(reviewCall).toBeDefined();
            expect(reviewCall).toContain('--base');
            expect(reviewCall).toContain('origin/main');

            // A flag-shaped base is rejected (isError) — never reaches the subprocess as a flag.
            const r = (await client.callTool({
                name: 'swarm_scan_task',
                arguments: { task: 'feat', base: '--force' },
            })) as { isError?: boolean };
            expect(r.isError).toBe(true);
            expect(invocations().flat()).not.toContain('--force');
        } finally {
            await close();
        }
    });

    it('no tool adds a verdict key anywhere in its OWN authored content (recursive, INV-002)', async () => {
        const collectKeys = (obj: unknown, skip: string, acc: string[] = []): string[] => {
            if (Array.isArray(obj)) {
                for (const v of obj) collectKeys(v, skip, acc);
            } else if (obj && typeof obj === 'object') {
                for (const [k, v] of Object.entries(obj)) {
                    acc.push(k);
                    if (k !== skip) collectKeys(v, skip, acc); // `data` is the CLI's verbatim output — exempt
                }
            }
            return acc;
        };
        const { client, close } = await connectClient();
        try {
            for (const call of ALL_TOOL_CALLS) {
                const sc = ((await client.callTool(call)) as { structuredContent?: Record<string, unknown> })
                    .structuredContent;
                const keys = collectKeys(sc, 'data');
                for (const forbidden of FORBIDDEN_VERDICT_KEYS) {
                    expect(keys, `${call.name} adds no nested "${forbidden}"`).not.toContain(forbidden);
                }
            }
        } finally {
            await close();
        }
    });

    it('validate_review_packet surfaces the CLI check diagnostics through the envelope', async () => {
        const { client, close } = await connectClient();
        try {
            const r = (await client.callTool({
                name: 'swarm_validate_review_packet',
                arguments: { review: 'specs/a/spec.md' },
            })) as { structuredContent: { ok: boolean; data: { diagnostics: { code: string }[] } } };
            expect(r.structuredContent.ok).toBe(true);
            expect(r.structuredContent.data.diagnostics.map((d) => d.code)).toContain('C004');
        } finally {
            await close();
        }
    });
});
