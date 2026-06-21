/**
 * Builds the MCP server and registers the Neovim control tools.
 *
 * Each tool is a thin, well-described wrapper over NvimController. The
 * descriptions matter: they are what an agent like Claude Code reads to decide
 * which tool to call, so they spell out the "agent living inside Neovim" model.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NvimController, NvimNotAvailableError } from "./nvim.js";
import { logger } from "./logger.js";

export const SERVER_NAME = "nvim-mcp";
export const SERVER_VERSION = "0.1.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

function errorResult(err: unknown): ToolResult {
  const message =
    err instanceof NvimNotAvailableError
      ? err.message
      : err instanceof Error
        ? `${err.name}: ${err.message}`
        : String(err);
  logger.error("Tool error", message);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap an async handler so failures become structured tool errors. */
function guard<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

const bufTarget = {
  bufnr: z
    .number()
    .int()
    .optional()
    .describe("Target buffer number. Omit to use the path or the current buffer."),
  path: z
    .string()
    .optional()
    .describe("Target buffer by file path (must already be open). Ignored if bufnr is set."),
};

export function buildServer(nvim: NvimController): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "These tools control the live Neovim session this agent is running " +
        "inside (detected via the NVIM environment variable). You can read and " +
        "edit buffers, inspect windows and diagnostics, and — unlike a plain " +
        "file editor integration — open terminals inside Neovim, send them " +
        "input, and read their output.\n\n" +
        "IMPORTANT: prefer nvim_run_in_terminal over your built-in shell/Bash " +
        "tool for running commands. Running commands through Neovim means the " +
        "user watches them execute inside their own editor (the way Cursor's " +
        "agent does), and the command shares the editor's environment and " +
        "working directory. Use nvim_run_in_terminal for one-shot commands and " +
        "nvim_open_terminal + nvim_terminal_send/read for interactive sessions.",
    },
  );

  // --- Session ------------------------------------------------------------

  server.registerTool(
    "nvim_info",
    {
      title: "Neovim session info",
      description:
        "Report the connected Neovim instance: version, channel, working " +
        "directory, current buffer/window and how the connection was resolved. " +
        "Use this first to confirm the agent is wired to a live Neovim.",
      inputSchema: {},
    },
    guard(async () => json(await nvim.info())),
  );

  // --- Generic escape hatches --------------------------------------------

  server.registerTool(
    "nvim_exec_lua",
    {
      title: "Execute Lua",
      description:
        "Run Lua in Neovim via nvim_exec_lua and return the result as JSON. " +
        "The code is a function body, so use `return` to produce a value and " +
        "reference call arguments via `...`. This is the most powerful tool: " +
        "anything the Neovim Lua API can do is reachable here.",
      inputSchema: {
        code: z.string().describe("Lua code to execute. Use `return` to yield a value."),
        args: z
          .array(z.any())
          .optional()
          .describe("Optional arguments, available in the Lua code via `...`."),
      },
    },
    guard(async ({ code, args }) => json(await nvim.execLua(code, args ?? []))),
  );

  server.registerTool(
    "nvim_command",
    {
      title: "Run Ex command",
      description:
        "Execute an Ex command (e.g. `:write`, `:bnext`, `:vsplit foo.txt`) and " +
        "return its captured output.",
      inputSchema: {
        command: z.string().describe("The Ex command, without the leading colon."),
      },
    },
    guard(async ({ command }) => text((await nvim.execCommand(command)) || "(no output)")),
  );

  server.registerTool(
    "nvim_eval",
    {
      title: "Evaluate VimL expression",
      description: "Evaluate a Vimscript expression (e.g. `expand('%:p')`) and return the result.",
      inputSchema: {
        expr: z.string().describe("The Vimscript expression to evaluate."),
      },
    },
    guard(async ({ expr }) => json(await nvim.evalExpr(expr))),
  );

  // --- Buffers ------------------------------------------------------------

  server.registerTool(
    "nvim_list_buffers",
    {
      title: "List buffers",
      description:
        "List all buffers with their number, name, type, modified state and " +
        "line count. Terminal buffers report buftype 'terminal'.",
      inputSchema: {},
    },
    guard(async () => json(await nvim.listBuffers())),
  );

  server.registerTool(
    "nvim_read_buffer",
    {
      title: "Read buffer",
      description:
        "Read lines from a buffer (by number, path, or the current buffer). " +
        "Line range is 0-based and end-exclusive; end = -1 reads to the end.",
      inputSchema: {
        ...bufTarget,
        start: z.number().int().optional().describe("First line (0-based). Default 0."),
        end: z
          .number()
          .int()
          .optional()
          .describe("End line (0-based, exclusive). Default -1 (end of buffer)."),
      },
    },
    guard(async ({ bufnr, path, start, end }) => {
      const res = await nvim.readBuffer({ bufnr, path }, start ?? 0, end ?? -1);
      return text(
        `buffer ${res.bufnr} (${res.name || "[No Name]"}):\n` + res.lines.join("\n"),
      );
    }),
  );

  server.registerTool(
    "nvim_write_buffer",
    {
      title: "Write buffer lines",
      description:
        "Replace a line range in a buffer with new lines. Line range is 0-based " +
        "and end-exclusive; use start = 0, end = -1 to replace the whole buffer.",
      inputSchema: {
        ...bufTarget,
        lines: z.array(z.string()).describe("Replacement lines (no trailing newlines)."),
        start: z.number().int().optional().describe("First line to replace (0-based). Default 0."),
        end: z
          .number()
          .int()
          .optional()
          .describe("End line (0-based, exclusive). Default -1 (replace to end)."),
      },
    },
    guard(async ({ bufnr, path, lines, start, end }) =>
      json(await nvim.setBufferLines({ bufnr, path }, lines, start ?? 0, end ?? -1)),
    ),
  );

  server.registerTool(
    "nvim_open_file",
    {
      title: "Open file",
      description: "Open a file in Neovim, optionally in a split or new tab, and return its buffer info.",
      inputSchema: {
        path: z.string().describe("Path to the file to open."),
        split: z
          .enum(["none", "horizontal", "vertical", "tab"])
          .optional()
          .describe("How to open it. Default 'none' (replace current window)."),
      },
    },
    guard(async ({ path, split }) => json(await nvim.openFile(path, { split }))),
  );

  // --- Windows & diagnostics ---------------------------------------------

  server.registerTool(
    "nvim_list_windows",
    {
      title: "List windows",
      description: "List open windows with their buffer, size and cursor position.",
      inputSchema: {},
    },
    guard(async () => json(await nvim.listWindows())),
  );

  server.registerTool(
    "nvim_diagnostics",
    {
      title: "Get diagnostics",
      description:
        "Return LSP/diagnostic entries (errors, warnings, etc.) for a buffer, or " +
        "for all buffers if none is given. Great for letting the agent see and " +
        "fix problems the way Cursor does.",
      inputSchema: {
        bufnr: z.number().int().optional().describe("Buffer number. Omit for all buffers."),
      },
    },
    guard(async ({ bufnr }) => json(await nvim.diagnostics(bufnr))),
  );

  // --- Terminals ----------------------------------------------------------

  server.registerTool(
    "nvim_run_in_terminal",
    {
      title: "Run command in a terminal",
      description:
        "Open a terminal inside Neovim, run a single shell command, wait for it " +
        "to finish, and return its output and exit code. This is the one-shot " +
        "building block: e.g. run `echo hello world` and read it back. The " +
        "terminal runs inside the user's editor, so the command shares the " +
        "editor's environment and working directory.",
      inputSchema: {
        cmd: z.string().describe("Shell command to run."),
        cwd: z.string().optional().describe("Working directory. Defaults to Neovim's cwd."),
        shell: z.string().optional().describe("Shell to use (default: bash if available)."),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe("Max time to wait for completion in ms. Default 15000."),
        keepOpen: z
          .boolean()
          .optional()
          .describe(
            "Keep the terminal buffer even on success. Failed commands are kept " +
              "automatically so the user can inspect them. Default false.",
          ),
        display: z
          .enum(["panel", "hidden", "log"])
          .optional()
          .describe(
            "Where to surface execution inside Neovim: 'panel' (a terminal in " +
              "the Agent Terminals tabpage), 'hidden' (a terminal with no " +
              "window), or 'log' (streamed into the shared log buffer). Defaults " +
              "to the server's configured display mode.",
          ),
      },
    },
    guard(async ({ cmd, cwd, shell, timeoutMs, keepOpen, display }) => {
      const res = await nvim.runInTerminal(cmd, { cwd, shell, timeoutMs, keepOpen, display });
      const header =
        `exit code: ${res.exitCode ?? "unknown"}` +
        (res.timedOut ? " (timed out)" : "") +
        `\n--- output ---\n`;
      return text(header + res.output);
    }),
  );

  server.registerTool(
    "nvim_open_terminal",
    {
      title: "Open a terminal",
      description:
        "Open a persistent terminal inside Neovim and return its buffer number, " +
        "channel and job id. Use nvim_terminal_send to type into it and " +
        "nvim_terminal_read to read its screen. Use this for interactive or " +
        "long-running sessions; for one-shot commands prefer nvim_run_in_terminal.",
      inputSchema: {
        cmd: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Program to run. Default: the user's shell."),
        cwd: z.string().optional().describe("Working directory."),
        name: z.string().optional().describe("Optional display name for the terminal buffer."),
        display: z
          .enum(["panel", "hidden", "log"])
          .optional()
          .describe(
            "Where to surface the terminal: 'panel' (shown in the Agent " +
              "Terminals tabpage) or 'hidden' (no window; use the returned " +
              "bufnr with nvim_terminal_send/read). Defaults to the server's " +
              "configured display mode.",
          ),
      },
    },
    guard(async ({ cmd, cwd, name, display }) =>
      json(await nvim.openTerminal({ cmd, cwd, name, display })),
    ),
  );

  server.registerTool(
    "nvim_list_terminals",
    {
      title: "List terminals",
      description: "List terminal buffers currently open in Neovim, with their job/channel and running state.",
      inputSchema: {},
    },
    guard(async () => json(await nvim.listTerminals())),
  );

  server.registerTool(
    "nvim_terminal_send",
    {
      title: "Send to terminal",
      description:
        "Send input to an open terminal buffer. By default a carriage return is " +
        "appended so the line is submitted; set enter=false to send raw keys " +
        "(e.g. control characters).",
      inputSchema: {
        bufnr: z.number().int().describe("Terminal buffer number (from nvim_open_terminal/list)."),
        data: z.string().describe("Text to send."),
        enter: z.boolean().optional().describe("Append a carriage return. Default true."),
      },
    },
    guard(async ({ bufnr, data, enter }) => json(await nvim.terminalSend(bufnr, data, enter ?? true))),
  );

  server.registerTool(
    "nvim_terminal_read",
    {
      title: "Read terminal",
      description:
        "Read the rendered contents (scrollback + current screen) of a terminal " +
        "buffer. Trailing blank lines are trimmed by default.",
      inputSchema: {
        bufnr: z.number().int().describe("Terminal buffer number."),
        stripTrailingBlank: z
          .boolean()
          .optional()
          .describe("Trim trailing blank lines. Default true."),
      },
    },
    guard(async ({ bufnr, stripTrailingBlank }) => {
      const res = await nvim.terminalRead(bufnr, { stripTrailingBlank });
      return text(res.lines.join("\n"));
    }),
  );

  // --- LSP (the editor's language intelligence) ---------------------------
  //
  // Positions are 1-based line and 1-based column, the way a human reads them.

  const lspPos = {
    line: z.number().int().optional().describe("1-based line number. Default 1."),
    col: z.number().int().optional().describe("1-based column number. Default 1."),
  };

  server.registerTool(
    "nvim_lsp_clients",
    {
      title: "List LSP clients",
      description:
        "List the language servers attached to a buffer (or the current " +
        "buffer), with their id, name, root directory and whether they have " +
        "finished initializing. Use this to check language intelligence is " +
        "available before calling the other nvim_lsp_* tools.",
      inputSchema: {
        bufnr: z.number().int().optional().describe("Buffer number. Omit for the current buffer."),
      },
    },
    guard(async ({ bufnr }) => json(await nvim.lspClients(bufnr))),
  );

  server.registerTool(
    "nvim_lsp_hover",
    {
      title: "LSP hover",
      description:
        "Get hover documentation (signatures, types, docs) for the symbol at a " +
        "position, as the editor's language server would show it.",
      inputSchema: { ...bufTarget, ...lspPos },
    },
    guard(async ({ bufnr, line, col }) => {
      const res = await nvim.lspHover({ bufnr, line, col });
      return text(res.contents || "(no hover information)");
    }),
  );

  server.registerTool(
    "nvim_lsp_definition",
    {
      title: "LSP go to definition",
      description:
        "Resolve the definition location(s) of the symbol at a position. Returns " +
        "file, line and column (1-based) for each location.",
      inputSchema: { ...bufTarget, ...lspPos },
    },
    guard(async ({ bufnr, line, col }) => json(await nvim.lspDefinition({ bufnr, line, col }))),
  );

  server.registerTool(
    "nvim_lsp_references",
    {
      title: "LSP find references",
      description: "Find all references to the symbol at a position across the project.",
      inputSchema: {
        ...bufTarget,
        ...lspPos,
        includeDeclaration: z
          .boolean()
          .optional()
          .describe("Include the declaration itself. Default true."),
      },
    },
    guard(async ({ bufnr, line, col, includeDeclaration }) =>
      json(await nvim.lspReferences({ bufnr, line, col, includeDeclaration })),
    ),
  );

  server.registerTool(
    "nvim_lsp_document_symbols",
    {
      title: "LSP document symbols",
      description:
        "List the symbols (functions, classes, variables, …) defined in a " +
        "buffer, with their kind and line. Nesting is reported via `depth`.",
      inputSchema: {
        bufnr: z.number().int().optional().describe("Buffer number. Omit for the current buffer."),
      },
    },
    guard(async ({ bufnr }) => json(await nvim.lspDocumentSymbols(bufnr))),
  );

  server.registerTool(
    "nvim_lsp_rename",
    {
      title: "LSP rename symbol",
      description:
        "Rename the symbol at a position project-wide via the language server " +
        "and apply the resulting edits (set apply=false to preview which files " +
        "would change without modifying anything).",
      inputSchema: {
        newName: z.string().describe("The new name for the symbol."),
        ...bufTarget,
        ...lspPos,
        apply: z.boolean().optional().describe("Apply the edits. Default true."),
      },
    },
    guard(async ({ newName, bufnr, line, col, apply }) =>
      json(await nvim.lspRename({ newName, bufnr, line, col, apply })),
    ),
  );

  server.registerTool(
    "nvim_lsp_code_action",
    {
      title: "LSP code actions",
      description:
        "List the code actions (quick fixes, refactors) the language server " +
        "offers at a position, including any diagnostics there. Pass applyIndex " +
        "(1-based, from a previous listing) to apply one of them.",
      inputSchema: {
        ...bufTarget,
        ...lspPos,
        applyIndex: z
          .number()
          .int()
          .optional()
          .describe("1-based index of the action to apply. Omit to only list."),
      },
    },
    guard(async ({ bufnr, line, col, applyIndex }) =>
      json(await nvim.lspCodeAction({ bufnr, line, col, applyIndex })),
    ),
  );

  server.registerTool(
    "nvim_lsp_format",
    {
      title: "LSP format buffer",
      description: "Format a buffer using its language server and apply the changes in place.",
      inputSchema: {
        bufnr: z.number().int().optional().describe("Buffer number. Omit for the current buffer."),
      },
    },
    guard(async ({ bufnr }) => json(await nvim.lspFormat(bufnr))),
  );

  return server;
}
