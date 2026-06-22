/**
 * The Neovim-side runtime for nvim-mcp.
 *
 * This Lua is installed once per connection (see NvimController.ensureRuntime)
 * and exposes a single global table, `_G.__nvim_mcp`, that owns the state the
 * per-call inline Lua can't keep between requests:
 *
 *   - a shared "log" buffer for `mirror`/`log` display modes,
 *   - a dedicated "Agent Terminals" tabpage (the `panel`),
 *   - a registry of the terminals/jobs the agent has started.
 *
 * Crucially, terminal creation here is *windowless*: termopen runs inside
 * `nvim_buf_call`, so it never splits a window or steals the user's focus. That
 * is what makes parallel `runInTerminal` calls safe — the agent can fire many
 * commands at once without disturbing where the human is typing.
 *
 * The table is built idempotently (`_G.__nvim_mcp or {}`) so re-installing on a
 * reconnect preserves any existing handles.
 */
export const RUNTIME_LUA = String.raw`
local R = _G.__nvim_mcp or {}
_G.__nvim_mcp = R

R.terminals = R.terminals or {} -- bufnr -> { cmd, started_at, job, done, exit_code }
R.jobs = R.jobs or {}           -- id -> { cmd, lines, pending, exit_code, done, job_id }
R.job_seq = R.job_seq or 0
-- R.log_buf and R.panel_tab persist across calls when valid.

-- Shared, append-only log buffer used by 'log' display mode and the mirror hook.
function R.ensure_log_buf()
  if R.log_buf and vim.api.nvim_buf_is_valid(R.log_buf) then
    return R.log_buf
  end
  local buf = vim.api.nvim_create_buf(true, true) -- listed + scratch
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'nvim-mcp-log'
  pcall(vim.api.nvim_buf_set_name, buf, 'nvim-mcp://log')
  R.log_buf = buf
  return buf
end

-- Append lines to the log buffer and keep any window showing it scrolled to the
-- bottom (so the user watches output stream in).
function R.append_log(lines)
  local buf = R.ensure_log_buf()
  local cur = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  if #cur == 1 and cur[1] == '' then
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  else
    vim.api.nvim_buf_set_lines(buf, -1, -1, false, lines)
  end
  local last = vim.api.nvim_buf_line_count(buf)
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == buf then
      pcall(vim.api.nvim_win_set_cursor, win, { last, 0 })
    end
  end
  return buf
end

-- Ensure the dedicated "Agent Terminals" tabpage exists, WITHOUT moving the user
-- to it. Returns the tabpage handle.
function R.ensure_panel()
  if R.panel_tab and vim.api.nvim_tabpage_is_valid(R.panel_tab) then
    return R.panel_tab
  end
  local prev_tab = vim.api.nvim_get_current_tabpage()
  local prev_win = vim.api.nvim_get_current_win()
  vim.cmd('tabnew')
  local tab = vim.api.nvim_get_current_tabpage()
  pcall(vim.api.nvim_tabpage_set_var, tab, 'nvim_mcp_panel', true)
  if vim.api.nvim_tabpage_is_valid(prev_tab) then
    pcall(vim.api.nvim_set_current_tabpage, prev_tab)
  end
  if vim.api.nvim_win_is_valid(prev_win) then
    pcall(vim.api.nvim_set_current_win, prev_win)
  end
  R.panel_tab = tab
  return tab
end

-- Show a buffer in the panel tab (reusing the empty placeholder window the first
-- time, splitting thereafter), then restore the user's focus.
function R.show_in_panel(buf)
  local tab = R.ensure_panel()
  local prev_tab = vim.api.nvim_get_current_tabpage()
  local prev_win = vim.api.nvim_get_current_win()
  local target
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
    local b = vim.api.nvim_win_get_buf(w)
    if not R.terminals[b] and vim.api.nvim_buf_get_name(b) == '' and vim.bo[b].buftype == '' then
      target = w
      break
    end
  end
  vim.api.nvim_set_current_tabpage(tab)
  if target and vim.api.nvim_win_is_valid(target) then
    vim.api.nvim_set_current_win(target)
  else
    vim.cmd('vsplit')
  end
  vim.api.nvim_set_current_buf(buf)
  if vim.api.nvim_tabpage_is_valid(prev_tab) then
    pcall(vim.api.nvim_set_current_tabpage, prev_tab)
  end
  if vim.api.nvim_win_is_valid(prev_win) then
    pcall(vim.api.nvim_set_current_win, prev_win)
  end
end

-- Create a terminal WITHOUT touching the user's windows. termopen runs inside
-- nvim_buf_call, which makes the fresh buffer temporarily current in a scratch
-- context only — no split, no focus change, safe under parallel calls.
-- opts: { cwd, name, cmd_str, show = 'panel'|'none', listed }
function R.open_term(cmd, opts)
  opts = opts or {}
  local buf = vim.api.nvim_create_buf(true, false)
  -- Register the terminal up front so the on_exit callback (which can fire
  -- before termopen even returns for a very fast command) always has a record
  -- to write its exit code into.
  local rec = { cmd = opts.cmd_str or '', started_at = os.time(), job = nil, done = false, exit_code = nil }
  R.terminals[buf] = rec
  local term_opts = vim.empty_dict()
  if opts.cwd and opts.cwd ~= '' then term_opts.cwd = opts.cwd end
  -- Capture completion from the job's own exit event rather than the visual
  -- "[Process exited N]" marker: a windowless terminal is never redrawn, so on
  -- some Neovim builds that marker is never written into the buffer lines and a
  -- poll that waits for it would spin until timeout.
  term_opts.on_exit = function(_, code)
    rec.exit_code = code
    rec.done = true
  end
  local job
  vim.api.nvim_buf_call(buf, function()
    job = vim.fn.termopen(cmd, term_opts)
  end)
  rec.job = job
  if opts.name and opts.name ~= '' then
    pcall(vim.api.nvim_buf_set_name, buf, 'term://' .. opts.name)
  end
  if opts.listed == false then
    vim.bo[buf].buflisted = false
  end
  if opts.show == 'panel' then
    pcall(R.show_in_panel, buf)
  end
  return {
    bufnr = buf,
    channel = vim.bo[buf].channel,
    job_id = job,
    name = vim.api.nvim_buf_get_name(buf),
  }
end

-- Completion + exit code for a terminal we created, captured from termopen's
-- on_exit (see R.open_term). Polled by runInTerminal instead of scraping the
-- "[Process exited N]" buffer marker, which is unreliable for windowless terms.
function R.term_status(buf)
  local rec = R.terminals[buf]
  if not rec then return { found = false } end
  return { found = true, done = rec.done == true, exit_code = rec.exit_code }
end

-- Forget a terminal we created (used when a one-shot succeeds and is cleaned up).
function R.forget_term(buf)
  R.terminals[buf] = nil
  pcall(vim.api.nvim_buf_delete, buf, { force = true })
end

-- Reconstruct full lines from jobstart's chunked stdout/stderr. data[1] continues
-- the previous partial line; data[#data] becomes the new partial.
local function feed(rec, data)
  local emitted = {}
  for i, chunk in ipairs(data) do
    chunk = (chunk or ''):gsub('\r', '')
    if i == 1 then
      rec.pending = (rec.pending or '') .. chunk
    else
      emitted[#emitted + 1] = rec.pending or ''
      rec.pending = chunk
    end
  end
  if #emitted > 0 then
    for _, l in ipairs(emitted) do rec.lines[#rec.lines + 1] = l end
    R.append_log(emitted)
  end
end

-- Run a command via jobstart (no PTY) and stream its output into the log buffer.
-- Returns an id to poll with R.job_status. opts: { cwd, cmd_str }
function R.run_job(cmd, opts)
  opts = opts or {}
  R.job_seq = R.job_seq + 1
  local id = R.job_seq
  local rec = { cmd = opts.cmd_str or '', lines = {}, pending = '', exit_code = nil, done = false }
  R.jobs[id] = rec
  R.ensure_log_buf()
  R.append_log({ '$ ' .. (opts.cmd_str or table.concat(cmd, ' ')) })
  local function on_output(_, data)
    if data then feed(rec, data) end
  end
  rec.job_id = vim.fn.jobstart(cmd, {
    cwd = (opts.cwd and opts.cwd ~= '' and opts.cwd) or nil,
    on_stdout = on_output,
    on_stderr = on_output,
    on_exit = function(_, code)
      if rec.pending and rec.pending ~= '' then
        rec.lines[#rec.lines + 1] = rec.pending
        R.append_log({ rec.pending })
        rec.pending = ''
      end
      rec.exit_code = code
      rec.done = true
      R.append_log({ '[exit ' .. code .. ']', '' })
    end,
  })
  return id
end

function R.job_status(id)
  local rec = R.jobs[id]
  if not rec then return { found = false } end
  return {
    found = true,
    done = rec.done,
    exit_code = rec.exit_code,
    output = table.concat(rec.lines, '\n'),
    log_buf = R.log_buf,
  }
end

return true
`;
