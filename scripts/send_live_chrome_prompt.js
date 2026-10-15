const http = require('http');

async function getGeminiPageWsUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://[::1]:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          const page = list.find(p => p.type === 'page' && p.url.includes('gemini.google.com'));
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
          } else {
            reject(new Error('No gemini.google.com page found in Chrome'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function sendCommand(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const testPrompt = process.argv[2] || "Hello Gemini! Please confirm that this chat is running live on the official Google Gemini Web interface (gemini.google.com). Introduce yourself and state what model you are running as.";
  console.log("============================================================");
  console.log("🚀 SENDING LIVE PROMPT VIA REAL GOOGLE CHROME (CDP)");
  console.log("Prompt:", testPrompt);
  console.log("============================================================");

  const wsUrl = await getGeminiPageWsUrl();
  console.log("[CDP] Connected to Chrome WebSocket:", wsUrl);
  const ws = new WebSocket(wsUrl);

  await new Promise(r => ws.onopen = r);

  // 1. Bring Chrome tab to front
  await sendCommand(ws, "Page.bringToFront");

  // 2. Clear any popups / modals
  console.log("[CDP] Checking for dialogs and locating input box...");
  const initRes = await sendCommand(ws, "Runtime.evaluate", {
    expression: `
      (function() {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const letsGo = btns.find(b => {
          const t = (b.innerText || b.textContent || '').toLowerCase();
          return t.includes("let's go") || t.includes("got it") || t.includes("dismiss");
        });
        if (letsGo) letsGo.click();

        const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                      document.querySelector('div[contenteditable="true"]') ||
                      document.querySelector('textarea');
        if (!input) return { error: "No input box found" };
        input.focus();
        return { success: true };
      })()
    `,
    returnByValue: true
  });

  if (!initRes?.result?.value?.success) {
    console.error("[CDP Error] Could not find prompt input box:", initRes);
    process.exit(1);
  }

  // 3. Type the prompt into Google Gemini's rich textarea
  console.log("[CDP] Injecting prompt text into Google Gemini prompt box...");
  await sendCommand(ws, "Runtime.evaluate", {
    expression: `
      (function(text) {
        const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                      document.querySelector('div[contenteditable="true"]') ||
                      document.querySelector('textarea');
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, text);
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return { length: input.innerText ? input.innerText.length : 0 };
      })(${JSON.stringify(testPrompt)})
    `,
    returnByValue: true
  });

  await new Promise(r => setTimeout(r, 600));

  // 4. Click Send
  console.log("[CDP] Clicking Google Gemini Send button...");
  const sendRes = await sendCommand(ws, "Runtime.evaluate", {
    expression: `
      (function() {
        let sendBtn = document.querySelector('button[aria-label*="Send message"]') ||
                      document.querySelector('button[aria-label*="Send prompt"]') ||
                      document.querySelector('button[aria-label*="Send"]') ||
                      document.querySelector('button.send-button');
        if (!sendBtn) {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          sendBtn = btns.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('send'));
        }
        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
          sendBtn.click();
          return { clicked: true };
        }
        return { clicked: false, fallback: "needs-enter" };
      })()
    `,
    returnByValue: true
  });

  if (!sendRes?.result?.value?.clicked) {
    console.log("[CDP] Fallback: Pressing Enter key...");
    await sendCommand(ws, "Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", text: "\r" });
    await sendCommand(ws, "Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter" });
  }

  // 5. Watch the response stream live in the Google Chrome window!
  console.log("\n[CDP] Watching live response stream from Google Gemini Web:");
  console.log("------------------------------------------------------------");

  let lastLength = 0;
  let fullText = "";
  let finalUrl = "";
  let isDone = false;
  let idleCount = 0;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));

    const checkRes = await sendCommand(ws, "Runtime.evaluate", {
      expression: `
        (function() {
          const responses = document.querySelectorAll(
            'model-response, message-content, [data-test-id="model-response-text"], .model-response-text, .response-content, div.markdown'
          );
          let currentText = '';
          if (responses.length > 0) {
            const last = responses[responses.length - 1];
            currentText = last.innerText || last.textContent || '';
          }
          const stopBtn = document.querySelector('button[aria-label*="Stop"]') || document.querySelector('button[aria-label*="stop"]');
          return {
            text: currentText.trim(),
            generating: Boolean(stopBtn),
            url: window.location.href
          };
        })()
      `,
      returnByValue: true
    });

    const status = checkRes?.result?.value;
    if (status) {
      finalUrl = status.url;
      if (status.text && status.text.length > lastLength) {
        const delta = status.text.substring(lastLength);
        process.stdout.write(delta);
        lastLength = status.text.length;
        fullText = status.text;
        idleCount = 0;
      } else if (fullText.length > 0 && !status.generating) {
        idleCount++;
        if (idleCount >= 2) {
          isDone = true;
          break;
        }
      }
    }
  }

  console.log("\n------------------------------------------------------------");
  console.log("🟢 LIVE GENERATION COMPLETE!");
  console.log("Live Web URL on Google:", finalUrl);
  console.log("============================================================");

  ws.close();
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
