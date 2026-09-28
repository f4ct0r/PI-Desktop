import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServerClient } from "../electron/main/plugin-mcp.ts";
import { SseEventParser, parseSseMessages } from "../electron/main/mcp-transport.ts";

const rootPath = () => mkdtempSync(join(tmpdir(), "pi-mcp-sse-"));

function collect(chunks) {
  const events = [];
  const parser = new SseEventParser();
  for (const chunk of chunks) parser.push(chunk, (event) => events.push(event));
  parser.flush((event) => events.push(event));
  return events;
}

test("parses an event stream split across arbitrary chunk boundaries", () => {
  const body = 'event: endpoint\ndata: /messages\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
  // Every split point must produce the same two events, because a real stream
  // delivers whatever the network happened to hand us.
  for (let split = 1; split < body.length; split += 1) {
    assert.deepEqual(
      collect([body.slice(0, split), body.slice(split)]),
      [
        { event: "endpoint", data: "/messages" },
        { event: "message", data: '{"jsonrpc":"2.0","id":1,"result":{}}' },
      ],
      `split at ${split}`,
    );
  }
});

test("parses CRLF framing, comments and multi-line data", () => {
  assert.deepEqual(
    collect([": keep-alive\r\nevent: message\r\ndata: {\r\ndata: \"a\":1}\r\n\r\n"]),
    [{ event: "message", data: '{\n"a":1}' }],
  );
});

test("dispatches an event the body ended in the middle of", () => {
  // A stream cut between events leaves the last record unterminated; dropping
  // it would silently lose a JSON-RPC reply.
  assert.deepEqual(collect(['event: message\ndata: {"id":9}']), [
    { event: "message", data: '{"id":9}' },
  ]);
});

test("defaults an unnamed event to `message` and ignores a lone CR", () => {
  assert.deepEqual(collect(["data: {\"id\":1}\r\r"]), [{ event: "message", data: '{"id":1}' }]);
});

test("refuses an event larger than the frame bound", () => {
  const parser = new SseEventParser();
  assert.throws(
    () => parser.push(`data: ${"x".repeat(4 * 1024 * 1024)}`, () => {}),
    { code: "LIMIT_EXCEEDED" },
  );
});

test("parseSseMessages still reads a whole buffered event-stream body", () => {
  assert.deepEqual(
    parseSseMessages(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n',
    ),
    [
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ],
  );
  // An `endpoint` frame is a connection instruction, not a JSON-RPC message.
  assert.deepEqual(parseSseMessages("event: endpoint\ndata: /messages\n\n"), []);
});

/**
 * A legacy HTTP+SSE MCP server: the client GETs an open event stream, the
 * server names its POST endpoint, and every JSON-RPC reply is written back
 * onto that same stream.
 */
async function startSseServer(t, options = {}) {
  const posted = [];
  const streams = new Set();
  const seen = [];
  let refuse = options.refuse;
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      streams.add(res);
      req.on("close", () => streams.delete(res));
      if (options.headersProbe) seen.push(req.headers);
      res.write(`event: endpoint\ndata: ${options.endpoint ?? "/messages"}\n\n`);
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      posted.push({ path: req.url, headers: req.headers, message });
      if (refuse) {
        res.writeHead(refuse.status).end();
        return;
      }
      // A notification has no JSON-RPC reply; everything else is acknowledged
      // here and answered on the open stream.
      res.writeHead(202, { "content-type": "text/plain" }).end("Accepted");
      if (message.id === undefined) return;
      const reply =
        message.method === "initialize"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: message.params.protocolVersion, capabilities: {} },
            }
          : message.method === "tools/list"
            ? { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo" }] } }
            : {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `${message.params?.arguments?.text}|${req.headers["x-api-key"]}`,
                    },
                  ],
                },
              };
      for (const stream of streams) {
        stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const stream of streams) stream.end();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/sse`,
    posted,
    seen,
    /** Close the open event stream, as a server restart or proxy timeout would. */
    dropStream: () => {
      for (const stream of streams) stream.end();
      streams.clear();
    },
  };
}

test("completes a full handshake and tool call over legacy SSE", async (t) => {
  const server = await startSseServer(t);
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: server.url },
    values: { "x-api-key": "sk-test" },
  });
  t.after(() => client.close());

  const tools = await client.connect();
  assert.equal(client.transportKind, "sse");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["echo"],
  );
  assert.equal(client.isConnected(), true);

  // Messages go to the endpoint the stream announced, not to the SSE url.
  assert.ok(server.posted.length > 0);
  for (const entry of server.posted) {
    assert.equal(entry.path, "/messages");
    assert.equal(entry.headers.accept.includes("text/event-stream"), true);
    assert.equal(entry.headers["x-api-key"], "sk-test");
  }

  const result = await client.callTool("echo", { text: "hello sse" });
  assert.equal(result.content[0].text, "hello sse|sk-test");
});

test("opens the event stream with GET and the event-stream accept header", async (t) => {
  const server = await startSseServer(t, { headersProbe: true });
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: server.url },
    values: {},
  });
  t.after(() => client.close());
  await client.connect();
  assert.equal(server.seen.length, 1);
  assert.equal(server.seen[0].accept, "text/event-stream");
});

test("a relative endpoint event resolves against the stream url", async (t) => {
  const server = await startSseServer(t, { endpoint: "/messages" });
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: server.url },
    values: {},
  });
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual([...new Set(server.posted.map((entry) => entry.path))], ["/messages"]);
});

/**
 * An event stream that stays open until the test closes it.
 *
 * A real SSE stream never ends on its own, and the client holds a pending read
 * on it for the life of the session. A test that forgets to close one leaves
 * that read dangling and the whole run ends early, so every stream-backed test
 * registers the close.
 */
function openEventStream() {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  };
}

test("refuses an endpoint event pointing at another origin", async (t) => {
  const events = openEventStream();
  t.after(() => events.close());
  const fetchImpl = async (url, options) => {
    if (options?.method === "GET") {
      events.push("event: endpoint\ndata: https://elsewhere.example/messages\n\n");
      return new Response(events.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected ${url} ${options?.method}`);
  };
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: "https://mcp.example.com/sse" },
    values: { authorization: "Bearer secret" },
    fetchImpl,
    connectTimeoutMs: 500,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.match(error.message, /another origin/);
    return true;
  });
  assert.equal(client.isConnected(), false);
});

test("applies the url policy to the announced endpoint", async (t) => {
  const events = openEventStream();
  t.after(() => events.close());
  let posts = 0;
  const fetchImpl = async (_url, options) => {
    if (options?.method === "GET") {
      events.push("event: endpoint\ndata: /messages\n\n");
      return new Response(events.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    posts += 1;
    return new Response(null, { status: 202 });
  };
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: "https://mcp.example.com/sse" },
    values: {},
    fetchImpl,
    assertUrlAllowed: (url) => {
      if (url.includes("/messages")) throw new Error("mcp endpoint is not allowed");
    },
    connectTimeoutMs: 500,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.match(error.message, /not allowed/);
    return true;
  });
  assert.equal(posts, 0, "a refused endpoint must never receive a message");
});

test("fails the handshake when the server never announces an endpoint", async (t) => {
  const events = openEventStream();
  t.after(() => events.close());
  const fetchImpl = async (_url, options) => {
    if (options?.method === "GET") {
      return new Response(events.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(null, { status: 202 });
  };
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: "https://mcp.example.com/sse" },
    values: {},
    fetchImpl,
    connectTimeoutMs: 150,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, "TIMEOUT");
    return true;
  });
  assert.equal(client.isConnected(), false);
});

test("fails the handshake when the endpoint does not return an event stream", async (t) => {
  const fetchImpl = async () =>
    new Response("<html>not sse</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: "https://mcp.example.com/sse" },
    values: {},
    fetchImpl,
    connectTimeoutMs: 500,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.match(error.message, /did not return an event stream/);
    return true;
  });
});

test("a stream that closes mid-session drops the session instead of hanging", async (t) => {
  const server = await startSseServer(t);
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: server.url },
    values: {},
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await client.connect();
  assert.equal(client.isConnected(), true);

  // The open stream is the session; losing it has to be observable at once,
  // otherwise every later call would sit on a connection that is gone.
  server.dropStream();
  await assert.rejects(client.callTool("echo", { text: "after drop" }));
  assert.equal(client.isConnected(), false);
  assert.deepEqual(client.getTools(), []);
});

test("a redirecting POST endpoint is refused rather than followed", async (t) => {
  const events = openEventStream();
  t.after(() => events.close());
  const fetchImpl = async (_url, options) => {
    if (options?.method === "GET") {
      events.push("event: endpoint\ndata: /messages\n\n");
      return new Response(events.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/m" } });
  };
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: "https://mcp.example.com/sse" },
    values: {},
    fetchImpl,
    connectTimeoutMs: 500,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, "HTTP_REDIRECT");
    return true;
  });
});

test("aborting one SSE tool call does not tear down the shared stream", async (t) => {
  const server = await startSseServer(t);
  const client = new McpServerClient({
    rootPath: rootPath(),
    server: { id: "legacy", transport: "sse", url: server.url },
    values: { "x-api-key": "sk-test" },
  });
  t.after(() => client.close());
  await client.connect();

  const controller = new AbortController();
  const call = client.callTool("echo", { text: "cancelled" }, controller.signal);
  controller.abort();
  await assert.rejects(call, { code: "TOOL_ABORTED" });

  // The connection is shared, so an aborted call must leave it usable.
  assert.equal(client.isConnected(), true);
  const result = await client.callTool("echo", { text: "still here" });
  assert.equal(result.content[0].text, "still here|sk-test");
});
