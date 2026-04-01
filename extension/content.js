/**
 * Google Messages MCP Bridge — Content Script
 * Connects to local WebSocket server and exposes Google Messages DOM data.
 */

(function () {
  "use strict";

  const WS_URL = "ws://localhost:7008";
  const RECONNECT_DELAY = 3000;
  let ws = null;
  let reconnectTimer = null;

  // ─── WebSocket Connection ──────────────────────────────────────

  function connect() {
    if (ws && ws.readyState <= 1) return; // already open or connecting
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log("[GMsgMCP] Connected to MCP bridge");
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = async (event) => {
      let request;
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }
      const response = await handleCommand(request);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ id: request.id, ...response }));
      }
    };

    ws.onclose = () => {
      console.log("[GMsgMCP] Disconnected, reconnecting...");
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  }

  // ─── Command Router ────────────────────────────────────────────

  async function handleCommand(req) {
    try {
      switch (req.type) {
        case "ping":
          return { ok: true, status: "connected", url: location.href };

        case "list_chats":
          return { ok: true, data: extractConversations() };

        case "read_messages":
          return await readMessages(req.conversationId);

        case "send_message":
          return await sendMessage(req.conversationId, req.text);

        case "get_status":
          return { ok: true, data: getConnectionStatus() };

        case "debug_dom":
          return { ok: true, data: debugDom(req.selector) };

        default:
          return { ok: false, error: `Unknown command: ${req.type}` };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── DOM Extraction: Conversation List ─────────────────────────

  function extractConversations() {
    // Primary approach: find all conversation links and deduplicate
    const links = document.querySelectorAll('a[href*="/web/conversations/"]');
    const seen = new Set();
    const conversations = [];

    for (const link of links) {
      const id = link.href.match(/conversations\/([^/?]+)/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Walk up to find the conversation container
      const container = link.closest('[role="listitem"]') || link.closest('li') || link;

      // Extract text content from the container
      const textNodes = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text && text.length > 0) textNodes.push(text);
      }

      // Heuristic: first text is usually the name, short texts may be time,
      // remaining text is the snippet
      const name = textNodes[0] || "Unknown";

      // Try to find timestamp - usually a short text like "10:30 AM", "Yesterday", etc.
      let time = "";
      let snippetParts = [];
      for (let i = 1; i < textNodes.length; i++) {
        const t = textNodes[i];
        if (!time && (t.match(/^\d{1,2}:\d{2}/) || t.match(/^(Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i) || t.match(/^\d{1,2}\/\d{1,2}/))) {
          time = t;
        } else {
          snippetParts.push(t);
        }
      }
      const snippet = snippetParts.join(" ").substring(0, 120);

      // Check for unread indicator
      const unreadEl = container.querySelector('[data-unread-count], .unread-count, .badge');
      const unread = unreadEl ? parseInt(unreadEl.textContent) || 1 : 0;

      conversations.push({ id, name, snippet, time, unread });
    }

    return conversations;
  }

  function extractConversationsFallback() {
    const conversations = [];
    // Google Messages web renders conversation list as a series of divs/links
    // Each conversation is typically an anchor tag to /web/conversations/XXXX
    const links = document.querySelectorAll('a[href*="/web/conversations/"]');
    const seen = new Set();

    for (const link of links) {
      const id = link.href.match(/conversations\/([^/?]+)/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Walk up to find the conversation item container
      const container = link.closest('[role="listitem"]') || link.closest('li') || link;

      // Get all text nodes
      const textNodes = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text) textNodes.push(text);
      }

      const name = textNodes[0] || "Unknown";
      const time = textNodes[1] || "";
      const snippet = textNodes.slice(2).join(" ").substring(0, 100) || "";

      conversations.push({ id, name, snippet, time, unread: 0 });
    }

    return conversations;
  }

  // ─── DOM Extraction: Read Messages ─────────────────────────────

  async function readMessages(conversationId) {
    // Check if we're already on the right conversation
    const currentConvMatch = location.href.match(/conversations\/([^/?]+)/);
    const currentConvId = currentConvMatch?.[1];

    if (conversationId && conversationId !== currentConvId) {
      // Navigate to the conversation
      const link = document.querySelector(`a[href*="/web/conversations/${conversationId}"]`);
      if (link) {
        link.click();
        await waitForNavigation(conversationId);
      } else {
        // Try direct navigation
        window.location.href = `https://messages.google.com/web/conversations/${conversationId}`;
        await sleep(2000);
      }
    }

    await sleep(1000); // Let messages render

    const messages = extractMessages();
    if (messages.length === 0) {
      // Return debug info to help fix selectors
      const debug = debugDom();
      return { ok: true, data: [], debug };
    }
    return { ok: true, data: messages };
  }

  function extractMessages() {
    const messages = [];

    // Google Messages uses mms-message or similar elements
    const messageEls = document.querySelectorAll(
      'mms-message, [data-e2e-message-id], .message'
    );

    if (messageEls.length > 0) {
      for (const el of messageEls) {
        const text = el.querySelector('.text-msg, .message-text, [data-e2e-message-text]')?.textContent?.trim()
          || el.textContent?.trim()?.substring(0, 500)
          || "";
        const time = el.querySelector('time, .message-timestamp, [data-e2e-message-timestamp]')?.textContent?.trim()
          || el.querySelector('[data-e2e-timestamp]')?.getAttribute('data-e2e-timestamp')
          || "";
        const isOutgoing = el.classList.contains('outgoing')
          || el.getAttribute('data-e2e-is-outgoing') === 'true'
          || el.closest('.outgoing') !== null;

        if (text) {
          messages.push({
            text,
            time,
            direction: isOutgoing ? "sent" : "received",
          });
        }
      }
    }

    // Fallback: parse message bubbles from visible structure
    if (messages.length === 0) {
      return extractMessagesFallback();
    }

    return messages;
  }

  function extractMessagesFallback() {
    const messages = [];
    // Google Messages typically uses distinct containers for sent vs received
    // Look for message bubbles
    const bubbles = document.querySelectorAll(
      '[data-message-id], .message-bubble, [role="row"], [role="listitem"]'
    );

    for (const bubble of bubbles) {
      const textEl = bubble.querySelector('.text-msg-content, .message-content, span[dir]');
      const text = textEl?.textContent?.trim() || bubble.textContent?.trim()?.substring(0, 500);
      if (!text || text.length < 1) continue;

      const timeEl = bubble.querySelector('time, [datetime], .timestamp');
      const time = timeEl?.textContent?.trim() || timeEl?.getAttribute('datetime') || "";

      // Determine direction by checking alignment or class names
      const style = window.getComputedStyle(bubble);
      const isOutgoing = bubble.classList.contains('outgoing')
        || bubble.closest('.outgoing') !== null
        || style.marginLeft === 'auto'
        || style.alignSelf === 'flex-end'
        || bubble.querySelector('.send-status') !== null;

      messages.push({
        text: text.substring(0, 500),
        time,
        direction: isOutgoing ? "sent" : "received",
      });
    }

    return messages;
  }

  // ─── Send Message ──────────────────────────────────────────────

  async function sendMessage(conversationId, text) {
    if (!text) return { ok: false, error: "No message text provided" };

    // Navigate to conversation if needed
    const currentConvMatch = location.href.match(/conversations\/([^/?]+)/);
    if (conversationId && conversationId !== currentConvMatch?.[1]) {
      const link = document.querySelector(`a[href*="/web/conversations/${conversationId}"]`);
      if (link) {
        link.click();
        await waitForNavigation(conversationId);
        await sleep(1000);
      } else {
        window.location.href = `https://messages.google.com/web/conversations/${conversationId}`;
        await sleep(3000);
      }
    }

    const debug = {};

    // Find the input field — try multiple selectors
    const inputSelectors = [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea[placeholder*="essage"]',
      'textarea',
      'input[placeholder*="essage"]',
    ];
    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) { debug.inputSelector = sel; debug.inputTag = input.tagName; break; }
    }

    if (!input) {
      debug.allContentEditable = document.querySelectorAll('[contenteditable]').length;
      debug.allTextarea = document.querySelectorAll('textarea').length;
      debug.allInputs = document.querySelectorAll('input').length;
      return { ok: false, error: "Could not find message input field", debug };
    }

    // Send via MAIN WORLD script (main-world.js) to trigger Angular's zone.js
    // Content script isolated world events don't enter Angular's zone
    // Communication via CustomEvent on document (works between worlds)
    debug.currentUrl = location.href;

    const callbackId = 'gmcp_reply_' + Date.now();

    // Listen for response from main-world.js via CustomEvent
    const sendResult = new Promise((resolve) => {
      const handler = (event) => {
        document.removeEventListener(callbackId, handler);
        resolve(event.detail);
      };
      document.addEventListener(callbackId, handler);
      setTimeout(() => {
        document.removeEventListener(callbackId, handler);
        resolve({ success: false, reason: 'timeout' });
      }, 8000);
    });

    // Send request to main-world.js via CustomEvent
    document.dispatchEvent(new CustomEvent('gmcp-send-request', {
      detail: { text, inputSelector: debug.inputSelector, callbackId }
    }));

    const res = await sendResult;
    debug.mainWorldResult = res;

    return {
      ok: res.success,
      message: res.success ? "Message sent" : "Send may have failed",
      debug
    };
  }

  // ─── Status ────────────────────────────────────────────────────

  function getConnectionStatus() {
    const isPaired = !document.querySelector('[data-e2e-qr-code]')
      && !location.href.includes('/authentication')
      && !location.href.includes('/welcome');

    return {
      paired: isPaired,
      url: location.href,
      title: document.title,
      conversationCount: document.querySelectorAll('a[href*="/web/conversations/"]').length,
    };
  }

  // ─── Debug ─────────────────────────────────────────────────────

  function debugDom(selector) {
    const url = location.href;
    const result = { url, info: {} };

    // Get all tag names in the page (custom elements)
    const allEls = document.querySelectorAll('*');
    const tagCounts = {};
    for (const el of allEls) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes('-') || tag.startsWith('mw') || tag.startsWith('mms')) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    result.info.customElements = tagCounts;

    // Count conversation links
    result.info.convLinks = document.querySelectorAll('a[href*="/web/conversations/"]').length;

    // If a selector is provided, return matching elements' outerHTML (truncated)
    if (selector) {
      const matches = document.querySelectorAll(selector);
      result.info.selectorMatches = matches.length;
      result.info.selectorSamples = Array.from(matches).slice(0, 3).map(el => el.outerHTML.substring(0, 500));
    }

    // Check for message-related elements
    const messageSelectors = [
      'mms-message', 'mws-message', 'mw-message', 'message-part',
      '[data-message-id]', '[data-e2e-message-id]',
      '.message', '.message-bubble', '.text-msg',
      '[role="row"]', '[role="listitem"]',
      'mws-message-wrapper', 'mws-text-message-part',
    ];
    result.info.messageSelectorHits = {};
    for (const sel of messageSelectors) {
      const count = document.querySelectorAll(sel).length;
      if (count > 0) result.info.messageSelectorHits[sel] = count;
    }

    // Get body children structure (top-level layout)
    result.info.bodyChildren = Array.from(document.body.children).slice(0, 10).map(el => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: el.className ? el.className.substring(0, 100) : undefined,
    }));

    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForNavigation(conversationId, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (location.href.includes(conversationId)) return;
      await sleep(200);
    }
  }

  // ─── Initialize ────────────────────────────────────────────────

  // Wait for page to be fully loaded before connecting
  if (document.readyState === 'complete') {
    connect();
  } else {
    window.addEventListener('load', connect);
  }

  // Also inject a small indicator
  const indicator = document.createElement('div');
  indicator.id = 'gmsg-mcp-indicator';
  indicator.style.cssText = 'position:fixed;bottom:8px;right:8px;width:10px;height:10px;border-radius:50%;background:#4CAF50;z-index:99999;opacity:0.7;pointer-events:none;';
  document.body.appendChild(indicator);

  // Update indicator based on connection status
  setInterval(() => {
    indicator.style.background = (ws && ws.readyState === 1) ? '#4CAF50' : '#f44336';
  }, 1000);

  console.log("[GMsgMCP] Content script loaded, connecting to MCP bridge...");
})();
