import crypto from "crypto";
import fs from "fs";
import path from "path";
import { session, WebContents } from "electron";

export interface GoogleSessionState {
  isLoggedIn: boolean;
  snlm0e?: string;
  cookiesStr?: string;
  sapisid?: string;
  authHeader?: string;
  email?: string;
  lastChecked: number;
}

export class SessionAuth {
  private static partitionName = "persist:gemini-web";
  private static sessionFilePath = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, "..", ".."), ".session.json");
  private static state: GoogleSessionState = {
    isLoggedIn: false,
    lastChecked: 0,
  };

  public static getPartition(): string {
    return this.partitionName;
  }

  public static getState(): GoogleSessionState {
    return this.state;
  }

  /**
   * Initializes session auth: loads any existing cached session from disk into Electron partition.
   */
  public static async init(): Promise<void> {
    await this.loadCachedSession();
    await this.refreshSession();
  }

  /**
   * Generates a fresh SAPISIDHASH Authorization header with current timestamp.
   */
  public static getFreshAuthHeader(): string | undefined {
    const sapisid = this.state.sapisid;
    if (!sapisid) return this.state.authHeader;

    const ts = Math.floor(Date.now() / 1000);
    const hash = crypto
      .createHash("sha1")
      .update(`${ts} ${sapisid} https://gemini.google.com`)
      .digest("hex");
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  /**
   * Imports session from CDP cookies array or raw cookie string + optional SNlM0e token.
   */
  public static async importSessionFromData(data: {
    cookies: any[] | string;
    snlm0e?: string;
  }): Promise<GoogleSessionState> {
    const sess = session.fromPartition(this.partitionName);

    let cookieList: any[] = [];
    if (typeof data.cookies === "string") {
      // Parse "key=value; key2=value2"
      const pairs = data.cookies.split(";");
      for (const pair of pairs) {
        const idx = pair.indexOf("=");
        if (idx > 0) {
          const name = pair.substring(0, idx).trim();
          const value = pair.substring(idx + 1).trim();
          cookieList.push({
            name,
            value,
            domain: ".google.com",
            path: "/",
            secure: true,
          });
        }
      }
    } else if (Array.isArray(data.cookies)) {
      cookieList = data.cookies;
    }

    // Inject cookies into Electron partition
    for (const c of cookieList) {
      try {
        let domain = c.domain || ".google.com";
        if (domain.startsWith(".")) domain = domain.substring(1);

        await sess.cookies.set({
          url: "https://gemini.google.com",
          name: c.name,
          value: c.value,
          domain: domain,
          path: c.path || "/",
          secure: c.secure !== false,
          httpOnly: c.httpOnly === true,
        });
      } catch (err) {
        // Skip incompatible cookie flags
      }
    }

    if (data.snlm0e) {
      this.state.snlm0e = data.snlm0e;
    }

    // Save to disk cache
    try {
      fs.writeFileSync(
        this.sessionFilePath,
        JSON.stringify(
          {
            cookies: cookieList,
            snlm0e: this.state.snlm0e,
            savedAt: Date.now(),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (err) {
      console.error("[SessionAuth] Failed to cache session to disk:", err);
    }

    return this.refreshSession();
  }

  /**
   * Loads cached session from disk if present.
   */
  public static async loadCachedSession(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.sessionFilePath)) return false;

      const raw = fs.readFileSync(this.sessionFilePath, "utf8");
      const data = JSON.parse(raw);

      if (data.snlm0e) {
        this.state.snlm0e = data.snlm0e;
      }

      if (Array.isArray(data.cookies) && data.cookies.length > 0) {
        const sess = session.fromPartition(this.partitionName);
        for (const c of data.cookies) {
          try {
            let domain = c.domain || ".google.com";
            if (domain.startsWith(".")) domain = domain.substring(1);

            await sess.cookies.set({
              url: "https://gemini.google.com",
              name: c.name,
              value: c.value,
              domain: domain,
              path: c.path || "/",
              secure: c.secure !== false,
              httpOnly: c.httpOnly === true,
            });
          } catch {}
        }
        return true;
      }
    } catch (err) {
      console.warn("[SessionAuth] Could not restore cached session:", err);
    }
    return false;
  }

  /**
   * Refreshes cookie tokens and extracts SNlM0e CSRF token from webContents.
   */
  public static async refreshSession(webContents?: WebContents): Promise<GoogleSessionState> {
    try {
      const sess = session.fromPartition(this.partitionName);
      const cookies = await sess.cookies.get({ url: "https://gemini.google.com" });

      if (cookies.length === 0) {
        this.state = {
          isLoggedIn: false,
          snlm0e: this.state.snlm0e,
          lastChecked: Date.now(),
        };
        return this.state;
      }

      const cookieMap = new Map<string, string>();
      for (const c of cookies) {
        cookieMap.set(c.name, c.value);
      }

      const cookiesStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const sapisid =
        cookieMap.get("SAPISID") ||
        cookieMap.get("__Secure-3PAPISID") ||
        cookieMap.get("__Secure-1PAPISID");

      let authHeader: string | undefined;
      if (sapisid) {
        const ts = Math.floor(Date.now() / 1000);
        const hash = crypto
          .createHash("sha1")
          .update(`${ts} ${sapisid} https://gemini.google.com`)
          .digest("hex");
        authHeader = `SAPISIDHASH ${ts}_${hash}`;
      }

      let snlm0e: string | undefined = this.state.snlm0e;
      if (webContents && !webContents.isDestroyed()) {
        try {
          const extracted = await webContents.executeJavaScript(
            "window.WIZ_global_data?.SNlM0e",
            true
          );
          if (typeof extracted === "string" && extracted.length > 5) {
            snlm0e = extracted;
          }
        } catch {}
      }

      const hasAuthCookies =
        cookieMap.has("SID") ||
        cookieMap.has("__Secure-1PSID") ||
        cookieMap.has("__Secure-3PSID");

      this.state = {
        isLoggedIn: Boolean(hasAuthCookies && (sapisid || authHeader)),
        snlm0e,
        cookiesStr,
        sapisid,
        authHeader,
        lastChecked: Date.now(),
      };

      return this.state;
    } catch (err) {
      console.error("[SessionAuth] Failed to refresh session:", err);
      return this.state;
    }
  }
}
