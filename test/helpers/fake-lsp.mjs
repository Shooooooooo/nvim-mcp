#!/usr/bin/env node
/**
 * A minimal, deterministic LSP server over stdio, used only by the test suite.
 *
 * It implements just enough of the Language Server Protocol to exercise
 * nvim-mcp's nvim_lsp_* tools without depending on a real language server (which
 * would mean network downloads and flaky, version-specific behaviour). Every
 * response is canned but realistic, and edits are observable so tests can assert
 * that apply paths actually changed the buffer.
 */

let pending = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const headerEnd = pending.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = pending.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      pending = pending.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (pending.length < bodyStart + length) return;
    const body = pending.subarray(bodyStart, bodyStart + length).toString("utf8");
    pending = pending.subarray(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch {
      /* ignore malformed frames */
    }
  }
});

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

const range = (sl, sc, el, ec) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        capabilities: {
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          renameProvider: true,
          codeActionProvider: true,
          documentFormattingProvider: true,
        },
        serverInfo: { name: "fake-lsp", version: "0.0.1" },
      });
      return;

    case "shutdown":
      reply(id, null);
      return;
    case "exit":
      process.exit(0);
      return;

    // Notifications we simply accept.
    case "initialized":
    case "textDocument/didOpen":
    case "textDocument/didChange":
    case "textDocument/didClose":
    case "textDocument/didSave":
    case "$/setTrace":
      return;

    case "textDocument/hover":
      reply(id, {
        contents: {
          kind: "markdown",
          value: "**fakeSymbol**\n\nA symbol provided by the fake LSP server.",
        },
      });
      return;

    case "textDocument/definition":
      reply(id, {
        uri: params.textDocument.uri,
        range: range(0, 0, 0, 10),
      });
      return;

    case "textDocument/references":
      reply(id, [
        { uri: params.textDocument.uri, range: range(0, 0, 0, 10) },
        { uri: params.textDocument.uri, range: range(2, 6, 2, 16) },
      ]);
      return;

    case "textDocument/documentSymbol":
      reply(id, [
        {
          name: "fakeSymbol",
          kind: 12, // Function
          range: range(0, 0, 0, 10),
          selectionRange: range(0, 0, 0, 10),
          children: [
            {
              name: "child",
              kind: 13, // Variable
              range: range(1, 2, 1, 7),
              selectionRange: range(1, 2, 1, 7),
            },
          ],
        },
      ]);
      return;

    case "textDocument/rename":
      // Replace columns 0..10 of the first line with the new name.
      reply(id, {
        changes: {
          [params.textDocument.uri]: [{ range: range(0, 0, 0, 10), newText: params.newName }],
        },
      });
      return;

    case "textDocument/codeAction":
      reply(id, [
        {
          title: "Fake quickfix: prepend marker",
          kind: "quickfix",
          edit: {
            changes: {
              [params.textDocument.uri]: [{ range: range(0, 0, 0, 0), newText: "-- fixed\n" }],
            },
          },
        },
      ]);
      return;

    case "textDocument/formatting":
      // Insert a marker at the top of the file so the apply is observable.
      reply(id, [{ range: range(0, 0, 0, 0), newText: "-- formatted\n" }]);
      return;

    default:
      if (id !== undefined) reply(id, null);
  }
}
