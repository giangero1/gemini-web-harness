import fs from "fs";
import path from "path";

export interface WorkspaceFileEntry {
  path: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
  extension: string;
  category: "entry" | "module" | "config" | "docs" | "other";
}

export interface WorkspaceSummary {
  workspaceRoot: string;
  totalFiles: number;
  totalBytes: number;
  keyFiles: WorkspaceFileEntry[];
  sampleFilesByCategory: {
    entry: WorkspaceFileEntry[];
    module: WorkspaceFileEntry[];
    config: WorkspaceFileEntry[];
    docs: WorkspaceFileEntry[];
  };
}

export interface DemoScenario {
  id: string;
  title: string;
  category: "auth" | "tools" | "arch" | "forensic" | "reasoning" | "custom";
  icon: string;
  prompt: string;
  targetPath?: string;
  description: string;
}

export class WorkspaceScanner {
  private static defaultWorkspace = process.cwd();
  private static customScenariosPath = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, "..", ".."), ".custom-demos.json");

  private static ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "temp-codex-repo",
    ".chrome-profile",
    ".gemini",
    "coverage",
    ".vscode",
  ]);

  /**
   * Scans a target workspace directory and returns structured file metadata.
   */
  public static scan(targetDir: string = this.defaultWorkspace, maxDepth: number = 3): WorkspaceSummary {
    const root = fs.existsSync(targetDir) ? path.resolve(targetDir) : path.resolve(this.defaultWorkspace);
    const results: WorkspaceFileEntry[] = [];
    let totalBytes = 0;

    function walk(dir: string, depth: number) {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (!WorkspaceScanner.ignoreDirs.has(ent.name) && !ent.name.startsWith(".")) {
            walk(path.join(dir, ent.name), depth + 1);
          }
        } else if (ent.isFile()) {
          const fullPath = path.join(dir, ent.name);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) continue; // skip files > 2MB
            totalBytes += stat.size;

            const ext = path.extname(ent.name).toLowerCase();
            const rel = path.relative(root, fullPath);

            let cat: WorkspaceFileEntry["category"] = "other";
            if (/^(main|index|server|app)\.(ts|js|html)$/i.test(ent.name)) {
              cat = "entry";
            } else if (/\.(ts|js|py|cpp|c|rs|go)$/i.test(ext)) {
              cat = "module";
            } else if (/\.(json|ya?ml|toml|env|config)$/i.test(ext) || ent.name.includes("config")) {
              cat = "config";
            } else if (/\.(md|txt|rst|pdf)$/i.test(ext)) {
              cat = "docs";
            }

            results.push({
              path: fullPath,
              relativePath: rel,
              name: ent.name,
              sizeBytes: stat.size,
              extension: ext,
              category: cat,
            });
          } catch {}
        }
      }
    }

    walk(root, 1);

    const summary: WorkspaceSummary = {
      workspaceRoot: root,
      totalFiles: results.length,
      totalBytes,
      keyFiles: results.slice(0, 50),
      sampleFilesByCategory: {
        entry: results.filter((f) => f.category === "entry").slice(0, 10),
        module: results.filter((f) => f.category === "module").slice(0, 15),
        config: results.filter((f) => f.category === "config").slice(0, 8),
        docs: results.filter((f) => f.category === "docs").slice(0, 8),
      },
    };

    return summary;
  }

  /**
   * Generates dynamic, workspace-tailored demonstration scenarios.
   * Completely replaces hardcoded paths with real detected workspace files.
   */
  public static getDynamicScenarios(targetDir: string = this.defaultWorkspace): DemoScenario[] {
    const summary = this.scan(targetDir);

    const mainFile =
      summary.sampleFilesByCategory.entry.find((f) => f.name === "main.ts" || f.name === "server.ts") ||
      summary.sampleFilesByCategory.entry[0] ||
      summary.sampleFilesByCategory.module[0];

    const logicFile =
      summary.sampleFilesByCategory.module.find((f) => f.name.includes("screencast") || f.name.includes("shim") || f.name.includes("prompt")) ||
      summary.sampleFilesByCategory.module[0];

    const docFile =
      summary.sampleFilesByCategory.docs.find((f) => f.name.toLowerCase().includes("readme") || f.name.toLowerCase().includes("project")) ||
      summary.sampleFilesByCategory.docs[0];

    const scenarios: DemoScenario[] = [
      {
        id: "auth-check",
        title: "Live Auth & Model Ping",
        category: "auth",
        icon: "⚡",
        description: "Validates Google session authenticity, active model (Gemini 4 Argon), and thinking configuration.",
        prompt:
          "Confirm live connection on gemini.google.com, state your active model name (Gemini 4 Argon), confirm High Thinking is engaged, and confirm session authenticity.",
      },
      {
        id: "antigravity-tool-proto",
        title: "Antigravity Tool Protocol Simulation",
        category: "tools",
        icon: "🛠️",
        description: "Tests the strict Antigravity Backend Protocol tool call execution and stop-generation rule.",
        prompt: `You are operating as the Antigravity Backend Model. The user asks you to read the contents of the project's entrypoint.
Follow the Autonomous Coding Agent Protocol:
Emit an exact \`\`\`function_call\`\`\` block for the tool "view_file" targeting the file "${mainFile ? mainFile.relativePath : "src/main.ts"}".
Remember rule 2: Do not write text before the tool call. Output the tool call immediately and stop generating.`,
      },
      {
        id: "arch-audit",
        title: "Architecture & System Review",
        category: "arch",
        icon: "🏗️",
        description: "Reads the project's source directory and performs an architectural audit using 1M context.",
        targetPath: path.join(summary.workspaceRoot, "src"),
        prompt:
          "Perform a comprehensive architectural review of this codebase. Evaluate the bridge architecture, Chrome CDP screencast integration, SSE streaming gateway, and state isolation.",
      },
      {
        id: "forensic-bug-hunt",
        title: "Forensic Bug Hunt",
        category: "forensic",
        icon: "🔍",
        description: "Performs deep forensic code inspection on key logic modules for race conditions and edge cases.",
        targetPath: logicFile ? logicFile.path : path.join(summary.workspaceRoot, "src", "bridge", "chrome-screencast.ts"),
        prompt: `Perform a deep forensic bug hunt on this module. Analyze asynchronous race conditions, error handling, WebSocket lifecycle state management, and edge cases under high load. Think deeply and present findings with line-specific references.`,
      },
      {
        id: "frontier-math",
        title: "Frontier Math & Deep Logic",
        category: "reasoning",
        icon: "🧠",
        description: "Tests multi-step deductive reasoning and high thinking on frontier logic problems.",
        prompt:
          "Consider three boxes: one with gold coins, one with silver coins, and one with a mixture. All labels (Gold, Silver, Mixed) are incorrect. You can draw one coin from one box without looking inside. Which box must you sample from to determine the correct contents of all three boxes with 100% certainty? Show formal logical proof.",
      },
    ];

    // Load any user-saved custom scenarios
    const custom = this.getCustomScenarios();
    return [...scenarios, ...custom];
  }

  public static getCustomScenarios(): DemoScenario[] {
    try {
      if (!fs.existsSync(this.customScenariosPath)) return [];
      const raw = fs.readFileSync(this.customScenariosPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  public static saveCustomScenario(scenario: Omit<DemoScenario, "id" | "category">): DemoScenario {
    const list = this.getCustomScenarios();
    const newEntry: DemoScenario = {
      id: "custom_" + Date.now().toString(36),
      category: "custom",
      ...scenario,
    };
    list.push(newEntry);
    try {
      fs.writeFileSync(this.customScenariosPath, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      console.error("[WorkspaceScanner] Failed to save custom scenario:", err);
    }
    return newEntry;
  }

  public static deleteCustomScenario(id: string): boolean {
    const list = this.getCustomScenarios();
    const filtered = list.filter((s) => s.id !== id);
    try {
      fs.writeFileSync(this.customScenariosPath, JSON.stringify(filtered, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  }
}
