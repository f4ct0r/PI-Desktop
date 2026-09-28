import type { PluginMcpServerContrib } from "@pi-desktop/plugin-sdk";
import { APP_NAME, APP_VERSION } from "@pi-desktop/shared";

/** MCP revision we advertise during the handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * The `User-Agent` every MCP request announces.
 *
 * Main-process `fetch` is Electron's `net.fetch`, which is Chromium's network
 * stack and therefore sends a `Mozilla/... Chrome/... Electron/...` agent
 * unless one is set explicitly. Local MCP servers guard against DNS rebinding
 * by refusing anything that looks browser-originated — Burp's MCP server
 * answers such a request `403` before the protocol is ever spoken — and this
 * app is a desktop client, not a page. Naming it honestly is both the truth
 * and what every real MCP client does: the reference SDKs send `node` and
 * `python-httpx/...`, never a `Mozilla` agent.
 */
export const MCP_USER_AGENT = `${APP_NAME}/${APP_VERSION}`;

/**
 * Largest single JSON-RPC frame we accept from a server, across every
 * transport. A server that exceeds it is refused rather than buffered.
 */
export const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/** Transports an MCP server can be reached over. */
export type McpTransportKind = PluginMcpServerContrib["transport"];

/**
 * Every transport is reduced to "send a message, receive messages", which lets
 * the client speak the same JSON-RPC dialect over a pipe, over streamable HTTP,
 * or over the legacy HTTP+SSE split.
 */
export type McpTransport = {
  send: (message: JsonRpcMessage, timeoutMs?: number, signal?: AbortSignal) => Promise<void>;
  close: () => void;
};

export type McpTransportHandlers = {
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (reason: string) => void;
};

export type McpError = Error & { code?: string };

export function mcpError(code: string, message: string): McpError {
  const error = new Error(message) as McpError;
  error.code = code;
  return error;
}

/** One decoded `text/event-stream` event. */
export type SseEvent = { event: string; data: string };

/**
 * Incremental parser for a `text/event-stream` body, following the WHATWG
 * event-stream framing: `\r\n`, `\n` and `\r` all end a line, an empty line
 * dispatches the accumulated event, `:` starts a comment, and the first space
 * after the field colon is not part of the value.
 *
 * Incremental because the legacy SSE transport carries every reply on a stream
 * that stays open for the life of the session, so events must surface as they
 * arrive rather than after the body ends.
 */
export class SseEventParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];

  /**
   * Feed a decoded chunk, emitting every event it completes.
   *
   * @throws when one event grows past {@link MAX_MCP_MESSAGE_BYTES}, so a
   * server cannot stream an unbounded frame at us.
   */
  push(chunk: string, onEvent: (event: SseEvent) => void): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_MCP_MESSAGE_BYTES) {
      this.resetEvent();
      throw mcpError("LIMIT_EXCEEDED", "mcp server sent an oversized event");
    }
    let next = this.nextLineEnd();
    while (next) {
      const line = this.buffer.slice(0, next.end);
      this.buffer = this.buffer.slice(next.resume);
      this.consumeLine(line, onEvent);
      next = this.nextLineEnd();
    }
  }

  /**
   * Dispatch whatever the final chunk left unterminated.
   *
   * A body read to completion may end mid-event; without this the last event
   * would be dropped instead of parsed.
   */
  flush(onEvent: (event: SseEvent) => void): void {
    if (this.buffer) {
      const line = this.buffer;
      this.buffer = "";
      this.consumeLine(line, onEvent);
    }
    this.dispatch(onEvent);
  }

  /**
   * Locate the end of the first buffered line.
   *
   * `resume` is where the next line starts, which is past the whole terminator
   * so that a `\r\n` pair does not present an empty line between two records.
   */
  private nextLineEnd(): { end: number; resume: number } | null {
    for (let i = 0; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (char === "\n") return { end: i, resume: i + 1 };
      if (char === "\r") {
        // A trailing `\r` may still be half of a `\r\n` split across chunks,
        // so it cannot terminate a line until the next chunk proves otherwise.
        if (i + 1 >= this.buffer.length) return null;
        return this.buffer[i + 1] === "\n" ? { end: i, resume: i + 2 } : { end: i, resume: i + 1 };
      }
    }
    return null;
  }

  private consumeLine(line: string, onEvent: (event: SseEvent) => void): void {
    if (line === "") {
      this.dispatch(onEvent);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
  }

  private dispatch(onEvent: (event: SseEvent) => void): void {
    if (!this.dataLines.length) {
      this.resetEvent();
      return;
    }
    const event: SseEvent = { event: this.eventName || "message", data: this.dataLines.join("\n") };
    this.resetEvent();
    onEvent(event);
  }

  /**
   * Clear the accumulated event only.
   *
   * The line buffer is deliberately left alone: `dispatch` runs from inside
   * `push`, which may still hold the unconsumed remainder of the chunk, and
   * dropping it would silently swallow every event after the first.
   */
  private resetEvent(): void {
    this.eventName = "";
    this.dataLines = [];
  }
}

/** Parse a whole event-stream body, for transports that buffer the response. */
export function parseSseMessages(body: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  const onEvent = (event: SseEvent) => {
    if (event.event !== "message") return;
    try {
      out.push(JSON.parse(event.data) as JsonRpcMessage);
    } catch {
      // A partial event is not actionable; the request times out instead.
    }
  };
  const parser = new SseEventParser();
  try {
    parser.push(body, onEvent);
    parser.flush(onEvent);
  } catch {
    // An oversized body yields no messages, which reads like an empty reply.
  }
  return out;
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () =>
      finish(() => reject(mcpError("TOOL_ABORTED", "mcp tool call aborted")));
    const timer = setTimeout(
      () => finish(() => reject(mcpError("TIMEOUT", onTimeout()))),
      Math.max(0, timeoutMs),
    );
    timer.unref?.();
    function finish(run: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      run();
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The legacy HTTP+SSE transport (MCP 2024-11-05), which older servers still
 * expose and which no other transport here can talk to.
 *
 * It is a split connection rather than one request per message: the client
 * opens a long-lived `GET` event stream, the server's first event names the
 * `POST` endpoint every message must be sent to, and the JSON-RPC replies come
 * back over that same open stream rather than in the `POST` response.
 *
 * The stream is opened as soon as the transport is created, and the first
 * `send` waits for the endpoint event — so a server that never announces one
 * fails the handshake instead of hanging until the call budget expires.
 */
export function createSseTransport(
  options: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    assertUrlAllowed?: (url: string) => void;
  },
  handlers: McpTransportHandlers,
): McpTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw mcpError("UNSUPPORTED", "fetch is unavailable for remote mcp servers");
  }
  const baseUrl = new URL(options.url);
  const baseOrigin = baseUrl.origin;
  const streamController = new AbortController();
  const activeControllers = new Set<AbortController>();

  let closed = false;
  let streamEnded = false;
  let postUrl: string | undefined;
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A rejection nobody is awaiting yet would surface as an unhandled rejection
  // during the window between transport creation and the first `send`.
  ready.catch(() => {});

  /**
   * The stream is over. A session that was never established must also fail the
   * `send` waiting on the endpoint event, or the handshake would sit there.
   */
  const endStream = (reason: string) => {
    if (streamEnded) return;
    streamEnded = true;
    closed = true;
    rejectReady(mcpError("UNAVAILABLE", reason));
    handlers.onClose(reason);
  };

  const handleEvent = (event: SseEvent) => {
    if (event.event === "endpoint") {
      // Only the first endpoint event counts; a later one would be a
      // mid-session redirect with no session state to move along with it.
      if (postUrl) return;
      let resolved: URL;
      try {
        resolved = new URL(event.data.trim(), baseUrl);
      } catch {
        endStream("mcp sse server announced an invalid endpoint");
        return;
      }
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        endStream("mcp sse server announced an unsupported endpoint");
        return;
      }
      // A server naming another origin would move this session's messages and
      // its declared credentials to a host the user never configured.
      if (resolved.origin !== baseOrigin) {
        endStream("mcp sse server announced an endpoint on another origin");
        return;
      }
      try {
        options.assertUrlAllowed?.(resolved.toString());
      } catch (error) {
        endStream((error as Error).message);
        return;
      }
      postUrl = resolved.toString();
      resolveReady(postUrl);
      return;
    }
    if (event.event !== "message") return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(event.data) as JsonRpcMessage;
    } catch {
      // A partial or non-JSON frame is not actionable; the request times out.
      return;
    }
    handlers.onMessage(message);
  };

  const openStream = async () => {
    try {
      options.assertUrlAllowed?.(options.url);
      const response = await fetchImpl(options.url, {
        method: "GET",
        headers: {
          ...options.headers,
          accept: "text/event-stream",
          "user-agent": MCP_USER_AGENT,
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        signal: streamController.signal,
      });
      const discard = async () => {
        try {
          await response.body?.cancel();
        } catch {
          // The stream is already unusable; cancellation is best effort.
        }
      };
      if (!response.ok) {
        await discard();
        endStream(`mcp server returned ${response.status}`);
        return;
      }
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        await discard();
        endStream("mcp sse endpoint did not return an event stream");
        return;
      }
      if (!response.body) {
        endStream("mcp sse endpoint returned no stream");
        return;
      }
      const reader = response.body.getReader();
      const parser = new SseEventParser();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        parser.push(decoder.decode(value, { stream: true }), handleEvent);
        if (streamEnded) return;
      }
      parser.push(decoder.decode(), handleEvent);
      parser.flush(handleEvent);
      reader.releaseLock();
      endStream("mcp sse stream closed");
    } catch (error) {
      // A close we asked for is not a failure worth reporting twice.
      if (closed) return;
      endStream((error as Error).message || "mcp sse stream failed");
    }
  };

  void openStream();

  return {
    send: async (message, timeoutMs = options.timeoutMs, signal) => {
      if (closed) throw mcpError("UNAVAILABLE", "mcp sse session is closed");
      const url =
        postUrl ??
        (await withDeadline(ready, timeoutMs, signal, () =>
          "mcp sse server did not announce a message endpoint",
        ));
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      activeControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            ...options.headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "user-agent": MCP_USER_AGENT,
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify(message),
          redirect: "manual",
          signal: controller.signal,
        });
        try {
          await response.body?.cancel();
        } catch {
          // The reply arrives on the open stream, so this body is unused.
        }
        // A redirect would move messages to a host the user never configured.
        if (response.status >= 300 && response.status <= 399) {
          throw mcpError("HTTP_REDIRECT", `mcp sse endpoint redirected: ${url}`);
        }
        if (!response.ok) {
          throw mcpError("HTTP_ERROR", `mcp server returned ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        activeControllers.delete(controller);
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      streamEnded = true;
      streamController.abort();
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
      rejectReady(mcpError("UNAVAILABLE", "mcp session closed"));
      handlers.onClose("mcp session closed");
    },
  };
}
