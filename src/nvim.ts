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

const SEVERITY_NAMES: Record<number, string> = {
  1: "ERROR",
  2: "WARN",
  3: "INFO",
  4: "HINT",
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
   * world and read it back". Completion is detected from the
   * `[Process exited N]` line Neovim appends when the job ends; if that never
   * appears within `timeoutMs` we return what we have with `timedOut: true`.
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

    // Poll the buffer (non-blocking for Neovim) until the process-exit marker
    // shows up. Polling avoids blocking the user's editor the way jobwait would.
    while (true) {
      const { lines } = await this.terminalRead(opened.bufnr, {
        stripTrailingBlank: true,
      });
      const joined = lines.join("\n");
      const m = exitRe.exec(joined);
      if (m) {
        exitCode = Number(m[1]);
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
        `local b = ...; pcall(vim.api.nvim_buf_delete, b, { force = true })`,
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
