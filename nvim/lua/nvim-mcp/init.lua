-- nvim-mcp: a thin Neovim-side companion to the nvim-mcp MCP server.
--
-- The MCP server itself needs no plugin: when you launch an agent (Claude Code)
-- from inside a Neovim `:terminal`, Neovim sets `$NVIM` to its own RPC socket,
-- and the server picks that up automatically. This plugin makes the workflow a
-- single command and, crucially, wires up how the agent's *command execution*
-- surfaces inside the editor:
--
--   * mode    — how strongly shell execution is routed through Neovim:
--               "off"     do nothing,
--               "steer"   tell the agent (via CLAUDE.md) to prefer the editor,
--               "mirror"  let the agent's Bash tool run, but echo each command
--                         and its output into a Neovim log buffer (hooks),
--               "enforce" deny the built-in Bash tool so *all* shell goes
--                         through nvim_run_in_terminal (Cursor-like).
--   * display — where execution shows up: "panel" | "hidden" | "log".
--
-- `:ClaudeCode` generates the matching project configuration (.mcp.json,
-- .claude/settings.local.json and a managed CLAUDE.md block) and opens the agent.

local M = {}

M.config = {
  -- Command (and args) used to launch the agent inside a Neovim terminal.
  agent_cmd = { "claude" },
  -- How to place the agent terminal: "vertical", "horizontal", "tab" or "float".
  split = "vertical",
  -- Width (for vertical) / height (for horizontal) as a fraction of the editor.
  size = 0.4,
  -- Start in insert/terminal mode so you can type at the agent immediately.
  start_insert = true,

  -- Routing strategy: "off" | "steer" | "mirror" | "enforce".
  mode = "steer",
  -- Execution surface passed to the server: "panel" | "hidden" | "log".
  display = "panel",
  -- How the .mcp.json launches the server (the --display flag is appended).
  server_cmd = { "npx", "-y", "nvim-mcp" },
  -- The hook bin used by "mirror"/"enforce" modes. Install globally
  -- (`npm i -g nvim-mcp`) for it to be on PATH, or set this to an npx form.
  hook_cmd = "nvim-mcp-hook",
  -- Whether to write the managed steering block into CLAUDE.md.
  write_claude_md = true,
}

local state = {
  bufnr = nil,
  winid = nil,
  project_configured = false,
}

local MODES = { off = true, steer = true, mirror = true, enforce = true }
local DISPLAYS = { panel = true, hidden = true, log = true }

-- The MCP tools enforce mode allows without prompting, so the agent has a clear
-- path once Bash is denied.
local NVIM_EXEC_TOOLS = {
  "mcp__nvim__nvim_run_in_terminal",
  "mcp__nvim__nvim_open_terminal",
  "mcp__nvim__nvim_terminal_send",
  "mcp__nvim__nvim_terminal_read",
  "mcp__nvim__nvim_list_terminals",
}

local CLAUDE_MD_BEGIN = "<!-- BEGIN nvim-mcp (managed; edits between these markers are overwritten) -->"
local CLAUDE_MD_END = "<!-- END nvim-mcp -->"

-- ---------------------------------------------------------------------------
-- Small file/JSON helpers
-- ---------------------------------------------------------------------------

local function is_array(t)
  if type(t) ~= "table" then return false end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n > 0 and n == #t
end

-- Minimal pretty-printer so generated config is readable and diffs cleanly.
local function encode_json(v, indent)
  indent = indent or ""
  local pad = indent .. "  "
  local tv = type(v)
  if tv == "string" then
    return vim.json.encode(v)
  elseif tv == "number" or tv == "boolean" then
    return tostring(v)
  elseif tv == "nil" then
    return "null"
  elseif tv == "table" then
    if next(v) == nil then
      return "{}"
    elseif is_array(v) then
      local parts = {}
      for _, item in ipairs(v) do
        parts[#parts + 1] = pad .. encode_json(item, pad)
      end
      return "[\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "]"
    else
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = k end
      table.sort(keys)
      local parts = {}
      for _, k in ipairs(keys) do
        parts[#parts + 1] = pad .. vim.json.encode(k) .. ": " .. encode_json(v[k], pad)
      end
      return "{\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "}"
    end
  end
  return "null"
end

local function read_json(path)
  if vim.fn.filereadable(path) ~= 1 then return nil end
  local ok, decoded = pcall(function()
    return vim.json.decode(table.concat(vim.fn.readfile(path), "\n"))
  end)
  if ok and type(decoded) == "table" then return decoded end
  return nil
end

local function write_file(path, contents)
  local dir = vim.fn.fnamemodify(path, ":h")
  if dir ~= "" and vim.fn.isdirectory(dir) ~= 1 then
    vim.fn.mkdir(dir, "p")
  end
  vim.fn.writefile(vim.split(contents, "\n", { plain = true }), path)
end

-- ---------------------------------------------------------------------------
-- Project configuration writers
-- ---------------------------------------------------------------------------

local function write_mcp_json(root)
  local path = root .. "/.mcp.json"
  local data = read_json(path) or {}
  data.mcpServers = data.mcpServers or {}
  local args = {}
  for i = 2, #M.config.server_cmd do
    args[#args + 1] = M.config.server_cmd[i]
  end
  args[#args + 1] = "--display"
  args[#args + 1] = M.config.display
  data.mcpServers.nvim = {
    command = M.config.server_cmd[1],
    args = args,
  }
  write_file(path, encode_json(data) .. "\n")
  return path
end

-- Drop any hook entries we previously installed (commands invoking hook_cmd) so
-- re-running and switching modes stays clean.
local function strip_our_hooks(list)
  if type(list) ~= "table" then return {} end
  local kept = {}
  for _, entry in ipairs(list) do
    local ours = false
    if type(entry) == "table" and type(entry.hooks) == "table" then
      for _, h in ipairs(entry.hooks) do
        if type(h) == "table" and type(h.command) == "string"
          and h.command:find(M.config.hook_cmd, 1, true) then
          ours = true
        end
      end
    end
    if not ours then kept[#kept + 1] = entry end
  end
  return kept
end

local function bash_hook(sub)
  return {
    matcher = "Bash",
    hooks = { { type = "command", command = M.config.hook_cmd .. " " .. sub } },
  }
end

local function ensure(list, value)
  for _, v in ipairs(list) do
    if v == value then return end
  end
  list[#list + 1] = value
end

local function remove(list, value)
  for i = #list, 1, -1 do
    if list[i] == value then table.remove(list, i) end
  end
end

local function write_settings(root, mode)
  local path = root .. "/.claude/settings.local.json"
  local data = read_json(path) or {}

  -- Start from a clean slate for the keys we manage.
  data.permissions = data.permissions or {}
  data.permissions.allow = data.permissions.allow or {}
  data.permissions.deny = data.permissions.deny or {}
  data.hooks = data.hooks or {}
  data.hooks.PreToolUse = strip_our_hooks(data.hooks.PreToolUse)
  data.hooks.PostToolUse = strip_our_hooks(data.hooks.PostToolUse)

  -- "Bash" in deny is treated as managed by this plugin.
  remove(data.permissions.deny, "Bash")
  for _, tool in ipairs(NVIM_EXEC_TOOLS) do
    remove(data.permissions.allow, tool)
  end

  if mode == "enforce" then
    ensure(data.permissions.deny, "Bash")
    for _, tool in ipairs(NVIM_EXEC_TOOLS) do
      ensure(data.permissions.allow, tool)
    end
    data.hooks.PreToolUse[#data.hooks.PreToolUse + 1] = bash_hook("deny-bash")
  elseif mode == "mirror" then
    data.hooks.PreToolUse[#data.hooks.PreToolUse + 1] = bash_hook("mirror-pre")
    data.hooks.PostToolUse[#data.hooks.PostToolUse + 1] = bash_hook("mirror-post")
  end

  -- Tidy empty managed containers so we don't litter the file.
  if #data.permissions.allow == 0 then data.permissions.allow = nil end
  if #data.permissions.deny == 0 then data.permissions.deny = nil end
  if data.permissions.allow == nil and data.permissions.deny == nil then
    data.permissions = nil
  end
  if #data.hooks.PreToolUse == 0 then data.hooks.PreToolUse = nil end
  if #data.hooks.PostToolUse == 0 then data.hooks.PostToolUse = nil end
  if data.hooks.PreToolUse == nil and data.hooks.PostToolUse == nil then
    data.hooks = nil
  end

  if next(data) == nil then
    -- Nothing left to write (e.g. steer mode with no prior settings).
    return nil
  end
  write_file(path, encode_json(data) .. "\n")
  return path
end

local function write_claude_md(root)
  local path = root .. "/CLAUDE.md"
  local block = {
    CLAUDE_MD_BEGIN,
    "## Running commands (nvim-mcp)",
    "",
    "This project runs inside Neovim with the nvim-mcp server attached. Prefer the",
    "`nvim_run_in_terminal` MCP tool over the built-in Bash tool for shell commands,",
    "so they execute inside the user's editor where they can watch them run. Use",
    "`nvim_open_terminal` + `nvim_terminal_send`/`nvim_terminal_read` for interactive",
    "or long-running sessions.",
    CLAUDE_MD_END,
  }

  local lines = {}
  if vim.fn.filereadable(path) == 1 then
    lines = vim.fn.readfile(path)
  end

  -- Replace an existing managed block in place, else append.
  local b, e
  for i, l in ipairs(lines) do
    if l == CLAUDE_MD_BEGIN then b = i end
    if l == CLAUDE_MD_END then e = i; break end
  end
  if b and e and e >= b then
    local out = {}
    for i = 1, b - 1 do out[#out + 1] = lines[i] end
    for _, l in ipairs(block) do out[#out + 1] = l end
    for i = e + 1, #lines do out[#out + 1] = lines[i] end
    lines = out
  else
    if #lines > 0 and lines[#lines] ~= "" then lines[#lines + 1] = "" end
    for _, l in ipairs(block) do lines[#lines + 1] = l end
  end
  vim.fn.writefile(lines, path)
  return path
end

--- Generate the project configuration for the current mode/display.
function M.setup_project()
  local cfg = M.config
  if cfg.mode == "off" then return end
  local root = vim.fn.getcwd()

  local written = { write_mcp_json(root) }
  local settings = write_settings(root, cfg.mode)
  if settings then written[#written + 1] = settings end
  if cfg.write_claude_md then
    written[#written + 1] = write_claude_md(root)
  end

  local rels = {}
  for _, p in ipairs(written) do
    rels[#rels + 1] = vim.fn.fnamemodify(p, ":.")
  end
  vim.notify(
    ("nvim-mcp: configured mode=%s display=%s -> %s"):format(
      cfg.mode, cfg.display, table.concat(rels, ", ")
    ),
    vim.log.levels.INFO
  )
end

-- ---------------------------------------------------------------------------
-- Agent terminal
-- ---------------------------------------------------------------------------

local function is_valid_win(winid)
  return winid ~= nil and vim.api.nvim_win_is_valid(winid)
end

local function is_valid_buf(bufnr)
  return bufnr ~= nil and vim.api.nvim_buf_is_valid(bufnr)
end

local function open_split()
  local cfg = M.config
  if cfg.split == "tab" then
    vim.cmd("tabnew")
  elseif cfg.split == "horizontal" then
    local height = math.max(5, math.floor(vim.o.lines * cfg.size))
    vim.cmd("botright " .. height .. "split")
  elseif cfg.split == "float" then
    local width = math.floor(vim.o.columns * 0.8)
    local height = math.floor(vim.o.lines * 0.8)
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_open_win(buf, true, {
      relative = "editor",
      width = width,
      height = height,
      row = math.floor((vim.o.lines - height) / 2),
      col = math.floor((vim.o.columns - width) / 2),
      border = "rounded",
    })
    return buf
  else -- vertical (default)
    local width = math.max(40, math.floor(vim.o.columns * cfg.size))
    vim.cmd("botright " .. width .. "vsplit")
  end
  return nil
end

--- Open (or focus) the agent terminal.
function M.toggle()
  -- If the agent terminal already exists and is visible, jump to it.
  if is_valid_buf(state.bufnr) then
    if is_valid_win(state.winid) then
      vim.api.nvim_set_current_win(state.winid)
      if M.config.start_insert then
        vim.cmd("startinsert")
      end
      return
    end
    -- Buffer exists but no window: re-show it in a split.
    open_split()
    vim.api.nvim_set_current_buf(state.bufnr)
    state.winid = vim.api.nvim_get_current_win()
    if M.config.start_insert then
      vim.cmd("startinsert")
    end
    return
  end

  M.open()
end

--- Always open a fresh agent terminal.
function M.open()
  local cfg = M.config
  local exe = cfg.agent_cmd[1]
  if vim.fn.executable(exe) ~= 1 then
    vim.notify(
      ("nvim-mcp: '%s' is not executable. Install Claude Code (or set agent_cmd)."):format(exe),
      vim.log.levels.ERROR
    )
    return
  end

  local floating_buf = open_split()
  if floating_buf == nil then
    -- termopen attaches to the current (empty) buffer of the new split window.
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_set_current_buf(buf)
  end

  -- termopen inherits the current process environment, which crucially includes
  -- $NVIM pointing at this very editor — that's how the MCP server finds its way
  -- back here.
  vim.fn.termopen(cfg.agent_cmd)
  state.bufnr = vim.api.nvim_get_current_buf()
  state.winid = vim.api.nvim_get_current_win()
  vim.bo[state.bufnr].buflisted = false
  vim.api.nvim_buf_set_name(state.bufnr, "nvim-mcp://agent")

  if cfg.start_insert then
    vim.cmd("startinsert")
  end
end

--- Configure the plugin and register the user commands.
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})

  if not MODES[M.config.mode] then
    vim.notify("nvim-mcp: invalid mode '" .. tostring(M.config.mode) .. "', using 'steer'", vim.log.levels.WARN)
    M.config.mode = "steer"
  end
  if not DISPLAYS[M.config.display] then
    vim.notify("nvim-mcp: invalid display '" .. tostring(M.config.display) .. "', using 'panel'", vim.log.levels.WARN)
    M.config.display = "panel"
  end

  vim.api.nvim_create_user_command("ClaudeCode", function()
    if not state.project_configured then
      pcall(M.setup_project)
      state.project_configured = true
    end
    M.toggle()
  end, { desc = "Configure the project and open/focus the Claude Code agent (nvim-mcp)" })

  vim.api.nvim_create_user_command("ClaudeCodeNew", function()
    M.open()
  end, { desc = "Open a fresh Claude Code agent terminal (nvim-mcp)" })

  vim.api.nvim_create_user_command("ClaudeCodeMode", function(cmd)
    local mode = vim.trim(cmd.args)
    if not MODES[mode] then
      vim.notify("nvim-mcp: mode must be one of off|steer|mirror|enforce", vim.log.levels.ERROR)
      return
    end
    M.config.mode = mode
    M.setup_project()
  end, {
    nargs = 1,
    complete = function() return { "off", "steer", "mirror", "enforce" } end,
    desc = "Set the nvim-mcp routing mode and regenerate project config",
  })

  vim.api.nvim_create_user_command("ClaudeCodeSetup", function()
    M.setup_project()
    state.project_configured = true
  end, { desc = "(Re)generate nvim-mcp project configuration" })
end

return M
