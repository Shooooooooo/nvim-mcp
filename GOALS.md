# nvim-mcp — Build Plan (GOALS)

> Target: rebuild this project from scratch in an empty directory. This document is the spec. Every exact string, flag, env var, indexing convention and tool description below is load-bearing — tests, agent behaviour and the acceptance criteria in this document depend on them being reproduced verbatim.

---

## What you are building

An MCP server (TypeScript, ESM, stdio transport) that gives an AI coding agent full control of the **live Neovim session the agent is running inside**: buffers, windows, diagnostics, LSP, and — the differentiator — terminals *inside* the editor. Unlike file-scoped editor plugins (claudecode.nvim and friends), which expose only the file currently being edited, this server attaches to Neovim's own msgpack-RPC channel and can therefore drive the whole editor: open a terminal in a split, run a command, wait for the real exit code, and read the rendered output back. It ships as an npm bin (`npx -y nvim-mcp`) that an MCP host spawns as a child process; no Neovim plugin is required on the editor side, because every operation is an inline Lua chunk shipped over `nvim_exec_lua`. The product thesis: an agent that can *see and use* the user's editor — including its terminals and its already-running language servers — makes Neovim feel like Cursor without leaving Neovim.

**The insight that makes it possible:** Neovim exports its own RPC socket address in the `$NVIM` environment variable to every child process it spawns. An agent launched from `:terminal` therefore inherits, with zero configuration, the address of its own parent editor — and any MCP server that agent spawns inherits it too. Discovery is free; the whole product is downstream of that one env var.

---

## Definition of done

Inside a real Neovim, the user runs `:terminal claude`. The agent is asked:

> "Open a terminal in Neovim, run `echo hello world` in it, and tell me what it printed."

The agent calls `nvim_run_in_terminal` with `{ cmd: "echo hello world" }`; a terminal is created inside the user's editor, the command runs, and the tool returns text containing both `hello world` and `exit code: 0`. The agent reports `hello world` back to the user. The cursor is returned to the window it started in, the transient terminal split is gone once the call returns (the terminal buffer is deleted), the user's Neovim is still running with no unsaved work lost, and nothing was written to stdout except JSON-RPC frames.

> Note the honest scope of that claim: with the split implementation specified here, a horizontal split is opened and then removed during the call. Window *layout* is restored, not untouched, and concurrent `runInTerminal` calls are **not** isolated (see guardrail 7 and stretch goal 1).

This is asserted headlessly by `test/mcp.test.ts` (M6) and demonstrated with a live agent by `scripts/e2e-claude-code.sh` (M3, manual, credentialed, never part of `npm test`).

---

## Milestone map

| Milestone | Theme | Depends on |
|---|---|---|
| M0 | Package skeleton, logger, CLI, LICENSE, tsconfigs | — |
| M1 | Connection layer + real-Neovim test harness | M0 |
| M2 | MCP protocol layer + escape hatches + `nvim_info` | M0, M1 |
| M3 | **Terminals (headline)** + first MCP-level proof + live-agent e2e | M0–M2 |
| M4 | Buffers, windows, files, diagnostics | M0–M2 |
| M5 | LSP tool group + fake language server | M0–M4 |
| M6 | Definition of done: full MCP surface through a real client | M0–M5 |
| M7 | Ship it: CI matrix, release automation, README, examples | M0–M6 |

**Registration order ≠ build order.** `registerTool` call order is the wire order of `listTools()` and is asserted. M3 is built third for risk reasons, but in `buildServer` the terminal tools are registered *after* a reserved slot for the M4 buffer/window/diagnostic tools. Concretely: after M3 `listTools()` is `[4 M2 tools, 5 terminal tools]`; M4 **inserts** its six tools between `nvim_eval` and `nvim_run_in_terminal` (15 total); M5 appends eight (23 total), matching the tool-surface table exactly.

---

### M0 — Package skeleton: pure ESM, NodeNext, npx-able bin, stderr-only logger

**Depends on:** nothing.

**Goal.** A publishable TypeScript package whose compiled entry point runs under `node dist/index.js --help` and whose logging can never corrupt an MCP stream.

**Deliverables**

- `package.json`: `name: "nvim-mcp"`, `version: "0.1.0"`, `"type": "module"`, `bin: { "nvim-mcp": "dist/index.js" }` (**exactly one bin**), `main: "dist/index.js"`, `files: ["dist", "README.md"]`, `publishConfig.access: "public"`, `engines.node: ">=18"`, `license: "MIT"`, `author`, and `repository` / `homepage` / `bugs` pointing at the GitHub repo (npm provenance cross-checks `repository`). Also:
  - `description`: `"An MCP server that gives an agent (e.g. Claude Code) full control over the Neovim session it lives inside — buffers, windows, diagnostics, and terminals — turning Neovim into a Cursor-like agentic editor."`
  - `keywords`: `["mcp","model-context-protocol","neovim","nvim","claude","claude-code","agent","editor"]`
- `LICENSE`: MIT, first lines `MIT License` / blank / `Copyright (c) 2026 nvim-mcp contributors`.
- Scripts: `build` = `tsc -p tsconfig.json`; `typecheck` = `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`; `test` = `vitest run`; `test:watch` = `vitest`; `dev` = `tsx src/index.ts`; `start` = `node dist/index.js`; `prepublishOnly` = `npm run build`.
- Dependencies: `@modelcontextprotocol/sdk ^1.29.0`, `neovim ^5.4.0`, `zod ^3.25.0` (**zod 3, not 4** — the SDK's `McpServer` tool-schema API requires it). Dev: `@types/node ^22.10.0`, `tsx ^4.19.0`, `typescript ^5.7.0`, `vitest ^2.1.0`. Commit `package-lock.json` (lockfileVersion 3).
- `tsconfig.json`: `target: ES2022`, `lib: ["ES2022"]`, `module: NodeNext`, `moduleResolution: NodeNext`, `rootDir: "src"`, `outDir: "dist"`, `strict`, `declaration`, `sourceMap`, `esModuleInterop`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `verbatimModuleSyntax: false`; `include: ["src/**/*.ts"]`, `exclude: ["node_modules", "dist", "test"]`.
- `tsconfig.test.json`: `{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": true, "rootDir": "." }, "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"] }`. Without it the suite is only type-*stripped* by esbuild and never type-checked.
- Version, read once, never duplicated as a literal:
  ```ts
  import { createRequire } from "node:module";
  const require_ = createRequire(import.meta.url);
  export const SERVER_VERSION: string = (require_("../package.json") as { version: string }).version;
  ```
  Resolves to the package root from both `dist/server.js` and `src/server.ts` under `tsx`, and npm always ships `package.json` in the tarball. **Do not** `import pkg from "../package.json"` — `rootDir: "src"` makes that a TS6059 error and would emit `dist/src/…`.
- `src/index.ts` starts with `#!/usr/bin/env node` (tsc preserves it; npm sets the exec bit on `bin` targets — no `chmod` step).
- `src/logger.ts`: levels `{ debug: 10, info: 20, warn: 30, error: 40 }`, threshold from `NVIM_MCP_LOG_LEVEL` defaulting to `info` (unrecognised value → `info`; warn once on stderr instead of degrading silently). Line format, **stderr only**:
  `[nvim-mcp] <ISO-8601> <LEVEL> <message>[ <extra>]\n` where `extra` is appended raw if a string, else `JSON.stringify`, else `String()` inside try/catch. Exported as a `logger` object with `debug/info/warn/error`.
- CLI parser accepting exactly: `--socket <addr>`, `--address <addr>`, `--socket=<addr>`, `--address=<addr>`, `-h`, `--help`. Unknown flags ignored, not rejected; later flags overwrite earlier ones. `--help` writes the HELP block to stdout and returns **before** any transport is connected.
- The HELP block, verbatim (`${SERVER_NAME} ${SERVER_VERSION}` interpolated):

```
nvim-mcp 0.1.0

An MCP server that gives an agent full control over the Neovim session it lives
inside: buffers, windows, diagnostics and terminals.

Usage:
  nvim-mcp [--socket <addr>]

The target Neovim is resolved in this order:
  1. --socket / --address <addr>
  2. $NVIM_MCP_SOCKET
  3. $NVIM                (set automatically inside a Neovim :terminal)
  4. $NVIM_LISTEN_ADDRESS (legacy)

<addr> is a unix socket path (or named pipe) or a host:port TCP address.
```

- `.gitignore`: `node_modules/`, `dist/`, `*.log`, `.DS_Store`, `coverage/`, `*.sock`, `.vitest/`.

**Acceptance**

- `npm run build` emits `dist/index.js` whose first line is the shebang; `node dist/index.js --help` prints the HELP block and exits 0.
- `npm pack --dry-run` lists only `dist/**`, `README.md`, `package.json`, `LICENSE`. Deleting `dist/` then running `npm pack` still yields a tarball containing `dist/index.js` (proves `prepublishOnly`).
- A source grep for `process.stdout.write` and `console.` finds exactly one hit: the `--help` path.
- `parseArgs` unit table: `["--socket"]` (flag last) → `socket === undefined`; `["--socket="]` → `""` (both fall through to the env chain because resolution requires `explicit && explicit.trim()`); `["--socket","/a","--address","/b"]` → `/b`; `["--bogus"]` → ignored, `help === false`; `-h` anywhere → `help === true`.
- `npm run typecheck` type-checks `test/**` (introduce a deliberate type error in a test file and watch it fail).

**Traps**

- NodeNext will not rewrite specifiers: every intra-project import must be written `./nvim.js`, `./logger.js` against `.ts` files; SDK imports must use the `/server/mcp.js`, `/server/stdio.js`, `/client/index.js`, `/client/stdio.js` subpaths; Node builtins use the `node:` prefix. A missing `.js` compiles fine and throws `ERR_MODULE_NOT_FOUND` only at runtime — after publish.
- `dist/` is gitignored but is the only code in `files`. Without `prepublishOnly` the tarball ships `README.md`, `package.json` and `LICENSE` — no code at all.
- Do **not** hardcode the server version as a literal duplicated from `package.json` (the original did; it drifts on the first `npm version`).

---

### M1 — Connection layer + real-Neovim test harness

**Depends on:** M0.

**Goal.** Resolve the target editor from the 4-level precedence chain, connect lazily over a unix socket or TCP, self-heal, bound every request, and tear down **without killing the user's editor**. Plus the harness every later milestone tests against.

**Deliverables**

- `resolveNvimAddress(explicit?: string): NvimAddress | null` where `NvimAddress = { address: string; source: "option" | "NVIM_MCP_SOCKET" | "NVIM" | "NVIM_LISTEN_ADDRESS" }`. Precedence, highest first: CLI `--socket`/`--address` (tag `"option"`) → `$NVIM_MCP_SOCKET` → `$NVIM` → `$NVIM_LISTEN_ADDRESS`. A candidate counts only if non-empty after `.trim()`; the stored address is the trimmed value; all-unset → `null`.
- `parseTcp(address): { host: string; port: number } | null`:
  1. If `fs.existsSync(address)` and the entry is a socket (`statSync(address).isSocket()`), return `null` — a real socket path always wins, which fixes `/tmp/nvim:123`.
  2. Match `/^(.*):(\d+)$/`. No match → `null`.
  3. `host = match[1] || "127.0.0.1"`; strip one pair of surrounding brackets so `[::1]:6789` → host `::1` (`net.connect(6789, "[::1]")` fails `ENOTFOUND` — verified; unbracketed `::1:6789` already works because the greedy `.*` leaves `::1`).
  4. `port = Number(match[2])`; accept only `Number.isInteger(port) && port > 0`. **No upper bound** — `host:99999` stays classified as TCP so it fails with a clean `NvimNotAvailableError` wrapping `ERR_SOCKET_BAD_PORT` rather than being silently reinterpreted as a filesystem path.
- `class NvimController`: `constructor(explicitAddress?)` (resolves and **freezes** the address at construction), `get addressInfo()`, `hasAddress()`, `isConnected()`, `connect()`, `close()`, `execLua(code, args = [])`, `execCommand(cmd)`, `evalExpr(expr)`. (`info()` belongs to M2.)
- `class NvimNotAvailableError extends Error` with `name === "NvimNotAvailableError"`. Exact messages:
  - no address: `No Neovim address found. Set the NVIM environment variable (this is done automatically when the agent runs inside a Neovim :terminal), or pass NVIM_MCP_SOCKET / --socket explicitly.`
  - connect failure: `Failed to connect to Neovim at ${address}: ${err.message}`
  - request deadline: `Neovim at ${address} did not respond within ${ms}ms`
  - mid-flight loss: `Lost connection to Neovim at ${address}`
- Single-flight connect cache: cached client → in-flight promise → new attempt. **Wrap the shared promise once, inside the attempt**, so concurrent losers also get `NvimNotAvailableError`, not a raw `ECONNREFUSED`. Clear the in-flight promise in `finally`. Set a `closed` flag in `close()` and check it before assigning `this.client`, so `close()` during an in-flight connect cannot resurrect the connection. On `'disconnect'`: `logger.warn("Neovim connection closed")` and null the cached client **only if it is still the same object**.
- Both transports pre-connect symmetrically: `net.connect(port, host)` for TCP and `net.connect(path)` for unix, each with a `'error'` listener, and only then `attach({ reader: socket, writer: socket })`. Remove the connect-time `error` listener after `connect` fires and install a persistent one that logs and drops the cached client.
- Liveness probe: after attach, `const [channelId] = await client.apiInfo;` (**a getter, not a method**) *before* assigning `this.client`, then log `Connected to Neovim (channel ${channelId})`. This is a second `nvim_get_api_info` round trip — the client already issues one internally in `setupTransport()` — and it is what turns a half-open socket into a catchable failure instead of an opaque first tool call.
- Per-request deadline: `NVIM_MCP_RPC_TIMEOUT_MS`, default `10000`. Every RPC races the deadline; on expiry, or on `'disconnect'` with requests outstanding, reject the pending promises with `NvimNotAvailableError` (messages above) and null the cached client so the next call reconnects.
- Pass an explicit stderr logger into `attach({ options: { logger } })`.
- Exact log strings this layer and `src/index.ts` emit (all stderr): `Target Neovim: ${address} (from ${source})`; `No Neovim address found (NVIM not set). Tools will error until a target is available. Run inside a Neovim :terminal or pass --socket.`; `Connecting to Neovim at ${address} (via ${source})`; `Connected to Neovim (channel ${channelId})`; `Neovim connection closed`; `Shutting down`; `nvim-mcp ${SERVER_VERSION} ready on stdio`; `Fatal error` + stack.
- `test/helpers/nvim.ts`: exports `interface HeadlessNvim { socket: string; proc: ChildProcess; stop: () => Promise<void> }`, `startHeadlessNvim(opts?: { nvimPath?: string; extraArgs?: string[] }): Promise<HeadlessNvim>`, and `testNvimBinary(): string`. Spawns
  `nvim --headless --listen <mkdtemp(tmpdir(),"nvim-mcp-test-")>/nvim.sock -n -u NONE -i NONE` (+`extraArgs`)
  with `stdio: ["ignore","ignore","pipe"]`, accumulating stderr. Readiness = `Promise.race([ready, exited])`; `ready` retries an actual `net.connect()` (**not** `existsSync` — a bound socket file is not yet an accepting socket) every 25 ms against a 10 s deadline, throwing `Neovim socket did not appear at ${socket}`; `exited` rejects with `Neovim exited early (code ${code}). stderr:\n${stderr}` or `Failed to spawn '${nvim}': ${err.message}`. `stop()` = SIGTERM → wait ≤2000 ms **on the `exit` event** (track a boolean; do not gate on `proc.killed`) → SIGKILL → `rm -rf` the tmpdir, errors swallowed; calling it twice is a no-op. Binary override: `NVIM_MCP_TEST_NVIM`.
- Test-suite convention, established here and binding on every later milestone: any suite that sets `process.env.NVIM` in `beforeAll` **must** `delete process.env.NVIM` in `afterAll`. `test/mcp.test.ts` must never touch the parent env at all — it passes `NVIM` only through the transport's `env`.
- `vitest.config.ts`: `include: ["test/**/*.test.ts"]`, `testTimeout: 30_000`, `hookTimeout: 30_000`, `pool: "forks"`, `poolOptions.forks.singleFork: true`.
- Test file created here: `test/nvim.test.ts` (connection cases; M4 extends it with buffer/window/diagnostic cases).

**Acceptance**

- Unit table: explicit arg wins (`source: "option"`); `NVIM_MCP_SOCKET` > `NVIM` > `NVIM_LISTEN_ADDRESS`; whitespace-only values skipped; returned address trimmed; all unset → `null`.
- `parseTcp`: `127.0.0.1:6789` → `{host:"127.0.0.1",port:6789}`; `:6789` → host `127.0.0.1`; `[::1]:6789` → `{host:"::1",port:6789}`; `/run/user/1000/nvim.1234.0` → `null`; `/tmp/sock:0` → `null` (port ≤ 0); an existing unix socket at `<tmpdir>/nvim:123` → `null` (statSync branch); `127.0.0.1:99999` → TCP, and connecting to it rejects with `NvimNotAvailableError` rather than crashing.
- Harness: `startHeadlessNvim()` resolves in well under a second and returns a socket under a unique tmpdir; `{ nvimPath: "definitely-not-nvim" }` rejects with `Failed to spawn` in under 2 s; `{ extraArgs: ["--bogus-flag"] }` rejects with `Neovim exited early` including stderr, also under 2 s; after `stop()` the process is gone and the tmpdir is deleted; `stop()` twice does not throw.
- Pristine-flags proof: with a hostile `~/.config/nvim/init.lua` present, `execLua("return vim.g.mapleader")` returns nil and `execLua("return vim.o.swapfile")` reports swapfile off; two consecutive runs write no shada.
- Integration: connecting to a nonexistent unix path **and** to a closed TCP port both reject with `NvimNotAvailableError` matching `/^Failed to connect to Neovim at /`; the process stays alive; a `process.on('unhandledRejection')` spy sees nothing.
- Against headless Neovim: `ctl.addressInfo?.address === nv.socket` and `.source === "NVIM"`; two concurrent `connect()` calls resolve to the **same client object**; 20 concurrent `execLua` calls produce exactly one connection; killing Neovim flips `isConnected()` false and the next call reconnects to a restarted instance; mutating `process.env.NVIM` after construction does not change `addressInfo`.
- Deadline: a fake msgpack peer accepts a request then destroys the socket without replying — the call rejects within `NVIM_MCP_RPC_TIMEOUT_MS` with `NvimNotAvailableError` naming the address, `isConnected()` is false afterwards, and the next call reconnects. A request issued after `'disconnect'` rejects rather than hanging.
- **Teardown regression test:** a fake msgpack peer records every request sent during `close()` and finds **no** `nvim_command` with `qa!`; against a real headless Neovim, `close()` leaves the process alive and still accepting a fresh connection. `close()` during an in-flight connect leaves `isConnected() === false`.

**Traps**

- `client.quit()` in `neovim@5.4.0` is literally `this.command('qa!')` — it force-quits the *user's* editor and discards unsaved buffers. The original wired this into SIGINT/SIGTERM. Use `client.close()` (ends the writer) / `socket.destroy()` instead. Never call `close()` from a short-lived helper process.
- `attach({ socket })` returns synchronously and never attaches an `'error'` listener; a stale `$NVIM` from an exited editor produces an **unhandled rejection** that kills the process, and `await client.apiInfo` never settles so your try/catch cannot see it. This is the single most likely real-world failure. Pre-connect on both branches.
- The TCP branch's connect-time `once("error", reject)` must be removed after `connect`, or a later socket error silently calls `reject` on a settled promise: no log, no reconnect.
- `neovim@5.4.0`'s `attach()` monkey-patches global `console` onto a winston logger. With `ALLOW_CONSOLE=1` it writes to **stdout** and corrupts the protocol. Pass an explicit logger; never set `ALLOW_CONSOLE`; the other knobs are `NVIM_NODE_LOG_LEVEL` and `NVIM_NODE_LOG_FILE`. Be aware `console.log` added for debugging silently vanishes after the first connect.
- The upstream client never rejects `Transport.pending` on `'detach'` and has no timeout — verified: after the peer closed the socket, `commandOutput('echo 1')` neither resolved nor rejected within 1.5 s. That is what the deadline is for.
- `ChildProcess.killed` means "a signal was delivered", not "the process is gone"; a SIGKILL fallback gated on `!proc.killed` is unreachable.
- `net.connect(99999, host)` throws `ERR_SOCKET_BAD_PORT` **synchronously** — keep it inside the async attempt so it becomes a rejection.

---

### M2 — MCP protocol layer + escape hatches + `nvim_info`

**Depends on:** M0, M1.

**Goal.** A server that completes the MCP handshake with no Neovim present, lists its tools, and never throws a protocol error.

**Deliverables**

- `src/server.ts` exporting exactly three symbols: `SERVER_NAME = "nvim-mcp"`, `SERVER_VERSION` (read from `package.json`, see M0), and `buildServer(nvim: NvimController): McpServer`. Constructed as `new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions })`. Instructions text, **verbatim, em dashes included**:
  > These tools control the live Neovim session this agent is running inside (detected via the NVIM environment variable). You can read and edit buffers, inspect windows and diagnostics, and — unlike a plain file editor integration — open terminals inside Neovim, send them input, and read their output. Use nvim_run_in_terminal for one-shot commands and nvim_open_terminal + nvim_terminal_send/read for interactive sessions.
- Registration form: `server.registerTool(name, { title, description, inputSchema }, handler)` where `inputSchema` is a **raw ZodRawShape** (a plain object of `z.*` values, never `z.object({})`). Zero-arg tools pass `inputSchema: {}` and a zero-arity handler.
- Helpers: `text(v) => { content: [{ type: "text", text: v }] }`; `json(v) => text(JSON.stringify(v, null, 2))`.
- `errorResult(err)`: message is `err.message` for `NvimNotAvailableError` (bare — its message is already the remediation), `` `${err.name}: ${err.message}` `` for any other `Error`, else `String(err)`. Logs `Tool error <message>` to stderr and returns `{ content: [{ type: "text", text: "Error: " + message }], isError: true }`.
- `guard<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult>` — generic, identity-shaped, try/catch. **Every** handler is wrapped; no handler has its own try/catch.
- `src/index.ts`: parse argv → `--help` short-circuit → log `Target Neovim: …` or the no-address warning → construct controller → `buildServer` → `await server.connect(new StdioServerTransport())` → log `nvim-mcp <version> ready on stdio`. SIGINT/SIGTERM → log `Shutting down` → `await controller.close()` in try/catch → `process.exit(0)`. Top-level catch → `logger.error("Fatal error", err.stack)` → `process.exit(1)`.
- Modern RPCs, not the deprecated aliases the client's convenience methods use. `client.lua()` maps to `nvim_execute_lua` and `client.commandOutput()` to `nvim_command_output`. Instead:
  - `execLua(code, args = [])` → `client.request("nvim_exec_lua", [code, args])` (the generic `request` on the client's `BaseApi`).
  - `execCommand(cmd)` → `execLua("local a = ... return vim.api.nvim_exec2(a.cmd, { output = true }).output", [{ cmd }])`. `nvim_exec2` exists from Neovim 0.9, so the CI floor is safe. **It returns a dict, not a string** — read `.output` (or `?? ""`) or `nvim_command` will stringify an object and the `(no output)` fallback will never fire.
- `evalExpr(expr)` → `client.eval(expr)` (`nvim_eval`, not deprecated).
- Tools this milestone, in this order: `nvim_info`, `nvim_exec_lua`, `nvim_command`, `nvim_eval`.
- `info()` implementation: `const [channelId, apiInfo] = await client.apiInfo` (a **getter**) plus one Lua chunk returning `version` via `string.format('%d.%d.%d', v.major, v.minor, v.patch)` from `vim.version()`, `cwd` (`vim.fn.getcwd()`), `current_buffer`, `current_buffer_name`, `current_window`, and `listed_buffers` counted with `vim.fn.buflisted(b) == 1`. `apiLevel` read defensively as `apiInfo.version?.api_level ?? 0`. Map snake_case → camelCase explicitly; add `connected: true`, `address`, `addressSource` in TS.

**Acceptance**

- `client.getServerVersion()` deep-equals `{ name: "nvim-mcp", version: <package.json version> }`; `client.getInstructions()` string-equals the instructions block character-for-character.
- Launched as a subprocess with `NVIM`, `NVIM_MCP_SOCKET`, `NVIM_LISTEN_ADDRESS` all unset: the handshake succeeds, `listTools()` returns exactly `["nvim_info","nvim_exec_lua","nvim_command","nvim_eval"]` in that order, and `nvim_info` **resolves** (does not reject) with `isError: true` and text beginning `Error: No Neovim address found.` mentioning `NVIM`, `:terminal`, `NVIM_MCP_SOCKET`, `--socket`. Process still alive afterwards.
- With `NVIM` set to a headless socket: `nvim_info` parses to `connected: true`, `addressSource: "NVIM"`, `channelId > 0`, `version` matching `/^\d+\.\d+\.\d+$/`, non-empty absolute `cwd`; opening two files increments `listedBuffers` by two.
- `execLua("return 1 + select(1, ...)", [41])` → `42`; `evalExpr("1 + 2")` → `3`; `execCommand("echo 'hi there'")` contains `hi there`; a silent command renders as the literal `(no output)`; a bad Ex command → `isError: true`, text starting `Error: `.
- A handler throwing `new TypeError("boom")` yields exactly `Error: TypeError: boom`; a thrown non-Error yields `Error: <String(value)>`; both log `ERROR Tool error` to stderr and the process survives.
- Every stdout byte parses as newline-framed JSON-RPC; all `[nvim-mcp] ` lines appear on stderr. A regression run with `ALLOW_CONSOLE=1 NVIM_NODE_LOG_LEVEL=debug` still finds stdout clean.

**Traps**

- Zod validation failures happen inside the SDK **before** your handler, so bad-typed args still surface as protocol errors, not `isError`. That asymmetry is inherent; document it.
- `inputSchema: {}` and omitting `inputSchema` produce different handler signatures (`(args, extra)` vs `(extra)`). Always pass `{}` and use a zero-arity arrow.
- Keep `guard`'s signature generic and identity-shaped or contextual typing collapses every destructured param to `any` with no compile error.
- `nvim_command_output` never captures `:!` shell output — which is exactly why M3 exists.
- Every Lua chunk is a *function body*: args arrive as `...`, callers must `return`; read them as `local args = ...` with exactly **one** table argument; `end` is a keyword, so range fields must be `args['end']`. An empty Lua table msgpacks as `[]`, not `{}`.
- `nvim_exec_lua` runs on Neovim's main loop, so **no other RPC interleaves within a chunk**; only registered callbacks (e.g. `on_exit`) fire between chunks. This atomicity is the premise behind M3's poll design — do not add locking that is not needed, and do not assume interleaving that cannot happen.

---

### M3 — **Terminals (headline milestone)**

**Depends on:** M0, M1, M2.

**Goal.** Open a terminal *inside* the user's Neovim, run a command, get the real exit code and rendered output back, drive long-lived interactive terminals, and prove the whole thing through a real MCP client and a live agent — all working under `--headless` on Neovim 0.9.5.

**Deliverables**

- `defaultShell()`: Lua `if vim.fn.executable('bash') == 1 then return 'bash' end return vim.o.shell` (bash preferred for predictable `-c`).
- `openTerminal({ cmd?, cwd?, name?, split?, focus? })` → `{ bufnr, channel, jobId, name }`:
  - `cmd` defaults to `defaultShell()`; `cwd` defaults to `""` meaning "inherit Neovim's cwd".
  - `split` default `"horizontal"`; Ex mapping `horizontal→new`, `vertical→vnew`, `tab→tabnew`, `none→enew`.
  - Save `prev_win` **before** the split; capture `buf = nvim_get_current_buf()` after it; build options as `local term_opts = vim.empty_dict()`; set `cwd` only when non-empty; register `on_exit` **before** `vim.fn.termopen`; call `termopen(cmd, term_opts)`; check the return (`<= 0` → `error('termopen failed for ' .. vim.inspect(args.cmd) .. ' (returned ' .. job .. ')')`); read `channel` from `vim.bo[buf].channel`; rename via `pcall(nvim_buf_set_name, buf, 'term://' .. name)`; restore focus with `if not args.focus and vim.api.nvim_win_is_valid(prev_win) then vim.api.nvim_set_current_win(prev_win) end` (`focus` default `false`).
  - `on_exit` body: `_G.__nvim_mcp_term_exits = _G.__nvim_mcp_term_exits or {}; _G.__nvim_mcp_term_exits[buf] = code`.
  - Feature-detect: `vim.fn.termopen` is deprecated from Neovim 0.11 in favour of `vim.fn.jobstart(cmd, { term = true })`. Pick at runtime; both take the same options dict.
- `runInTerminal(cmd, { cwd?, shell?, timeoutMs = 15_000, keepOpen = false, split = "horizontal" })` → `{ bufnr, bufferDeleted, output, exitCode: number | null, timedOut: boolean }`:
  - argv is the **list** `[shell, "-c", cmd]`, never a shell string; always `focus: false`.
  - `split: "none"` is rejected before doing anything, with the message `split 'none' is not supported for run_in_terminal (it would replace the buffer in the user's current window)`.
  - Poll loop, in this order: probe → deadline check → `sleep(75)`. Probe chunk: `local b = ...; local exits = _G.__nvim_mcp_term_exits or {}; local code = exits[b]; return { done = code ~= nil, exit_code = code }`. (Probe-before-deadline means `timeoutMs: 0` still gets one probe.) Test `code ~= nil`, never truthiness — `0` is a valid exit code.
  - Read with `stripTrailingBlank: true`, pop trailing lines matching the exit regex, then pop trailing `""` again, join with `\n`.
  - Unless `keepOpen`: one chunk clears `_G.__nvim_mcp_term_exits[b]` **and** `pcall(vim.api.nvim_buf_delete, b, { force = true })`; set `bufferDeleted: true`. With `keepOpen`, `bufferDeleted: false`.
- Exit-marker regex, used **only** for cosmetics, isolated so it cannot drift into detection logic: `export function trimExitMarker(lines: string[]): string[]` containing the single occurrence of `/\[Process exited (-?\d+)\]/` in the codebase. It takes no completion state.
- `terminalSend(bufnr, data, enter = true)` → `{ bufnr, bytes }`: resolve `chan = vim.bo[bufnr].channel`, `error('buffer ' .. bufnr .. ' is not a terminal')` when `chan == 0`; append `'\r'` (**carriage return, not newline**) when `enter`; `vim.fn.chansend(chan, payload)`; `bytes` is the Lua `#payload` byte count including the CR.
- `terminalRead(bufnr, { stripTrailingBlank = true })` → `{ bufnr, lines }`: assert `vim.bo[bufnr].buftype == 'terminal'` else `error('buffer ' .. bufnr .. ' is not a terminal')`; `nvim_buf_get_lines(bufnr, 0, -1, false)`; pop trailing lines exactly equal to `''`.
- `listTerminals()` → `{ bufnr, name, channel, jobId, running }[]`: iterate `nvim_list_bufs()`, keep `vim.bo[b].buftype == 'terminal'`; `job = vim.b[b].terminal_job_id or vim.bo[b].channel`; running detection is exactly
  ```lua
  local running = true
  local ok, status = pcall(vim.fn.jobwait, { job }, 0)
  if ok and status[1] ~= -1 then running = false end
  ```
  (`-1` = still running; anything else, including `-3` "invalid job id", is not running; a `pcall` failure leaves `running` at its `true` default). Includes terminals the **user** opened by hand, not just agent-created ones. While iterating, prune `_G.__nvim_mcp_term_exits` entries whose bufnr fails `nvim_buf_is_valid` — this is the explicit-forget path that keeps the registry bounded.
- MCP tools registered **after the reserved M4 slot**: `nvim_run_in_terminal`, `nvim_open_terminal`, `nvim_list_terminals`, `nvim_terminal_send`, `nvim_terminal_read`.
- `nvim_run_in_terminal` output is **plain text**, exactly:
  `` `exit code: ${exitCode ?? "unknown"}` + (timedOut ? " (timed out)" : "") + "\n--- output ---\n" + output ``
  A **non-zero exit code and a timeout are both successful tool results**: `isError` is unset, the outcome lives in the header, and `exitCode: null` renders as the literal `unknown`. Never map a non-zero exit to `isError`.
- Test file: `test/terminal.test.ts`.
- `scripts/e2e-claude-code.sh` (mode 0755, excluded from `npm test`) — runnable the moment M3 lands, since it allowlists only terminal tools:
  - `set -euo pipefail`; `ROOT="$(cd "$(dirname "$0")/.." && pwd)"`; preflight `nvim`, `claude`, `dist/index.js` with distinct messages (`nvim not found on PATH`, `claude (Claude Code CLI) not found on PATH`, `Build first: npm run build`).
  - `mktemp -d` workdir + `trap cleanup EXIT` that kills the nvim it started and `rm -rf`s the workdir; write `$WORKDIR/.mcp.json` = `{"mcpServers":{"nvim":{"command":"node","args":["$ROOT/dist/index.js"]}}}`.
  - Start `nvim --headless --listen "$SOCKET" -n -u NONE -i NONE` (**include `-u NONE`** — the original omitted it and loaded the developer's plugins); wait up to 10 s with `[ -S "$SOCKET" ]`, else `Neovim socket never appeared`.
  - `PROMPT='Use the nvim MCP server. Open a terminal inside this Neovim session and run the shell command "echo hello world", then read the terminal output back and report exactly what it printed.'`
  - Run `NVIM="$SOCKET" claude -p "$PROMPT" --output-format text --allowedTools "mcp__nvim__nvim_run_in_terminal" "mcp__nvim__nvim_open_terminal" "mcp__nvim__nvim_terminal_read"`, **teeing stderr to `$WORKDIR/claude.err` and printing it on failure** (the original discarded it with `2>/dev/null`, so auth failures looked like assertion failures).
  - `grep -qi "hello world"` → print `PASS: agent ran the command in an in-editor terminal and read 'hello world' back` and exit 0; else print `FAIL: 'hello world' not found in the agent's reply` to stderr and exit 1.

**Acceptance** (all against `--headless` Neovim with no UI ever attached, on both `stable` and `v0.9.5`)

- `runInTerminal("echo hello world")` → output contains `hello world`, `exitCode === 0`, `timedOut === false`, and the call resolves in **< 2000 ms** (assert on a `Date.now()` delta).
- `runInTerminal("echo nope; exit 3")` → output contains `nope`, `exitCode === 3`.
- `runInTerminal("sleep 30", { timeoutMs: 300 })` returns within ~400 ms with `timedOut: true`, `exitCode: null`. While a `runInTerminal("sleep 5")` poll is in flight, a concurrent `execLua("return vim.api.nvim_get_current_buf()")` resolves within 300 ms.
- Returned `output` has no trailing `[Process exited N]` line and no trailing blanks. `trimExitMarker` is unit-tested directly; the regex appears exactly once in `src/`, inside it.
- With `keepOpen` unset: `bufferDeleted === true` and `terminalRead(result.bufnr)` throws `buffer N is not a terminal`. With `keepOpen: true`: `bufferDeleted === false`, `terminalRead` succeeds, and the registry entry survives until `listTerminals()` prunes it after the buffer is wiped.
- Window discipline: record `nvim_get_current_win()` and `#nvim_list_wins()` before and after `runInTerminal("echo hi")`; both are unchanged after the call returns.
- `runInTerminal("echo x", { split: "none" })` → rejects with the exact `split 'none' is not supported…` message; over MCP it is `isError: true`.
- Interactive: `openTerminal({ name: "interactive" })` → `bufnr > 0`, `channel > 0`, `buftype === 'terminal'`, name starts `term://`, current window unchanged. All four split modes produce a working terminal. `terminalSend(bufnr, "echo interactive-marker-123")` then poll `terminalRead` at 75 ms up to 40 times until the marker appears **at least twice** (echoed keystrokes + command output). `listTerminals()` contains the bufnr with `running: true`; after the shell exits it reports `running: false`.
- `terminalSend`/`terminalRead` on a non-terminal buffer throw `buffer N is not a terminal`.
- Dict-vs-list demonstration: a test passes a plain `{}` to `termopen` through `nvim_exec_lua` and asserts it **fails**, then asserts `vim.empty_dict()` succeeds — proving the quirk is understood, not merely copied.
- **MCP level, here and not deferred:** an SDK `Client` over `StdioClientTransport` sees `listTools()` = the four M2 tools followed by the five terminal tools, in that order; `callTool({ name: "nvim_run_in_terminal", arguments: { cmd: "echo hello world" } })` returns `isError` falsy with text containing `hello world`, `exit code: 0` and the literal line `--- output ---`.

**Traps**

- **`[Process exited N]` is a rendering artifact, not an event.** Neovim writes it during terminal redraw; a headless/windowless terminal never renders it. The original scraped for it and every PTY test on nvim 0.9.5 burned the full 15 s and returned `exitCode: null` (suite wall time ~10 s → ~127 s, one hard timeout). Read the exit code from `termopen`'s `on_exit` callback — an event-loop signal independent of rendering.
- `on_exit` can fire **before `termopen` returns** for a fast command like `echo`. Key the lazily-created global on the `buf` captured before `termopen`; never write into a record created after it.
- `_G.__nvim_mcp_term_exits` does not exist until the first terminal exits. Every read must guard (`or {}` / `if ... then`) or the first `runInTerminal` of a session raises "attempt to index a nil value".
- `termopen`'s options argument must msgpack as a **dictionary**. An empty Lua table encodes as a list and is rejected — start from `vim.empty_dict()`.
- `vim.fn.termopen` returns `0` for bad args and `-1` for a non-executable command and does **not** raise. Unchecked, `on_exit` never fires and you burn the full timeout.
- Output is a **rendered screen**, not a stream: prompt lines, echoed input, blank grid padding, and hard-wrapping at terminal width. Anything needing byte-exact stdout must not use this path.
- `vim.cmd('new')` per terminal means N parallel `runInTerminal` calls split the layout N times. Do not claim parallel safety unless you adopt the windowless technique (stretch goal 1).
- Newline (`\n`) does not reliably submit a line to a PTY; use `\r`.
- Do **not** solve the registry leak with a `BufWipeout` autocmd — persistent editor-side state is forbidden by guardrail 3. Use the explicit clear + prune specified above.

---

### M4 — Core editor primitives: buffers, windows, files, diagnostics

**Depends on:** M0, M1, M2. (Independent of M3; its six tools are registered into the reserved slot before the terminal tools.)

**Goal.** Read and edit buffers in memory, open files, enumerate windows, and harvest diagnostics.

**Deliverables**

- The shared `bufTarget` zod fragment lives here (see the parameter reference below) and is spread into `nvim_read_buffer` and `nvim_write_buffer`; M5 reuses it.
- **One shared** buffer-target resolver, factored into a single Lua prelude string used by every call site (never copy-pasted): `bufnr >= 0` → that buffer; else non-empty `path` → resolve; else `nvim_get_current_buf()`. Wire sentinels are `bufnr: -1` and `path: ""`. Then `if not nvim_buf_is_loaded(buf) then vim.fn.bufload(buf) end`.
  - **Improvement over the original, mandatory:** never call `vim.fn.bufnr(path)`. That is Vim *pattern* matching — `foo.txt` matches `.../foobar.txt`, glob metacharacters are live, and a pattern matching two buffers returns `-1`, indistinguishable from not-found (all verified). Instead:
    ```lua
    local want = vim.fn.fnamemodify(args.path, ':p')
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_get_name(b) == want then buf = b break end
    end
    if buf == nil then error('no buffer for path: ' .. args.path) end
    ```
    Error message stays `no buffer for path: <path>`. Exact-name matching also makes "ambiguous" impossible, so the message never lies.
- `listBuffers()` → per buffer `{ bufnr, name, buftype, modified, lineCount, listed, loaded, current }`. Iterates `nvim_list_bufs()` (`:ls!` semantics — includes unlisted/unloaded). `lineCount` is `0` for unloaded buffers by design; say so in the description.
- `readBuffer(target, start = 0, end = -1)` → `{ bufnr, name, lines }` via `nvim_buf_get_lines(buf, start, end, false)`.
- `setBufferLines(target, lines, start = 0, end = -1)` → `{ bufnr, lineCount }` via `nvim_buf_set_lines(buf, start, end, false, lines)`. In-memory only — the buffer becomes modified; nothing is written to disk. Pre-validate: reject any line containing `\n` with `line ${i} contains a newline; pass one array element per line`, and reject a non-`modifiable` buffer with a clear message rather than letting the raw RPC error through.
- `openFile(path, split)` → `BufferInfo`. Mapping: `none`/undefined→`edit`, `horizontal`→`split`, `vertical`→`vsplit`, `tab`→`tabedit`; issued as `vim.cmd(cmd .. ' ' .. vim.fn.fnameescape(path))`. Relative paths resolve against **Neovim's** cwd. The returned `BufferInfo` reports `loaded: true, current: true` (it is, by construction) and a real `lineCount`. **Decided behaviour:** `openFile` intentionally leaves the cursor in the newly opened window — putting work in front of the human is the point — unlike `openTerminal`, which restores `prev_win`. Say so in the tool description.
- `listWindows()` → `{ winid, bufnr, bufname, width, height, cursor: [row, col], current }` across all tabpages including floats. `cursor` is `nvim_win_get_cursor` output: **`[1-based row, 0-based byte column]`**.
- `diagnostics(bufnr?)` → `{ bufnr, lnum, col, severity, message, source?, code? }[]`. `bufnr` omitted (wire `-1`) → all buffers via `vim.diagnostic.get(nil)`. `lnum`/`col` are **0-based**, passed through untouched. `severity` mapped in TS: `1→"ERROR", 2→"WARN", 3→"INFO", 4→"HINT"`, unknown → `String(n)`. Only these seven fields are copied out.
- **camelCase at the boundary, everywhere.** Every controller method maps Lua snake_case to camelCase explicitly in its `.then()`; nothing is merely `as`-cast. Wire keys are `lineCount`, `jobId`, `rootDir`, `endLine`, `endCol`, `editCount`, `hasEdit`, `hasCommand`, `appliedTitle`, `offsetEncoding`, `changedFiles`. This is an **intentional breaking change** from v0.1.0, which emitted `line_count` from `nvim_list_buffers`, `nvim_write_buffer` and `nvim_open_file` while its TypeScript interfaces declared `lineCount` — so `result.lineCount` was `undefined` at runtime.
- Tools, inserted before the terminal block: `nvim_list_buffers`, `nvim_read_buffer`, `nvim_write_buffer`, `nvim_open_file`, `nvim_list_windows`, `nvim_diagnostics`.
- `nvim_read_buffer` returns **text**: `` `buffer ${bufnr} (${name || "[No Name]"}):\n` + lines.join("\n") ``.
- Test cases land in `test/nvim.test.ts`.

**Acceptance**

- `listTools()` now returns 15 names in the tool-table order, terminals last.
- `setBufferLines({bufnr}, ["alpha","beta","gamma"], 0, -1)` then `readBuffer({bufnr})` returns exactly those three; `readBuffer(t, 1, 2)` returns `["beta"]`; `setBufferLines(t, ["x"], 1, 1)` inserts without deleting; out-of-range indices clamp (`strict_indexing = false`); a line containing `\n` is rejected with the documented message.
- Path targeting: `{bufnr: N}` wins over a simultaneously-supplied `path`; a `:badd`-ed unloaded buffer resolves by absolute path and reads real content (proving `bufload` ran); with `sub/foo.txt` and `sub/bar.txt` open, the absolute path resolves while `ub/fo` errors `no buffer for path: ub/fo`, `*.txt` errors, and a path containing `[` resolves literally; an unopened path errors with `no buffer for path: `.
- Split mapping is distinguishable: after `horizontal`, `vim.fn.winlayout()[1] === 'col'`; after `vertical`, `'row'`; window count +1 for both; `tabpagenr('$')` +1 for `tab`; both unchanged for `none`. A path with a space opens as one buffer (proves `fnameescape`). After any split mode, `nvim_get_current_win()` has changed (documented focus-stealing).
- `listWindows()` has at least one entry with `current === true`.
- `diagnostics()` returns `[]` on a clean buffer; after `vim.diagnostic.set` on a known namespace at Lua line 0, `diagnostics(bufnr)` yields `lnum === 0`, `severity === "ERROR"`; severity `9` stringifies to `"9"`; passing a bufnr scopes the result.
- **Key-name test (runtime half):** `Object.keys(JSON.parse(text)).sort()` for a `nvim_list_buffers` entry deep-equals `["bufnr","buftype","current","lineCount","listed","loaded","modified","name"]`; `nvim_write_buffer` parses to keys `["bufnr","lineCount"]`.
- **Key-name test (type half):** the test file contains `satisfies BufferInfo` / `satisfies SetBufferLinesResult` assertions and `npm run typecheck` checks `test/**` via `tsconfig.test.json`.

**Traps**

- Three indexing conventions coexist and nothing in the JSON labels them: buffer ranges 0-based/end-exclusive/negative-from-end; diagnostics `lnum`/`col` 0-based; LSP 1-based/1-based; window `cursor` mixed. An agent copying a diagnostic's `lnum` into `nvim_lsp_hover`'s `line` is off by one. Say so in the descriptions.
- `:edit` on a modified buffer with `'hidden'` off raises E37 inside `vim.cmd` and surfaces as a raw Vim error string.
- `listBuffers` reporting `lineCount: 0` for unloaded buffers disagrees with `readBuffer` on the same buffer (which calls `bufload` first). Document it.
- Empty Lua tables msgpack as `[]`, not `{}` — a result table stripped of all optional keys arrives as an array.

---

### M5 — LSP tool group + fake language server

**Depends on:** M0–M4 (it reuses M4's buffer-target resolver and needs `openFile`/`readBuffer` for its fixtures).

**Goal.** Borrow the language servers the user's Neovim already has running, and test it offline and deterministically.

**Deliverables**

- The shared `lspPos` fragment lives here and is spread, together with M4's `bufTarget`, into hover / definition / references / rename / code_action.
- Position helper: `lspPosition(line?, col?) => { line: Math.max(0, (line ?? 1) - 1), character: Math.max(0, (col ?? 1) - 1) }`. Reverse conversion (+1 on all four range coords) happens in Lua.
- **`path` is forwarded.** Every LSP handler destructures `{ bufnr, path, line, col, … }` and passes both into **M4's shared buffer-target resolver** — the same prelude, verbatim, including `fnamemodify(':p')`, exact-name matching, `bufload`, and the `no buffer for path: <path>` error. The original declared `path` via `bufTarget` and then silently ignored it; that bug must not be reproduced.
- Client lookup shim, used everywhere: `local get = vim.lsp.get_clients or vim.lsp.get_active_clients` (`get_clients` is 0.10+, `get_active_clients` is 0.9). This is exactly what the `v0.9.5` CI leg exists to protect.
- Every request: `vim.lsp.buf_request_sync(bufnr, method, params, 2000)` — the timeout stays hardcoded at 2000 ms in this milestone (per-tool `timeoutMs` is stretch goal 3, and adding it here would contradict the schemas M6 asserts). Each response loop starts `if r.error then error(vim.inspect(r.error)) end`. When `buf_request_sync` returns `nil` (timeout, or no client handles the method), log to stderr `LSP request produced no response for <method> (timeout or no handler)` and report the honest result — never `applied: true`.
- **Deterministic multi-client policy** (replaces the original's `pairs()` roulette): iterate `pairs(responses)` capturing `client_id` alongside each result; among clients that returned a non-nil result, pick the one advertising the relevant capability, tie-breaking by lowest client id. Concatenate (never pick) for definition, references, symbols and code actions.
- Offset encoding: one shared helper. When applying an edit, use the encoding of **the client that produced it** — look it up with `get({ bufnr = bufnr })` filtered on `c.id == client_id` — falling back to `'utf-16'`. No copy-pasted `cs[1].offset_encoding` blocks.
- `lspClients(bufnr?)` → `{ id, name, rootDir?, initialized, offsetEncoding? }[]`; `initialized` = `c.server_capabilities ~= nil`; `rootDir` = `(c.config and c.config.root_dir) or c.root_dir`. Returns `[]` with nothing attached.
- `lspHover({bufnr, path, line, col})` → `{ contents }`: selected client's result; flatten with `vim.lsp.util.convert_input_to_markdown_lines(result.contents)` (handles all three hover shapes), pop trailing `''`, join with `\n`; `''` when nothing.
- `lspDefinition` / `lspReferences` share one implementation parameterized by method name, with references adding `{ context = { includeDeclaration = opts.includeDeclaration ?? true } }` merged via `vim.tbl_extend('force', base, extra)`. Normalize Location **and** LocationLink: `uri = loc.uri or loc.targetUri`, `range = loc.range or loc.targetSelectionRange or loc.targetRange` (that precedence), `filename = vim.uri_to_fname(uri)`, coords +1. Handle a bare single object as well as an array. Merge across clients by concatenation.
- `lspDocumentSymbols(bufnr?)` → flat `{ name, kind, detail?, line?, depth }[]` via a recursive Lua flattener, top level `depth = 0`. Accepts DocumentSymbol (`s.range`) and SymbolInformation (`s.location.range`). `kind` decoded in TS from the full SymbolKind table, unknown → `String(n)`:
  `1 File, 2 Module, 3 Namespace, 4 Package, 5 Class, 6 Method, 7 Property, 8 Field, 9 Constructor, 10 Enum, 11 Interface, 12 Function, 13 Variable, 14 Constant, 15 String, 16 Number, 17 Boolean, 18 Array, 19 Object, 20 Key, 21 Null, 22 EnumMember, 23 Struct, 24 Event, 25 Operator, 26 TypeParameter`.
- `lspRename({ newName, bufnr?, path?, line?, col?, apply = true })` → `{ applied, changedFiles: [{ file, edits }], editCount, resourceOps }`. Preview walks `edit.changes` (uri→edits map) **and** `edit.documentChanges` (array), **deduping by absolute filename** when a server populates both (legal, and some do). `resourceOps` counts `documentChanges` entries without a `textDocument` — CreateFile / RenameFile / DeleteFile — which the original silently skipped while still performing them. With no server result, return exactly `{ applied: false, changedFiles: [], editCount: 0, resourceOps: 0 }`. Apply via `vim.lsp.util.apply_workspace_edit(edit, enc)`.
- `lspCodeAction({ bufnr?, path?, line?, col?, applyIndex? })` → `{ actions: [{ index, title, kind?, hasEdit, hasCommand, needsResolve }], applied, appliedTitle? }`. Context diagnostics come from `vim.diagnostic.get(bufnr, { lnum })` (the 0-based LSP line) filtered to `d.user_data.lsp`; range is zero-width at the position. `index` is **1-based**; the apply guard is an explicit `apply_index ~= nil and apply_index >= 1 and actions[apply_index] ~= nil` (never rely on `actions[0]` being nil, because `0` is truthy in Lua). `needsResolve` is true when an action has neither `edit` nor `command` — applying such an action returns `applied: false` with no `appliedTitle` instead of falsely reporting success. Apply: `apply_workspace_edit(a.edit, enc)`; a table `command` triggers a nested `workspace/executeCommand`; a bare-string `command` (old Command shape) is reported as unsupported rather than silently skipped.
- `lspFormat(bufnr?)` → `{ applied, editCount }`; options `tabSize = shiftwidth > 0 ? shiftwidth : 4`, `insertSpaces = expandtab`; applied with `vim.lsp.util.apply_text_edits(edits, bufnr, enc)`. `applied` is `true` only when a response actually arrived and edits were applied — a timeout yields `{ applied: false, editCount: 0 }`, never the original's `{ applied: true, editCount: 0 }`.
- `test/helpers/fake-lsp.mjs`: a `#!/usr/bin/env node` stdio JSON-RPC server. Framing: accumulate `Buffer.concat`, find `\r\n\r\n`, parse `/Content-Length:\s*(\d+)/i`, return early while `pending.length < bodyStart + length`, slice with `subarray` before `toString("utf8")`; outgoing `Content-Length` is the **byte** length of `Buffer.from(JSON.stringify(msg), "utf8")`. Advertise `hoverProvider/definitionProvider/referencesProvider/documentSymbolProvider/renameProvider/codeActionProvider/documentFormattingProvider` and `serverInfo { name: "fake-lsp", version: "0.0.1" }`. **`shutdown` → reply `null`; `exit` → `process.exit(0)`** (without this the process is orphaned by every `vim.lsp.start`, and under `singleFork` they accumulate across the whole run). Accept `initialized`/`didOpen`/`didChange`/`didClose`/`didSave`/`$/setTrace` silently; reply `null` to any other message **that has an `id`**; swallow malformed frames. Canned payloads: hover markdown `**fakeSymbol**\n\nA symbol provided by the fake LSP server.`; definition = a single Location (not an array) at range(0,0,0,10); references = two Locations at (0,0,0,10) and (2,6,2,16); documentSymbol = `fakeSymbol` kind 12 with child `child` kind 13; rename = `changes` replacing (0,0,0,10) with `params.newName`; codeAction = `Fake quickfix: prepend marker` kind `quickfix` inserting `-- fixed\n` at 0,0; formatting = one edit inserting `-- formatted\n` at 0,0.
- Test wiring in `test/lsp.test.ts`: write the fixture, `ctl.openFile(path)`, then `vim.api.nvim_set_current_buf(bufnr); vim.lsp.start({ name = 'fake-lsp', cmd = { 'node', <abs path> }, root_dir = <per-suite mkdtemp> })`, then poll `lspClients(bufnr)` for `initialized` every 50 ms up to 10 s. Fixture: `["fakeSymbol = 1", "local y = 2", "print(fakeSymbol)"].join("\n") + "\n"`, a **fresh file per mutating test** (`vim.lsp.start` dedupes by config, so one server process serves all of them).

**Acceptance**

- `listTools()` returns all 23 names in the tool-table order.
- Unit: `lspPosition(1,1)` → `{line:0,character:0}`; `(3,7)` → `{line:2,character:6}`; `()` → `{line:0,character:0}`; `(-5,-5)` → `{line:0,character:0}`.
- Clients: `name === "fake-lsp"`, `initialized === true` within 10 s; `[]` with none attached.
- Hover contents contains `fakeSymbol`, no trailing blanks.
- `lspDefinition({bufnr, line: 3, col: 7})` → exactly 1 location with `line === 1`, filename ending in the fixture name. `lspReferences({bufnr, line: 1, col: 1})` → 2, second at `line === 3`.
- `path` forwarding: `nvim_lsp_hover { path: <abs path of a non-current open buffer>, line: 1, col: 1 }` returns hover for **that** buffer, not the current one.
- Symbols → `[{name:"fakeSymbol", kind:"Function", line:1, depth:0}, {name:"child", kind:"Variable", line:2, depth:1}]`; a SymbolInformation-shaped payload still yields a correct `line`; kind `99` → `"99"`.
- Rename `apply:true` → `{applied:true, editCount:1, resourceOps:0}` and line 0 contains `renamed`; `apply:false` → `{applied:false, changedFiles.length === 1}` and line 0 still exactly `fakeSymbol = 1`; a `documentChanges`-only server yields the same counts; a server populating **both** `changes` and `documentChanges` for the same file still yields `editCount: 1` and one `changedFiles` entry; a `documentChanges` payload with a CreateFile op reports `resourceOps: 1`.
- Code action listing → 1 item, `hasEdit:true`, `needsResolve:false`, buffer unmodified; `applyIndex: 1` → line 0 exactly `-- fixed`; `applyIndex: 99` → `applied:false`, no error; an action with only `title`/`kind`/`data` lists as `needsResolve:true` and applying it returns `applied:false`.
- Format → `{applied:true, editCount:1}`, line 0 exactly `-- formatted`; `shiftwidth=2, expandtab` sends `{tabSize:2, insertSpaces:true}`, `shiftwidth=0` sends `tabSize:4`; on a buffer with no attached server it completes without throwing and reports `{applied:false, editCount:0}`.
- Offset encoding: with two clients attached where the second advertises `utf-8`, applying an edit produced by the second passes `'utf-8'` to `apply_workspace_edit` (assert by stubbing `vim.lsp.util.apply_workspace_edit` in Lua and recording its second argument).
- MCP level: `nvim_lsp_clients` on a serverless buffer → `isError` falsy and `JSON.parse(text)` deep-equals `[]`; `nvim_lsp_hover` where the server returns no contents → exactly the text `(no hover information)`; a server responding with an LSP error → `isError: true` and text starting `Error: `.
- LSP framing test: a body split across two `data` chunks and a multibyte UTF-8 body both decode without desync.

**Traps**

- `buf_request_sync` returns `nil, 'timeout'` — **not** an error — on timeout or when no client handles the method, so every loop degrades silently to "no results" unless you check for `nil` explicitly.
- `buf_request_sync` blocks Neovim's main loop for up to the timeout — the user's editor freezes. The code-action apply path nests a second sync request inside the first (~4 s worst case). Note it in the descriptions; the async fix is stretch goal 3.
- `Position.character` is counted in the client's offset encoding (UTF-16 by default), but the tool presents it as a plain 1-based column. On emoji/CJK lines the numbers do not match `nvim_win_get_cursor`. Documented limitation; stretch goal 6 fixes it.
- `apply_workspace_edit` materializes unopened files as in-memory buffers — a project-wide rename leaves N **modified, unsaved** buffers and `applied: true` with nothing on disk. Resource operations (create/rename/delete) *do* touch the filesystem, so "apply" is not uniformly reversible by closing buffers. Document both.
- `vim.lsp.start` dedupes by config; four `openWithLsp` calls reuse one server process attached to several buffers. Mutating tests must therefore use fresh files.

---

### M6 — Definition of done: a live agent runs a command in the user's editor

**Depends on:** M0–M5.

**Goal.** Prove the whole stack through a real MCP client, end to end, exactly as the Definition of Done describes.

**Deliverables**

- `test/mcp.test.ts`: `Client` + `StdioClientTransport` from the SDK spawning `node_modules/.bin/tsx src/index.ts` (path built from `dirname(fileURLToPath(import.meta.url))`) with `env: { ...process.env, NVIM: nv.socket } as Record<string,string>` and `stderr: "inherit"`. **Spread `process.env`** — the SDK's stdio transport otherwise passes a minimal allowlist and strips `PATH`/`HOME`, breaking `tsx` and the terminal shell. This file must **never** touch the parent `process.env.NVIM`; teardown is `await client?.close()` then `await nv?.stop()`.
- An entry-point switch so the same suite can run against the compiled artifact: `NVIM_MCP_TEST_ENTRY` (default `tsx src/index.ts`, alternative `node dist/index.js`). M7 wires a CI job to the second form.
- A short DoD walkthrough in the README's Testing section describing the manual `:terminal claude` run and pointing at `scripts/e2e-claude-code.sh` (delivered in M3).

**Acceptance**

- `listTools()` returns all 23 `nvim_*` names **in registration order with exactly the titles and descriptions reproduced in this document**; `nvim_read_buffer`'s schema has properties `{bufnr, path, start, end}` with `required: []`; `nvim_terminal_send` has `required: ["bufnr","data"]`; `nvim_lsp_rename` lists `newName` first with `required: ["newName"]`; no schema contains a `default` keyword; every parameter has a non-empty `description`; the four zero-arg tools expose `{"type":"object","properties":{}}`.
- The emitted `enum` arrays for `split` on `nvim_open_file`, `nvim_run_in_terminal` and `nvim_open_terminal` are deep-equal.
- `nvim_lsp_clients` → `isError` falsy and `JSON.parse(text)` deep-equals `[]`.
- `nvim_info` → `connected: true`, `addressSource: "NVIM"`.
- `nvim_run_in_terminal {cmd:"echo hello world"}` → text containing `hello world` and `exit code: 0`.
- `nvim_write_buffer {lines:["one","two","three"], start:0, end:-1}` then `nvim_read_buffer {}` round-trips; the read text's first line matches `/^buffer \d+ \(.*\):$/`.
- Every successful result has `content.length === 1` and `content[0].type === "text"`.
- The whole suite passes with `NVIM_MCP_TEST_ENTRY="node dist/index.js"` after `npm run build`.
- `npm test` runs 10× consecutively with 10 clean passes. Deliberately removing one suite's `delete process.env.NVIM` makes a later suite fail (proving the singleFork coupling the convention protects against).
- The manual `npm run build && ./scripts/e2e-claude-code.sh` prints `PASS: agent ran the command in an in-editor terminal and read 'hello world' back` and exits 0 on an authenticated machine.

**Traps**

- Under `singleFork`, every test file shares one OS process. `test/mcp.test.ts` passing `NVIM` only through the transport is what keeps it from silently passing for the wrong reason.
- `tsx` runs the TypeScript source; without the `NVIM_MCP_TEST_ENTRY` job the compiled artifact users actually get via npx is never exercised by an automated test.

---

### M7 — Ship it: CI matrix, release automation, README, examples

**Depends on:** M0–M6.

**Goal.** Gate the suite on the versions that expose the quirks, publish reproducibly, and document the positioning.

**Deliverables**

- `.github/workflows/ci.yml`: triggers `push: branches: ["**"]` + `pull_request`; `ubuntu-latest`; job name `test (node ${{ matrix.node }}, nvim ${{ matrix.nvim }})`; `fail-fast: false`; matrix `node: ["20","22"] × nvim: ["stable","v0.9.5"]`. Steps in order: `actions/checkout@v4` → `rhysd/action-setup-vim@v1` with `neovim: true, version: ${{ matrix.nvim }}` → `nvim --version | head -1` → `actions/setup-node@v4` with `cache: npm` → `npm ci` → `npm run typecheck` → `npm run build` → `npm test` → `node dist/index.js --help` smoke run. Neovim is installed **before** Node so a missing editor fails fast.
- A fifth CI job `dist` (node 22, nvim stable): `npm ci && npm run build && NVIM_MCP_TEST_ENTRY="node dist/index.js" npx vitest run test/mcp.test.ts`.
- `.github/workflows/release.yml`: `push: tags: ["v*"]` + `workflow_dispatch`; `permissions: { contents: read, id-token: write }`; setup-node 22 with `registry-url: "https://registry.npmjs.org"` and `cache: npm`; **install Neovim and run the test suite here too** (the original's release job had no test gate) → `npm ci` → typecheck → build → test → `npm publish --provenance --access public` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`.
- `examples/mcp.json`: `{"mcpServers":{"nvim":{"command":"npx","args":["-y","nvim-mcp"]}}}` plus a `"//"` key explaining project-level `.mcp.json` auto-loading and `$NVIM` inheritance. Strict JSON only — no comments, no JSON5; `"//"` is a real key, which is why it parses.
- README, in this order: the "Make Neovim feel like Cursor" pitch → `## Why not just claudecode.nvim?` (file-scoped plugins cannot open a terminal in the editor) → `## How it works` (the `$NVIM` mechanism + an ASCII diagram nvim → `:terminal` → agent → msgpack-RPC → buffers/terminals) → `## Install` (`npm i -g nvim-mcp` / `npx -y nvim-mcp`) → `## Use with Claude Code` (`claude mcp add nvim -- npx -y nvim-mcp`, the `.mcp.json` sample, `:terminal claude`) → `## Tools` (a **15-row core table** with `nvim_run_in_terminal` bolded, then `### LSP tools — the editor's language intelligence` as an **8-row sub-table**, then `### Targeting a specific Neovim` with the 4-level resolution list and the address format) → `## Testing` (per-file coverage, "real, not mocked", and `### Real end-to-end with the live agent`) → `## Development` → `## Releasing` (`NPM_TOKEN` **automation** token, `npm version <patch|minor|major>`, `git push --follow-tags`) → `## License`.

**Acceptance**

- All 4 CI matrix cells plus the `dist` job green.
- Release gate is checkable without publishing: a `workflow_dispatch` run reaches the `npm publish` step with `--provenance --access public`, `id-token: write` present, `npm whoami` succeeding against the configured `registry-url`, and `npm publish --dry-run` printing the expected file list. A real tag push then publishes a version whose npm page shows a provenance badge linking to the workflow run.
- The version reported in `initialize` equals `package.json`'s `version` (asserted in `test/mcp.test.ts`).
- Copying `examples/mcp.json` to `.mcp.json` in a scratch project and running `:terminal claude` inside Neovim yields working `nvim_*` tool calls.

**Traps**

- Provenance fails at publish time (after the tag is pushed) unless all three hold: `id-token: write`, `--access public` matching `publishConfig.access`, and a `repository` URL resolving to the building repo.
- `NODE_AUTH_TOKEN` authenticates nothing without `registry-url` on `actions/setup-node` — omit it and you get `ENEEDAUTH`.
- The `v0.9.5` leg is not decoration: it forces `vim.lsp.get_clients or vim.lsp.get_active_clients` and it is where the terminal rendering quirk showed up.

---

## Tool surface — the exact target API

23 tools, all prefixed `nvim_`, registered (and therefore listed) in this order. Every parameter carries a `.describe()` string; defaults live in that prose and are applied in TypeScript with `??`, never via zod `.default()`.

| # | M | Tool | Title | Parameters (zod raw shape) | Returns |
|---|---|---|---|---|---|
| 1 | M2 | `nvim_info` | Neovim session info | *(none)* | JSON `{ connected, address, addressSource, channelId, version, apiLevel, cwd, currentBuffer, currentBufferName, currentWindow, listedBuffers }` |
| 2 | M2 | `nvim_exec_lua` | Execute Lua | `code: string` (req), `args?: any[]` | JSON of the Lua return value |
| 3 | M2 | `nvim_command` | Run Ex command | `command: string` (req, no leading colon) | Text: captured output, or `(no output)` |
| 4 | M2 | `nvim_eval` | Evaluate VimL expression | `expr: string` (req) | JSON of the VimL value |
| 5 | M4 | `nvim_list_buffers` | List buffers | *(none)* | JSON `{ bufnr, name, buftype, modified, lineCount, listed, loaded, current }[]` |
| 6 | M4 | `nvim_read_buffer` | Read buffer | `bufnr?`, `path?`, `start?` (0-based, default 0), `end?` (0-based exclusive, default -1) | Text: `buffer <n> (<name or [No Name]>):\n` + lines joined by `\n` |
| 7 | M4 | `nvim_write_buffer` | Write buffer lines | `bufnr?`, `path?`, `lines: string[]` (req, no trailing newlines), `start?` (default 0), `end?` (default -1) | JSON `{ bufnr, lineCount }` |
| 8 | M4 | `nvim_open_file` | Open file | `path: string` (req), `split?: "none"\|"horizontal"\|"vertical"\|"tab"` (default `none`) | JSON `BufferInfo` |
| 9 | M4 | `nvim_list_windows` | List windows | *(none)* | JSON `{ winid, bufnr, bufname, width, height, cursor: [1-based row, 0-based byte col], current }[]` |
| 10 | M4 | `nvim_diagnostics` | Get diagnostics | `bufnr?` (omit for all buffers) | JSON `{ bufnr, lnum (0-based), col (0-based), severity: "ERROR"\|"WARN"\|"INFO"\|"HINT", message, source?, code? }[]` |
| 11 | **M3** | **`nvim_run_in_terminal`** | Run command in a terminal | `cmd: string` (req), `cwd?`, `shell?`, `timeoutMs?: int` (default 15000), `keepOpen?: bool` (default false), `split?: enum` (default `horizontal`; `none` rejected) | Text: `exit code: <n\|unknown>`[` (timed out)`]`\n--- output ---\n`<output> |
| 12 | M3 | `nvim_open_terminal` | Open a terminal | `cmd?: string \| string[]`, `cwd?`, `name?`, `split?: enum` (default `horizontal`), `focus?: bool` (default false) | JSON `{ bufnr, channel, jobId, name }` |
| 13 | M3 | `nvim_list_terminals` | List terminals | *(none)* | JSON `{ bufnr, name, channel, jobId, running }[]` |
| 14 | M3 | `nvim_terminal_send` | Send to terminal | `bufnr: int` (req), `data: string` (req), `enter?: bool` (default true → appends `\r`) | JSON `{ bufnr, bytes }` (byte count incl. CR) |
| 15 | M3 | `nvim_terminal_read` | Read terminal | `bufnr: int` (req), `stripTrailingBlank?: bool` (default true) | Text: lines joined by `\n` |
| 16 | M5 | `nvim_lsp_clients` | List LSP clients | `bufnr?` | JSON `{ id, name, rootDir?, initialized, offsetEncoding? }[]` |
| 17 | M5 | `nvim_lsp_hover` | LSP hover | `bufnr?`, `path?`, `line?` (1-based, default 1), `col?` (1-based, default 1) | Text: markdown, or `(no hover information)` |
| 18 | M5 | `nvim_lsp_definition` | LSP go to definition | `bufnr?`, `path?`, `line?`, `col?` | JSON `{ uri, filename, line, col, endLine, endCol }[]` (all 1-based) |
| 19 | M5 | `nvim_lsp_references` | LSP find references | `bufnr?`, `path?`, `line?`, `col?`, `includeDeclaration?: bool` (default true) | JSON `LspLocation[]` |
| 20 | M5 | `nvim_lsp_document_symbols` | LSP document symbols | `bufnr?` | JSON `{ name, kind (name string), detail?, line? (1-based), depth (0 at top) }[]` |
| 21 | M5 | `nvim_lsp_rename` | LSP rename symbol | `newName: string` (req, **first**), `bufnr?`, `path?`, `line?`, `col?`, `apply?: bool` (default true) | JSON `{ applied, changedFiles: [{ file (abs path), edits }], editCount, resourceOps }` |
| 22 | M5 | `nvim_lsp_code_action` | LSP code actions | `bufnr?`, `path?`, `line?`, `col?`, `applyIndex?: int` (1-based; omit to list only) | JSON `{ actions: [{ index, title, kind?, hasEdit, hasCommand, needsResolve }], applied, appliedTitle? }` |
| 23 | M5 | `nvim_lsp_format` | LSP format buffer | `bufnr?` | JSON `{ applied, editCount }` |

### Tool descriptions — verbatim

These are the agent's only documentation and are asserted exactly. Every one opens with an imperative verb, states conventions the schema cannot express, cross-references sibling tools by name, and (where it earns it) names the competitive framing.

1. **`nvim_info`** — "Report the connected Neovim instance: version, channel, working directory, current buffer/window and how the connection was resolved. Use this first to confirm the agent is wired to a live Neovim."
2. **`nvim_exec_lua`** — "Run Lua in Neovim via nvim_exec_lua and return the result as JSON. The code is a function body, so use `return` to produce a value and reference call arguments via `...`. This is the most powerful tool: anything the Neovim Lua API can do is reachable here."
3. **`nvim_command`** — "Execute an Ex command (e.g. `:write`, `:bnext`, `:vsplit foo.txt`) and return its captured output."
4. **`nvim_eval`** — "Evaluate a Vimscript expression (e.g. `expand('%:p')`) and return the result."
5. **`nvim_list_buffers`** — "List all buffers with their number, name, type, modified state and line count. Terminal buffers report buftype 'terminal'. lineCount is 0 for buffers that are not loaded."
6. **`nvim_read_buffer`** — "Read lines from a buffer (by number, path, or the current buffer). Line range is 0-based and end-exclusive; end = -1 reads to the end."
7. **`nvim_write_buffer`** — "Replace a line range in a buffer with new lines. Line range is 0-based and end-exclusive; use start = 0, end = -1 to replace the whole buffer. This edits the buffer in memory only — run nvim_command with `write` to save it."
8. **`nvim_open_file`** — "Open a file in Neovim, optionally in a split or new tab, and return its buffer info. This moves the user's cursor into the newly opened window."
9. **`nvim_list_windows`** — "List open windows with their buffer, size and cursor position. cursor is [1-based row, 0-based byte column]."
10. **`nvim_diagnostics`** — "Return LSP/diagnostic entries (errors, warnings, etc.) for a buffer, or for all buffers if none is given. lnum and col are 0-based, unlike the 1-based nvim_lsp_* tools. Great for letting the agent see and fix problems the way Cursor does."
11. **`nvim_run_in_terminal`** — "Open a terminal inside Neovim, run a single shell command, wait for it to finish, and return its output and exit code. This is the one-shot building block: e.g. run `echo hello world` and read it back. The terminal runs inside the user's editor, so the command shares the editor's environment and working directory. A non-zero exit code is reported in the output header, not as an error."
12. **`nvim_open_terminal`** — "Open a persistent terminal inside Neovim and return its buffer number, channel and job id. Use nvim_terminal_send to type into it and nvim_terminal_read to read its screen. Use this for interactive or long-running sessions; for one-shot commands prefer nvim_run_in_terminal."
13. **`nvim_list_terminals`** — "List terminal buffers currently open in Neovim, with their job/channel and running state. This includes terminals the user opened by hand."
14. **`nvim_terminal_send`** — "Send input to an open terminal buffer. By default a carriage return is appended so the line is submitted; set enter=false to send raw keys (e.g. control characters)."
15. **`nvim_terminal_read`** — "Read the rendered contents (scrollback + current screen) of a terminal buffer. Trailing blank lines are trimmed by default. This is a painted screen, not a byte-exact stdout stream: it includes the prompt, echoed input and hard wrapping."
16. **`nvim_lsp_clients`** — "List the language servers attached to a buffer (or the current buffer), with their id, name, root directory and whether they have finished initializing. Use this to check language intelligence is available before calling the other nvim_lsp_* tools."
17. **`nvim_lsp_hover`** — "Get hover documentation (signatures, types, docs) for the symbol at a position, as the editor's language server would show it."
18. **`nvim_lsp_definition`** — "Resolve the definition location(s) of the symbol at a position. Returns file, line and column (1-based) for each location."
19. **`nvim_lsp_references`** — "Find all references to the symbol at a position across the project."
20. **`nvim_lsp_document_symbols`** — "List the symbols (functions, classes, variables, …) defined in a buffer, with their kind and line. Nesting is reported via `depth`."
21. **`nvim_lsp_rename`** — "Rename the symbol at a position project-wide via the language server and apply the resulting edits (set apply=false to preview which files would change without modifying anything). Applied edits land in unsaved buffers; run nvim_command with `wa` to write them."
22. **`nvim_lsp_code_action`** — "List the code actions (quick fixes, refactors) the language server offers at a position, including any diagnostics there. Pass applyIndex (1-based, from a previous listing) to apply one of them."
23. **`nvim_lsp_format`** — "Format a buffer using its language server and apply the changes in place."

### Parameter `.describe()` strings — verbatim

Shared fragments (declared once, spread with `...`):

- `bufTarget.bufnr` — "Target buffer number. Omit to use the path or the current buffer."
- `bufTarget.path` — "Target buffer by file path (must already be open). Ignored if bufnr is set."
- `lspPos.line` — "1-based line number. Default 1."
- `lspPos.col` — "1-based column number. Default 1."

Per tool:

- `nvim_exec_lua.code` — "Lua code to execute. Use \`return\` to yield a value."
- `nvim_exec_lua.args` — "Optional arguments, available in the Lua code via \`...\`."
- `nvim_command.command` — "The Ex command, without the leading colon."
- `nvim_eval.expr` — "The Vimscript expression to evaluate."
- `nvim_read_buffer.start` — "First line (0-based). Default 0."
- `nvim_read_buffer.end` — "End line (0-based, exclusive). Default -1 (end of buffer)."
- `nvim_write_buffer.lines` — "Replacement lines (no trailing newlines)."
- `nvim_write_buffer.start` — "First line to replace (0-based). Default 0."
- `nvim_write_buffer.end` — "End line (0-based, exclusive). Default -1 (replace to end)."
- `nvim_open_file.path` — "Path to the file to open."
- `nvim_open_file.split` — "How to open it. Default 'none' (replace current window)."
- `nvim_diagnostics.bufnr` — "Buffer number. Omit for all buffers."
- `nvim_run_in_terminal.cmd` — "Shell command to run."
- `nvim_run_in_terminal.cwd` — "Working directory. Defaults to Neovim's cwd."
- `nvim_run_in_terminal.shell` — "Shell to use (default: bash if available)."
- `nvim_run_in_terminal.timeoutMs` — "Max time to wait for completion in ms. Default 15000."
- `nvim_run_in_terminal.keepOpen` — "Keep the terminal buffer open afterwards. Default false."
- `nvim_run_in_terminal.split` — "Where to show the terminal. Default 'horizontal'. 'none' is not supported here."
- `nvim_open_terminal.cmd` — "Program to run. Default: the user's shell."
- `nvim_open_terminal.cwd` — "Working directory."
- `nvim_open_terminal.name` — "Optional display name for the terminal buffer."
- `nvim_open_terminal.split` — "Where to show it. Default 'horizontal'."
- `nvim_open_terminal.focus` — "Move the cursor into the terminal window. Default false."
- `nvim_terminal_send.bufnr` — "Terminal buffer number (from nvim_open_terminal/list)."
- `nvim_terminal_send.data` — "Text to send."
- `nvim_terminal_send.enter` — "Append a carriage return. Default true."
- `nvim_terminal_read.bufnr` — "Terminal buffer number."
- `nvim_terminal_read.stripTrailingBlank` — "Trim trailing blank lines. Default true."
- `nvim_lsp_clients.bufnr` / `nvim_lsp_document_symbols.bufnr` / `nvim_lsp_format.bufnr` — "Buffer number. Omit for the current buffer."
- `nvim_lsp_references.includeDeclaration` — "Include the declaration itself. Default true."
- `nvim_lsp_rename.newName` — "The new name for the symbol."
- `nvim_lsp_rename.apply` — "Apply the edits. Default true."
- `nvim_lsp_code_action.applyIndex` — "1-based index of the action to apply. Omit to only list."

**Uniform result contract.** Success = exactly one `{ type: "text" }` content block. JSON tools emit `JSON.stringify(value, null, 2)`. Failure = `{ content: [{ type: "text", text: "Error: <msg>" }], isError: true }` where `<msg>` is the bare message for `NvimNotAvailableError` and `` `${err.name}: ${err.message}` `` otherwise. No `outputSchema`, no `structuredContent`, no annotations, no resources, no prompts, no non-text blocks.

**Normalize the `split` enum.** Export one zod enum constant (`["horizontal","vertical","tab","none"]`) reused by `nvim_open_file`, `nvim_run_in_terminal` and `nvim_open_terminal` so their emitted `enum` arrays are deep-equal; keep the differing defaults documented per tool.

---

## Non-goals and guardrails

These were built, tested, and deleted. Do not rebuild them.

**1. No command-execution routing (steer / mirror / enforce modes).** A prior commit shipped all three — a managed `CLAUDE.md` block, `PreToolUse`/`PostToolUse` hooks mirroring every Bash command into a Neovim log buffer, and an enforce mode that added `permissions.deny: ["Bash"]` plus an allowlist of `mcp__nvim__*` terminal tools — with tests and a live-agent e2e proving it worked. It was reverted 2 days later: *"None of the routing modes were working out in practice."* It required a second npm bin (`nvim-mcp-hook`), host-agent-specific hook payload/decision JSON, and permission rewriting in the user's project. **Guardrail:** `grep -rn 'mirror-pre\|mirror-post\|deny-bash\|permissionDecision\|hookSpecificOutput' src/ examples/ scripts/` returns nothing; `bin` has exactly one entry; nothing writes `.claude/settings.local.json`.

**2. No display surfaces (`panel` / `hidden` / `log`) and no `--display` flag.** An "Agent Terminals" tabpage, a windowless terminal mode, and a shared `nvim-mcp://log` `jobstart` stream were three parallel answers to "where does output show up" — ~235 lines of Lua state plus the TypeScript plumbing around it, a `display` param on two tools, a CLI flag, `$NVIM_MCP_EXEC_DISPLAY`, and a `runViaJob` path that returned a *different kind of bufnr*. **Guardrail:** the terminal tools expose `split`/`focus` only; `--help` prints the block in M0 with the Usage line exactly `nvim-mcp [--socket <addr>]` and advertises no `--display` flag or display env var; `runInTerminal` has exactly one execution path.

**3. No persistent Lua runtime module in the user's Neovim.** `src/runtime.ts` installed a 235-line `RUNTIME_LUA` blob creating `_G.__nvim_mcp` (log buffer, panel tabpage, terminal and job registries) once per RPC connection, needing an `ensureRuntime()` gate and a client-identity check to survive reconnects. **Guardrail:** all Lua is passed inline to `nvim_exec_lua`; the only global the server touches is the flat `_G.__nvim_mcp_term_exits` bufnr→exit-code table; **no autocmds, no augroups, no user commands** are created in the user's session.

**4. No bundled Neovim plugin, no `:ClaudeCode` launcher.** A `nvim/` directory with a split/float agent-terminal launcher was shipped, grown to 457 lines with project-config generation, then deleted: *"The server is used directly via .mcp.json / `claude mcp add` and started from a Neovim :terminal, so the plugin was an extra surface with no remaining dependents."* `:terminal claude` already exports `$NVIM`. **Guardrail:** no `nvim/` directory; `files` is `["dist","README.md"]`.

**5. No writing into the user's project files.** `setup_project()` merged into `.mcp.json`, `.claude/settings.local.json` and `CLAUDE.md` on every launch — with a hand-rolled sorted-key JSON printer, `strip_our_hooks` for idempotent mode switches, and marker-delimited CLAUDE.md surgery. High blast radius, deleted within 48 hours. **Guardrail:** no code path writes those files; `examples/mcp.json` is a copy-paste sample.

**6. Never detect command completion by scraping `[Process exited N]`.** See M3. **Guardrail:** the regex exists exactly once, inside `trimExitMarker`, which takes no completion state; it may trim the last output line, it may never decide completion.

**7. Do not promise parallel-safe, focus-preserving terminals with the split implementation.** The windowless design was the only thing that made 8 parallel `runInTerminal` calls safe, and the test asserting it was deleted with the revert. Document the trade honestly; do not claim isolation you do not have.

**8. Do not blanket-revert a commit range.** Release/packaging automation landed 30 minutes before the big revert and was surgically preserved. Keep orthogonal infrastructure out of feature reverts.

---

## Key decisions to preserve

- **`$NVIM` discovery, 4 levels, with source tagging.** Precedence `--socket`/`--address` (`"option"`) > `$NVIM_MCP_SOCKET` > `$NVIM` > `$NVIM_LISTEN_ADDRESS`, each trimmed, `null` when all empty. The chosen source is observable as `nvim_info.addressSource` and is asserted by tests. The address is frozen at controller construction — mutating `process.env` afterwards changes nothing.
- **Env vars, complete list.** `NVIM`, `NVIM_MCP_SOCKET`, `NVIM_LISTEN_ADDRESS` (targeting); `NVIM_MCP_LOG_LEVEL` (`debug|info|warn|error`, default `info`); `NVIM_MCP_RPC_TIMEOUT_MS` (default `10000`); `NVIM_MCP_TEST_NVIM` and `NVIM_MCP_TEST_ENTRY` (tests only). Never set `ALLOW_CONSOLE`.
- **stdout is the protocol channel.** Every diagnostic goes to `process.stderr` via the logger; the only stdout write is `--help`, on a path that returns before the transport connects. Fatal errors log to stderr then `process.exit(1)`.
- **Start even with no editor.** Hosts register the server before Neovim exists (`npx -y nvim-mcp` in `.mcp.json`). Log a warning, connect the transport anyway, and defer failure to per-call `isError` results whose message is itself the remediation.
- **`guard()` on every handler.** No exception ever reaches the protocol layer.
- **Inline Lua over `nvim_exec_lua`, one table argument, `local args = ...`.** No plugin to install, no runtime to keep in sync, nothing left behind in the user's session. Buffer/Window/Tabpage wrapper objects from the `neovim` client are deliberately unused. A Lua chunk runs on Neovim's main loop, so no other RPC interleaves **within** it; only registered callbacks fire between chunks.
- **Indexing conventions, stated in `.describe()` because JSON Schema cannot express them.** Buffer ranges: 0-based, end-exclusive, `-1` = end of buffer. Diagnostics `lnum`/`col`: 0-based. All LSP tools: 1-based line **and** 1-based column. `applyIndex` and code-action `index`: 1-based. Window `cursor`: `[1-based row, 0-based byte column]`.
- **Exit codes from `termopen`'s `on_exit`, never from rendered text.** Registered before `termopen`, keyed on the bufnr captured before it, into a lazily-created global that every reader guards.
- **`vim.empty_dict()` for `termopen` options.** An empty Lua table encodes as a msgpack list and is rejected.
- **`\r` submits a terminal line, not `\n`.**
- **A non-zero exit and a timeout are successful tool results.** The outcome lives in the `exit code:` header; `isError` stays unset.
- **camelCase on the wire, mapped explicitly at every boundary.** No `as`-casts over snake_case Lua results.
- **Real Neovim in every test — nothing mocked.** Each test file spawns `nvim --headless --listen <tmp sock> -n -u NONE -i NONE` (pristine: no vimrc, no shada, no swapfile), on its own tmpdir socket, with SIGTERM→2 s→SIGKILL teardown, readiness proven by a real `net.connect` retry.
- **`pool: "forks"` + `singleFork: true` + 30 s timeouts.** Tests spawn real editors and ptys and mutate process-global `process.env.NVIM`; parallelism produces flake and cross-file env bleed. Any suite that sets `process.env.NVIM` deletes it in `afterAll`; `test/mcp.test.ts` never touches it.
- **A deterministic fake LSP server over stdio.** No network, no credentials, no version-specific responses — while still exercising Neovim's genuine `vim.lsp` stack. `Content-Length` is a byte count; reply `null` to any unhandled message carrying an `id`; honour `shutdown` and `exit`.
- **CI matrix `node ["20","22"] × nvim ["stable","v0.9.5"]`, `fail-fast: false`.** The 0.9.5 leg is what forces `vim.lsp.get_clients or vim.lsp.get_active_clients` and what exposed the terminal rendering quirk. Install Neovim before Node so a missing editor fails fast.
- **Pure ESM + NodeNext.** `"type": "module"`, `.js` extensions on every local import, `node:` prefix on builtins, SDK subpath imports with `.js`.
- **npx-first distribution.** One bin, `files: ["dist","README.md"]`, `prepublishOnly: npm run build`, tag-triggered publish with `--provenance`.
- **`close()` must never touch the user's editor.** Destroy the socket / end the writer. Never `client.quit()`.
- **Tool descriptions are load-bearing documentation.** Imperative opening verb; conventions and defaults spelled out in prose; sibling tools cross-referenced by name to route the agent (`nvim_run_in_terminal` for one-shot, `nvim_open_terminal` + `send`/`read` for interactive).

---

## Stretch goals

Grounded gaps a rebuild can close **after** the milestones above; none of these duplicate a milestone deliverable.

1. **Windowless terminals for genuine concurrency.** Re-adopt `termopen` inside `vim.api.nvim_buf_call(buf, ...)` on a `nvim_create_buf(true, false)` buffer — no split, no focus change — as the default for `runInTerminal`, keeping the split path for `openTerminal`. Ship the deleted concurrency test with it: 8 parallel runs each returning their own `marker-N`, distinct exit codes, and an assertion that the current window and buffer are unchanged throughout. This is what would let the Definition of Done claim true layout invariance.
2. **Byte-exact command output.** Add an opt-in non-PTY mode (`vim.fn.jobstart` with on_stdout/on_stderr line reassembly — data[1] continues the previous partial, data[#data] becomes the new pending partial, strip `\r`) returning true stdout/stderr streams separately, for tools whose output an agent must parse.
3. **Per-request LSP timeouts, cancellation, and a responsive editor.** Add `timeoutMs?: int` ("Max ms to wait for the language server. Default 2000.") to all eight LSP tools, add `timedOut: boolean` to the LSP result shapes so "timed out" is distinguishable from "no results", and replace `buf_request_sync` with `vim.lsp.buf_request` + a poll so the user's editor stops freezing for up to 2 s (up to ~4 s on the nested code-action apply path).
4. **`codeAction/resolve` support.** M5 already reports `needsResolve` and refuses to fake success; this implements the resolve round trip so `title`/`kind`/`data`-only actions can actually be applied.
5. **Per-client LSP results.** M5 picks deterministically; this returns every attached client's hover/format/rename result side by side so the agent can choose (useful with ts_ls + eslint).
6. **Offset-encoding-correct columns.** Convert between UTF-16 code units and byte columns with `vim.lsp.util.character_offset` / `vim.str_utfindex` so LSP columns match `nvim_win_get_cursor` on emoji/CJK lines.
7. **A `save`/`write` affordance.** `apply_workspace_edit` leaves N modified unsaved buffers with no on-disk change. Add an explicit `save?: boolean` to `nvim_lsp_rename` / `nvim_lsp_code_action` / `nvim_write_buffer`, plus a `nvim_save_buffers` tool, so the agent does not have to fall back to `nvim_command "wa"`.
8. **Friendlier path targeting.** On `no buffer for path:`, optionally open the file instead (`create: true` / `open: true`) rather than erroring — the exact-match resolver in M4 already removed the ambiguity problem.
9. **Full `bufTarget` coverage.** `nvim_diagnostics`, `nvim_lsp_clients`, `nvim_lsp_document_symbols` and `nvim_lsp_format` still accept only `bufnr`; because zod strips unknown keys, an agent passing `path` gets it silently dropped and operates on the wrong buffer. Either accept `path` on those four too or reject unknown keys.
10. **Structured tool output.** The SDK supports `outputSchema` + `structuredContent`; today every result is a stringified-JSON text blob the agent must parse. Emitting structured content (while keeping the text block for compatibility) makes the API self-describing.
11. **Selection-aware code actions and visual-range operations.** The code-action range is zero-width at the cursor; supporting an explicit `endLine`/`endCol` unlocks extract-function and other range actions.
12. **Cursor and mode control.** There is no tool to move the cursor, read the current selection, or enter/leave insert mode — an agent that can open a terminal but cannot place the user's cursor at a diagnostic is half-integrated.