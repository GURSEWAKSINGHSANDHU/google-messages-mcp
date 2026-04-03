#!/usr/bin/env node

/**
 * Google Messages MCP Server
 *
 * Bridges Claude Code to Google Messages Web via a Chrome extension.
 * - Runs an MCP server (stdio) for Claude Code
 * - Runs a WebSocket server (port 7008) for the Chrome extension
 * - 3 tools: list_chats, read_messages, send_message
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

// Zod is bundled with MCP SDK, no extra dependency needed

// ─── WebSocket Bridge ────────────────────────────────────────────

const WS_PORT = 7008;
let extensionSocket = null;
let requestCounter = 0;
const pendingRequests = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (socket) => {
  // Only allow one extension connection at a time
  if (extensionSocket && extensionSocket.readyState === 1) {
    extensionSocket.close();
  }
  extensionSocket = socket;
  process.stderr.write(`[GMsgMCP] Chrome extension connected\n`);

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);
        pending.resolve(msg);
      }
    } catch (e) {
      process.stderr.write(`[GMsgMCP] Bad message from extension: ${e.message}\n`);
    }
  });

  socket.on("close", () => {
    if (extensionSocket === socket) extensionSocket = null;
    process.stderr.write(`[GMsgMCP] Chrome extension disconnected\n`);
  });
});

process.stderr.write(`[GMsgMCP] WebSocket server listening on ws://localhost:${WS_PORT}\n`);

/**
 * Send a command to the Chrome extension and wait for a response.
 */
function sendToExtension(command, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject(new Error(
        "Chrome extension not connected. Make sure:\n" +
        "1. Google Messages (messages.google.com) is open in Chrome\n" +
        "2. The 'Google Messages MCP Bridge' extension is installed and enabled\n" +
        "3. Look for the green dot in the bottom-right corner of Google Messages"
      ));
      return;
    }

    const id = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Extension response timed out (10s). The page may be loading or unresponsive."));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ id, ...command }));
  });
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = new McpServer({
  name: "google-messages",
  version: "1.0.0",
});

// Tool 1: List Chats
server.tool(
  "list_chats",
  "List recent SMS/RCS conversations from Google Messages",
  {
    limit: z.number().optional().default(20).describe("Max conversations to return"),
  },
  async ({ limit }) => {
    const result = await sendToExtension({ type: "list_chats" });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    const chats = (result.data || []).slice(0, limit);
    if (chats.length === 0) {
      return { content: [{ type: "text", text: "No conversations found. Make sure Google Messages is open and paired." }] };
    }

    const lines = chats.map((c, i) =>
      `${i + 1}. ${c.name}${c.unread ? ` (${c.unread} unread)` : ""}\n   ID: ${c.id}\n   ${c.snippet} — ${c.time}`
    );

    return {
      content: [{
        type: "text",
        text: `${chats.length} conversations:\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// Tool 2: Read Messages
server.tool(
  "read_messages",
  "Read messages from a specific SMS/RCS conversation",
  {
    conversationId: z.string().describe("Conversation ID from list_chats"),
    limit: z.number().optional().default(20).describe("Max messages to return"),
  },
  async ({ conversationId, limit }) => {
    const result = await sendToExtension(
      { type: "read_messages", conversationId },
      15000 // longer timeout for navigation
    );

    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    const messages = (result.data || []).slice(-limit);
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "No messages found in this conversation." }] };
    }

    const lines = messages.map((m) => {
      const arrow = m.direction === "sent" ? "→" : "←";
      return `[${m.time || "?"}] ${arrow} ${m.text}`;
    });

    return {
      content: [{
        type: "text",
        text: `${messages.length} messages:\n\n${lines.join("\n")}`,
      }],
    };
  }
);

// Tool 3: Send Message
server.tool(
  "send_message",
  "Send an SMS/RCS message via Google Messages",
  {
    conversationId: z.string().describe("Conversation ID from list_chats"),
    text: z.string().describe("Message text to send"),
  },
  async ({ conversationId, text }) => {
    const result = await sendToExtension(
      { type: "send_message", conversationId, text },
      15000
    );

    if (!result.ok) {
      return { content: [{ type: "text", text: `Failed to send: ${result.error || result.message}` }] };
    }

    return {
      content: [{
        type: "text",
        text: `Message sent to conversation ${conversationId}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
      }],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write("[GMsgMCP] MCP server started (stdio). Waiting for Chrome extension...\n");
