# swarm-mcp

An [MCP](https://modelcontextprotocol.io) stdio server that exposes [Swarm](https://github.com/jcosta33/swarm)'s
read + reconcile facts to agent clients (Claude Desktop, Cursor) — so an agent mid-task can ask Swarm
*"what's my scope?"*, *"what evidence is missing?"*, *"what should the reviewer not miss?"* — **without
being allowed to declare itself done.**

## What it is — and what it is not

swarm-mcp is a **thin adapter over the `swarm` CLI's `--json` contract**. It spawns `swarm <cmd> --json`
with fixed arguments and reshapes the output into MCP tools, resources, and prompts. It does **not**
import swarm-cli's internals, run a model loop, write durable artifacts, or issue a verdict.

- **Reconcile-only.** Every result carries `noVerdictIssued: true`. swarm-mcp surfaces *facts* (coverage
  gaps, out-of-scope changes, empty-evidence Pass rows, self-report mismatches) and a *derived*
  human-attention list; a human or an independent reviewer owns the Pass / Fail / Unverified / Blocked
  result. An empty or weak Evidence cell reads Unverified regardless of a clean reconcile.
- **Root-confined.** It only reads inside a configured workspace root; every client-supplied path/stem is
  validated before any subprocess runs (no `..`, no absolute escapes, no symlink escapes).
- **Many libraries, not a framework.** It couples to swarm-cli only through the public `--json`
  interface, so swarm-cli keeps its minimal footprint and each piece stays useful on its own.

## Run it

```jsonc
// Claude Desktop / Cursor MCP config
{
  "mcpServers": {
    "swarm": {
      "command": "swarm-mcp",
      "args": ["--workspace", "/path/to/your/swarm-workspace"]
    }
  }
}
```

Config: `--workspace <path>` / `SWARM_WORKSPACE` (the workspace root); `--swarm-bin <path>` / `SWARM_BIN`
(the `swarm` binary, default `swarm` on PATH). Requires the [`swarm` CLI](https://github.com/jcosta33/swarm-cli)
installed.

## v0 surface (read-only)

- **Tools:** `swarm_get_status`, `swarm_check_workspace`, `swarm_check_file`, `swarm_scan_task`,
  `swarm_reconcile_review`, `swarm_validate_review_packet`. *(Loader tools `swarm_get_task/spec/review/checks`
  and the read prompts land next, on a `swarm show --json` family.)*
- **Resources:** `swarm://workspace`, `swarm://status`.

## Develop

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test:run && pnpm build
```

Status: **v0, slice 1** — the read/reconcile tools that ride the CLI's existing `--json`. Built as a
sibling of swarm-cli; deviates from the canon sketch (which imagined importing the core library) by
shelling out over the `--json` contract instead — see the ADR in the swarm workspace.
