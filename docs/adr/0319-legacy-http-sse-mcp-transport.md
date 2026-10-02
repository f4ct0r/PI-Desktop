# ADR 0319: Support the legacy HTTP+SSE MCP transport

- Status: Accepted
- Date: 2026-09-26
- Related: [ADR 0038](0038-plugin-mcp-bridge.md), [ADR 0142](0142-allow-non-loopback-http-mcp.md), [ADR 0203](0203-local-mcp-control-plane.md)

## Context

The MCP client speaks two transports: `stdio`, and streamable HTTP, which
carries each JSON-RPC message in its own request/response exchange. A
meaningful share of deployed MCP servers still expose only the older
HTTP+SSE transport, in which the client opens a long-lived `GET` event stream,
the server's first event names the `POST` endpoint every message must be sent
to, and the JSON-RPC replies arrive on that open stream rather than in the
`POST` response.

Those servers are not reachable today. The import path compounded this: an
entry declaring `"type": "sse"` was folded into `http`, so importing such a
config produced a server the client could not connect to, with no error at
import time.

The two remote transports are not interchangeable. The streamable-HTTP client
`POST`s each message to the configured URL and reads the reply out of the
response body; a legacy server answers `202 Accepted` and delivers the reply
on a stream that must already be open. Reusing the streamable-HTTP client
against such a server hangs until the call budget expires.

## Decision

1. `transport` accepts a third value, `sse`, everywhere it is already
   validated: the Plugin SDK `contributes.mcpServers` contribution, user MCP
   server records, and marketplace catalog entries. This is a widening of an
   existing union and is backward compatible; `stdio` and `http` keep their
   current meaning, fields, and budgets.
2. `sse` takes the same fields as `http` — `url` and `headers` — and obeys the
   same URL policy, including the non-loopback HTTP disclosure from ADR 0142.
   The two differ only in the shape of the connection, not in what may be
   configured.
3. The client opens the `GET` event stream when the transport is created and
   sends every message to the endpoint the server announces. The first `send`
   waits for that endpoint event under the normal connect budget, so a server
   that never announces one fails the handshake rather than hanging.
4. A server may only announce an endpoint on the same origin as the configured
   URL, and the endpoint passes the same per-request endpoint policy
   (`assertUrlAllowed`) as the stream URL itself. The `POST` endpoint does not
   follow redirects. An announced endpoint is the one place a remote server
   could otherwise redirect this session — and the credentials declared in
   `headers` — to a host the user never configured, so it is constrained
   rather than trusted.
5. Losing the stream ends the session: pending calls fail, the discovered tool
   catalog is dropped, and the client reconnects on the next use. A stream that
   ends is the same class of event as a stdio child exiting.
6. A single SSE event is bounded by the same 4 MB frame limit the other
   transports apply, so a server cannot stream an unbounded frame at us.

## Consequences

- Servers that expose only the legacy transport become usable, and importing
  such a config produces a server the client can actually connect to.
- `sse` and `http` share validation, URL policy, and the editor surface, so a
  future remote transport has one place to be added rather than a parallel
  branch through each of them.
- The transport contract (JSON-RPC message shape, the `McpTransport` interface,
  the error shape, and the event-stream parser) now lives in
  `apps/desktop/electron/main/mcp-transport.ts` rather than inside
  `plugin-mcp.ts`, so adding a transport did not push the client module past
  its size budget and the event-stream framing has a single implementation
  shared by the buffered and streaming readers.
- A server that legitimately splits its `POST` endpoint onto another origin is
  not supported. This has not been seen in practice, and honoring it would
  mean sending the session to an unconfigured host.
- An idle SSE session holds one open HTTP response for its lifetime. Sessions
  are still lazy and torn down with their plugin or user server, so this does
  not outlive the surface that opened it.
