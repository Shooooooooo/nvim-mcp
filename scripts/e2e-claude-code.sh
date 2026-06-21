#!/usr/bin/env bash
#
# Real end-to-end smoke test of the brief's scenario with the *live* agent:
#
#   start nvim -> Claude Code (with $NVIM set, exactly as a :terminal does) ->
#   ask the agent to open a terminal in nvim, run `echo hello world`, and read
#   it back to verify.
#
# Unlike the automated vitest suite (which drives the MCP server directly and
# needs no API key), this runs the genuine agent, so it requires:
#   * the `claude` CLI on PATH and authenticated (ANTHROPIC_API_KEY or login)
#   * this server built:  npm run build
#
# It is intentionally NOT part of `npm test` because it depends on credentials
# and a real LLM. Run it manually:
#
#   npm run build && ./scripts/e2e-claude-code.sh
#
# Setting NVIM in this shell is a faithful stand-in for launching the agent from
# inside a Neovim `:terminal` — that is the one and only thing the :terminal
# does that nvim-mcp depends on. Running claude here (rather than buried in a
# terminal buffer) just makes its output easy to capture and assert on.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v nvim   >/dev/null 2>&1 || { echo "nvim not found on PATH" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "claude (Claude Code CLI) not found on PATH" >&2; exit 1; }
[ -f "$ROOT/dist/index.js" ] || { echo "Build first: npm run build" >&2; exit 1; }

WORKDIR="$(mktemp -d)"
SOCKET="$WORKDIR/nvim.sock"
cleanup() {
  [ -n "${NVIM_PID:-}" ] && kill "$NVIM_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# Register nvim-mcp for this throwaway project so Claude Code can launch it.
# --display panel surfaces the agent's command execution in a dedicated tabpage.
cat >"$WORKDIR/.mcp.json" <<JSON
{
  "mcpServers": {
    "nvim": { "command": "node", "args": ["$ROOT/dist/index.js", "--display", "panel"] }
  }
}
JSON

# 'enforce' mode: deny the built-in Bash tool so all shell must go through the
# editor. This mirrors what the :ClaudeCode plugin writes for mode = "enforce".
mkdir -p "$WORKDIR/.claude"
cat >"$WORKDIR/.claude/settings.local.json" <<JSON
{
  "permissions": { "deny": ["Bash"] }
}
JSON

# 1) Start a real (headless) Neovim listening on a socket.
nvim --headless --listen "$SOCKET" -n -i NONE >/dev/null 2>&1 &
NVIM_PID=$!
for _ in $(seq 1 100); do [ -S "$SOCKET" ] && break; sleep 0.1; done
[ -S "$SOCKET" ] || { echo "Neovim socket never appeared" >&2; exit 1; }

# 2) Run the agent with $NVIM pointing at that Neovim (as a :terminal would).
PROMPT='Use the nvim MCP server. Open a terminal inside this Neovim session and run the shell command "echo hello world", then read the terminal output back and report exactly what it printed.'

OUTPUT="$(
  cd "$WORKDIR" && NVIM="$SOCKET" \
    claude -p "$PROMPT" \
      --output-format text \
      --allowedTools "mcp__nvim__nvim_run_in_terminal" "mcp__nvim__nvim_open_terminal" "mcp__nvim__nvim_terminal_read" \
    2>/dev/null
)"

echo "--- agent reply ---"
echo "$OUTPUT"
echo "-------------------"

# 3) Verify the agent actually saw the terminal output from inside Neovim.
if ! echo "$OUTPUT" | grep -qi "hello world"; then
  echo "FAIL: 'hello world' not found in the agent's reply" >&2
  exit 1
fi
echo "PASS: agent ran the command in an in-editor terminal and read 'hello world' back"

# 4) Enforce-mode check: with Bash denied (settings.local.json above), a *generic*
# request to run a command must still succeed by routing through Neovim — the
# agent has no other way to run shell. We don't name the tool this time.
echo
echo "=== enforce mode: Bash denied, command must route through Neovim ==="
PROMPT2='Run the shell command "echo enforced-marker-42" and tell me exactly what it printed.'
OUTPUT2="$(
  cd "$WORKDIR" && NVIM="$SOCKET" \
    claude -p "$PROMPT2" \
      --output-format text \
      --allowedTools "mcp__nvim__nvim_run_in_terminal" "mcp__nvim__nvim_open_terminal" "mcp__nvim__nvim_terminal_read" \
    2>/dev/null
)"
echo "--- agent reply ---"
echo "$OUTPUT2"
echo "-------------------"

if echo "$OUTPUT2" | grep -qi "enforced-marker-42"; then
  echo "PASS: with Bash denied, the agent ran the command through Neovim"
  exit 0
fi

echo "FAIL: 'enforced-marker-42' not found in the agent's reply" >&2
exit 1
