import { BrowserWindow } from "electron";
import { BrowserHost } from "./browser-window";

export class DomAutomation {
  /**
   * Automates the Gemini Webview: dismisses onboarding, types prompt, clicks Send, and watches response live!
   */
  public static async executeLivePrompt(
    promptText: string,
    onChunk?: (text: string) => void
  ): Promise<{ response: string; conversationTitle?: string; conversationUrl?: string }> {
    const win = BrowserHost.openAuthWindow();
    win.show();
    win.focus();

    const wc = win.webContents;

    // 1. Wait until initial page load completes
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        wc.once("did-finish-load", () => resolve());
      });
    }

    // 2. Wait for SPA hydration & dismiss any "Let's go" onboarding popups
    console.log("[DomAutomation] Waiting for Gemini Web SPA to be interactive...");
    const waitScript = `
      (async function() {
        for (let i = 0; i < 40; i++) {
          // Dismiss "Let's go" / "Got it" modal if present
          const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const letsGoBtn = allBtns.find(b => {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            return txt.includes("let's go") || txt.includes("dismiss") || txt.includes("got it") || txt.includes("try it");
          });
          if (letsGoBtn) {
            letsGoBtn.click();
            await new Promise(r => setTimeout(r, 400));
          }

          // Check if prompt input is ready
          const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                        document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                        document.querySelector('div[contenteditable="true"]') ||
                        document.querySelector('textarea');
          if (input) {
            return { ready: true };
          }
          await new Promise(r => setTimeout(r, 500));
        }
        return { ready: false, error: "Timed out waiting for Gemini prompt input box" };
      })();
    `;

    const waitRes = await wc.executeJavaScript(waitScript);
    if (!waitRes || !waitRes.ready) {
      throw new Error(waitRes?.error || "Gemini Web interface did not load input box");
    }

    // 3. Inject prompt text via Instant Native Clipboard Paste
    console.log("[DomAutomation] Pasting prompt via Native Clipboard API into Gemini Webview...");
    const { clipboard } = require("electron");
    clipboard.writeText(promptText);

    const clearAndFocusScript = `
      (async function() {
        const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                      document.querySelector('div[contenteditable="true"]') ||
                      document.querySelector('textarea');

        if (!input) return { success: false, error: "Input box vanished" };

        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        return { success: true };
      })();
    `;

    const focusRes = await wc.executeJavaScript(clearAndFocusScript);
    if (!focusRes || !focusRes.success) {
      throw new Error(focusRes?.error || "Could not focus prompt input box");
    }

    // Trigger native clipboard paste
    wc.paste();
    await new Promise((r) => setTimeout(r, 600));

    // Dispatch input events and locate Send button
    const clickSendScript = `
      (async function() {
        const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                      document.querySelector('div[contenteditable="true"]') ||
                      document.querySelector('textarea');

        if (input) {
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }

        await new Promise(r => setTimeout(r, 600));

        let sendBtn = document.querySelector('button[aria-label*="Send message"]') ||
                      document.querySelector('button[aria-label*="Send prompt"]') ||
                      document.querySelector('button[aria-label*="Send"]') ||
                      document.querySelector('button[aria-label*="send"]') ||
                      document.querySelector('button.send-button');

        if (!sendBtn) {
          const all = Array.from(document.querySelectorAll('button, [role="button"]'));
          sendBtn = all.find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('send');
          });
        }

        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
          sendBtn.click();
          return { success: true, method: "button-click" };
        } else {
          return { success: true, method: "needs-enter-key" };
        }
      })();
    `;

    const sendRes = await wc.executeJavaScript(clickSendScript);
    if (sendRes && sendRes.method === "needs-enter-key") {
      console.log("[DomAutomation] Sending trusted Enter key...");
      wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      wc.sendInputEvent({ type: "char", keyCode: "Return" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    }

    // 4. Poll DOM and stream response back to listener
    console.log("[DomAutomation] Streaming response from Gemini Webview...");
    let lastText = "";
    let completed = false;
    let attempts = 0;
    const maxAttempts = 240; // up to 120 seconds
    let idleCount = 0;

    while (!completed && attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500));
      attempts++;

      const checkScript = `
        (function() {
          const responses = document.querySelectorAll(
            'model-response, message-content, [data-test-id="model-response-text"], .model-response-text, .response-content, div.markdown'
          );
          let currentText = '';
          if (responses.length > 0) {
            const last = responses[responses.length - 1];
            currentText = last.innerText || last.textContent || '';
          }

          // Check if still generating (Stop button visible)
          const stopBtn = document.querySelector('button[aria-label*="Stop"]') || 
                          document.querySelector('button[aria-label*="stop"]');
          const isGenerating = Boolean(stopBtn);

          // Get active conversation title from sidebar
          const activeItem = document.querySelector('.conversation-item.active, [aria-selected="true"], nav a[aria-current="page"]');
          const title = activeItem ? (activeItem.innerText || activeItem.textContent || '').trim() : null;

          return {
            text: currentText.trim(),
            isGenerating: isGenerating,
            title: title,
            url: window.location.href
          };
        })();
      `;

      try {
        const status = await wc.executeJavaScript(checkScript);
        if (status && status.text) {
          if (status.text !== lastText) {
            const delta = status.text.startsWith(lastText)
              ? status.text.substring(lastText.length)
              : status.text;
            lastText = status.text;
            idleCount = 0;
            if (onChunk) onChunk(delta);
          } else {
            idleCount++;
          }

          // If stop button disappeared or idle for 4 seconds after substantial text
          if ((!status.isGenerating && status.text.length > 15 && attempts > 6) || (idleCount > 8 && status.text.length > 30)) {
            completed = true;
            return {
              response: status.text,
              conversationTitle: status.title,
              conversationUrl: status.url
            };
          }
        }
      } catch (err) {
        // Navigation in progress
      }
    }

    return { response: lastText };
  }
}
