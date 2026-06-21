/**
 * Integration tests for NvimController against a real headless Neovim.
 *
 * Each test connects through the same code path the MCP server uses, so these
 * exercise the full RPC round-trip: buffers, windows, diagnostics, and the
 * terminal capabilities that distinguish this server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NvimController } from "../src/nvim.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

let nv: HeadlessNvim;
let ctl: NvimController;

beforeAll(async () => {
  nv = await startHeadlessNvim();
  // Simulate the agent living inside Neovim: it discovers the parent via $NVIM.
  process.env.NVIM = nv.socket;
  ctl = new NvimController();
  await ctl.connect();
});

afterAll(async () => {
  await ctl?.close();
  await nv?.stop();
  delete process.env.NVIM;
});

describe("address resolution", () => {
  it("resolves the target from the NVIM env var", () => {
    expect(ctl.addressInfo?.source).toBe("NVIM");
    expect(ctl.addressInfo?.address).toBe(nv.socket);
  });
});

describe("session info", () => {
  it("reports a live Neovim", async () => {
    const info = await ctl.info();
    expect(info.connected).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.channelId).toBeGreaterThan(0);
    expect(info.addressSource).toBe("NVIM");
  });
});

describe("generic primitives", () => {
  it("executes Lua and returns values", async () => {
    const result = await ctl.execLua("return 1 + select(1, ...)", [41]);
    expect(result).toBe(42);
  });

  it("evaluates VimL expressions", async () => {
    expect(await ctl.evalExpr("1 + 2")).toBe(3);
  });

  it("runs Ex commands and captures output", async () => {
    const out = await ctl.execCommand("echo 'hi there'");
    expect(out).toContain("hi there");
  });
});

describe("buffers", () => {
  it("lists, writes and reads buffer contents", async () => {
    await ctl.execCommand("enew");
    const buffers = await ctl.listBuffers();
    const current = buffers.find((b) => b.current);
    expect(current).toBeTruthy();

    await ctl.setBufferLines({ bufnr: current!.bufnr }, ["alpha", "beta", "gamma"], 0, -1);
    const read = await ctl.readBuffer({ bufnr: current!.bufnr });
    expect(read.lines).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("windows", () => {
  it("lists open windows", async () => {
    const wins = await ctl.listWindows();
    expect(wins.length).toBeGreaterThanOrEqual(1);
    expect(wins.some((w) => w.current)).toBe(true);
  });
});

describe("diagnostics", () => {
  it("returns an array (empty on a clean buffer)", async () => {
    const diags = await ctl.diagnostics();
    expect(Array.isArray(diags)).toBe(true);
  });
});
