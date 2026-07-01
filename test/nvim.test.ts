/**
 * Integration tests for NvimController against a real headless Neovim.
 *
 * Each test connects through the same code path the MCP server uses, so these
 * exercise the full RPC round-trip: buffers, windows, diagnostics, and the
 * terminal capabilities that distinguish this server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("saving buffers", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nvim-mcp-save-"));
    // Let :edit abandon an unwritten buffer so opening files never hits E37.
    await ctl.execCommand("set hidden");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("writes buffer edits to disk", async () => {
    const file = join(dir, "note.txt");
    await writeFile(file, "old\n", "utf8");
    const buf = await ctl.openFile(file);

    await ctl.setBufferLines({ bufnr: buf.bufnr }, ["new one", "new two"], 0, -1);
    const res = await ctl.saveBuffer({ bufnr: buf.bufnr });

    expect(res.saved).toHaveLength(1);
    expect(res.saved[0].bufnr).toBe(buf.bufnr);
    expect(res.saved[0].modified).toBe(false);
    expect(await readFile(file, "utf8")).toBe("new one\nnew two\n");
  });

  it("saves a buffer under a new path with saveAs", async () => {
    await ctl.execCommand("enew");
    const cur = (await ctl.listBuffers()).find((b) => b.current)!;
    await ctl.setBufferLines({ bufnr: cur.bufnr }, ["saved as content"], 0, -1);

    const target = join(dir, "saved-as.txt");
    const res = await ctl.saveBuffer({ bufnr: cur.bufnr }, { saveAs: target });

    expect(res.saved[0].name).toContain("saved-as.txt");
    expect(res.saved[0].modified).toBe(false);
    expect(await readFile(target, "utf8")).toBe("saved as content\n");
  });

  it("writes every modified file buffer with all=true", async () => {
    const a = join(dir, "all-a.txt");
    const b = join(dir, "all-b.txt");
    await writeFile(a, "a0\n", "utf8");
    await writeFile(b, "b0\n", "utf8");
    const bufA = await ctl.openFile(a);
    const bufB = await ctl.openFile(b);
    await ctl.setBufferLines({ bufnr: bufA.bufnr }, ["a1"], 0, -1);
    await ctl.setBufferLines({ bufnr: bufB.bufnr }, ["b1"], 0, -1);

    const res = await ctl.saveBuffer({}, { all: true });
    const savedNames = res.saved.map((s) => s.name);
    expect(savedNames.some((n) => n.includes("all-a.txt"))).toBe(true);
    expect(savedNames.some((n) => n.includes("all-b.txt"))).toBe(true);
    expect(res.saved.every((s) => s.modified === false)).toBe(true);
    expect(await readFile(a, "utf8")).toBe("a1\n");
    expect(await readFile(b, "utf8")).toBe("b1\n");
  });

  it("errors when saving an unnamed buffer without saveAs", async () => {
    await ctl.execCommand("enew");
    const cur = (await ctl.listBuffers()).find((b) => b.current)!;
    await expect(ctl.saveBuffer({ bufnr: cur.bufnr })).rejects.toThrow(/no file name/);
  });
});
