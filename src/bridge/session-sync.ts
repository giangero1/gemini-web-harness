import fs from "fs";
import path from "path";

export interface SessionMapping {
  antigravityConvId: string;
  workspaceDir: string;
  geminiUrl: string;
  lastUpdated: number;
}

export class SessionSync {
  private static mappingFile = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, "..", ".."), ".session-mapping.json");

  /**
   * Resolves the Antigravity conversation ID:
   * 1. Uses explicit convId if provided on the command line.
   * 2. Auto-detects the active brain directory in ~/.gemini/antigravity/brain
   * 3. Fallback: generates a workspace-scoped hash.
   */
  public static resolveAntigravityConvId(explicitId?: string, workspaceDir?: string): string {
    if (explicitId && explicitId.trim() && explicitId !== "<conversation-id>") {
      return explicitId.trim();
    }

    try {
      const userProfile = process.env.USERPROFILE || process.env.HOME || "";
      const brainDir = path.join(userProfile, ".gemini", "antigravity", "brain");
      if (fs.existsSync(brainDir)) {
        const dirs = fs.readdirSync(brainDir, { withFileTypes: true });
        const validDirs = dirs
          .filter((d) => d.isDirectory() && d.name !== "tempmediaStorage")
          .map((d) => {
            const transcript = path.join(brainDir, d.name, ".system_generated", "logs", "transcript.jsonl");
            let mtime = 0;
            if (fs.existsSync(transcript)) {
              mtime = fs.statSync(transcript).mtimeMs;
            } else {
              mtime = fs.statSync(path.join(brainDir, d.name)).mtimeMs;
            }
            return { name: d.name, mtime };
          })
          .sort((a, b) => b.mtime - a.mtime);

        // If the newest transcript was active in the last 15 minutes, bind to it!
        if (validDirs.length > 0 && Date.now() - validDirs[0].mtime < 15 * 60 * 1000) {
          return validDirs[0].name;
        }
      }
    } catch {}

    if (workspaceDir) {
      return "ws_" + Buffer.from(path.resolve(workspaceDir)).toString("base64url").substring(0, 24);
    }

    return "default_session";
  }

  public static getMapping(): Record<string, SessionMapping> {
    try {
      if (fs.existsSync(this.mappingFile)) {
        return JSON.parse(fs.readFileSync(this.mappingFile, "utf8"));
      }
    } catch {}
    return {};
  }

  public static getSession(convId: string): SessionMapping | null {
    const map = this.getMapping();
    return map[convId] || null;
  }

  public static saveSession(convId: string, workspaceDir: string, geminiUrl: string): void {
    try {
      const map = this.getMapping();
      map[convId] = {
        antigravityConvId: convId,
        workspaceDir: path.resolve(workspaceDir || process.cwd()),
        geminiUrl,
        lastUpdated: Date.now(),
      };
      fs.writeFileSync(this.mappingFile, JSON.stringify(map, null, 2), "utf8");
    } catch (err: any) {
      console.warn(`[SessionSync] Failed to save session mapping: ${err.message}`);
    }
  }
}
