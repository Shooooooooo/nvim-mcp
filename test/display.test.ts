/**
 * The three execution "display" surfaces, each verified against a real Neovim:
 *
 *   panel  — a PTY terminal shown in a dedicated "Agent Terminals" tabpage,
 *   hidden — a PTY terminal with no window (surfaced on demand),
 *   log    — a windowless jobstart streamed into one shared log buffer.
 *
 * In every mode the user's own window/tab must be left exactly where it was.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NvimController } from "../src/nvim.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

let nv: HeadlessNvim;

beforeAll(async () => {
  nv = await startHeadlessNvim();
  process.env.NVIM = nv.socket;
});

afterAll(async () => {
  await nv?.stop();
  delete process.env.NVIM;
});

/** A fresh controller sharing the one headless Neovim (close() would quit it). */
function controller(display: "panel" | "hidden" | "log"): NvimController {
  return new NvimController(undefined, { display });
}

describe("execution display modes", () => {
  it("panel: shows a kept terminal in a dedicated tabpage without moving the user", async () => {
    const ctl = controller("panel");
    await ctl.connect();
    const startTab = (await ctl.execLua(`return vim.api.nvim_get_current_tabpage()`)) as number;

    // A failing command is kept (not cleaned up), so it stays visible in the panel.
    const res = await ctl.runInTerminal("echo panel-fail; exit 2");
    expect(res.exitCode).toBe(2);

    const probe = (await ctl.execLua(`
      local panel_tab
      for _, t in ipairs(vim.api.nvim_list_tabpages()) do
        local ok, v = pcall(vim.api.nvim_tabpage_get_var, t, 'nvim_mcp_panel')
        if ok and v then panel_tab = t end
      end
      local has_term = false
      if panel_tab then
        for _, w in ipairs(vim.api.nvim_tabpage_list_wins(panel_tab)) do
          if vim.bo[vim.api.nvim_win_get_buf(w)].buftype == 'terminal' then has_term = true end
        end
      end
      return {
        panel_exists = panel_tab ~= nil,
        panel_has_terminal = has_term,
        current_tab = vim.api.nvim_get_current_tabpage(),
      }
    `)) as { panel_exists: boolean; panel_has_terminal: boolean; current_tab: number };

    expect(probe.panel_exists).toBe(true);
    expect(probe.panel_has_terminal).toBe(true);
    // The user was never pulled into the panel tab.
    expect(probe.current_tab).toBe(startTab);
  });

  it("hidden: keeps a failed terminal as a buffer with no window", async () => {
    const ctl = controller("hidden");
    await ctl.connect();
    const winsBefore = (await ctl.execLua(`return #vim.api.nvim_list_wins()`)) as number;

    const res = await ctl.runInTerminal("echo hidden-fail; exit 5");
    expect(res.exitCode).toBe(5);

    const winsAfter = (await ctl.execLua(`return #vim.api.nvim_list_wins()`)) as number;
    expect(winsAfter).toBe(winsBefore);

    // The terminal buffer we just created exists (kept on failure) but is shown
    // in no window — checked on the specific buffer so other tests' panel
    // terminals (this Neovim is shared) don't interfere.
    const probe = (await ctl.execLua(`
      local b = ...
      local is_term = vim.bo[b].buftype == 'terminal'
      local shown = false
      for _, w in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_get_buf(w) == b then shown = true end
      end
      return { is_term = is_term, shown = shown }
    `, [res.bufnr])) as { is_term: boolean; shown: boolean };
    expect(probe.is_term).toBe(true);
    expect(probe.shown).toBe(false);
  });

  it("log: streams output into the shared log buffer via the job path", async () => {
    const ctl = controller("log");
    await ctl.connect();

    const res = await ctl.runInTerminal("echo log-line-one; echo log-line-two");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("log-line-one");
    expect(res.output).toContain("log-line-two");
    // The job path returns the shared log buffer, not a PTY terminal buffer.
    expect(res.bufnr).toBeGreaterThan(0);

    const lines = (await ctl.execLua(`
      local b = ...
      return vim.api.nvim_buf_get_lines(b, 0, -1, false)
    `, [res.bufnr])) as string[];
    const joined = lines.join("\n");
    expect(joined).toContain("$ echo log-line-one; echo log-line-two");
    expect(joined).toContain("log-line-one");
    expect(joined).toContain("[exit 0]");

    // The log buffer is a normal nofile buffer, not a terminal.
    const buftype = (await ctl.execLua(`return vim.bo[...].buftype`, [res.bufnr])) as string;
    expect(buftype).toBe("nofile");
  });
});
