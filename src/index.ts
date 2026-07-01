#!/usr/bin/env node
/**
 * nvim-mcp entrypoint.
 *
 * Starts an MCP server over stdio that controls the Neovim session the agent is
 * running inside. The target Neovim is discovered from the `NVIM` environment
 * variable (set automatically inside a Neovim `:terminal`); it can be
 * overridden with `--socket <addr>` or the `NVIM_MCP_SOCKET` env var.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NvimController, resolveNvimAddress } from "./nvim.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { logger } from "./logger.js";

function parseArgs(argv: string[]): { socket?: string; help: boolean; version: boolean } {
  let socket: string | undefined;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--socket" || arg === "--address") {
      socket = argv[++i];
    } else if (arg.startsWith("--socket=")) {
      socket = arg.slice("--socket=".length);
    } else if (arg.startsWith("--address=")) {
      socket = arg.slice("--address=".length);
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    }
  }
  return { socket, help, version };
}

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server that gives an agent full control over the Neovim session it lives
inside: buffers, windows, diagnostics and terminals.

Usage:
  nvim-mcp [--socket <addr>]
  nvim-mcp --version
  nvim-mcp --help

The target Neovim is resolved in this order:
  1. --socket / --address <addr>
  2. $NVIM_MCP_SOCKET
  3. $NVIM                (set automatically inside a Neovim :terminal)
  4. $NVIM_LISTEN_ADDRESS (legacy)

<addr> is a unix socket path (or named pipe) or a host:port TCP address.
`;

async function main(): Promise<void> {
  const { socket, help, version } = parseArgs(process.argv.slice(2));
  if (version) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (help) {
    process.stdout.write(HELP);
    return;
  }

  const resolved = resolveNvimAddress(socket);
  if (resolved) {
    logger.info(`Target Neovim: ${resolved.address} (from ${resolved.source})`);
  } else {
    // We still start — tools will return a clear error if invoked — so the
    // server can be registered even when no Neovim is reachable yet.
    logger.warn(
      "No Neovim address found (NVIM not set). Tools will error until a " +
        "target is available. Run inside a Neovim :terminal or pass --socket.",
    );
  }

  const controller = new NvimController(socket);
  const server = buildServer(controller);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    logger.info("Shutting down");
    try {
      await controller.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  logger.info(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  logger.error("Fatal error", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
