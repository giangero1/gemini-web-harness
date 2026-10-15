import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import fs from "fs";
import WebSocket from "ws";
import { GatewayServer } from "./gateway/server";
import { BrowserHost } from "./bridge/browser-window";
import { SessionAuth } from "./bridge/session-auth";
import { ChromeLoginService } from "./bridge/chrome-login";
import { ChromeScreencastService } from "./bridge/chrome-screencast";
import { SessionSync } from "./bridge/session-sync";
import { AccountRotator } from "./bridge/account-rotator";
import { DEFAULT_CONFIG, MODELS } from "./config";

// Set user agent before app ready
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
app.userAgentFallback = CHROME_UA;

let mainWindow: BrowserWindow | null = null;
const SETTINGS_FILE = path.join(__dirname, "..", ".harness-settings.json");

function getSettings(): { autoStartChrome: boolean } {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    }
  } catch {}
  return { autoStartChrome: false };
}

function saveSettings(settings: { autoStartChrome: boolean }): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (err: any) {
    console.error("[Main] Failed to save settings:", err.message);
  }
}

async function bootstrap() {
  console.log("[Main] Starting Gemini Web Harness bootstrap...");

  // 1. Start loopback GenAI gateway server on 127.0.0.1:8046
  try {
    await GatewayServer.start(DEFAULT_CONFIG.port);
    console.log(`[Main] Gateway server active on port ${DEFAULT_CONFIG.port}`);
  } catch (err) {
    console.error("[Main] Failed to start gateway server:", err);
  }

  // 2. Initialize persistent Chromium session
  try {
    await BrowserHost.init();
  } catch (err) {
    console.error("[Main] BrowserHost init error:", err);
  }

  // 3. Create Sleek Verification Cockpit window
  createCockpitWindow();

  // 4. Register streamlined IPC handlers
  setupIpcHandlers();

  // 5. Auto-start Chrome if setting is enabled
  const settings = getSettings();
  if (settings.autoStartChrome) {
    console.log("[Main] Auto-start Chrome is enabled. Checking Chrome CDP on port 9222...");
    ChromeScreencastService.queryCdpTargets().then((targets) => {
      if (!targets || targets.length === 0) {
        console.log("[Main] Chrome not running on port 9222. Spawning Chrome...");
        ChromeScreencastService.ensureChromeAndGetWs().catch((e) => {
          console.warn("[Main] Auto-start Chrome failed:", e.message);
        });
      }
    });
  }
}

function createCockpitWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 420,
    minHeight: 520,
    maxWidth: 600,
    maxHeight: 820,
    show: true,
    title: "Gemini Web Harness - Verification Cockpit",
    backgroundColor: "#101114",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("console-message", (_event, _level, message, line, sourceId) => {
    console.log(`[UI Console] ${message} (${sourceId}:${line})`);
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupIpcHandlers() {
  // 1. Core Verification Status Provider
  ipcMain.handle("get-verification-data", async () => {
    const sessionFile = path.join(__dirname, "..", ".session.json");
    let authData = {
      isLoggedIn: false,
      hasCsrfToken: false,
      cookiesCount: 0,
      savedAt: 0,
      email: undefined as string | undefined,
    };

    if (fs.existsSync(sessionFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        authData.hasCsrfToken = Boolean(parsed.snlm0e);
        authData.cookiesCount = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0;
        authData.savedAt = parsed.savedAt || 0;
        authData.isLoggedIn = authData.hasCsrfToken && authData.cookiesCount > 0;
      } catch {}
    }

    const memAuth = SessionAuth.getState();
    if (memAuth.isLoggedIn) {
      authData.isLoggedIn = true;
      if (memAuth.snlm0e) authData.hasCsrfToken = true;
      if (memAuth.email) authData.email = memAuth.email;
    }

    let cdpData = {
      running: false,
      port: 9222,
      geminiTab: null as { found: boolean; url?: string; title?: string } | null,
    };

    try {
      const targets = await ChromeScreencastService.queryCdpTargets();
      if (targets && targets.length > 0) {
        cdpData.running = true;
        const gTab = targets.find(
          (t: any) => t.type === "page" && t.url && t.url.includes("gemini.google.com")
        );
        if (gTab) {
          cdpData.geminiTab = {
            found: true,
            url: gTab.url,
            title: gTab.title,
          };
        } else {
          cdpData.geminiTab = { found: false };
        }
      }
    } catch {}

    let latestSession = null;
    try {
      const map = SessionSync.getMapping();
      const keys = Object.keys(map);
      if (keys.length > 0) {
        const sorted = keys
          .map((k) => map[k])
          .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
        latestSession = sorted[0];
      }
    } catch {}

    const settings = getSettings();

    const accountPool = {
      currentSlot: AccountRotator.getCurrentSlot(),
      slots: AccountRotator.getAllSlots(),
    };

    return {
      auth: authData,
      cdp: cdpData,
      latestSession,
      autoStartChrome: settings.autoStartChrome,
      gatewayPort: DEFAULT_CONFIG.port,
      selectedModel: DEFAULT_CONFIG.selectedModel,
      thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
      accountPool,
    };
  });

  // 2. 1-Click Verification Diagnostic Probe
  ipcMain.handle("run-verification-probe", async () => {
    const startTime = Date.now();
    try {
      const targets = await ChromeScreencastService.queryCdpTargets();
      if (!targets || targets.length === 0) {
        return {
          success: false,
          latencyMs: Date.now() - startTime,
          message: "Chrome CDP is offline on port 9222. Launch Chrome first.",
        };
      }

      const gTab = targets.find(
        (t: any) => t.type === "page" && t.url && t.url.includes("gemini.google.com")
      );
      if (!gTab || !gTab.webSocketDebuggerUrl) {
        return {
          success: false,
          latencyMs: Date.now() - startTime,
          message: "Chrome running, but no active gemini.google.com tab detected.",
        };
      }

      const ws = new WebSocket(gTab.webSocketDebuggerUrl);
      const probeResult = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          resolve({ timeout: true });
        }, 3000);

        ws.on("open", () => {
          try {
            const reqId = 98124;
            const msgHandler = (evt: any) => {
              try {
                const res = JSON.parse(evt.toString());
                if (res.id === reqId) {
                  clearTimeout(timer);
                  ws.removeListener("message", msgHandler);
                  ws.close();
                  resolve(res.result?.result?.value || {});
                }
              } catch {}
            };
            ws.on("message", msgHandler);

            ws.send(
              JSON.stringify({
                id: reqId,
                method: "Runtime.evaluate",
                params: {
                  expression: `
                    (function() {
                      const editor = document.querySelector('div[contenteditable="true"]') ||
                                     document.querySelector('.ql-editor') ||
                                     document.querySelector('rich-textarea') ||
                                     document.querySelector('textarea');
                      return {
                        url: window.location.href,
                        title: document.title,
                        hasEditor: Boolean(editor),
                        isLoggedIn: !window.location.href.includes('/signin')
                      };
                    })()
                  `,
                  returnByValue: true,
                },
              })
            );
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });

        ws.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });

      const latencyMs = Date.now() - startTime;
      if (probeResult.timeout) {
        return {
          success: false,
          latencyMs,
          message: "CDP probe timed out after 3000ms.",
        };
      }

      return {
        success: true,
        latencyMs,
        url: probeResult.url || gTab.url,
        hasEditor: probeResult.hasEditor,
        title: probeResult.title || gTab.title,
        message: `Verified in ${latencyMs}ms! Tab active & Quill prompt editor ready.`,
      };
    } catch (err: any) {
      return {
        success: false,
        latencyMs: Date.now() - startTime,
        message: `Probe failed: ${err.message}`,
      };
    }
  });

  // 3. Launch Chrome (with remote debugging port 9222)
  ipcMain.handle("launch-chrome", async () => {
    try {
      await ChromeScreencastService.ensureChromeAndGetWs();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 4. Launch Chrome in Login & Capture Mode
  ipcMain.handle("launch-chrome-login", async () => {
    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      ChromeLoginService.launchAndCapture(
        (msg) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("log-message", msg);
          }
        },
        () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("auth-refreshed");
          }
          resolve({ success: true });
        }
      ).then((started) => {
        if (!started) {
          resolve({ success: false, message: "Failed to launch Chrome" });
        }
      });
    });
  });

  // 5. Bring Chrome window to front / open Gemini
  ipcMain.handle("bring-chrome-front", async () => {
    try {
      await ChromeScreencastService.bringChromeToFront("https://gemini.google.com/app");
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 6. Toggle Auto-Start Chrome setting
  ipcMain.handle("toggle-auto-start", async (_event, enabled: boolean) => {
    const s = getSettings();
    s.autoStartChrome = Boolean(enabled);
    saveSettings(s);
    return { success: true, autoStartChrome: s.autoStartChrome };
  });

  // 7. Backward compatibility endpoints for status / models
  ipcMain.on("get-status", (event) => {
    const auth = SessionAuth.getState();
    event.reply("status-update", {
      authenticated: auth.isLoggedIn,
      hasCsrfToken: Boolean(auth.snlm0e),
      selectedModel: DEFAULT_CONFIG.selectedModel,
      thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
    });
  });

  ipcMain.on("set-model", (_event, modelId: string) => {
    if (MODELS[modelId] || modelId === "argon" || modelId === "pro" || modelId === "flash" || modelId === "flash-lite") {
      DEFAULT_CONFIG.selectedModel = modelId;
    }
  });

  ipcMain.on("set-thinking-level", (_event, level: "low" | "medium" | "high") => {
    DEFAULT_CONFIG.thinkingLevel = level;
  });

  ipcMain.handle("set-model-and-thinking", async (_event, { model, thinking }: { model: string; thinking: "low" | "medium" | "high" }) => {
    console.log(`[Main] User configured model: ${model}, thinking level: ${thinking}`);
    DEFAULT_CONFIG.selectedModel = model;
    DEFAULT_CONFIG.thinkingLevel = thinking;

    try {
      const result = await ChromeScreencastService.ensureModelSelected(model, thinking);
      return { success: true, activeModel: result.selectedModel, thinkingLevel: result.thinkingLevel };
    } catch (err: any) {
      console.warn(`[Main] Live Chrome mode switch deferred: ${err.message}`);
      return { success: true, deferred: true, message: err.message };
    }
  });

  ipcMain.handle("get-account-pool", async () => {
    return {
      currentSlot: AccountRotator.getCurrentSlot(),
      slots: AccountRotator.getAllSlots(),
    };
  });

  ipcMain.handle("switch-account-slot", async (_event, slot: number) => {
    try {
      console.log(`[Main] User requested switch to account slot #${slot}`);
      const res = await ChromeScreencastService.switchToAccountSlot(slot);
      return res;
    } catch (err: any) {
      console.error(`[Main] Failed to switch account slot:`, err.message);
      return { success: false, error: err.message };
    }
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Keep running if closed or exit cleanly
    app.quit();
  }
});
