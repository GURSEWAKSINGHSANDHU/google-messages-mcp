/**
 * Google Messages MCP — Main World Script
 * Runs in the page's main JavaScript context (not the isolated content script world).
 * This allows us to trigger Angular's zone.js change detection properly.
 */

console.log('[GMsgMCP] Main world script loaded');

// Listen for send requests from the content script via CustomEvent
document.addEventListener('gmcp-send-request', async (event) => {
  console.log('[GMsgMCP] Main world received send request');
  const { text, inputSelector, callbackId } = event.detail;
  const result = { success: false };

  try {
    // Find the textarea
    const input = document.querySelector(inputSelector);
    if (!input) {
      result.reason = 'no-input';
      document.dispatchEvent(new CustomEvent(callbackId, { detail: result }));
      return;
    }

    // Focus the input
    input.focus();

    // Set value using native setter
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, text);
    else input.value = text;

    // Dispatch input event — this runs inside zone.js, so Angular detects it
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    result.valueSet = true;
    result.valueCheck = input.value.substring(0, 30);

    // Wait for Angular change detection
    await new Promise(r => setTimeout(r, 500));

    // Find the visible send button
    const btns = document.querySelectorAll('button[aria-label*="Send"], button[data-e2e-send-text-button]');
    let sendBtn = null;
    for (const btn of btns) {
      if (btn.offsetParent !== null) { sendBtn = btn; break; }
    }

    if (!sendBtn) {
      result.reason = 'no-visible-send-btn';
      result.btnCount = btns.length;
      document.dispatchEvent(new CustomEvent(callbackId, { detail: result }));
      return;
    }

    result.btnLabel = sendBtn.getAttribute('aria-label');

    // Click send button — in main world, this goes through zone.js
    sendBtn.click();
    result.clicked = true;

    // Wait and check
    await new Promise(r => setTimeout(r, 500));

    const afterVal = input.value || '';
    result.inputAfter = afterVal.substring(0, 50);
    result.success = afterVal.length === 0;

    if (!result.success) {
      // Try Enter key from main world
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));

      await new Promise(r => setTimeout(r, 300));
      const afterEnter = input.value || '';
      result.inputAfterEnter = afterEnter.substring(0, 50);
      result.success = afterEnter.length === 0;
      result.sentVia = result.success ? 'enter-main-world' : 'none';
    } else {
      result.sentVia = 'click-main-world';
    }
  } catch (e) {
    result.error = e.message;
  }

  console.log('[GMsgMCP] Main world send result:', result);
  document.dispatchEvent(new CustomEvent(callbackId, { detail: result }));
});
