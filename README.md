# nvim-mcp

**Make Neovim feel like Cursor.** `nvim-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server that gives an agent — such as [Claude Code](https://claude.com/claude-code) —
**full control over the Neovim session it is running inside**: buffers, windows,
diagnostics, **LSP language intelligence** (definition, references, hover,
rename, code actions), and, crucially, **terminals**.

When you launch an agent from inside a Neovim `:terminal`, the agent isn't just
editing files in a vacuum — it's living inside your editor. `nvim-mcp` lets it
act like it: open a split, read a buffer, check LSP diagnostics, spin up a
terminal, run a command, and read the output back — the same things you'd do by
hand.

## Why not just claudecode.nvim?

Plugins like `claudecode.nvim` expose the *file being edited* to the agent. That
is useful, but the agent still can't see or drive the rest of the editor — most
notably it **cannot open a terminal inside Neovim, run something, and read the
result**. `nvim-mcp` connects to Neovim's own RPC channel, so the agent gets the
whole editor, terminals included.

## How it works

Neovim is a first-class RPC server. Whenever Neovim spawns a child process — a
`:terminal`, `jobstart()`, `system()` — it exports the address of its own
msgpack-RPC socket in the **`NVIM`** environment variable:

```
$ nvim                    # inside Neovim, open a terminal with :terminal
$ echo $NVIM
/run/user/1000/nvim.1234.0
```

Any client that connects to that socket can drive the parent editor. `nvim-mcp`:

1. reads `NVIM` (the default; this is set automatically inside a `:terminal`),
2. connects to that socket over msgpack-RPC, and
3. exposes a focused set of MCP tools that the agent can call.

```
┌──────────────────────────── Neovim ────────────────────────────┐
│  your code buffers, windows, LSP diagnostics                    │
│                                                                 │
│  ┌─ :terminal ──────────────────────────────────────────────┐  │
│  │  $ claude            ($NVIM is set in here)               │  │
│  │     └── nvim-mcp ──msgpack-RPC──┐                         │  │
│  └─────────────────────────────────┼────────────────────────┘  │
│        controls buffers/terminals  │                            │
│  ◄─────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install -g nvim-mcp     # or run on demand with: npx -y nvim-mcp
```

From source:

```bash
git clone https://github.com/shooooooooo/nvim-mcp
cd nvim-mcp
npm install
npm run build
```

## Use with Claude Code

Register the server so Claude Code can launch it. The simplest way is a
project-level `.mcp.json` (see [`examples/mcp.json`](examples/mcp.json)):

```json
{
  "mcpServers": {
    "nvim": { "command": "npx", "args": ["-y", "nvim-mcp"] }
  }
}
```

or globally:

```bash
claude mcp add nvim -- npx -y nvim-mcp
```

Then **start Claude Code from inside Neovim** so it inherits `$NVIM`:

```vim
:terminal claude
```

That's it — the agent can now call the `nvim_*` tools and they act on the editor
it's running inside. Ask it things like *"open a terminal and run the tests, then
fix whatever fails."*

## Tools

| Tool | What it does |
| --- | --- |
| `nvim_info` | Version, channel, cwd, current buffer/window, how the connection was resolved. |
| `nvim_exec_lua` | Run arbitrary Lua via `nvim_exec_lua` (the full power escape hatch). |
| `nvim_command` | Run an Ex command and capture its output. |
| `nvim_eval` | Evaluate a Vimscript expression. |
| `nvim_list_buffers` | List buffers (number, name, type, modified, line count). |
| `nvim_read_buffer` | Read lines from a buffer by number, path, or current. |
| `nvim_write_buffer` | Replace a line range in a buffer. |
| `nvim_open_file` | Open a file (optionally in a split or tab). |
| `nvim_list_windows` | List windows with buffer, size, cursor. |
| `nvim_diagnostics` | LSP/diagnostic entries for a buffer or all buffers. |
| `nvim_run_in_terminal` | **Open a terminal, run one command, wait, return output + exit code.** |
| `nvim_open_terminal` | Open a persistent terminal; returns its buffer/channel/job id. |
| `nvim_terminal_send` | Send input/keys to an open terminal. |
| `nvim_terminal_read` | Read a terminal's rendered contents. |
| `nvim_list_terminals` | List open terminal buffers and whether they're still running. |

### LSP tools — the editor's language intelligence

These let the agent use the language servers Neovim already has running, instead
of re-deriving semantics from raw text. Positions are **1-based line and 1-based
column**.

| Tool | What it does |
| --- | --- |
| `nvim_lsp_clients` | List the language servers attached to a buffer (and whether they've initialized). |
| `nvim_lsp_hover` | Hover docs (signatures, types) for the symbol at a position. |
| `nvim_lsp_definition` | Resolve definition location(s) of the symbol at a position. |
| `nvim_lsp_references` | Find all references to the symbol at a position. |
| `nvim_lsp_document_symbols` | List the symbols defined in a buffer (with kind and nesting depth). |
| `nvim_lsp_rename` | Rename a symbol project-wide; applies the edits (or previews with `apply=false`). |
| `nvim_lsp_code_action` | List code actions (quick fixes/refactors) at a position; apply one by index. |
| `nvim_lsp_format` | Format a buffer via its language server and apply the changes. |

### Targeting a specific Neovim

By default the target is discovered from the environment, highest priority first:

1. `--socket <addr>` / `--address <addr>` CLI flag
2. `NVIM_MCP_SOCKET`
3. `NVIM` *(set automatically inside a Neovim `:terminal`)*
4. `NVIM_LISTEN_ADDRESS` *(legacy)*

`<addr>` may be a unix-socket path / named pipe, or a `host:port` TCP address
(start Neovim with `nvim --listen 127.0.0.1:6789` for the latter).

## Testing

The test suite is real, not mocked: every integration test spins up an actual
headless Neovim, points `NVIM` at it, and drives it exactly as the agent would.

```bash
npm test
```

What's covered:

- **`test/nvim.test.ts`** — the controller against a live Neovim: address
  resolution, session info, Lua/eval/Ex commands, buffer read/write, windows,
  diagnostics.
- **`test/terminal.test.ts`** — the headline scenario: open a terminal, run
  `echo hello world`, read it back; plus non-zero exit codes and interactive
  send/read.
- **`test/lsp.test.ts`** — the LSP tools driven against a deterministic fake
  language server (`test/helpers/fake-lsp.mjs`), covering hover, definition,
  references, document symbols, rename (apply + preview), code actions, and
  formatting — all offline, no real language server or network required.
- **`test/mcp.test.ts`** — the full MCP stack: an MCP client launches the server
  as a subprocess with `NVIM` set, lists the tools, and calls
  `nvim_run_in_terminal` to run `echo hello world` end-to-end over JSON-RPC.

The reusable harness in [`test/helpers/nvim.ts`](test/helpers/nvim.ts) starts a
pristine headless Neovim (`-u NONE -i NONE -n`) on a fresh socket and tears it
down cleanly, so you can build more scenarios on top of it. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the whole thing
against multiple Node and Neovim versions.

### Real end-to-end with the live agent

`npm test` deliberately avoids needing an API key — it drives the MCP server
directly, which is the exact code path the agent uses. To verify the *literal*
"Claude Code inside Neovim" loop with the real LLM, see
[`scripts/e2e-claude-code.sh`](scripts/e2e-claude-code.sh): it starts Neovim,
launches Claude Code in an in-editor terminal, and asks it to run
`echo hello world` in a Neovim terminal and read it back. That script needs the
`claude` CLI authenticated and is kept out of the automated suite for that
reason.

## Development

```bash
npm install
npm run dev          # run the server from TypeScript (tsx)
npm run typecheck
npm run build
npm test
```

## Releasing

Publishing to npm is automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml), which runs on
any pushed `v*` tag (or manually from the Actions tab). One-time setup: add an
`NPM_TOKEN` repository secret (an npm **automation** token with publish rights).
Then cut a release:

```bash
npm version patch     # or minor / major — bumps package.json and tags it
git push --follow-tags
```

The workflow typechecks, builds, and runs `npm publish --provenance`, so the
published package always ships a fresh `dist/`.

## License

MIT — see [LICENSE](LICENSE).
