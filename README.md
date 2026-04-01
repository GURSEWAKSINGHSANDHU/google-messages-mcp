# Google Messages MCP Bridge

> **The missing link between AI agents and your real SMS/RCS conversations.**

A Chrome extension + MCP server that lets [Claude Code](https://claude.ai/claude-code) (or any MCP client) read, search, and send SMS/RCS messages through your existing [Google Messages for Web](https://messages.google.com) session. No third-party servers. No phone-side apps. No API keys. Just your browser.

---

## Why This Exists

We tried every existing solution. None of them worked well enough.

### The Problem with OpenMessage
[OpenMessage](https://github.com/nicobailey/openmessage) uses the `libgm` protocol to emulate Google Messages pairing. Sounds great in theory. In practice:
- **SSE sessions expire constantly.** The MCP transport uses Server-Sent Events, and sessions silently die after minutes of inactivity. You get `Invalid session ID` errors mid-conversation with no recovery path except restarting the Docker container.
- **Hostname mismatch bugs.** The SSE server returns callback URLs with `localhost` but if you connected via `127.0.0.1`, the handshake fails silently.
- **7 tool definitions = ~1,500 tokens per conversation.** Every Claude Code session loads all tool schemas into context. Seven tools for SMS is overkill and burns through your context window.
- **Message sync lag.** New incoming messages don't appear until you restart the container to re-trigger the backfill. Not exactly "real-time."
- **Docker dependency.** Requires a running Docker container, adding complexity and resource overhead to what should be a lightweight integration.

### The Problem with TextBee
[TextBee](https://textbee.dev) is an Android app that turns your phone into an SMS gateway with a REST API. It works, but:
- **Requires a dedicated Android app** running 24/7 on your phone, draining battery and using mobile data.
- **Cloud relay dependency.** Messages route through TextBee's cloud servers before reaching your webhook. Your private SMS conversations pass through a third party.
- **SMS only.** No RCS support. In 2025+, most Android-to-Android conversations are RCS with end-to-end encryption. TextBee can only see and send plain SMS.
- **Complex webhook pipeline.** You need Tailscale Funnel (or ngrok) + Express.js webhook server + API client just to receive messages. That's three moving parts for basic SMS access.
- **No conversation context.** The REST API gives you raw messages without conversation threading, contact names, or read status.

### Our Approach: Use What's Already Working
Your Google Messages is already paired and running in Chrome. It already has all your conversations, contacts, RCS support, and end-to-end encryption. Why not just talk to it directly?

**Google Messages MCP Bridge** injects a content script into your existing Google Messages tab and exposes it as a clean 3-tool MCP server. That's it. No Docker. No cloud relay. No phone-side apps. No API keys.

---

## Architecture

```
Claude Code <--stdio--> MCP Server (Node.js) <--WebSocket:7008--> Chrome Extension (content.js on messages.google.com)
```

| Component | Role |
|-----------|------|
| **Chrome Extension** | Content script on messages.google.com. Extracts conversations/messages from the DOM, types and sends messages, reports connection status. |
| **MCP Server** | Node.js process with stdio transport (no SSE, no session expiry). Runs a WebSocket server on port 7008 to bridge Claude Code tool calls to the extension. |
| **Google Messages Web** | Your already-paired session. The extension reads from and writes to the live DOM. |

### Token Efficiency

| Solution | Tools | Tokens per Conversation |
|----------|-------|------------------------|
| OpenMessage | 7 | ~1,500 |
| TextBee + Custom MCP | 2-3 | ~400-600 |
| **Google Messages MCP** | **3** | **~300** |

---

## Tools

### `list_chats`
List recent SMS/RCS conversations with contact names, last message preview, timestamps, and unread counts.

### `read_messages`
Read the message history of a specific conversation. Returns text, timestamp, and direction (sent/received) for each message.

### `send_message`
Send an SMS/RCS message to an existing conversation. Types into the Google Messages compose field and clicks send.

---

## Setup

### Prerequisites
- Google Chrome with [Google Messages for Web](https://messages.google.com) paired to your phone
- Node.js 18+
- Claude Code (or any MCP-compatible client)

### 1. Install the Chrome Extension

```bash
git clone https://github.com/GURSEWAKSINGHSANDHU/google-messages-mcp.git
cd google-messages-mcp
```

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Open [messages.google.com](https://messages.google.com) - you should see a green dot in the bottom-right corner

### 2. Install the MCP Server

```bash
cd server
npm install
```

### 3. Register with Claude Code

```bash
claude mcp add -s user --transport stdio google-messages -- node C:/path/to/google-messages-mcp/server/index.js
```

Replace `C:/path/to/` with your actual path.

### 4. Verify

Open Claude Code and ask:
```
List my recent text messages
```

You should see your Google Messages conversations.

---

## Status

### Working
- **`list_chats`** - Reliably extracts all conversations with names, snippets, timestamps
- **`read_messages`** - Full message history with sent/received direction detection
- **WebSocket auto-reconnect** - Extension reconnects automatically if the server restarts
- **Connection indicator** - Green/red dot on Google Messages shows bridge status

### In Progress
- **`send_message`** - Text input works but Angular's zone.js change detection requires main-world script injection for reliable send button activation. See [Issue #1](#contributing).

### Planned
- Conversation search by contact name or phone number
- New conversation creation (message a number not in existing chats)
- Attachment/image support
- Unread message notifications via MCP resources
- Auto-reply mode with customizable AI personas

---

## How It Works

### DOM Extraction
Google Messages Web is an Angular application. The extension uses a multi-strategy approach to extract data:

1. **Conversation list**: Finds all `<a>` tags linking to `/web/conversations/`, walks up to the container, and extracts text nodes (name, timestamp, snippet) using a TreeWalker. Deduplicates by conversation ID.

2. **Messages**: Queries multiple selectors (`mms-message`, `[role="listitem"]`, message bubbles) and determines direction by checking CSS alignment (`margin-left: auto` = sent, left-aligned = received).

3. **Send**: Locates the textarea input, sets the value, and clicks the visible send button (Google Messages renders hidden duplicate buttons - we filter by `offsetParent !== null`).

### Main World Injection
Content scripts run in Chrome's "isolated world" - they share the DOM but have a separate JavaScript context. Angular's zone.js only patches event listeners in the main world. This means:

- Events dispatched from the content script **don't trigger Angular change detection**
- The textarea value gets set in the DOM but Angular's form control doesn't see it
- Button clicks fire but Angular's handlers don't run

The solution: `main-world.js` runs as a Manifest V3 `world: "MAIN"` content script. It communicates with `content.js` via `CustomEvent` on the document, and performs all DOM mutations from within Angular's zone.

---

## Contributing

This project is actively being built. The core reading infrastructure works. The main challenge is reliable message sending through Angular's change detection boundary.

If you have experience with:
- Angular internals / zone.js
- Chrome extension main world scripts
- Google Messages Web DOM structure

We'd love your help. Open an issue or PR.

---

## Comparison

| Feature | OpenMessage | TextBee | **This Project** |
|---------|------------|---------|-----------------|
| RCS Support | Partial | No | **Yes** |
| E2E Encryption | No | No | **Yes (native)** |
| Cloud Dependency | No | Yes | **No** |
| Phone App Required | No | Yes | **No** |
| Docker Required | Yes | No | **No** |
| Session Stability | Poor (SSE expiry) | Good | **Good (stdio)** |
| Token Overhead | ~1,500 (7 tools) | ~400 (2 tools) | **~300 (3 tools)** |
| Setup Complexity | High | High | **Low** |
| Message Sync | Delayed | Real-time | **Real-time** |

---

## License

MIT

---

*Built with frustration, persistence, and Claude Code.*
