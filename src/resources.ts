// v0 resources (slice 1: the two that ride existing CLI --json). Resources are application-driven
// context: they expose the workspace board as addressable, read-only data. The loader resources
// (specs/tasks/reviews/findings/checks) land in slice 3 on the `swarm show` family.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { invoke_swarm } from './swarm/invoke.ts';
import type { Ctx } from './tools.ts';

export function register_resources(server: McpServer, ctx: Ctx): void {
    server.registerResource(
        'workspace',
        'swarm://workspace',
        {
            title: 'Swarm workspace',
            description: 'Workspace root, mode, and the current board summary.',
            mimeType: 'application/json',
        },
        (uri) => {
            const status = invoke_swarm(ctx.env, 'status');
            const body = {
                workspaceRoot: ctx.root,
                mode: 'read-only',
                noVerdictIssued: true,
                board: status.kind === 'ok' ? status.data : null,
            };
            return {
                contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }],
            };
        }
    );

    server.registerResource(
        'status',
        'swarm://status',
        {
            title: 'Swarm board',
            description: 'The derived workspace board — specs, tasks, reviews, gaps.',
            mimeType: 'application/json',
        },
        (uri) => {
            const status = invoke_swarm(ctx.env, 'status');
            const text =
                status.kind === 'ok'
                    ? JSON.stringify(status.data, null, 2)
                    : JSON.stringify({ note: 'board unavailable', detail: status }, null, 2);
            return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
        }
    );
}
