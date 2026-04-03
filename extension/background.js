/**
 * Google Messages MCP Bridge — Background Service Worker
 * Uses Chrome DevTools Protocol (CDP) via chrome.debugger to send trusted
 * keyboard events. This bypasses all framework-level event interception
 * (Angular, Lit, Web Components, Shadow DOM) because the browser engine
 * itself performs the text insertion.
 */

function sendCDP(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/**
 * Focus the message input element — handles both textarea and
 * contenteditable inside Shadow DOM (Web Components / Lit).
 */
async function focusInput(tabId) {
  const result = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(() => {
      // Strategy 1: Shadow DOM (Lit/Web Components)
      const compose = document.querySelector('mws-message-compose, mw-message-compose');
      if (compose && compose.shadowRoot) {
        const editable = compose.shadowRoot.querySelector('[contenteditable="true"]')
                      || compose.shadowRoot.querySelector('textarea');
        if (editable) { editable.focus(); editable.click(); return 'shadow-dom'; }
      }

      // Strategy 2: Regular textarea
      const textarea = document.querySelector('textarea[placeholder*="essage"]')
                    || document.querySelector('textarea');
      if (textarea) { textarea.focus(); textarea.click(); return 'textarea'; }

      // Strategy 3: Any contenteditable
      const editable = document.querySelector('[contenteditable="true"][role="textbox"]')
                    || document.querySelector('[contenteditable="true"]');
      if (editable) { editable.focus(); editable.click(); return 'contenteditable'; }

      return 'not-found';
    })()`,
    returnByValue: true
  });
  return result.result.value;
}

/**
 * Select all text in the focused element (to replace existing content).
 */
async function selectAll(tabId) {
  await sendCDP(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "a", code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2 // Ctrl
  });
  await sendCDP(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA",
    windowsVirtualKeyCode: 65
  });
  await new Promise(r => setTimeout(r, 50));
}

/**
 * Type text and press Enter to send.
 */
async function typeAndSend(tabId, text) {
  await chrome.debugger.attach({ tabId }, "1.3");
  const debug = {};

  try {
    // 1. Focus the input
    const inputType = await focusInput(tabId);
    debug.inputType = inputType;
    if (inputType === 'not-found') {
      throw new Error("Could not find message input field");
    }

    await new Promise(r => setTimeout(r, 100));

    // 2. Select all existing text (if any) and delete
    await selectAll(tabId);
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8
    });
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8
    });
    await new Promise(r => setTimeout(r, 50));

    // 3. Insert text — single CDP call, works like IME/emoji keyboard
    await sendCDP(tabId, "Input.insertText", { text });
    debug.textInserted = true;

    await new Promise(r => setTimeout(r, 300));

    // 4. Press Enter to send
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, text: "\r"
    });
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "char", text: "\r"
    });
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13
    });
    debug.enterSent = true;

    await new Promise(r => setTimeout(r, 500));

    // 5. Check if the input was cleared (message sent)
    const checkResult = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const textarea = document.querySelector('textarea');
        if (textarea) return textarea.value.length === 0 ? 'sent' : 'still-has-text';
        const editable = document.querySelector('[contenteditable="true"][role="textbox"]')
                      || document.querySelector('[contenteditable="true"]');
        if (editable) return editable.textContent.trim().length === 0 ? 'sent' : 'still-has-text';
        return 'unknown';
      })()`,
      returnByValue: true
    });
    debug.sendStatus = checkResult.result.value;

    // If Enter didn't send, try clicking the visible send button via CDP
    if (debug.sendStatus === 'still-has-text') {
      debug.enterDidNotSend = true;
      // Click the send button using CDP mouse events
      const btnResult = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const btns = document.querySelectorAll('button[aria-label*="Send"], button[data-e2e-send-text-button]');
          for (const btn of btns) {
            if (btn.offsetParent !== null) {
              const rect = btn.getBoundingClientRect();
              return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
          }
          return null;
        })()`,
        returnByValue: true
      });

      if (btnResult.result.value) {
        const { x, y } = btnResult.result.value;
        await sendCDP(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button: "left", clickCount: 1
        });
        await sendCDP(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button: "left", clickCount: 1
        });
        debug.clickedSendBtn = true;

        await new Promise(r => setTimeout(r, 500));

        // Re-check
        const recheck = await sendCDP(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const textarea = document.querySelector('textarea');
            if (textarea) return textarea.value.length === 0 ? 'sent' : 'still-has-text';
            const editable = document.querySelector('[contenteditable="true"]');
            if (editable) return editable.textContent.trim().length === 0 ? 'sent' : 'still-has-text';
            return 'unknown';
          })()`,
          returnByValue: true
        });
        debug.sendStatusAfterClick = recheck.result.value;
      }
    }

    return { ok: true, debug };
  } catch (e) {
    return { ok: false, error: e.message, debug };
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // already detached
    }
  }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "typeAndSend" && sender.tab) {
    typeAndSend(sender.tab.id, msg.text)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async response
  }
});
