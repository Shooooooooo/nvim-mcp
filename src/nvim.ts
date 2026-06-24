/**
 * NvimController — the bridge between the MCP server and a live Neovim session.
 *
 * When a process is launched from inside Neovim (a `:terminal`, `jobstart()`,
 * `system()` call, etc.) Neovim exports the address of its own msgpack-RPC
 * socket in the `NVIM` environment variable. Any client that connects to that
 * socket can drive the *parent* editor: read and write buffers, move windows,
 * inspect diagnostics and — crucially — open terminals and read their output.
 *
 * That last capability is what sets this apart from plugins like
 * claudecode.nvim: the agent isn't limited to the file under the cursor, it can
 * spawn a terminal inside the user's editor, run a command, and read the result
 * back, exactly the way a human would.
 */

import * as net from "node:net";
import { attach, NeovimClient } from "neovim";
import { logger } from "./logger.js";

export interface NvimAddress {
  /** Raw address string (unix socket path or `host:port`). */
  address: string;
  /** Where the address came from, for diagnostics. */
  source: "option" | "NVIM_MCP_SOCKET" | "NVIM" | "NVIM_LISTEN_ADDRESS";
}

export interface BufferInfo {
  bufnr: number;
  name: string;
  buftype: string;
  modified: boolean;
  lineCount: number;
  listed: boolean;
  loaded: boolean;
  current: boolean;
}

export interface WindowInfo {
  winid: number;
  bufnr: number;
  bufname: string;
  width: number;
  height: number;
  cursor: [number, number];
  current: boolean;
}

export interface TerminalInfo {
  bufnr: number;
  name: string;
  channel: number;
  jobId: number;
  running: boolean;
}

export interface OpenTerminalResult {
  bufnr: number;
  channel: number;
  jobId: number;
  name: string;
}

export interface RunInTerminalResult {
  bufnr: number;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface Diagnostic {
  bufnr: number;
  lnum: number;
  col: number;
  severity: string;
  message: string;
  source?: string;
  code?: string | number;
}

export interface NvimInfo {
  connected: boolean;
  address: string;
  addressSource: string;
  channelId: number;
  version: string;
  apiLevel: number;
  cwd: string;
  currentBuffer: number;
  currentBufferName: string;
  currentWindow: number;
  listedBuffers: number;
}

export interface LspClientInfo {
  id: number;
  name: string;
  rootDir?: string;
  initialized: boolean;
  offsetEncoding?: string;
}

export interface LspLocation {
  uri: string;
  filename: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface LspSymbol {
  name: string;
  kind: string;
  detail?: string;
  line?: number;
  depth: number;
}

export interface LspHoverResult {
  contents: string;
}

export interface LspRenameResult {
  applied: boolean;
  changedFiles: Array<{ file: string; edits: number }>;
  editCount: number;
}

export interface LspCodeActionItem {
  index: number;
  title: string;
  kind?: string;
  hasEdit: boolean;
  hasCommand: boolean;
}

export interface LspCodeActionResult {
  actions: LspCodeActionItem[];
  applied: boolean;
  appliedTitle?: string;
}

export interface LspFormatResult {
  applied: boolean;
  editCount: number;
}

const SEVERITY_NAMES: Record<number, string> = {
  1: "ERROR",
  2: "WARN",
  3: "INFO",
  4: "HINT",
};

/** LSP SymbolKind numbers -> human names (see the LSP spec). */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/**
 * Resolve which Neovim instance to talk to.
 *
 * Priority, highest first:
 *   1. an explicit address passed in code/CLI,
 *   2. `NVIM_MCP_SOCKET` (lets you target a specific instance for testing),
 *   3. `NVIM` (set automatically inside a Neovim `:terminal` — the main path),
 *   4. `NVIM_LISTEN_ADDRESS` (legacy name used by older Neovim/Vim).
 */
export function resolveNvimAddress(explicit?: string): NvimAddress | null {
  if (explicit && explicit.trim()) {
    return { address: explicit.trim(), source: "option" };
  }
  const env = process.env;
  if (env.NVIM_MCP_SOCKET?.trim()) {
    return { address: env.NVIM_MCP_SOCKET.trim(), source: "NVIM_MCP_SOCKET" };
  }
  if (env.NVIM?.trim()) {
    return { address: env.NVIM.trim(), source: "NVIM" };
  }
  if (env.NVIM_LISTEN_ADDRESS?.trim()) {
    return {
      address: env.NVIM_LISTEN_ADDRESS.trim(),
      source: "NVIM_LISTEN_ADDRESS",
    };
  }
  return null;
}

function parseTcp(address: string): { host: string; port: number } | null {
  // A TCP address looks like `127.0.0.1:6789`; a unix socket path does not have
  // a trailing `:<number>` and usually contains a path separator.
  const match = /^(.*):(\d+)$/.exec(address);
  if (!match) return null;
  const host = match[1] || "127.0.0.1";
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0) return null;
  // Reject things that are clearly filesystem paths (e.g. `/run/user/nvim.123:0`
  // is not realistic, but a bare socket path won't match the regex anyway).
  return { host, port };
}

export class NvimNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NvimNotAvailableError";
  }
}

export class NvimController {
  private client: NeovimClient | null = null;
  private connecting: Promise<NeovimClient> | null = null;
  private readonly addr: NvimAddress | null;

  constructor(explicitAddress?: string) {
    this.addr = resolveNvimAddress(explicitAddress);
  }

  /** The resolved target address, or null if none could be determined. */
  get addressInfo(): NvimAddress | null {
    return this.addr;
  }

  hasAddress(): boolean {
    return this.addr !== null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Establish (or reuse) a connection to Neovim. Concurrent callers share a
   * single in-flight connection attempt. A failed attempt clears the cache so
   * the next call retries — handy if Neovim was started a moment after us.
   */
  async connect(): Promise<NeovimClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    if (!this.addr) {
      throw new NvimNotAvailableError(
        "No Neovim address found. Set the NVIM environment variable (this is " +
          "done automatically when the agent runs inside a Neovim :terminal), " +
          "or pass NVIM_MCP_SOCKET / --socket explicitly.",
      );
    }

    const address = this.addr.address;
    this.connecting = (async () => {
      logger.info(`Connecting to Neovim at ${address} (via ${this.addr!.source})`);
      let client: NeovimClient;
      const tcp = parseTcp(address);
      if (tcp) {
        const socket = net.connect(tcp.port, tcp.host);
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        client = attach({ reader: socket, writer: socket });
      } else {
        client = attach({ socket: address });
      }

      // Verify the channel is actually live before handing it out.
      const [channelId] = await client.apiInfo;
      logger.info(`Connected to Neovim (channel ${channelId})`);

      client.on("disconnect", () => {
        logger.warn("Neovim connection closed");
        if (this.client === client) this.client = null;
      });

      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (err) {
      this.client = null;
      throw new NvimNotAvailableError(
        `Failed to connect to Neovim at ${address}: ${(err as Error).message}`,
      );
    } finally {
      this.connecting = null;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        client.quit?.();
      } catch {
        /* ignore */
      }
    }
  }

  // --- Generic primitives -------------------------------------------------

  async execLua(code: string, args: unknown[] = []): Promise<unknown> {
    const nvim = await this.connect();
    return nvim.lua(code, args as never[]);
  }

  async execCommand(command: string): Promise<string> {
    const nvim = await this.connect();
    return nvim.commandOutput(command);
  }

  async evalExpr(expr: string): Promise<unknown> {
    const nvim = await this.connect();
    return nvim.eval(expr);
  }

  // --- Session info -------------------------------------------------------

  async info(): Promise<NvimInfo> {
    const nvim = await this.connect();
    const [channelId, apiInfo] = await nvim.apiInfo;
    const data = (await nvim.lua(`
      local v = vim.version()
      local cur = vim.api.nvim_get_current_buf()
      local listed = 0
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.fn.buflisted(b) == 1 then listed = listed + 1 end
      end
      return {
        version = string.format('%d.%d.%d', v.major, v.minor, v.patch),
        cwd = vim.fn.getcwd(),
        current_buffer = cur,
        current_buffer_name = vim.api.nvim_buf_get_name(cur),
        current_window = vim.api.nvim_get_current_win(),
        listed_buffers = listed,
      }
    `)) as {
      version: string;
      cwd: string;
      current_buffer: number;
      current_buffer_name: string;
      current_window: number;
      listed_buffers: number;
    };

    return {
      connected: true,
      address: this.addr!.address,
      addressSource: this.addr!.source,
      channelId,
      version: data.version,
      apiLevel: (apiInfo as { version?: { api_level?: number } }).version?.api_level ?? 0,
      cwd: data.cwd,
      currentBuffer: data.current_buffer,
      currentBufferName: data.current_buffer_name,
      currentWindow: data.current_window,
      listedBuffers: data.listed_buffers,
    };
  }

  // --- Buffers ------------------------------------------------------------

  async listBuffers(): Promise<BufferInfo[]> {
    return (await this.execLua(`
      local cur = vim.api.nvim_get_current_buf()
      local out = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        local loaded = vim.api.nvim_buf_is_loaded(b)
        out[#out + 1] = {
          bufnr = b,
          name = vim.api.nvim_buf_get_name(b),
          buftype = vim.bo[b].buftype,
          modified = vim.bo[b].modified,
          line_count = loaded and vim.api.nvim_buf_line_count(b) or 0,
          listed = vim.fn.buflisted(b) == 1,
          loaded = loaded,
          current = b == cur,
        }
      end
      return out
    `)) as BufferInfo[];
  }

  /**
   * Read lines from a buffer identified either by number or by file path.
   * `start`/`end` are 0-based, end-exclusive; end < 0 counts from the end.
   */
  async readBuffer(
    target: { bufnr?: number; path?: string },
    start = 0,
    end = -1,
  ): Promise<{ bufnr: number; name: string; lines: string[] }> {
    return (await this.execLua(
      `
      local args = ...
      local buf
      if args.bufnr ~= nil and args.bufnr >= 0 then
        buf = args.bufnr
      elseif args.path ~= nil and args.path ~= '' then
        buf = vim.fn.bufnr(args.path)
        if buf == -1 then error('no buffer for path: ' .. args.path) end
      else
        buf = vim.api.nvim_get_current_buf()
      end
      if not vim.api.nvim_buf_is_loaded(buf) then vim.fn.bufload(buf) end
      local lines = vim.api.nvim_buf_get_lines(buf, args.start, args['end'], false)
      return { bufnr = buf, name = vim.api.nvim_buf_get_name(buf), lines = lines }
    `,
      [{ bufnr: target.bufnr ?? -1, path: target.path ?? "", start, end }],
    )) as { bufnr: number; name: string; lines: string[] };
  }

  /** Replace a line range in a buffer. start/end 0-based, end-exclusive. */
  async setBufferLines(
    target: { bufnr?: number; path?: string },
    lines: string[],
    start = 0,
    end = -1,
  ): Promise<{ bufnr: number; lineCount: number }> {
    return (await this.execLua(
      `
      local args = ...
      local buf
      if args.bufnr ~= nil and args.bufnr >= 0 then
        buf = args.bufnr
      elseif args.path ~= nil and args.path ~= '' then
        buf = vim.fn.bufnr(args.path)
        if buf == -1 then error('no buffer for path: ' .. args.path) end
      else
        buf = vim.api.nvim_get_current_buf()
      end
      if not vim.api.nvim_buf_is_loaded(buf) then vim.fn.bufload(buf) end
      vim.api.nvim_buf_set_lines(buf, args.start, args['end'], false, args.lines)
      return { bufnr = buf, line_count = vim.api.nvim_buf_line_count(buf) }
    `,
      [{ bufnr: target.bufnr ?? -1, path: target.path ?? "", lines, start, end }],
    )) as { bufnr: number; lineCount: number };
  }

  async openFile(
    path: string,
    opts: { split?: "none" | "horizontal" | "vertical" | "tab" } = {},
  ): Promise<BufferInfo> {
    const splitCmd =
      opts.split === "horizontal"
        ? "split"
        : opts.split === "vertical"
          ? "vsplit"
          : opts.split === "tab"
            ? "tabedit"
            : "edit";
    return (await this.execLua(
      `
      local args = ...
      vim.cmd(args.cmd .. ' ' .. vim.fn.fnameescape(args.path))
      local b = vim.api.nvim_get_current_buf()
      return {
        bufnr = b,
        name = vim.api.nvim_buf_get_name(b),
        buftype = vim.bo[b].buftype,
        modified = vim.bo[b].modified,
        line_count = vim.api.nvim_buf_line_count(b),
        listed = vim.fn.buflisted(b) == 1,
        loaded = true,
        current = true,
      }
    `,
      [{ cmd: splitCmd, path }],
    )) as BufferInfo;
  }

  // --- Windows ------------------------------------------------------------

  async listWindows(): Promise<WindowInfo[]> {
    return (await this.execLua(`
      local cur = vim.api.nvim_get_current_win()
      local out = {}
      for _, w in ipairs(vim.api.nvim_list_wins()) do
        local b = vim.api.nvim_win_get_buf(w)
        out[#out + 1] = {
          winid = w,
          bufnr = b,
          bufname = vim.api.nvim_buf_get_name(b),
          width = vim.api.nvim_win_get_width(w),
          height = vim.api.nvim_win_get_height(w),
          cursor = vim.api.nvim_win_get_cursor(w),
          current = w == cur,
        }
      end
      return out
    `)) as WindowInfo[];
  }

  // --- Diagnostics --------------------------------------------------------

  async diagnostics(bufnr?: number): Promise<Diagnostic[]> {
    const raw = (await this.execLua(
      `
      local args = ...
      local target = (args.bufnr ~= nil and args.bufnr >= 0) and args.bufnr or nil
      local items = vim.diagnostic.get(target)
      local out = {}
      for _, d in ipairs(items) do
        out[#out + 1] = {
          bufnr = d.bufnr,
          lnum = d.lnum,
          col = d.col,
          severity = d.severity,
          message = d.message,
          source = d.source,
          code = d.code,
        }
      end
      return out
    `,
      [{ bufnr: bufnr ?? -1 }],
    )) as Array<Omit<Diagnostic, "severity"> & { severity: number }>;
    return raw.map((d) => ({
      ...d,
      severity: SEVERITY_NAMES[d.severity] ?? String(d.severity),
    }));
  }

  // --- Terminals (the differentiating capability) -------------------------

  /**
   * Open a terminal inside the user's Neovim. By default it appears in a
   * horizontal split so the user can watch, but focus stays on the original
   * window so the agent doesn't steal the user's place.
   */
  async openTerminal(opts: {
    cmd?: string | string[];
    cwd?: string;
    name?: string;
    split?: "horizontal" | "vertical" | "tab" | "none";
    focus?: boolean;
  } = {}): Promise<OpenTerminalResult> {
    const split = opts.split ?? "horizontal";
    const splitCmd =
      split === "vertical"
        ? "vnew"
        : split === "tab"
          ? "tabnew"
          : split === "none"
            ? "enew"
            : "new";
    const shell = await this.defaultShell();
    const cmd = opts.cmd ?? shell;
    return (await this.execLua(
      `
      local args = ...
      local prev_win = vim.api.nvim_get_current_win()
      vim.cmd(args.split_cmd)
      local win = vim.api.nvim_get_current_win()
      local buf = vim.api.nvim_get_current_buf()
      -- termopen's options must be a dictionary. An empty Lua table would be
      -- encoded as a list and rejected, so start from vim.empty_dict().
      local term_opts = vim.empty_dict()
      if args.cwd ~= '' then term_opts.cwd = args.cwd end
      -- Record the real exit code from the job's exit event, keyed by buffer.
      -- The visual "[Process exited N]" marker is not reliably written into the
      -- buffer on all Neovim builds (notably the headless Neovim used in CI), so
      -- runInTerminal polls this table rather than scraping that marker.
      term_opts.on_exit = function(_, code)
        _G.__nvim_mcp_term_exits = _G.__nvim_mcp_term_exits or {}
        _G.__nvim_mcp_term_exits[buf] = code
      end
      local job = vim.fn.termopen(args.cmd, term_opts)
      if args.name ~= '' then
        pcall(vim.api.nvim_buf_set_name, buf, 'term://' .. args.name)
      end
      local channel = vim.bo[buf].channel
      if not args.focus and vim.api.nvim_win_is_valid(prev_win) then
        vim.api.nvim_set_current_win(prev_win)
      end
      return {
        bufnr = buf,
        channel = channel,
        job_id = job,
        name = vim.api.nvim_buf_get_name(buf),
      }
    `,
      [
        {
          split_cmd: splitCmd,
          cmd,
          cwd: opts.cwd ?? "",
          name: opts.name ?? "",
          focus: opts.focus ?? false,
        },
      ],
    ).then((r) => {
      const res = r as { bufnr: number; channel: number; job_id: number; name: string };
      return { bufnr: res.bufnr, channel: res.channel, jobId: res.job_id, name: res.name };
    }));
  }

  async listTerminals(): Promise<TerminalInfo[]> {
    return (await this.execLua(`
      local out = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.bo[b].buftype == 'terminal' then
          local chan = vim.bo[b].channel
          local job = vim.b[b].terminal_job_id or chan
          local running = true
          local ok, status = pcall(vim.fn.jobwait, { job }, 0)
          if ok and status[1] ~= -1 then running = false end
          out[#out + 1] = {
            bufnr = b,
            name = vim.api.nvim_buf_get_name(b),
            channel = chan,
            job_id = job,
            running = running,
          }
        end
      end
      return out
    `).then((r) =>
      (r as Array<{ bufnr: number; name: string; channel: number; job_id: number; running: boolean }>).map(
        (t) => ({
          bufnr: t.bufnr,
          name: t.name,
          channel: t.channel,
          jobId: t.job_id,
          running: t.running,
        }),
      ),
    ));
  }

  /** Send raw input to a terminal. With `enter`, a newline is appended. */
  async terminalSend(
    bufnr: number,
    data: string,
    enter = true,
  ): Promise<{ bufnr: number; bytes: number }> {
    return (await this.execLua(
      `
      local args = ...
      local chan = vim.bo[args.bufnr].channel
      if chan == 0 then error('buffer ' .. args.bufnr .. ' is not a terminal') end
      local payload = args.data
      if args.enter then payload = payload .. '\\r' end
      vim.fn.chansend(chan, payload)
      return { bufnr = args.bufnr, bytes = #payload }
    `,
      [{ bufnr, data, enter }],
    )) as { bufnr: number; bytes: number };
  }

  /** Read the rendered contents of a terminal buffer (trailing blanks trimmed). */
  async terminalRead(
    bufnr: number,
    opts: { stripTrailingBlank?: boolean } = {},
  ): Promise<{ bufnr: number; lines: string[] }> {
    const strip = opts.stripTrailingBlank ?? true;
    return (await this.execLua(
      `
      local args = ...
      if vim.bo[args.bufnr].buftype ~= 'terminal' then
        error('buffer ' .. args.bufnr .. ' is not a terminal')
      end
      local lines = vim.api.nvim_buf_get_lines(args.bufnr, 0, -1, false)
      if args.strip then
        while #lines > 0 and lines[#lines] == '' do table.remove(lines) end
      end
      return { bufnr = args.bufnr, lines = lines }
    `,
      [{ bufnr, strip }],
    )) as { bufnr: number; lines: string[] };
  }

  /**
   * Convenience: open a terminal, run a single command, wait for it to finish,
   * and return its output. This is the building block behind "run echo hello
   * world and read it back". Completion is detected from the job's exit event
   * (captured in openTerminal's on_exit handler); if it never fires within
   * `timeoutMs` we return what we have with `timedOut: true`.
   */
  async runInTerminal(
    cmd: string,
    opts: {
      cwd?: string;
      shell?: string;
      timeoutMs?: number;
      keepOpen?: boolean;
      split?: "horizontal" | "vertical" | "tab" | "none";
    } = {},
  ): Promise<RunInTerminalResult> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const shell = opts.shell ?? (await this.defaultShell());
    const opened = await this.openTerminal({
      cmd: [shell, "-c", cmd],
      cwd: opts.cwd,
      split: opts.split ?? "horizontal",
      focus: false,
    });

    const deadline = Date.now() + timeoutMs;
    let exitCode: number | null = null;
    let timedOut = false;
    const exitRe = /\[Process exited (-?\d+)\]/;

    // Poll the exit code captured by openTerminal's on_exit handler (keyed by
    // buffer in `_G.__nvim_mcp_term_exits`). We do not scrape the visual
    // "[Process exited N]" marker: headless Neovim does not reliably render it
    // into the buffer, so a marker-based poll would spin until timeout. Polling
    // is non-blocking for the user's editor, unlike jobwait.
    while (true) {
      const status = (await this.execLua(
        `
        local b = ...
        local exits = _G.__nvim_mcp_term_exits or {}
        local code = exits[b]
        return { done = code ~= nil, exit_code = code }
        `,
        [opened.bufnr],
      )) as { done: boolean; exit_code: number | null };
      if (status.done) {
        exitCode = status.exit_code;
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await sleep(75);
    }

    const { lines } = await this.terminalRead(opened.bufnr, {
      stripTrailingBlank: true,
    });
    // Drop the trailing "[Process exited N]" marker line from user-facing output.
    const cleaned = [...lines];
    while (cleaned.length > 0 && exitRe.test(cleaned[cleaned.length - 1])) {
      cleaned.pop();
    }
    while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "") {
      cleaned.pop();
    }

    if (!opts.keepOpen) {
      await this.execLua(
        `local b = ...
         if _G.__nvim_mcp_term_exits then _G.__nvim_mcp_term_exits[b] = nil end
         pcall(vim.api.nvim_buf_delete, b, { force = true })`,
        [opened.bufnr],
      );
    }

    return {
      bufnr: opened.bufnr,
      output: cleaned.join("\n"),
      exitCode,
      timedOut,
    };
  }

  // --- LSP (the editor's own language intelligence) -----------------------
  //
  // These wrap vim.lsp.buf_request_sync so the agent can use the language
  // servers the editor already has running — go-to-definition, references,
  // hover, rename, code actions, formatting — instead of re-deriving semantics
  // from raw text. Positions are 1-based line and 1-based column (as a human
  // counts them); they are converted to LSP's 0-based coordinates internally.

  /** Convert a 1-based line / 1-based column to an LSP 0-based position. */
  private lspPosition(line?: number, col?: number): { line: number; character: number } {
    return {
      line: Math.max(0, (line ?? 1) - 1),
      character: Math.max(0, (col ?? 1) - 1),
    };
  }

  /** List the LSP clients attached to a buffer (or the current buffer). */
  async lspClients(bufnr?: number): Promise<LspClientInfo[]> {
    return (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local get = vim.lsp.get_clients or vim.lsp.get_active_clients
      local out = {}
      for _, c in ipairs(get({ bufnr = bufnr })) do
        out[#out + 1] = {
          id = c.id,
          name = c.name,
          root_dir = (c.config and c.config.root_dir) or c.root_dir,
          initialized = c.server_capabilities ~= nil,
          offset_encoding = c.offset_encoding,
        }
      end
      return out
    `,
      [{ bufnr: bufnr ?? -1 }],
    ).then((r) =>
      (r as Array<{ id: number; name: string; root_dir?: string; initialized: boolean; offset_encoding?: string }>).map(
        (c) => ({
          id: c.id,
          name: c.name,
          rootDir: c.root_dir,
          initialized: c.initialized,
          offsetEncoding: c.offset_encoding,
        }),
      ),
    ));
  }

  async lspHover(opts: { bufnr?: number; line?: number; col?: number } = {}): Promise<LspHoverResult> {
    const pos = this.lspPosition(opts.line, opts.col);
    return (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local params = {
        textDocument = { uri = vim.uri_from_bufnr(bufnr) },
        position = { line = args.line, character = args.character },
      }
      local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/hover', params, args.timeout)
      local result
      for _, r in pairs(responses or {}) do
        if r.error then error(vim.inspect(r.error)) end
        if r.result then result = r.result; break end
      end
      if not result or not result.contents then return { contents = '' } end
      local lines = vim.lsp.util.convert_input_to_markdown_lines(result.contents)
      while #lines > 0 and lines[#lines] == '' do table.remove(lines) end
      return { contents = table.concat(lines, '\\n') }
    `,
      [{ bufnr: opts.bufnr ?? -1, line: pos.line, character: pos.character, timeout: 2000 }],
    )) as LspHoverResult;
  }

  async lspDefinition(opts: { bufnr?: number; line?: number; col?: number } = {}): Promise<LspLocation[]> {
    return this.lspLocations("textDocument/definition", opts);
  }

  async lspReferences(
    opts: { bufnr?: number; line?: number; col?: number; includeDeclaration?: boolean } = {},
  ): Promise<LspLocation[]> {
    return this.lspLocations("textDocument/references", opts, {
      context: { includeDeclaration: opts.includeDeclaration ?? true },
    });
  }

  /** Shared implementation for the location-returning requests. */
  private async lspLocations(
    method: string,
    opts: { bufnr?: number; line?: number; col?: number },
    extraParams: Record<string, unknown> = {},
  ): Promise<LspLocation[]> {
    const pos = this.lspPosition(opts.line, opts.col);
    return (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local params = vim.tbl_extend('force', {
        textDocument = { uri = vim.uri_from_bufnr(bufnr) },
        position = { line = args.line, character = args.character },
      }, args.extra or {})

      local function to_item(loc)
        local uri = loc.uri or loc.targetUri
        local range = loc.range or loc.targetSelectionRange or loc.targetRange
        return {
          uri = uri,
          filename = vim.uri_to_fname(uri),
          line = range.start.line + 1,
          col = range.start.character + 1,
          end_line = range['end'].line + 1,
          end_col = range['end'].character + 1,
        }
      end

      local out = {}
      local responses = vim.lsp.buf_request_sync(bufnr, args.method, params, args.timeout)
      for _, r in pairs(responses or {}) do
        if r.error then error(vim.inspect(r.error)) end
        local res = r.result
        if res then
          if res.uri or res.targetUri then
            out[#out + 1] = to_item(res)
          else
            for _, loc in ipairs(res) do out[#out + 1] = to_item(loc) end
          end
        end
      end
      return out
    `,
      [
        {
          bufnr: opts.bufnr ?? -1,
          line: pos.line,
          character: pos.character,
          method,
          extra: extraParams,
          timeout: 2000,
        },
      ],
    ).then((r) =>
      (r as Array<{ uri: string; filename: string; line: number; col: number; end_line: number; end_col: number }>).map(
        (l) => ({
          uri: l.uri,
          filename: l.filename,
          line: l.line,
          col: l.col,
          endLine: l.end_line,
          endCol: l.end_col,
        }),
      ),
    ));
  }

  async lspDocumentSymbols(bufnr?: number): Promise<LspSymbol[]> {
    const raw = (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local params = { textDocument = { uri = vim.uri_from_bufnr(bufnr) } }
      local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/documentSymbol', params, args.timeout)

      local out = {}
      local function flatten(syms, depth)
        for _, s in ipairs(syms) do
          local range = s.range or (s.location and s.location.range)
          out[#out + 1] = {
            name = s.name,
            kind = s.kind,
            detail = s.detail,
            line = range and (range.start.line + 1) or nil,
            depth = depth,
          }
          if s.children then flatten(s.children, depth + 1) end
        end
      end
      for _, r in pairs(responses or {}) do
        if r.error then error(vim.inspect(r.error)) end
        if r.result then flatten(r.result, 0) end
      end
      return out
    `,
      [{ bufnr: bufnr ?? -1, timeout: 2000 }],
    )) as Array<{ name: string; kind: number; detail?: string; line?: number; depth: number }>;
    return raw.map((s) => ({
      name: s.name,
      kind: SYMBOL_KIND_NAMES[s.kind] ?? String(s.kind),
      detail: s.detail,
      line: s.line,
      depth: s.depth,
    }));
  }

  async lspRename(opts: {
    newName: string;
    bufnr?: number;
    line?: number;
    col?: number;
    apply?: boolean;
  }): Promise<LspRenameResult> {
    const pos = this.lspPosition(opts.line, opts.col);
    return (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local params = {
        textDocument = { uri = vim.uri_from_bufnr(bufnr) },
        position = { line = args.line, character = args.character },
        newName = args.new_name,
      }
      local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/rename', params, args.timeout)
      local edit
      for _, r in pairs(responses or {}) do
        if r.error then error(vim.inspect(r.error)) end
        if r.result then edit = r.result; break end
      end
      if not edit then return { applied = false, changed_files = {}, edit_count = 0 } end

      local files, count = {}, 0
      if edit.changes then
        for uri, edits in pairs(edit.changes) do
          files[#files + 1] = { file = vim.uri_to_fname(uri), edits = #edits }
          count = count + #edits
        end
      end
      if edit.documentChanges then
        for _, dc in ipairs(edit.documentChanges) do
          if dc.textDocument then
            local n = dc.edits and #dc.edits or 0
            files[#files + 1] = { file = vim.uri_to_fname(dc.textDocument.uri), edits = n }
            count = count + n
          end
        end
      end

      local applied = false
      if args.apply then
        local enc = 'utf-16'
        local get = vim.lsp.get_clients or vim.lsp.get_active_clients
        local cs = get({ bufnr = bufnr })
        if cs[1] then enc = cs[1].offset_encoding or enc end
        vim.lsp.util.apply_workspace_edit(edit, enc)
        applied = true
      end
      return { applied = applied, changed_files = files, edit_count = count }
    `,
      [
        {
          bufnr: opts.bufnr ?? -1,
          line: pos.line,
          character: pos.character,
          new_name: opts.newName,
          apply: opts.apply ?? true,
          timeout: 2000,
        },
      ],
    ).then((r) => {
      const res = r as { applied: boolean; changed_files: Array<{ file: string; edits: number }>; edit_count: number };
      return { applied: res.applied, changedFiles: res.changed_files, editCount: res.edit_count };
    }));
  }

  async lspCodeAction(opts: {
    bufnr?: number;
    line?: number;
    col?: number;
    applyIndex?: number;
  } = {}): Promise<LspCodeActionResult> {
    const pos = this.lspPosition(opts.line, opts.col);
    return (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local pos = { line = args.line, character = args.character }
      local diags = vim.diagnostic.get(bufnr, { lnum = args.line })
      local lsp_diags = {}
      for _, d in ipairs(diags) do
        if d.user_data and d.user_data.lsp then lsp_diags[#lsp_diags + 1] = d.user_data.lsp end
      end
      local params = {
        textDocument = { uri = vim.uri_from_bufnr(bufnr) },
        range = { start = pos, ['end'] = pos },
        context = { diagnostics = lsp_diags },
      }
      local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/codeAction', params, args.timeout)

      local actions = {}
      for _, r in pairs(responses or {}) do
        if r.error then error(vim.inspect(r.error)) end
        for _, a in ipairs(r.result or {}) do actions[#actions + 1] = a end
      end

      local listed, applied, applied_title = {}, false, nil
      for i, a in ipairs(actions) do
        listed[#listed + 1] = {
          index = i,
          title = a.title,
          kind = a.kind,
          has_edit = a.edit ~= nil,
          has_command = a.command ~= nil,
        }
      end

      if args.apply_index and actions[args.apply_index] then
        local a = actions[args.apply_index]
        local enc = 'utf-16'
        local get = vim.lsp.get_clients or vim.lsp.get_active_clients
        local cs = get({ bufnr = bufnr })
        if cs[1] then enc = cs[1].offset_encoding or enc end
        if a.edit then vim.lsp.util.apply_workspace_edit(a.edit, enc) end
        if a.command then
          local cmd = a.command
          if type(cmd) == 'table' and cmd.command then
            vim.lsp.buf_request_sync(bufnr, 'workspace/executeCommand',
              { command = cmd.command, arguments = cmd.arguments }, args.timeout)
          end
        end
        applied = true
        applied_title = a.title
      end

      return { actions = listed, applied = applied, applied_title = applied_title }
    `,
      [
        {
          bufnr: opts.bufnr ?? -1,
          line: pos.line,
          character: pos.character,
          apply_index: opts.applyIndex ?? 0,
          timeout: 2000,
        },
      ],
    ).then((r) => {
      const res = r as {
        actions: Array<{ index: number; title: string; kind?: string; has_edit: boolean; has_command: boolean }>;
        applied: boolean;
        applied_title?: string;
      };
      return {
        actions: res.actions.map((a) => ({
          index: a.index,
          title: a.title,
          kind: a.kind,
          hasEdit: a.has_edit,
          hasCommand: a.has_command,
        })),
        applied: res.applied,
        appliedTitle: res.applied_title,
      };
    }));
  }

  async lspFormat(bufnr?: number): Promise<LspFormatResult> {
    return (await this.execLua(
      `
      local args = ...
      local bufnr = (args.bufnr and args.bufnr >= 0) and args.bufnr or vim.api.nvim_get_current_buf()
      local params = {
        textDocument = { uri = vim.uri_from_bufnr(bufnr) },
        options = {
          tabSize = (vim.bo[bufnr].shiftwidth > 0) and vim.bo[bufnr].shiftwidth or 4,
          insertSpaces = vim.bo[bufnr].expandtab,
        },
      }
      local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/formatting', params, args.timeout)
      local edits, enc = nil, 'utf-16'
      local get = vim.lsp.get_clients or vim.lsp.get_active_clients
      local cs = get({ bufnr = bufnr })
      if cs[1] then enc = cs[1].offset_encoding or enc end
      for _, r in pairs(responses or {}) do
        if r.error then error(vim.inspect(r.error)) end
        if r.result then edits = r.result; break end
      end
      edits = edits or {}
      vim.lsp.util.apply_text_edits(edits, bufnr, enc)
      return { applied = true, edit_count = #edits }
    `,
      [{ bufnr: bufnr ?? -1, timeout: 2000 }],
    ).then((r) => {
      const res = r as { applied: boolean; edit_count: number };
      return { applied: res.applied, editCount: res.edit_count };
    }));
  }

  // --- Internal helpers ---------------------------------------------------

  private async defaultShell(): Promise<string> {
    // Prefer bash when available for predictable `-c` behaviour, else &shell.
    return (await this.execLua(`
      if vim.fn.executable('bash') == 1 then return 'bash' end
      return vim.o.shell
    `)) as string;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
