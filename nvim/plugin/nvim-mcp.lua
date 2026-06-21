-- Auto-registered entrypoint so `:ClaudeCode` works without an explicit
-- require(...).setup() call. Plugin managers that add `nvim/` to the
-- runtimepath will source this file on startup.
--
-- If you prefer to configure options, call:
--   require("nvim-mcp").setup({ split = "vertical", agent_cmd = { "claude" } })
-- from your own config instead; calling setup() again is harmless.

if vim.g.loaded_nvim_mcp then
  return
end
vim.g.loaded_nvim_mcp = true

require("nvim-mcp").setup()
