-- nvim-mcp: a thin Neovim-side companion to the nvim-mcp MCP server.
--
-- The MCP server itself needs no plugin: when you launch an agent (Claude Code)
-- from inside a Neovim `:terminal`, Neovim sets `$NVIM` to its own RPC socket,
-- and the server picks that up automatically. This plugin just makes the
-- "open the agent in a split" workflow a single command, turning Neovim into a
-- Cursor-like environment.

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
}

local state = {
  bufnr = nil,
  winid = nil,
}

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

  vim.api.nvim_create_user_command("ClaudeCode", function()
    M.toggle()
  end, { desc = "Open/focus the Claude Code agent terminal (nvim-mcp)" })

  vim.api.nvim_create_user_command("ClaudeCodeNew", function()
    M.open()
  end, { desc = "Open a fresh Claude Code agent terminal (nvim-mcp)" })
end

return M
