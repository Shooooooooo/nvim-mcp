/**
 * Minimal logger that writes to stderr.
 *
 * This server speaks the MCP protocol over stdio, which means stdout is
 * reserved exclusively for JSON-RPC frames. Anything we want to surface for
 * debugging therefore has to go to stderr, where the host (e.g. Claude Code)
 * will collect it without corrupting the protocol stream.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configured = (process.env.NVIM_MCP_LOG_LEVEL as Level) || "info";
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level: Level, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  let line = `[nvim-mcp] ${ts} ${level.toUpperCase()} ${message}`;
  if (extra !== undefined) {
    try {
      line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
    } catch {
      line += " " + String(extra);
    }
  }
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (message: string, extra?: unknown) => emit("debug", message, extra),
  info: (message: string, extra?: unknown) => emit("info", message, extra),
  warn: (message: string, extra?: unknown) => emit("warn", message, extra),
  error: (message: string, extra?: unknown) => emit("error", message, extra),
};
