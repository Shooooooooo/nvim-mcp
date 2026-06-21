/**
 * Test harness for spinning up a real, headless Neovim and exposing its RPC
 * socket — the same socket a child process would see in `$NVIM`.
 *
 * This is the foundation of the testing infrastructure: every integration test
 * runs against a genuine Neovim process (not a mock), so the buffer, window and
 * terminal behaviour we assert on is exactly what an agent would experience.
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HeadlessNvim {
  /** RPC socket address — assign this to `$NVIM` to simulate living inside it. */
  socket: string;
  proc: ChildProcess;
  /** Terminate the Neovim process and clean up its temp dir. */
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a headless Neovim listening on a fresh unix socket.
 *
 * `-u NONE -i NONE -n` keeps it pristine (no user config, no shada, no swap) so
 * tests are deterministic regardless of the host's Neovim setup.
 */
export async function startHeadlessNvim(
  opts: { nvimPath?: string; extraArgs?: string[] } = {},
): Promise<HeadlessNvim> {
  const nvim = opts.nvimPath ?? process.env.NVIM_MCP_TEST_NVIM ?? "nvim";
  const dir = await mkdtemp(join(tmpdir(), "nvim-mcp-test-"));
  const socket = join(dir, "nvim.sock");

  const proc = spawn(
    nvim,
    ["--headless", "--listen", socket, "-n", "-u", "NONE", "-i", "NONE", ...(opts.extraArgs ?? [])],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });

  const exited = new Promise<never>((_, reject) => {
    proc.once("exit", (code) =>
      reject(new Error(`Neovim exited early (code ${code}). stderr:\n${stderr}`)),
    );
    proc.once("error", (err) =>
      reject(new Error(`Failed to spawn '${nvim}': ${err.message}`)),
    );
  });

  // Wait for the socket to appear (Neovim creates it once the RPC server is up).
  const ready = (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(socket)) {
        // Give the listener a beat to start accepting connections.
        await sleep(50);
        return;
      }
      await sleep(25);
    }
    throw new Error(`Neovim socket did not appear at ${socket}`);
  })();

  await Promise.race([ready, exited]);

  const stop = async () => {
    if (!proc.killed) {
      proc.kill("SIGTERM");
      const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      await Promise.race([gone, sleep(2000)]);
      if (!proc.killed) proc.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  return { socket, proc, stop };
}

/** Resolve the Neovim binary used for tests, for skip checks. */
export function testNvimBinary(): string {
  return process.env.NVIM_MCP_TEST_NVIM ?? "nvim";
}
