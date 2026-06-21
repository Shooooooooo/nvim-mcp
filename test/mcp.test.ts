/**
 * Full end-to-end test of the MCP server itself.
 *
 * This is the closest runnable analogue to the brief's scenario: an MCP client
 * (standing in for Claude Code) launches the nvim-mcp server as a subprocess
 * with `NVIM` pointing at a live Neovim, lists its tools, then calls
 * `nvim_run_in_terminal` to execute `echo hello world` and reads it back to
 * verify. It validates the entire path the agent uses: MCP stdio JSON-RPC ->
 * server -> NvimController -> Neovim RPC -> terminal -> output.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startHeadlessNvim, HeadlessNvim } from "./helpers/nvim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const entry = resolve(repoRoot, "src/index.ts");

let nv: HeadlessNvim;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  nv = await startHeadlessNvim();

  // Launch the server exactly as a host would, but with NVIM set to our test
  // instance — this is the env var a real Neovim sets for its child processes.
  transport = new StdioClientTransport({
    command: tsx,
    args: [entry],
    env: { ...process.env, NVIM: nv.socket } as Record<string, string>,
    stderr: "inherit",
  });

  client = new Client({ name: "nvim-mcp-test-client", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await nv?.stop();
});

describe("MCP server", () => {
  it("advertises the Neovim control tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("nvim_info");
    expect(names).toContain("nvim_run_in_terminal");
    expect(names).toContain("nvim_open_terminal");
    expect(names).toContain("nvim_terminal_read");
    expect(names).toContain("nvim_read_buffer");
  });

  it("reports the connected Neovim via nvim_info", async () => {
    const res = (await client.callTool({ name: "nvim_info", arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    const info = JSON.parse(res.content[0].text);
    expect(info.connected).toBe(true);
    expect(info.addressSource).toBe("NVIM");
  });

  it("runs `echo hello world` in a Neovim terminal and reads it back", async () => {
    const res = (await client.callTool({
      name: "nvim_run_in_terminal",
      arguments: { cmd: "echo hello world" },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("hello world");
    expect(text).toContain("exit code: 0");
  });

  it("edits a buffer through MCP tools", async () => {
    await client.callTool({ name: "nvim_command", arguments: { command: "enew" } });
    const write = (await client.callTool({
      name: "nvim_write_buffer",
      arguments: { lines: ["one", "two", "three"], start: 0, end: -1 },
    })) as { isError?: boolean };
    expect(write.isError).toBeFalsy();

    const read = (await client.callTool({
      name: "nvim_read_buffer",
      arguments: {},
    })) as { content: Array<{ type: string; text: string }> };
    const text = read.content[0].text;
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
  });
});
