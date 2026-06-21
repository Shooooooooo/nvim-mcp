#!/usr/bin/env node
/**
 * nvim-mcp-hook — the bridge for Claude Code hooks that route the agent's
 * built-in Bash tool through Neovim.
 *
 * Claude Code invokes hooks with the hook payload as JSON on stdin and the
 * matched event configured in settings. This bin reads that payload and, using
 * the same `$NVIM` socket the agent inherited, surfaces the activity inside the
 * editor. Subcommands:
 *
 *   mirror-pre   (PreToolUse / Bash)  — write `$ <command>` into the log buffer
 *   mirror-post  (PostToolUse / Bash) — write the command's output below it
 *   deny-bash    (PreToolUse / Bash)  — emit a deny decision steering the agent
 *                                       to nvim_run_in_terminal instead
 *
 * Hooks must never break the agent: anything unexpected (no $NVIM, parse error,
 * unreachable editor) exits 0 quietly. Only `deny-bash` writes to stdout — the
 * mirror hooks are side-effect only.
 */

import { NvimController } from "./nvim.js";

type HookPayload = {
  tool_name?: string;
  tool_input?: { command?: string; description?: string } & Record<string, unknown>;
  tool_response?: unknown;
};

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function parsePayload(raw: string): HookPayload {
  try {
    return raw.trim() ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    return {};
  }
}

/** Extract a readable output string from a Bash tool_response (string or object). */
function responseToText(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.stdout === "string" && obj.stdout) parts.push(obj.stdout);
    if (typeof obj.stderr === "string" && obj.stderr) parts.push(obj.stderr);
    if (parts.length > 0) return parts.join("\n");
    try {
      return JSON.stringify(obj);
    } catch {
      return String(response);
    }
  }
  return String(response);
}

function splitLines(text: string): string[] {
  return text.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
}

async function mirror(kind: "pre" | "post", payload: HookPayload): Promise<void> {
  const command = payload.tool_input?.command;
  if (!command && kind === "pre") return;

  const controller = new NvimController();
  if (!controller.hasAddress()) return; // no $NVIM — nothing to mirror to

  try {
    if (kind === "pre") {
      await controller.appendLog([`$ ${command}`]);
    } else {
      const out = responseToText(payload.tool_response);
      const lines = out ? splitLines(out) : [];
      await controller.appendLog([...lines, ""]);
    }
  } catch {
    // Editor unreachable: don't disturb the agent.
  }
  // Note: we deliberately do NOT call controller.close() — that would quit the
  // user's Neovim. The process exits via process.exit(0) in main(), which tears
  // down the RPC socket without touching the editor.
}

function denyBash(): void {
  // Steer the agent to run shell through Neovim instead of the built-in tool.
  const reason =
    "Bash is disabled in this project. Run shell commands through Neovim with " +
    "the nvim_run_in_terminal MCP tool so they execute inside the user's editor.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main(): Promise<void> {
  const sub = process.argv[2];

  if (sub === "deny-bash") {
    // No need to read stdin to make the decision, but drain it to be safe.
    await readStdin();
    denyBash();
    return;
  }

  const payload = parsePayload(await readStdin());
  if (sub === "mirror-pre") {
    await mirror("pre", payload);
  } else if (sub === "mirror-post") {
    await mirror("post", payload);
  }
  // Unknown subcommand: no-op, exit 0.
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
