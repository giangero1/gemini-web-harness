import fs from "fs";
import path from "path";
import { exec } from "child_process";

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export class ToolExecutor {
  private static workspaceRoot: string = process.cwd();
  private static backupDirName: string = ".argon_backups";

  private static allowedCommands = [
    "git",
    "python",
    "python3",
    "pytest",
    "node",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "tsc",
    "cargo",
    "go",
    "dotnet",
    "rg",
    "dir",
    "ls",
    "echo",
    "cat",
    "type",
    "findstr",
    "grep",
    "pwsh",
    "powershell",
    "pip",
  ];

  private static blockedCommandPatterns = [
    /rmdir\s+\/s/i,
    /del\s+\/f\s+\/s\s+\/q/i,
    /rm\s+-rf/i,
    /format\s+[a-z]:/i,
    /mkfs/i,
    /drop\s+database/i,
    /shutdown/i,
  ];

  public static setWorkspaceRoot(root: string): void {
    if (fs.existsSync(root)) {
      this.workspaceRoot = path.resolve(root);
    }
  }

  public static getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Reads text from a file safely with optional startLine and endLine (1-indexed).
   */
  public static readFile(filePath: string, startLine?: number, endLine?: number): ToolResult {
    try {
      const resolved = this.resolvePath(filePath);
      if (!fs.existsSync(resolved)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return { success: false, error: `Path is a directory, not a file: ${filePath}. Use list_directory instead.` };
      }

      if (stat.size > 2 * 1024 * 1024) {
        return { success: false, error: `File is too large (${(stat.size / 1024 / 1024).toFixed(2)} MB). Max readable size is 2MB.` };
      }

      const raw = fs.readFileSync(resolved, "utf8");
      const lines = raw.split("\n");

      let selectedLines = lines;
      let start = 1;
      let end = lines.length;

      if (startLine && startLine > 0) {
        start = Math.max(1, startLine);
      }
      if (endLine && endLine >= start) {
        end = Math.min(lines.length, endLine);
      }

      selectedLines = lines.slice(start - 1, end);
      const numbered = selectedLines
        .map((line, idx) => `${start + idx}: ${line}`)
        .join("\n");

      return {
        success: true,
        output: `File: ${path.relative(this.workspaceRoot, resolved).replace(/\\/g, "/")}\nTotal Lines: ${lines.length} (Viewing ${start}-${end}):\n\n${numbered}`,
      };
    } catch (err: any) {
      return { success: false, error: `Failed to read file: ${err.message}` };
    }
  }

  /**
   * Writes code to a file, making an automatic backup in .argon_backups/ and syntax checking.
   */
  public static writeFile(filePath: string, content: string): ToolResult {
    try {
      const resolved = this.resolvePath(filePath);
      const parentDir = path.dirname(resolved);

      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // If file exists, create timestamped backup in .argon_backups/
      if (fs.existsSync(resolved)) {
        this.createBackup(resolved);
      }

      // Basic syntax check for JSON
      if (resolved.endsWith(".json")) {
        try {
          JSON.parse(content);
        } catch (jsonErr: any) {
          return { success: false, error: `Syntax error: Invalid JSON payload: ${jsonErr.message}` };
        }
      }

      fs.writeFileSync(resolved, content, "utf8");

      const relPath = path.relative(this.workspaceRoot, resolved).replace(/\\/g, "/");
      const stat = fs.statSync(resolved);
      return {
        success: true,
        output: `Successfully wrote ${stat.size} bytes to ${relPath}. (Backup saved to ${this.backupDirName}/)`,
      };
    } catch (err: any) {
      return { success: false, error: `Failed to write file: ${err.message}` };
    }
  }

  /**
   * Lists directory contents.
   */
  public static listDirectory(dirPath: string = ".", maxDepth: number = 2): ToolResult {
    try {
      const resolved = this.resolvePath(dirPath);
      if (!fs.existsSync(resolved)) {
        return { success: false, error: `Directory not found: ${dirPath}` };
      }

      const results: string[] = [];

      const walk = (current: string, depth: number) => {
        if (depth > maxDepth) return;
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "__pycache__") continue;
          const full = path.join(current, ent.name);
          const rel = path.relative(resolved, full).replace(/\\/g, "/");
          if (ent.isDirectory()) {
            results.push(`[DIR]  ${rel}/`);
            walk(full, depth + 1);
          } else {
            const size = (fs.statSync(full).size / 1024).toFixed(1);
            results.push(`[FILE] ${rel} (${size} KB)`);
          }
        }
      };

      walk(resolved, 1);
      return {
        success: true,
        output: `Contents of ${path.relative(this.workspaceRoot, resolved) || "."} (${results.length} items):\n` + results.join("\n"),
      };
    } catch (err: any) {
      return { success: false, error: `Failed to list directory: ${err.message}` };
    }
  }

  /**
   * Executes whitelisted terminal commands with a 60s timeout.
   */
  public static runCommand(command: string, timeoutMs: number = 60000): Promise<ToolResult> {
    return new Promise((resolve) => {
      const trimmed = command.trim();
      const firstToken = trimmed.split(/\s+/)[0].toLowerCase().replace(/^.*[/\\]/, "");

      // Check if command is blocked
      for (const pattern of this.blockedCommandPatterns) {
        if (pattern.test(trimmed)) {
          resolve({
            success: false,
            error: `Security Error: Command blocked by safety policy: "${trimmed}"`,
          });
          return;
        }
      }

      // Check against allowed executable whitelist
      const isAllowed = this.allowedCommands.some(
        (cmd) => firstToken === cmd || firstToken === `${cmd}.exe` || firstToken === `${cmd}.cmd` || firstToken === `${cmd}.bat`
      );

      if (!isAllowed) {
        resolve({
          success: false,
          error: `Execution Error: Executable "${firstToken}" is not in the safe whitelist (${this.allowedCommands.join(", ")}).`,
        });
        return;
      }

      exec(
        trimmed,
        {
          cwd: this.workspaceRoot,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              output: stdout ? stdout.trim() : undefined,
              error: `Exit Code ${error.code || 1}: ${stderr ? stderr.trim() : error.message}`,
            });
            return;
          }

          const rawOutput = (stdout || "").trim() || (stderr ? `(stderr): ${stderr.trim()}` : "(No output)");
          const MAX_OUTPUT = 25000;
          const output = rawOutput.length > MAX_OUTPUT
            ? rawOutput.substring(0, MAX_OUTPUT) + `\n\n[... Truncated: ${rawOutput.length - MAX_OUTPUT} characters omitted ...]`
            : rawOutput;

          resolve({
            success: true,
            output,
          });
        }
      );
    });
  }

  private static resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return path.resolve(p);
    }
    return path.resolve(this.workspaceRoot, p);
  }

  private static createBackup(targetFile: string): void {
    try {
      const backupDir = path.join(this.workspaceRoot, this.backupDirName);
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const rel = path.relative(this.workspaceRoot, targetFile).replace(/[\\/]/g, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(backupDir, `${rel}.${timestamp}.bak`);

      fs.copyFileSync(targetFile, backupPath);
    } catch {}
  }
}
