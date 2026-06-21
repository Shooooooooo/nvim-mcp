/**
 * The `nvim-mcp-hook` bin, which bridges Claude Code's hooks back into Neovim so
 * the agent's built-in Bash tool can be mirrored (or denied) inside the editor.
 *
 * The hooks are invoked exactly as Claude Code invokes them: the bin is spawned
 * with a subcommand argument and the hook payload as JSON on stdin, with `$NVIM`
 * pointing at the editor (inherited from the agent's terminal). We then read the
 * shared log buffer back out of the same Neovim to confirm the mirror landed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NvimController } from "../src/nvim.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const hookEntry = resolve(repoRoot, "src/hook.ts");

let nv: HeadlessNvim;
let ctl: NvimController;

beforeAll(async () => {
  nv = await startHeadlessNvim();
  process.env.NVIM = nv.socket;
  ctl = new NvimController();
  await ctl.connect();
});

afterAll(async () => {
  await ctl?.close();
  await nv?.stop();
  delete process.env.NVIM;
});

/** Run the hook bin with a subcommand and stdin payload; resolve its stdout. */
function runHook(
  sub: string,
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsx, [hookEntry, sub], {
      env: { ...process.env, NVIM: nv.socket, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, code }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function logText(): Promise<string> {
  const lines = (await ctl.execLua(`
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_get_name(b):find('nvim%-mcp://log') then
        return vim.api.nvim_buf_get_lines(b, 0, -1, false)
      end
    end
    return {}
  `)) as string[];
  return lines.join("\n");
}

describe("nvim-mcp-hook", () => {
  it("mirror-pre writes the command into the editor's log buffer", async () => {
    await runHook("mirror-pre", {
      tool_name: "Bash",
      tool_input: { command: "echo mirrored-pre-123" },
    });
    expect(await logText()).toContain("$ echo mirrored-pre-123");
  });

  it("mirror-post writes the command output into the log buffer", async () => {
    await runHook("mirror-post", {
      tool_name: "Bash",
      tool_input: { command: "echo x" },
      tool_response: { stdout: "mirrored-output-456\n", stderr: "" },
    });
    expect(await logText()).toContain("mirrored-output-456");
  });

  it("deny-bash emits a deny decision steering toward nvim_run_in_terminal", async () => {
    const { stdout } = await runHook("deny-bash", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    const decision = JSON.parse(stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(
      "nvim_run_in_terminal",
    );
  });

  it("exits cleanly when no editor is reachable (does not break the agent)", async () => {
    const { code } = await runHook(
      "mirror-pre",
      { tool_input: { command: "echo nope" } },
      { NVIM: "" },
    );
    expect(code).toBe(0);
  });
});
