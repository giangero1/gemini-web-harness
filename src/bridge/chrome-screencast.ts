import http from "http";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { BrowserWindow } from "electron";
import WebSocket from "ws";

export interface ChromeFrameData {
  data: string; // base64 jpeg
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp: number;
  };
  sessionId: number;
}

export class ChromeScreencastService {
  private static ws: any = null;
  private static chromeProcess: ChildProcess | null = null;
  private static activeWsUrl: string | null = null;
  private static cdpPort = 9222;
  private static profileDir = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, "..", ".."), ".chrome-profile");
  private static isConnecting = false;
  private static activePageId: string | null = null;
  private static mainWindow: BrowserWindow | null = null;
  private static isScreencasting = false;

  public static setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  public static findChromePath(): string | null {
    const candidates = [
      path.resolve(__dirname, "..", "..", ".chrome-bin", "chrome-win64", "chrome.exe"),
      path.resolve(process.cwd(), ".chrome-bin", "chrome-win64", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env.PROGRAMFILES || "", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google\\Chrome\\Application\\chrome.exe"),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Checks if Chrome CDP is responsive on port 9222 (IPv4 or IPv6)
   */
  public static async queryCdpTargets(): Promise<any[]> {
    const hosts = ["[::1]", "127.0.0.1", "localhost"];
    for (const host of hosts) {
      try {
        const list = await new Promise<any[]>((resolve, reject) => {
          const req = http.get(
            `http://${host}:${this.cdpPort}/json`,
            { timeout: 1500 },
            (res) => {
              let body = "";
              res.on("data", (c) => (body += c));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  resolve([]);
                }
              });
            }
          );
          req.on("error", () => resolve([]));
          req.on("timeout", () => {
            req.destroy();
            resolve([]);
          });
        });

        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      } catch {}
    }
    return [];
  }

  /**
   * Ensures Chrome is launched with remote debugging and returns the Gemini tab WebSocket URL.
   */
  public static async ensureChromeAndGetWs(): Promise<string> {
    let targets = await this.queryCdpTargets();

    if (targets.length === 0) {
      console.log("[ChromeScreencast] Chrome not detected on port 9222. Checking for Chrome binary...");
      let chromePath = this.findChromePath();
      if (!chromePath) {
        console.log("[ChromeScreencast] Chrome binary not found. Auto-provisioning portable Google Chrome...");
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("chrome-provisioning", { status: "downloading", percent: 0 });
        }
        try {
          const { ensurePortableChrome } = require(path.resolve(__dirname, "..", "..", "scripts", "download_chrome"));
          chromePath = await ensurePortableChrome((percent: number, mb: string, totalMb: string) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send("chrome-provisioning", { status: "downloading", percent, mb, totalMb });
            }
          });
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("chrome-provisioning", { status: "ready" });
          }
        } catch (provErr: any) {
          console.error("[ChromeScreencast] Auto-provisioning failed:", provErr);
          throw new Error(`Google Chrome not found and auto-download failed: ${provErr.message}`);
        }
      }

      if (!fs.existsSync(this.profileDir)) {
        fs.mkdirSync(this.profileDir, { recursive: true });
      }

      const args = [
        `--remote-debugging-port=${this.cdpPort}`,
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "https://gemini.google.com/app",
      ];

      if (!chromePath) {
        throw new Error("Could not locate or download Google Chrome binary.");
      }

      this.chromeProcess = spawn(chromePath, args, {
        detached: true,
        stdio: "ignore",
      });
      if (this.chromeProcess) {
        this.chromeProcess.unref();
      }

      // Poll until CDP is available (up to 12s)
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        targets = await this.queryCdpTargets();
        if (targets.length > 0) break;
      }
    }

    if (targets.length === 0) {
      throw new Error("Could not connect to Google Chrome via CDP on port 9222.");
    }

    let geminiTab = targets.find(
      (t) => t.type === "page" && t.url && t.url.includes("gemini.google.com")
    );

    if (!geminiTab) {
      // Find any page target or create new tab
      const anyPage = targets.find((t) => t.type === "page");
      if (anyPage && anyPage.id) {
        // Navigate it to Gemini
        geminiTab = anyPage;
      }
    }

    if (!geminiTab || !geminiTab.webSocketDebuggerUrl) {
      throw new Error("No accessible Gemini page target found in Chrome.");
    }

    this.activePageId = geminiTab.id;
    return geminiTab.webSocketDebuggerUrl;
  }

  /**
   * Starts screencasting live frames to mainWindow
   */
  public static async startScreencast(): Promise<boolean> {
    if (this.isScreencasting && this.ws) {
      return true;
    }

    try {
      const wsUrl = await this.ensureChromeAndGetWs();
      this.activeWsUrl = wsUrl;
      console.log("[ChromeScreencast] Connecting to WebSocket:", wsUrl);

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e: any) => reject(new Error("WebSocket error: " + e.message));
      });

      this.isScreencasting = true;
      console.log("[ChromeScreencast] WebSocket connected successfully! Starting Page.startScreencast...");

      // Bring to front and start screencast
      this.sendWs("Page.bringToFront");
      this.sendWs("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 1280,
        maxHeight: 820,
        everyNthFrame: 1,
      });

      let frameCount = 0;
      let lastFpsTime = Date.now();
      let framesInWindow = 0;
      let currentFps = 0;

      ws.onmessage = (event: any) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.method === "Page.screencastFrame") {
            frameCount++;
            framesInWindow++;
            const now = Date.now();
            if (now - lastFpsTime >= 1000) {
              currentFps = Math.round((framesInWindow * 1000) / (now - lastFpsTime));
              framesInWindow = 0;
              lastFpsTime = now;
              if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send("chrome-screencast-telemetry", {
                  fps: currentFps,
                  frameCount,
                  frameBytes: msg.params.data.length,
                  connected: true,
                });
              }
            }

            if (frameCount === 1 || frameCount % 60 === 0) {
              console.log(`[ChromeScreencast] Received frame #${frameCount} (size: ${msg.params.data.length} bytes, ${currentFps} fps)`);
            }
            const frame: ChromeFrameData = {
              data: msg.params.data,
              metadata: msg.params.metadata,
              sessionId: msg.params.sessionId,
            };

            // Acknowledge immediately for smooth fps
            this.sendWs("Page.screencastFrameAck", {
              sessionId: frame.sessionId,
            });

            // Send frame to renderer
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send("chrome-screencast-frame", frame);
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        console.log("[ChromeScreencast] WebSocket connection closed.");
        this.isScreencasting = false;
        this.ws = null;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("chrome-screencast-status", {
            connected: false,
          });
        }
      };

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("chrome-screencast-status", {
          connected: true,
          profile: "Google Chrome (CDP Port 9222)",
          url: "https://gemini.google.com/app",
        });
      }

      return true;
    } catch (err: any) {
      console.error("[ChromeScreencast Error]", err.message);
      this.isScreencasting = false;
      return false;
    }
  }

  public static sendWs(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) {
        resolve(null);
        return;
      }
      const id = Math.floor(Math.random() * 1000000);
      const handler = (event: any) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            this.ws?.removeEventListener("message", handler);
            resolve(data.result);
          }
        } catch {}
      };
      this.ws.addEventListener("message", handler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Forwards interactive mouse event from canvas to real Chrome
   */
  public static async forwardMouseEvent(event: {
    type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
  }) {
    if (!this.ws) return;
    await this.sendWs("Input.dispatchMouseEvent", event);
  }

  /**
   * Forwards keyboard event from canvas to real Chrome
   */
  public static async forwardKeyEvent(event: {
    type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
    windowsVirtualKeyCode?: number;
    nativeVirtualKeyCode?: number;
    key?: string;
    text?: string;
    unmodifiedText?: string;
  }) {
    if (!this.ws) return;
    await this.sendWs("Input.dispatchKeyEvent", event);
  }

  /**
   * Switches Chrome CDP session to target Google Account slot (/u/0..4)
   */
  public static async switchToAccountSlot(slot: number): Promise<{ success: boolean; url: string; email?: string; error?: string }> {
    const { AccountRotator } = require("./account-rotator");
    return AccountRotator.switchToSlot((method: string, params?: any) => this.sendWs(method, params), slot);
  }

  /**
   * Ensures the requested model and thinking level are selected in Chrome Gemini Web UI
   */
  public static async ensureModelSelected(
    targetModel: string = "argon",
    targetThinking: string = "high"
  ): Promise<{ selectedModel: string; thinkingLevel: string }> {
    console.log(`[ChromeScreencast] Enforcing model: ${targetModel} (${targetThinking} thinking) in Chrome UI...`);
    const evalRes = await this.sendWs("Runtime.evaluate", {
      expression: `
        (async function(targetModel, targetThinking) {
          const modeBtn = document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
                          document.querySelector('button[aria-label*="mode picker"]');
          if (!modeBtn) return { error: "No mode button found" };

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
            return {
              alreadySelected: true,
              buttonText: modeBtn.innerText.trim(),
              aria: modeBtn.getAttribute('aria-label')
            };
          }

          // Step 1: Open model menu
          modeBtn.click();
          await new Promise(r => setTimeout(r, 450));

          // Step 2: Check target model for rate-limiting
          const items = Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"]'));
          const modelOption = items.find(el => {
            const txt = (el.innerText || '').toLowerCase();
            const tid = (el.getAttribute('data-test-id') || '').toLowerCase();
            if (targetM.includes('argon')) {
              return tid.includes('95a4c0abcba24364') || txt.includes('argon');
            } else if (targetM.includes('pro')) {
              return tid.includes('e6fa609c3fa255c0') || txt.includes('3.1 pro') || txt.includes('pro');
            } else if (targetM.includes('flash-lite') || targetM.includes('lite')) {
              return tid.includes('8c46e95b1a07cecc') || txt.includes('flash-lite');
            } else if (targetM.includes('flash')) {
              return tid.includes('56fdd199312815e2') || (txt.includes('3.8 flash') && !txt.includes('lite'));
            }
            return false;
          });

          if (modelOption) {
            const optText = modelOption.innerText || '';
            const isRateLimited = optText.toLowerCase().includes('limit resets') ||
                                  modelOption.getAttribute('aria-disabled') === 'true' ||
                                  (modelOption as any).disabled === true;

            if (isRateLimited && !targetM.includes('flash-lite')) {
              document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return {
                rateLimited: true,
                resetInfo: optText.trim(),
                buttonText: modeBtn.innerText.trim(),
                aria: modeBtn.getAttribute('aria-label')
              };
            }

            modelOption.click();
            await new Promise(r => setTimeout(r, 500));
          }

          // Step 3: Enforce Thinking Level
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
                  buttonText: modeBtn.innerText.trim(),
                  aria: modeBtn.getAttribute('aria-label')
                };
              }
              targetItem.click();
              await new Promise(r => setTimeout(r, 450));
            } else {
              document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
          }

          return {
            success: true,
            buttonText: modeBtn.innerText.trim(),
            aria: modeBtn.getAttribute('aria-label')
          };
        })(${JSON.stringify(targetModel)}, ${JSON.stringify(targetThinking)})
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const val = evalRes?.result?.value;
    if (val?.rateLimited) {
      console.warn(`[ChromeScreencast] ⚠️ Quota limit detected on ${targetModel}: "${val.resetInfo}"`);
      return {
        selectedModel: val?.buttonText || "Flash-Lite",
        thinkingLevel: "None",
        rateLimited: true,
        resetTimeText: val?.resetInfo,
      } as any;
    }

    console.log(`[ChromeScreencast] Active model in Chrome is now:`, val?.buttonText || "Argon High");
    return {
      selectedModel: val?.buttonText || "Argon",
      thinkingLevel: val?.buttonText?.includes("High") ? "High" : targetThinking,
      rateLimited: false,
    } as any;
  }

  /**
   * Executes a live prompt inside real Google Chrome via CDP
   */
  public static async executeLivePrompt(
    promptText: string,
    onChunk?: (text: string) => void,
    model: string = "argon",
    thinking: string = "high"
  ): Promise<{ response: string; conversationTitle: string; conversationUrl: string; activeModel: string }> {
    await this.startScreencast();

    console.log("[ChromeScreencast] Bringing tab to front and clearing dialogs...");
    await this.sendWs("Page.bringToFront");

    // Enforce selected model (e.g. 4 Argon with High Thinking) in Chrome UI!
    const modelState = await this.ensureModelSelected(model, thinking);

    // 1. Locate input box and dismiss any onboarding
    const initRes = await this.sendWs("Runtime.evaluate", {
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
      returnByValue: true,
    });

    if (!initRes?.result?.value?.success) {
      throw new Error("Could not find prompt input box in Google Chrome.");
    }

    // 2. Ultra-Fast Prompt Injection via Quill Engine
    console.log(`[ChromeScreencast] Injecting ${promptText.length} characters into Google Gemini via Quill...`);
    await this.sendWs("Runtime.evaluate", {
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
      returnByValue: true,
    });

    // Send single character via CDP to wake up Angular form validation immediately (< 5ms)
    await this.sendWs("Input.insertText", { text: " " });
    await new Promise((r) => setTimeout(r, 60));

    // Record initial response count before sending to isolate the new generation
    const beforeCountRes = await this.sendWs("Runtime.evaluate", {
      expression: `document.querySelectorAll('model-response, message-content, [data-test-id="model-response-text"]').length`,
      returnByValue: true,
    });
    const initialResponseCount = Number(beforeCountRes?.result?.value) || 0;

    // 3. Click Send
    console.log("[ChromeScreencast] Clicking Google Gemini Send button...");
    const sendRes = await this.sendWs("Runtime.evaluate", {
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
      returnByValue: true,
    });

    if (!sendRes?.result?.value?.clicked) {
      console.log("[ChromeScreencast] Fallback: Pressing Enter key...");
      await this.sendWs("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: "Enter",
        text: "\r",
      });
      await this.sendWs("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: "Enter",
      });
    }

    // 4. Stream response and capture URL (Fast 100ms adaptive polling)
    console.log(`[ChromeScreencast] Watching live response stream from Google Gemini Web (waiting for turn #${initialResponseCount + 1})...`);
    let lastLength = 0;
    let fullText = "";
    let finalUrl = "https://gemini.google.com/app";
    let finalTitle = "Google Gemini Chat";
    let idleCount = 0;

    for (let i = 0; i < 1500; i++) {
      await new Promise((r) => setTimeout(r, 100));

      const checkRes = await this.sendWs("Runtime.evaluate", {
        expression: `
          (function(initialCount) {
            const responses = document.querySelectorAll(
              'model-response, message-content, [data-test-id="model-response-text"]'
            );
            const isNewResponse = responses.length > initialCount;
            let currentText = '';
            if (responses.length > 0 && isNewResponse) {
              const last = responses[responses.length - 1];
              currentText = last.innerText || last.textContent || '';
              currentText = currentText.replace(/^Gemini said\\s*/i, '');
            }
            const stopBtn = document.querySelector('button[aria-label*="Stop"]') || document.querySelector('button[aria-label*="stop"]');
            
            // Get active title from sidebar
            const activeTitleEl = document.querySelector('.conversation-item.active, [aria-selected="true"], nav a[aria-current="page"]');
            const activeTitle = activeTitleEl ? (activeTitleEl.innerText || activeTitleEl.textContent || '').trim() : '';

            return {
              text: currentText.trim(),
              isNew: isNewResponse,
              generating: Boolean(stopBtn),
              url: window.location.href,
              title: activeTitle || document.title
            };
          })(${initialResponseCount})
        `,
        returnByValue: true,
      });

      const status = checkRes?.result?.value;
      if (status) {
        finalUrl = status.url || finalUrl;
        finalTitle = status.title || finalTitle;

        if (status.text && status.text.length > lastLength && status.isNew) {
          const delta = status.text.substring(lastLength);
          if (onChunk) onChunk(delta);
          lastLength = status.text.length;
          fullText = status.text;
          idleCount = 0;
        } else if (fullText.length > 0 && !status.generating) {
          idleCount++;
          if (idleCount >= 8) { // 800ms of stable completion
            break;
          }
        }
      }
    }

    return {
      response: fullText,
      conversationTitle: finalTitle,
      conversationUrl: finalUrl,
      activeModel: modelState.selectedModel || "Argon",
    };
  }

  /**
   * Focuses and brings the Chrome window to the front on the user's screen
   */
  public static async bringChromeToFront(url?: string) {
    if (url && this.ws) {
      await this.sendWs("Page.navigate", { url });
    }
    await this.sendWs("Page.bringToFront");

    // Also focus via system command if possible
    try {
      const { exec } = require("child_process");
      exec('powershell -Command "$p = Get-Process chrome | Where-Object { $_.MainWindowTitle } | Select-Object -First 1; if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) }"');
    } catch {}
  }
}
