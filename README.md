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

## Running commands inside the editor (the Cursor feel)

By default Claude Code runs shell commands with its own built-in `Bash` tool, so
you never see them in your editor. `nvim-mcp` routes that execution *through
Neovim* so you watch it happen, with two independent knobs:

**`mode`** — how strongly shell execution is routed through Neovim:

| Mode | What happens |
| --- | --- |
| `off` | Do nothing; nvim-mcp is just available as tools. |
| `steer` | A managed `CLAUDE.md` block asks the agent to prefer `nvim_run_in_terminal` over Bash. *(default)* |
| `mirror` | The agent's Bash tool still runs, but each command and its output are echoed into a Neovim log buffer (via Claude Code hooks) so you watch its shell activity. |
| `enforce` | The built-in Bash tool is **denied**, so *all* shell goes through `nvim_run_in_terminal` — the most Cursor-like. |

**`display`** — where command execution is surfaced inside Neovim:

| Display | What you see |
| --- | --- |
| `panel` | Each command runs in a terminal shown in a dedicated **"Agent Terminals"** tabpage. *(default)* |
| `hidden` | Terminals run with no window; open them on demand via `nvim_list_terminals`. |
| `log` | Output is streamed into one shared `nvim-mcp://log` buffer (no PTY). |

In every mode and display, terminals are created **without stealing your focus or
disturbing your window layout** (termopen runs inside `nvim_buf_call`), so the
agent can run many commands in parallel while you keep editing. One-shot commands
are cleaned up on success and **kept on failure** so you can inspect what broke.

`mirror` and `enforce` use a small helper bin, `nvim-mcp-hook`, wired up via
Claude Code hooks. Install it on `PATH` with `npm i -g nvim-mcp` (which provides
both `nvim-mcp` and `nvim-mcp-hook`).

### The `:ClaudeCode` command

For a Cursor-like one-keystroke workflow, this repo ships a tiny Neovim plugin
(in [`nvim/`](nvim/)) that **generates the project configuration and opens the
agent** for you. With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "shooooooooo/nvim-mcp",
  config = function()
    require("nvim-mcp").setup({
      agent_cmd = { "claude" },  -- the agent to launch
      split = "vertical",        -- "vertical" | "horizontal" | "tab" | "float"
      size = 0.4,
      mode = "enforce",          -- "off" | "steer" | "mirror" | "enforce"
      display = "panel",         -- "panel" | "hidden" | "log"
    })
    vim.keymap.set("n", "<leader>cc", "<cmd>ClaudeCode<cr>", { desc = "Claude Code" })
  end,
}
```

`:ClaudeCode` first generates the matching project config — a `.mcp.json` (with
`--display`), a `.claude/settings.local.json` (the permissions/hooks for the
chosen `mode`), and a managed block in `CLAUDE.md` — then opens (or focuses) a
terminal split running the agent. Because that terminal inherits `$NVIM`,
`nvim-mcp` connects straight back to the same editor.

Config generation is **idempotent** and only touches what it manages: it merges
into existing files, marks its `CLAUDE.md` block with comment delimiters, and
cleans up when you switch modes. It writes to `settings.local.json` (which is
conventionally git-ignored) so nothing is committed without your say-so.

Other commands:

- `:ClaudeCodeMode <off|steer|mirror|enforce>` — switch mode and regenerate config.
- `:ClaudeCodeSetup` — (re)generate the project config without opening the agent.
- `:ClaudeCodeNew` — open a fresh agent terminal.

See [`examples/`](examples/) for the generated `settings.enforce.json` and
`settings.mirror.json`. You can of course skip the plugin and write these files
(or `--display`) by hand.

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
| `nvim_run_in_terminal` | **Run one command, wait, return output + exit code.** Takes a `display` override (`panel`/`hidden`/`log`). |
| `nvim_open_terminal` | Open a persistent terminal (windowless; `display` controls where it shows); returns its buffer/channel/job id. |
| `nvim_terminal_send` | Send input/keys to an open terminal. |
| `nvim_terminal_read` | Read a terminal's rendered contents. |
| `nvim_list_terminals` | List open terminal buffers, the command that started them, and whether they're still running. |

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
- **`test/concurrency.test.ts`** — many `runInTerminal` calls in parallel each
  return their own output, with distinct exit codes, and **never move the user's
  window or buffer** (the windowless-terminal guarantee).
- **`test/display.test.ts`** — the three display surfaces: `panel` (a kept
  terminal in the Agent Terminals tabpage), `hidden` (a terminal buffer shown in
  no window), and `log` (output streamed into the shared log buffer).
- **`test/hook.test.ts`** — the `nvim-mcp-hook` bin: `mirror-pre`/`mirror-post`
  append the command and its output to the editor's log buffer, `deny-bash`
  emits a deny decision, and the hook exits cleanly when no editor is reachable.
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

## License

MIT — see [LICENSE](LICENSE).
