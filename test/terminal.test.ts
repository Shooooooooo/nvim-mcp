/**
 * The headline scenario from the project brief, exercised end-to-end against a
 * real Neovim:
 *
 *   "within that session ask the agent to start a new terminal in nvim and
 *    execute `echo hello world` before reading it back to verify."
 *
 * Here the controller plays the part of the agent: it opens a terminal inside
 * the (headless) Neovim, runs the command, and reads the output back. This is
 * the capability claudecode.nvim lacks — control over a terminal *inside* the
 * editor, not just the file under the cursor.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NvimController } from "../src/nvim.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

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

describe("terminal control", () => {
  it("runs `echo hello world` in a terminal and reads it back", async () => {
    const result = await ctl.runInTerminal("echo hello world");
    expect(result.output).toContain("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures a non-zero exit code", async () => {
    const result = await ctl.runInTerminal("echo nope; exit 3");
    expect(result.output).toContain("nope");
    expect(result.exitCode).toBe(3);
  });

  it("supports an interactive terminal via send/read", async () => {
    const term = await ctl.openTerminal({ name: "interactive" });
    expect(term.bufnr).toBeGreaterThan(0);
    expect(term.channel).toBeGreaterThan(0);

    await ctl.terminalSend(term.bufnr, "echo interactive-marker-123");

    // Poll until the echoed output is rendered into the terminal buffer.
    let seen = "";
    for (let i = 0; i < 40; i++) {
      const { lines } = await ctl.terminalRead(term.bufnr);
      seen = lines.join("\n");
      if (seen.includes("interactive-marker-123") && seen.match(/interactive-marker-123/g)!.length >= 2) {
        // Wait for the command's *output* line, not just the typed echo.
        break;
      }
      await new Promise((r) => setTimeout(r, 75));
    }
    expect(seen).toContain("interactive-marker-123");

    const terms = await ctl.listTerminals();
    expect(terms.some((t) => t.bufnr === term.bufnr)).toBe(true);
  });
});
