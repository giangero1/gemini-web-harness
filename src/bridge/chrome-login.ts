import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import { SessionAuth } from "./session-auth";

export class ChromeLoginService {
  private static chromeProcess: ChildProcess | null = null;
  private static cdpPort = 9222;
  private static profileDir = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, "..", ".."), ".chrome-profile");
  private static isPolling = false;
  private static pollTimer: NodeJS.Timeout | null = null;

  public static findChromePath(): string | null {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env.PROGRAMFILES || "", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  public static async launchAndCapture(
    onLog: (msg: string) => void,
    onSuccess: () => void
  ): Promise<boolean> {
    if (this.isPolling) {
      onLog("[Chrome] Already waiting for Google login. Check your Chrome window.");
      return true;
    }

    const chromePath = this.findChromePath();
    if (!chromePath) {
      onLog("[Chrome Error] Google Chrome binary not found on this system.");
      return false;
    }

    if (!fs.existsSync(this.profileDir)) {
      try {
        fs.mkdirSync(this.profileDir, { recursive: true });
      } catch (err: any) {
        onLog(`[Chrome Error] Could not create profile directory: ${err.message}`);
      }
    }

    onLog(`[Chrome] Launching official Google Chrome: ${chromePath}`);
    onLog(`[Chrome] Profile directory on D: drive: ${this.profileDir}`);

    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://gemini.google.com/app",
    ];

    try {
      this.chromeProcess = spawn(chromePath, args, {
        detached: true,
        stdio: "ignore",
      });
      this.chromeProcess.unref();
    } catch (err: any) {
      onLog(`[Chrome Error] Failed to launch Chrome: ${err.message}`);
      return false;
    }

    onLog("[Chrome] Google Chrome opened! Please sign in with your Google account.");
    onLog("[Chrome] (Google does not block official Google Chrome!)");
    onLog("[Chrome] Listening via CDP to capture session tokens automatically...");

    this.startPolling(onLog, onSuccess);
    return true;
  }

  private static startPolling(
    onLog: (msg: string) => void,
    onSuccess: () => void
  ) {
    this.isPolling = true;
    let attempts = 0;
    const maxAttempts = 120; // 3 minutes timeout

    const check = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        this.stopPolling();
        onLog("[Chrome] Login capture timed out (3 minutes). Click 'Sign In via Chrome' to try again.");
        return;
      }

      try {
        const targets = await this.fetchTargets();
        const geminiTarget = targets.find(
          (t) => t.type === "page" && t.url && t.url.includes("gemini.google.com")
        );

        if (!geminiTarget) {
          const authTarget = targets.find(
            (t) => t.type === "page" && t.url && t.url.includes("accounts.google.com")
          );
          if (authTarget && attempts % 5 === 0) {
            onLog("[Chrome] Detected Google Sign-in page. Please complete login in Chrome...");
          }
        } else if (geminiTarget.webSocketDebuggerUrl) {
          // Attempt to extract session via CDP WebSocket
          const result = await this.extractSessionFromTarget(geminiTarget.webSocketDebuggerUrl);
          if (result && result.isComplete) {
            this.stopPolling();
            onLog("[Chrome Success] Authenticated Gemini session captured successfully!");
            onLog(`[Chrome Success] SNlM0e token: ${result.snlm0e ? result.snlm0e.substring(0, 15) + "..." : "none"}`);
            onLog(`[Chrome Success] Captured ${result.cookies.length} session cookies.`);

            await SessionAuth.importSessionFromData({
              cookies: result.cookies,
              snlm0e: result.snlm0e,
            });

            onSuccess();
            return;
          }
        }
      } catch (err: any) {
        // CDP endpoint not ready yet
      }

      if (this.isPolling) {
        this.pollTimer = setTimeout(check, 1500);
      }
    };

    this.pollTimer = setTimeout(check, 2000);
  }

  public static stopPolling() {
    this.isPolling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private static fetchTargets(): Promise<any[]> {
    return new Promise(async (resolve) => {
      for (const host of ["127.0.0.1", "[::1]"]) {
        try {
          const res = await fetch(`http://${host}:${this.cdpPort}/json`);
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            resolve(data);
            return;
          }
        } catch {}
      }
      resolve([]);
    });
  }

  private static extractSessionFromTarget(wsUrl: string): Promise<{
    isComplete: boolean;
    snlm0e?: string;
    cookies: any[];
  }> {
    return new Promise((resolve) => {
      let resolved = false;
      let ws: WebSocket;

      const finish = (result: { isComplete: boolean; snlm0e?: string; cookies: any[] }) => {
        if (!resolved) {
          resolved = true;
          try {
            ws.close();
          } catch {}
          resolve(result);
        }
      };

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        resolve({ isComplete: false, cookies: [] });
        return;
      }

      const timeout = setTimeout(() => {
        finish({ isComplete: false, cookies: [] });
      }, 3000);

      let snlm0e: string | undefined;
      let cookies: any[] = [];

      ws.onopen = () => {
        // 1. Enable network
        ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
        // 2. Query cookies
        ws.send(
          JSON.stringify({
            id: 2,
            method: "Network.getCookies",
            params: { urls: ["https://gemini.google.com", "https://google.com"] },
          })
        );
        // 3. Query SNlM0e CSRF token from window.WIZ_global_data
        ws.send(
          JSON.stringify({
            id: 3,
            method: "Runtime.evaluate",
            params: {
              expression: "window.WIZ_global_data ? window.WIZ_global_data.SNlM0e : null",
              returnByValue: true,
            },
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.id === 2 && msg.result && Array.isArray(msg.result.cookies)) {
            cookies = msg.result.cookies;
          }
          if (msg.id === 3 && msg.result && msg.result.result) {
            if (typeof msg.result.result.value === "string") {
              snlm0e = msg.result.result.value;
            }
          }

          const hasAuthCookie = cookies.some(
            (c) => c.name === "__Secure-1PSID" || c.name === "SID"
          );
          const hasSapisid = cookies.some(
            (c) => c.name === "SAPISID" || c.name === "__Secure-3PAPISID" || c.name === "__Secure-1PAPISID"
          );

          if (hasAuthCookie && hasSapisid && snlm0e && snlm0e.length > 5) {
            clearTimeout(timeout);
            finish({ isComplete: true, snlm0e, cookies });
          }
        } catch {
          // parse error
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        finish({ isComplete: false, cookies: [] });
      };
    });
  }
}
