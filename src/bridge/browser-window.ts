import { app, BrowserWindow, session } from "electron";
import { SessionAuth } from "./session-auth";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export class BrowserHost {
  private static browserWindow: BrowserWindow | null = null;

  public static async init(): Promise<void> {
    app.userAgentFallback = CHROME_UA;
    const sess = session.fromPartition(SessionAuth.getPartition());

    sess.setUserAgent(CHROME_UA);

    // Strip Electron identification from request headers
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders["User-Agent"] = CHROME_UA;
      if (details.requestHeaders["sec-ch-ua"]) {
        details.requestHeaders["sec-ch-ua"] =
          '"Chromium";v="133", "Google Chrome";v="133", "Not?A_Brand";v="99"';
      }
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    });

    // Load any cached session from disk
    await SessionAuth.init();
  }

  public static openAuthWindow(): BrowserWindow {
    if (this.browserWindow && !this.browserWindow.isDestroyed()) {
      this.browserWindow.show();
      this.browserWindow.focus();
      return this.browserWindow;
    }

    this.browserWindow = new BrowserWindow({
      width: 1050,
      height: 750,
      title: "Gemini Web Authentication & Session Window",
      webPreferences: {
        partition: SessionAuth.getPartition(),
        contextIsolation: false,
        nodeIntegration: false,
      },
    });

    this.browserWindow.loadURL("https://gemini.google.com/app", {
      userAgent: CHROME_UA,
    });

    // When navigation completes, refresh session tokens & dismiss onboarding overlays
    this.browserWindow.webContents.on("did-finish-load", async () => {
      await SessionAuth.refreshSession(this.browserWindow?.webContents);

      // Auto-dismiss onboarding "Let's go" / "Got it" modals
      try {
        await this.browserWindow?.webContents.executeJavaScript(`
          (function autoDismiss() {
            function check() {
              const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
              const letsGo = buttons.find(b => {
                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                return txt.includes("let's go") || txt.includes("dismiss") || txt.includes("got it");
              });
              if (letsGo) {
                letsGo.click();
                console.log("[Harness Webview] Auto-dismissed onboarding modal");
              }
            }
            check();
            setTimeout(check, 800);
            setTimeout(check, 2000);
            setTimeout(check, 4000);
          })();
        `);
      } catch {}
    });

    this.browserWindow.on("closed", () => {
      this.browserWindow = null;
    });

    return this.browserWindow;
  }

  public static getBrowserWindow(): BrowserWindow | null {
    return this.browserWindow;
  }
}
