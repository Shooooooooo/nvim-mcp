/**
 * LSP tool tests: the controller drives Neovim's *own* LSP client against a
 * deterministic fake language server (test/helpers/fake-lsp.mjs). This proves
 * the agent can use the editor's language intelligence — hover, definition,
 * references, symbols, rename, code actions, formatting — end to end, offline.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NvimController } from "../src/nvim.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeLsp = join(__dirname, "helpers", "fake-lsp.mjs");

const FILE_CONTENT = ["fakeSymbol = 1", "local y = 2", "print(fakeSymbol)"].join("\n") + "\n";

let nv: HeadlessNvim;
let ctl: NvimController;
let root: string;

/** Write a fresh file, open it, attach the fake LSP, and wait for init. */
async function openWithLsp(filename: string): Promise<number> {
  const path = join(root, filename);
  await writeFile(path, FILE_CONTENT, "utf8");
  const buf = await ctl.openFile(path);

  await ctl.execLua(
    `
    local args = ...
    vim.api.nvim_set_current_buf(args.bufnr)
    vim.lsp.start({ name = 'fake-lsp', cmd = { 'node', args.server }, root_dir = args.root })
  `,
    [{ bufnr: buf.bufnr, server: fakeLsp, root }],
  );

  // Wait for the client to finish initializing on this buffer.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const clients = await ctl.lspClients(buf.bufnr);
    if (clients.some((c) => c.initialized)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return buf.bufnr;
}

beforeAll(async () => {
  nv = await startHeadlessNvim();
  process.env.NVIM = nv.socket;
  ctl = new NvimController();
  await ctl.connect();
  root = await mkdtemp(join(tmpdir(), "nvim-mcp-lsp-"));
});

afterAll(async () => {
  await ctl?.close();
  await nv?.stop();
  delete process.env.NVIM;
});

describe("LSP read operations", () => {
  let bufnr: number;
  beforeAll(async () => {
    bufnr = await openWithLsp("read.lua");
  });

  it("reports the attached client", async () => {
    const clients = await ctl.lspClients(bufnr);
    expect(clients.length).toBeGreaterThanOrEqual(1);
    expect(clients[0].name).toBe("fake-lsp");
    expect(clients[0].initialized).toBe(true);
  });

  it("returns hover documentation", async () => {
    const res = await ctl.lspHover({ bufnr, line: 1, col: 1 });
    expect(res.contents).toContain("fakeSymbol");
  });

  it("resolves definitions", async () => {
    const locs = await ctl.lspDefinition({ bufnr, line: 3, col: 7 });
    expect(locs.length).toBe(1);
    expect(locs[0].line).toBe(1); // 1-based; fake points at line 0
    expect(locs[0].filename).toContain("read.lua");
  });

  it("finds references", async () => {
    const refs = await ctl.lspReferences({ bufnr, line: 1, col: 1 });
    expect(refs.length).toBe(2);
    expect(refs[1].line).toBe(3);
  });

  it("lists document symbols (flattened with depth)", async () => {
    const syms = await ctl.lspDocumentSymbols(bufnr);
    expect(syms.map((s) => s.name)).toEqual(["fakeSymbol", "child"]);
    expect(syms[0].kind).toBe("Function");
    expect(syms[1].depth).toBe(1);
  });

  it("searches workspace symbols across the project", async () => {
    const syms = await ctl.lspWorkspaceSymbols("fake", { bufnr });
    expect(syms.length).toBeGreaterThanOrEqual(1);
    expect(syms[0].name).toBe("fakeSymbol");
    expect(syms[0].kind).toBe("Function");
    expect(syms[0].containerName).toBe("fakeModule");
    expect(syms[0].filename).toContain("read.lua");
    expect(syms[0].line).toBe(1); // 1-based; fake points at line 0
  });
});

describe("LSP mutating operations", () => {
  it("renames a symbol and applies the edit", async () => {
    const bufnr = await openWithLsp("rename.lua");
    const res = await ctl.lspRename({ newName: "renamed", bufnr, line: 1, col: 1, apply: true });
    expect(res.applied).toBe(true);
    expect(res.editCount).toBe(1);

    const read = await ctl.readBuffer({ bufnr }, 0, 1);
    expect(read.lines[0]).toContain("renamed");
  });

  it("previews a rename without applying when apply=false", async () => {
    const bufnr = await openWithLsp("preview.lua");
    const res = await ctl.lspRename({ newName: "willNotApply", bufnr, line: 1, col: 1, apply: false });
    expect(res.applied).toBe(false);
    expect(res.changedFiles.length).toBe(1);

    const read = await ctl.readBuffer({ bufnr }, 0, 1);
    expect(read.lines[0]).toBe("fakeSymbol = 1");
  });

  it("lists and applies a code action", async () => {
    const bufnr = await openWithLsp("action.lua");
    const listed = await ctl.lspCodeAction({ bufnr, line: 1, col: 1 });
    expect(listed.actions.length).toBe(1);
    expect(listed.actions[0].title).toContain("quickfix");
    expect(listed.actions[0].hasEdit).toBe(true);

    const applied = await ctl.lspCodeAction({ bufnr, line: 1, col: 1, applyIndex: 1 });
    expect(applied.applied).toBe(true);
    const read = await ctl.readBuffer({ bufnr }, 0, 1);
    expect(read.lines[0]).toBe("-- fixed");
  });

  it("formats the buffer", async () => {
    const bufnr = await openWithLsp("format.lua");
    const res = await ctl.lspFormat(bufnr);
    expect(res.applied).toBe(true);
    expect(res.editCount).toBe(1);
    const read = await ctl.readBuffer({ bufnr }, 0, 1);
    expect(read.lines[0]).toBe("-- formatted");
  });
});
