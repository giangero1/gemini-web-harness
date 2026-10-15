#!/usr/bin/env node
/**
 * Direct Gemini 4 Argon Web Runner for Google Antigravity
 * Exclusively routes prompts through authenticated Google Gemini Web (gemini.google.com)
 * Uses direct Chrome CDP WebSocket connection for instant (<100ms) injection via Quill,
 * genuine Gemini 4 Argon execution with High Thinking compute, and adaptive 100ms live streaming.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const SESSION_FILE = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, ".."), ".session.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    model: "argon",
    thinkingLevel: "high",
    prompt: "",
    promptFile: "",
    folder: "",
    file: "",
    instruction: "",
    status: false,
    outputFile: "",
    newChat: false,
    agent: true,
    noAgent: false,
    uploadZip: false,
    maxTurns: 15,
    convId: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--status") {
      options.status = true;
    } else if (arg === "--conv-id" && i + 1 < args.length) {
      options.convId = args[++i];
    } else if (arg === "--agent" || arg === "--tools" || arg === "--interactive") {
      options.agent = true;
    } else if (arg === "--no-agent" || arg === "--courier" || arg === "--static") {
      options.agent = false;
      options.noAgent = true;
    } else if (arg === "--upload-zip" || arg === "--full-repo" || arg === "--bulk") {
      options.uploadZip = true;
    } else if (arg === "--max-turns" && i + 1 < args.length) {
      options.maxTurns = parseInt(args[++i], 10) || 15;
    } else if (arg === "--new" || arg === "--fresh") {
      options.newChat = true;
    } else if ((arg === "--output" || arg === "--output-file") && i + 1 < args.length) {
      options.outputFile = args[++i];
    } else if (arg === "--folder" && i + 1 < args.length) {
      options.folder = args[++i];
    } else if (arg === "--file" && i + 1 < args.length) {
      options.file = args[++i];
    } else if (arg === "--instruction" && i + 1 < args.length) {
      options.instruction = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      options.model = args[++i].toLowerCase();
    } else if (arg === "--thinking-level" && i + 1 < args.length) {
      options.thinkingLevel = args[++i].toLowerCase();
    } else if (arg === "--prompt" && i + 1 < args.length) {
      options.prompt = args[++i];
    } else if (arg === "--prompt-file" && i + 1 < args.length) {
      options.promptFile = args[++i];
    }
  }

  return options;
}

function checkSession() {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error(`[Error] Session file not found at ${SESSION_FILE}. Please complete sign-in first.`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data.snlm0e || !Array.isArray(data.cookies) || data.cookies.length === 0) {
      console.error("[Error] Invalid session file contents.");
      process.exit(1);
    }
    return data;
  } catch (err) {
    console.error(`[Error] Failed to read session file: ${err.message}`);
    process.exit(1);
  }
}

async function getGeminiWsUrl() {
  const hosts = ["[::1]", "127.0.0.1", "localhost"];
  for (const host of hosts) {
    try {
      const list = await new Promise((resolve) => {
        const req = http.get(`http://${host}:9222/json`, { timeout: 1500 }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve([]);
            }
          });
        });
        req.on("error", () => resolve([]));
        req.on("timeout", () => {
          req.destroy();
          resolve([]);
        });
      });

      if (Array.isArray(list) && list.length > 0) {
        const geminiTab = list.find(
          (t) => t.type === "page" && t.url && t.url.includes("gemini.google.com")
        );
        if (geminiTab && geminiTab.webSocketDebuggerUrl) {
          return geminiTab.webSocketDebuggerUrl;
        }
      }
    } catch {}
  }
  return null;
}

function sendWs(ws, method, params = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) {
      resolve(null);
      return;
    }
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          ws.removeEventListener("message", handler);
          resolve(data.result);
        }
      } catch {}
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function getActiveTabUrl(ws) {
  const res = await sendWs(ws, "Runtime.evaluate", {
    expression: `window.location.href`,
    returnByValue: true,
  });
  return res?.result?.value || "";
}

async function startNewGeminiChat(ws) {
  console.log("[SessionSync] Clicking 'New Chat' button in Gemini Web UI...");
  await sendWs(ws, "Runtime.evaluate", {
    expression: `
      (function() {
        const btn = document.querySelector('button[aria-label*="New Chat" i], [aria-label*="New chat" i]') ||
                    Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('new chat'));
        if (btn) {
          btn.click();
          return "clicked";
        }
        window.location.href = "https://gemini.google.com/app";
        return "navigated";
      })()
    `,
  });
  await new Promise((r) => setTimeout(r, 800));

  await sendWs(ws, "Runtime.evaluate", {
    expression: `
      (function() {
        const input = document.querySelector('rich-textarea div[contenteditable="true"]');
        if (input && input.innerText.trim()) {
          input.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        }
      })()
    `,
  });
  await new Promise((r) => setTimeout(r, 200));
}

async function navigateToGeminiChat(ws, targetUrl) {
  const currentUrl = await getActiveTabUrl(ws);
  const targetPath = targetUrl.replace(/^https?:\/\/[^/]+/, "");
  if (!currentUrl.includes(targetPath)) {
    console.log(`[SessionSync] Switching Gemini Web tab to mapped thread: ${targetUrl}...`);
    await sendWs(ws, "Page.navigate", { url: targetUrl });
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function ensureModelSelectedInTab(ws, targetModel = "argon", targetThinking = "high") {
  console.log(`[Chrome CDP] Enforcing model: ${targetModel} (${targetThinking} thinking) in Gemini Web UI...`);
  const res = await sendWs(ws, "Runtime.evaluate", {
    expression: `
      (async function(targetModel, targetThinking) {
        const modeBtn = document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
                        document.querySelector('button[aria-label*="mode picker"]');
        if (!modeBtn) return { error: "No mode button" };

        const currentText = (modeBtn.innerText || '').toLowerCase();
        const targetM = (targetModel || 'argon').toLowerCase();
        const targetT = (targetThinking || 'high').toLowerCase();

        const modelMatches = targetM.includes('argon') ? currentText.includes('argon') :
                             targetM.includes('pro') ? currentText.includes('pro') :
                             targetM.includes('flash-lite') || targetM.includes('lite') ? currentText.includes('lite') :
                             targetM.includes('flash') ? (currentText.includes('flash') && !currentText.includes('lite')) : true;

        const thinkingMatches = targetT === 'high' ? currentText.includes('high') :
                                targetT === 'medium' ? currentText.includes('medium') :
                                targetT === 'low' ? currentText.includes('low') : true;

        if (modelMatches && thinkingMatches) {
          return { alreadySelected: true, text: modeBtn.innerText.trim() };
        }

        modeBtn.click();
        await new Promise(r => setTimeout(r, 450));

        const items = Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"]'));
        const modelOption = items.find(el => {
          const txt = (el.innerText || '').toLowerCase();
          const tid = (el.getAttribute('data-test-id') || '').toLowerCase();
          if (targetM.includes('argon')) return tid.includes('95a4c0abcba24364') || txt.includes('argon');
          if (targetM.includes('pro')) return tid.includes('e6fa609c3fa255c0') || txt.includes('3.1 pro') || txt.includes('pro');
          if (targetM.includes('flash-lite') || targetM.includes('lite')) return tid.includes('8c46e95b1a07cecc') || txt.includes('flash-lite');
          if (targetM.includes('flash')) return tid.includes('56fdd199312815e2') || (txt.includes('3.8 flash') && !txt.includes('lite'));
          return false;
        });

        if (modelOption) {
          const optText = modelOption.innerText || '';
          const isRateLimited = optText.toLowerCase().includes('limit resets') ||
                                modelOption.getAttribute('aria-disabled') === 'true';

          if (isRateLimited && !targetM.includes('flash-lite')) {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return {
              rateLimited: true,
              resetInfo: optText.trim(),
              text: modeBtn.innerText.trim()
            };
          }

          modelOption.click();
          await new Promise(r => setTimeout(r, 500));
        }

        if (!targetM.includes('flash-lite')) {
          modeBtn.click();
          await new Promise(r => setTimeout(r, 450));
          const freshItems = Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"]'));
          const targetItem = freshItems.find(el => {
            const txt = (el.innerText || '').toLowerCase();
            if (targetT === 'high') return txt.startsWith('high') || txt.includes('extra thorough');
            if (targetT === 'medium') return txt.startsWith('medium') || txt.includes('balanced');
            if (targetT === 'low') return txt.startsWith('low') || txt.includes('quick');
            return false;
          });
          if (targetItem) {
            const itemText = targetItem.innerText || '';
            if (itemText.toLowerCase().includes('limit resets') && targetT === 'high') {
              document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return {
                rateLimited: true,
                resetInfo: itemText.trim(),
                text: modeBtn.innerText.trim()
              };
            }
            targetItem.click();
            await new Promise(r => setTimeout(r, 450));
          } else {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          }
        }

        return { success: true, text: modeBtn.innerText.trim() };
      })(${JSON.stringify(targetModel)}, ${JSON.stringify(targetThinking)})
    `,
    awaitPromise: true,
    returnByValue: true
  });
  const state = res?.result?.value;
  if (state?.rateLimited) {
    console.warn(`[Chrome CDP] ⚠️ Quota limit detected on ${targetModel}: "${state.resetInfo}"`);
  } else {
    console.log(`[Chrome CDP] Active model confirmed: ${state?.text || "Argon High"}`);
  }
  return state;
}

async function executeViaDirectCdp(promptText, options) {
  const wsUrl = await getGeminiWsUrl();
  if (!wsUrl) {
    throw new Error("Could not find Gemini page on Chrome CDP (port 9222). Please ensure Chrome is running with remote debugging.");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error("WebSocket error: " + e.message));
  });

  // 1. Bring tab to front
  await sendWs(ws, "Page.bringToFront");

  // Synchronize session with Antigravity
  const { SessionSync } = require("../dist/bridge/session-sync");
  const targetFolder = options.folder || options.file || process.cwd();
  const activeConvId = SessionSync.resolveAntigravityConvId(options.convId, targetFolder);
  const existingSession = SessionSync.getSession(activeConvId);

  if (options.newChat || !existingSession) {
    console.log(`[SessionSync] Detected new Antigravity session "${activeConvId}" -> Initializing clean Gemini Web chat...`);
    await startNewGeminiChat(ws);
  } else if (existingSession && existingSession.geminiUrl) {
    await navigateToGeminiChat(ws, existingSession.geminiUrl);
  }

  // 2. Ensure Argon High Thinking is active in UI
  let modelState = await ensureModelSelectedInTab(ws, options.model || "argon", options.thinkingLevel || "high");
  if (modelState?.rateLimited) {
    const { AccountRotator } = require("../dist/bridge/account-rotator");
    await AccountRotator.syncFromActiveTab((m, p) => sendWs(ws, m, p));
    while (modelState?.rateLimited) {
      console.warn(`[Chrome CDP] ⚠️ Account slot #${AccountRotator.getCurrentSlot()} reached quota limit: "${modelState.resetInfo || 'Locked'}". Auto-rotating account...`);
      AccountRotator.markRateLimited(AccountRotator.getCurrentSlot(), modelState.resetInfo);

      const nextAccount = AccountRotator.getNextAvailableSlot();
      if (!nextAccount) {
        console.error(`[Chrome CDP] ❌ All account slots in the pool are rate-limited.`);
        break;
      }

      console.log(`[Chrome CDP] 🚀 Rotating to Account Slot #${nextAccount.slot}: ${nextAccount.url}...`);
      const switchRes = await AccountRotator.switchToSlot((m, p) => sendWs(ws, m, p), nextAccount.slot);
      if (switchRes.success) {
        modelState = await ensureModelSelectedInTab(ws, options.model || "argon", options.thinkingLevel || "high");
      } else {
        console.warn(`[Chrome CDP] Failed to switch to slot #${nextAccount.slot}: ${switchRes.error}`);
        break;
      }
    }
  }

  // Record initial response count before sending to isolate the response turn
  const countRes = await sendWs(ws, "Runtime.evaluate", {
    expression: `document.querySelectorAll('model-response, message-content, [data-test-id="model-response-text"]').length`,
    returnByValue: true
  });
  const initialCount = Number(countRes?.result?.value) || 0;

  // 3. Ultra-fast instant prompt injection via Quill Engine (<90ms)
  await sendWs(ws, "Runtime.evaluate", {
    expression: `
      (function(text) {
        const rich = document.querySelector('rich-textarea');
        const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                      document.querySelector('div[contenteditable="true"]') ||
                      document.querySelector('textarea');
        if (rich && rich.__quill) {
          rich.__quill.focus();
          rich.__quill.setContents([{ insert: text }], 'user');
          return { quill: true };
        }
        if (input) {
          input.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, text);
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return { fallback: true };
        }
        return { error: "No input found" };
      })(${JSON.stringify(promptText)})
    `,
    returnByValue: true
  });

  // Single space via CDP to instantly trigger Angular form control validation
  await sendWs(ws, "Input.insertText", { text: " " });
  await new Promise((r) => setTimeout(r, 50));

  // 4. Click Send message button
  const sendRes = await sendWs(ws, "Runtime.evaluate", {
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
        return { clicked: false };
      })()
    `,
    returnByValue: true
  });

  if (!sendRes?.result?.value?.clicked) {
    // Fallback: Press Enter key
    await sendWs(ws, "Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: "Enter",
      text: "\r"
    });
    await sendWs(ws, "Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: "Enter"
    });
  }

  // 5. Stream response with adaptive 100ms polling
  let lastLength = 0;
  let fullText = "";
  let idleCount = 0;

  for (let i = 0; i < 1500; i++) {
    await new Promise((r) => setTimeout(r, 100));

    const checkRes = await sendWs(ws, "Runtime.evaluate", {
      expression: `
        (function(initialCount) {
          const responses = document.querySelectorAll(
            'model-response, message-content, [data-test-id="model-response-text"]'
          );
          const isNew = responses.length > initialCount;
          let currentText = '';
          if (responses.length > 0 && isNew) {
            const last = responses[responses.length - 1];
            const contentEl = last.querySelector('.response-content, .markdown, [data-test-id="model-response-text"]') || last;
            currentText = contentEl.innerText || contentEl.textContent || '';
            currentText = currentText.replace(/^Gemini said\\s*/i, '');
          }
          const stopBtn = document.querySelector('button[aria-label*="Stop"]') || document.querySelector('button[aria-label*="stop"]');
          return {
            text: currentText.trim(),
            isNew: isNew,
            generating: Boolean(stopBtn),
            url: window.location.href
          };
        })(${initialCount})
      `,
      returnByValue: true
    });

    const status = checkRes?.result?.value;
    if (status) {
      if (status.text && status.text.length > lastLength && status.isNew) {
        const delta = status.text.substring(lastLength);
        process.stdout.write(delta);
        lastLength = status.text.length;
        fullText = status.text;
        idleCount = 0;
      } else if (fullText.length > 0 && !status.generating) {
        idleCount++;
        if (idleCount >= 7) { // 700ms of stable completion
          break;
        }
      }
    }
  }

  const finalUrl = await getActiveTabUrl(ws);
  if (finalUrl && finalUrl.includes("/app")) {
    SessionSync.saveSession(activeConvId, targetFolder, finalUrl);
    console.log(`\n[SessionSync] Saved session mapping: ${activeConvId} <-> ${finalUrl}`);
  }

  ws.close();
  return fullText;
}

async function main() {
  const options = parseArgs();
  const session = checkSession();

  if (options.status) {
    console.log("=".repeat(60));
    console.log("⚡ GEMINI WEB AUTHENTICATED SESSION STATUS");
    console.log(`Session File:    ${SESSION_FILE}`);
    console.log(`Cookies Count:   ${session.cookies.length} active cookies`);
    console.log(`CSRF Token:      ${session.snlm0e.substring(0, 20)}...`);
    console.log(`Default Model:   Gemini 4 Argon (Web Frontier Reasoning)`);
    console.log(`Thinking Mode:   High Thinking Effort (Enforced in Chrome UI)`);
    console.log(`Execution Mode:  Exclusive Live Webview (CDP Chrome Automation)`);
    console.log(`Cost:            $0.00 (Unlimited Pro Web Session)`);
    console.log("Status:          🟢 AUTHENTICATED & READY");
    console.log("=".repeat(60));
    return;
  }

  let prompt = options.prompt;
  const targetDir = options.folder || options.file;

  const isAgentTask = options.agent && !options.noAgent && (Boolean(options.instruction) || Boolean(targetDir) || !options.prompt);
  if (isAgentTask) {
    const { AgentLoop } = require("../dist/agent/agent-loop");
    const { FileIngester } = require("../dist/bridge/file-ingester");

    const workspaceDir = path.resolve(targetDir || process.cwd());
    let treeOverview = "";
    try {
      const ingested = FileIngester.ingest(workspaceDir, options.instruction || options.prompt);
      treeOverview = ingested.treeOverview;
    } catch {}

    const initialPrompt = AgentLoop.buildToolPrompt(options.instruction || options.prompt, treeOverview);
    const wsUrl = await getGeminiWsUrl();
    if (!wsUrl) {
      throw new Error("Could not find Gemini page on Chrome CDP (port 9222). Please ensure Chrome is running with remote debugging.");
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error("WebSocket error: " + e.message));
    });

    await sendWs(ws, "Page.bringToFront");

    // Synchronize session with Antigravity
    const { SessionSync } = require("../dist/bridge/session-sync");
    const activeConvId = SessionSync.resolveAntigravityConvId(options.convId, workspaceDir);
    const existingSession = SessionSync.getSession(activeConvId);

    if (options.newChat || !existingSession) {
      console.log(`[SessionSync] Detected new Antigravity session "${activeConvId}" -> Initializing clean Gemini Web chat...`);
      await startNewGeminiChat(ws);
    } else if (existingSession && existingSession.geminiUrl) {
      await navigateToGeminiChat(ws, existingSession.geminiUrl);
    }

    const agentResult = await AgentLoop.run(ws, {
      workspaceDir,
      initialPrompt,
      userInstruction: options.instruction || options.prompt,
      treeOverview,
      maxTurns: options.maxTurns,
      uploadZip: options.uploadZip,
      model: options.model || "argon",
      thinkingLevel: options.thinkingLevel || "high",
    });

    const finalUrl = await getActiveTabUrl(ws);
    if (finalUrl && finalUrl.includes("/app")) {
      SessionSync.saveSession(activeConvId, workspaceDir, finalUrl);
      console.log(`\n[SessionSync] Saved session mapping: ${activeConvId} <-> ${finalUrl}`);
    }

    ws.close();

    if (options.outputFile && agentResult.finalResponse) {
      try {
        fs.writeFileSync(options.outputFile, agentResult.finalResponse, "utf8");
        console.log(`\n[Saved complete Argon response to: ${options.outputFile}]`);
      } catch (err) {
        console.error(`\n[Failed to write output file]: ${err.message}`);
      }
    }
    return;
  }

  if (targetDir) {
    try {
      const { FileIngester } = require("../dist/bridge/file-ingester");
      const ingested = FileIngester.ingest(targetDir, options.instruction || options.prompt);
      console.log(`[FileIngester] Ingested ${ingested.fileCount} files (${(ingested.totalBytes / 1024).toFixed(1)} KB, ~${ingested.estimatedTokens} tokens) from: ${targetDir}`);
      prompt = ingested.packagedContent;
    } catch (err) {
      console.error(`[FileIngester Error]: ${err.message}`);
      process.exit(1);
    }
  } else if (!prompt && options.instruction) {
    // If instruction provided without folder, auto-ingest current working directory
    const cwd = process.cwd();
    try {
      const { FileIngester } = require("../dist/bridge/file-ingester");
      const ingested = FileIngester.ingest(cwd, options.instruction);
      console.log(`[FileIngester] Auto-ingested ${ingested.fileCount} files (${(ingested.totalBytes / 1024).toFixed(1)} KB, ~${ingested.estimatedTokens} tokens) from workspace: ${cwd}`);
      prompt = ingested.packagedContent;
    } catch (err) {
      prompt = options.instruction;
    }
  } else if (options.promptFile) {
    if (!fs.existsSync(options.promptFile)) {
      console.error(`[Error] Prompt file not found: ${options.promptFile}`);
      process.exit(1);
    }
    prompt = fs.readFileSync(options.promptFile, "utf8");
  } else if (!prompt) {
    try {
      prompt = fs.readFileSync(0, "utf8");
    } catch {}
  }

  if (!prompt || !prompt.trim()) {
    console.error("[Error] No prompt provided. Use --prompt, --prompt-file, --folder, or --instruction.");
    process.exit(1);
  }

  const responseText = await executeViaDirectCdp(prompt, options);
  console.log("\n");

  if (options.outputFile && responseText) {
    try {
      fs.writeFileSync(options.outputFile, responseText, "utf8");
      console.log(`\n[Saved complete Argon response to: ${options.outputFile}]`);
    } catch (err) {
      console.error(`\n[Failed to write output file]: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("[Fatal Error]", err.message);
  process.exit(1);
});
