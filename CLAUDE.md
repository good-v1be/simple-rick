# CLAUDE.md

Guidance for AI agents working on this repository.

## What this is

Simple Rick is a local MCP server that gives coding agents persistent memory. It records sessions, normalizes them into embedded chunks, wires those into a graph, and serves the relevant context back at the start of the next session. See [README.md](README.md) for the user-facing documentation.

## Tech stack

- **Runtime:** Node.js 20+, TypeScript (ESM, `"type": "module"` — imports need the `.js` extension)
- **Interface:** MCP over stdio (`@modelcontextprotocol/sdk`)
- **Database:** SQLite via `better-sqlite3`, vectors via `sqlite-vec`
- **AI providers:** auto-detected — OpenAI, Google, Mistral, or Anthropic + Voyage (`services/ai-providers.ts`)
- **File watching:** chokidar
- **Tests:** Vitest

## Critical constraints

**Never write to stdout.** MCP speaks JSON-RPC over stdout; a single `console.log` corrupts the protocol. `src/server/index.ts` reassigns `console.log = console.error` on its first line, above all imports. Keep that line where it is, and use `console.error` for any logging.

**The database schema lives in code, not in migrations.** `src/server/db/sqlite.ts` applies `schema.sql` and any additional columns inline. There is no migration runner and no version table — if you add a column, add it there, idempotently.

## Commands

```bash
npm run dev      # tsx watch
npm run build    # tsc → dist/ (postbuild copies schema.sql and the UI)
npm run lint     # tsc --noEmit
npm test         # vitest run
```

`e2e/test_mcp_e2e.py` drives real Claude Code CLI sessions. It costs API calls and is deliberately not part of `npm test`.

## Layout

```
src/server/
  index.ts                 MCP entry point, tool definitions and handlers
  config.ts                bearer token + persisted config in the DB
  db/
    sqlite.ts              connection, schema application, vec tables
    schema.sql             table definitions
  http/
    server.ts              HTTP + WebSocket server (port 3777, loopback only)
    routes.ts              /api/graph, /api/sessions, /api/record
  services/
    session-manager.ts     session lifecycle
    recorder.ts            crash-safe raw turn + file state recording
    file-watcher.ts        chokidar diffs with ms timestamps
    norm-queue.ts          background worker, drain + recovery
    lightweight-normalizer.ts   cheap intent/domain classification
    deep-normalizer.ts     summarization + embedding
    edge-wirer.ts          links new chunks to related ones
    briefer.ts             session-start briefings, semantic search
    codebase-scanner.ts    initial scan, decisions from code and git history
    domain-router.ts       routes chunks to Code / Miscellaneous
    insight/               correlation, trend and causal-chain mining
  ui/index.html            flow visualization, served at :3777
hooks/
  simple-rick-recorder.js  PostToolUse hook, POSTs tool calls to /api/record
```

## Conventions

- All user-facing strings and LLM prompts are **English**. The project was originally written in German; do not reintroduce German text.
- Prompts asking for JSON say "Respond with JSON ONLY (no code fences)" and the caller strips fences defensively before parsing.
- The server's own data goes in `.simple-rick/` inside the target project, never in this repo.
- The bearer token file is written with mode `0600` and its directory with `0700`. Keep it that way.

## Known weak spots

Documented in the README under *Known limitations*: no migration system, unvalidated AI JSON output, swallowed errors, hardcoded limits, and embedding-dimension mismatches on provider switch. Fixing these is welcome; be aware they are known, not overlooked.
