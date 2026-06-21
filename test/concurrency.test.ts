/**
 * The agent runs commands in parallel, so terminal creation must be
 * concurrency-safe: many `runInTerminal` calls in flight at once must each get
 * the right output, and — crucially — none of them may steal the user's place
 * in the editor.
 *
 * This is what the windowless terminal creation (termopen inside nvim_buf_call,
 * see src/runtime.ts) buys us. Before that, opening a terminal split mutated the
 * current window and raced under parallel calls.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NvimController } from "../src/nvim.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

let nv: HeadlessNvim;
let ctl: NvimController;

beforeAll(async () => {
  nv = await startHeadlessNvim();
  process.env.NVIM = nv.socket;
  ctl = new NvimController(undefined, { display: "hidden" });
  await ctl.connect();
});

afterAll(async () => {
  await ctl?.close();
  await nv?.stop();
  delete process.env.NVIM;
});

async function focus(): Promise<{ win: number; buf: number }> {
  return (await ctl.execLua(
    `return { win = vim.api.nvim_get_current_win(), buf = vim.api.nvim_get_current_buf() }`,
  )) as { win: number; buf: number };
}

describe("concurrent terminal execution", () => {
  it("runs many commands in parallel, each returning its own output", async () => {
    const n = 8;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => ctl.runInTerminal(`echo marker-${i}`)),
    );
    results.forEach((res, i) => {
      expect(res.output).toContain(`marker-${i}`);
      expect(res.exitCode).toBe(0);
      expect(res.timedOut).toBe(false);
    });
  });

  it("does not move the user's window or buffer while running commands", async () => {
    const before = await focus();
    await Promise.all([
      ctl.runInTerminal("echo a"),
      ctl.runInTerminal("echo b"),
      ctl.runInTerminal("echo c"),
    ]);
    const after = await focus();
    expect(after).toEqual(before);
  });

  it("preserves distinct exit codes under parallel load", async () => {
    const [ok, bad] = await Promise.all([
      ctl.runInTerminal("echo fine"),
      ctl.runInTerminal("echo boom; exit 7"),
    ]);
    expect(ok.exitCode).toBe(0);
    expect(bad.exitCode).toBe(7);
    expect(bad.output).toContain("boom");
  });
});
