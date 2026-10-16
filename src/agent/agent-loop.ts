import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { ToolExecutor, ToolResult } from "./tool-executor";
import { CdpUploader } from "./cdp-uploader";

export interface AgentLoopOptions {
  workspaceDir: string;
  initialPrompt: string;
  userInstruction?: string;
  treeOverview?: string;
  maxTurns?: number;
  uploadZip?: boolean;
  model?: string;
  thinkingLevel?: string;
  onDelta?: (text: string) => void;
  onToolCall?: (name: string, args: any) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
}

export class AgentLoop {
  private static toolDeclarations = [
    {
      name: "read_file",
      description: "Reads content from a local workspace file with optional line slicing.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to file relative to workspace root or absolute path." },
          startLine: { type: "number", description: "1-indexed starting line number (optional)." },
          endLine: { type: "number", description: "1-indexed ending line number (optional)." },
        },
        required: ["filePath"],
      },
    },
    {
      name: "write_file",
      description: "Writes or overwrites a local workspace file safely, creating backups in .argon_backups/.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to file relative to workspace root or absolute path." },
          content: { type: "string", description: "The full content to write to the file." },
        },
        required: ["filePath", "content"],
      },
    },
    {
      name: "list_directory",
      description: "Lists directory contents, subdirectories, and file sizes.",
      parameters: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "Path to directory relative to workspace root (defaults to '.')." },
          maxDepth: { type: "number", description: "Maximum recursion depth (defaults to 2)." },
        },
      },
    },
    {
      name: "run_command",
      description: "Executes a safe whitelisted terminal command (git, pytest, python, node, npm, tsc, dir, ls) with 60s timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The exact shell command line string to execute." },
        },
        required: ["command"],
      },
    },
  ];

  public static buildToolPrompt(userInstruction: string, treeOverview?: string): string {
    const toolDoc = this.toolDeclarations
      .map((t) => `- **${t.name}**: ${t.description}\n  Parameters: \`${JSON.stringify(t.parameters.properties)}\``)
      .join("\n");

    const parts: string[] = [
      "You are an autonomous pair-programmer and expert software architect with direct tool access to the user's local filesystem and workspace.",
      "",
      "### AVAILABLE LOCAL TOOLS",
      toolDoc,
      "",
      "### TOOL CALLING CONTRACT",
      "When you need to read a file, inspect directory contents, write code, or run a test/command, output ONLY a single code block formatted as:",
      "```function_call",
      '{"name": "<tool_name>", "args": {<arguments>}}',
      "```",
      "- Do not add prose before the tool call.",
      "- Output the tool call immediately and stop. The harness will execute the action on the user's machine and provide the observation in the subsequent turn.",
      "- When all work is complete and no more tools are needed, write your comprehensive final response in standard markdown.",
      "",
    ];

    if (treeOverview) {
      parts.push("=== PROJECT DIRECTORY OVERVIEW ===");
      parts.push(treeOverview);
      parts.push("");
    }

    parts.push("### USER TASK");
    parts.push(userInstruction.trim());

    return parts.join("\n");
  }

  public static buildHandoffPrompt(
    userInstruction: string,
    filesRead: string[],
    filesModified: string[],
    lastObservation?: string,
    treeOverview?: string
  ): string {
    const toolDoc = this.toolDeclarations
      .map((t) => `- **${t.name}**: ${t.description}\n  Parameters: \`${JSON.stringify(t.parameters.properties)}\``)
      .join("\n");

    const parts: string[] = [
      "You are an autonomous pair-programmer and expert software architect continuing an active coding task.",
      "⚠️ NOTE: Automated Account Failover Occurred (Previous account reached its hourly quota). You are picking up seamlessly with 100% full continuity.",
      "",
      "### AVAILABLE LOCAL TOOLS",
      toolDoc,
      "",
      "### TOOL CALLING CONTRACT",
      "When you need to read a file, inspect directory contents, write code, or run a test/command, output ONLY a single code block formatted as:",
      "```function_call",
      '{"name": "<tool_name>", "args": {<arguments>}}',
      "```",
      "- Do not add prose before the tool call.",
      "- Output the tool call immediately and stop. The harness executes the action on the user's machine.",
      "",
    ];

    if (treeOverview) {
      parts.push("=== PROJECT DIRECTORY OVERVIEW ===");
      parts.push(treeOverview);
      parts.push("");
    }

    parts.push("### ORIGINAL USER TASK");
    parts.push(userInstruction.trim());
    parts.push("");

    parts.push("### WORK COMPLETED SO FAR BY PREVIOUS ACCOUNT");
    parts.push(filesRead.length > 0 ? `- Files Inspected: ${filesRead.join(", ")}` : "- No files inspected yet.");
    parts.push(filesModified.length > 0 ? `- Files Written / Modified: ${filesModified.join(", ")}` : "- No files modified yet.");
    parts.push("");

    if (lastObservation) {
      parts.push("### LATEST OBSERVATION FROM TOOL EXECUTION");
      parts.push(lastObservation);
      parts.push("");
    }

    parts.push("### DIRECTIVE FOR THIS ACCOUNT");
    parts.push("Do NOT repeat steps that are already completed above. Continue directly with the remaining analysis or code implementation using your tools, or deliver your final report if all work is complete.");

    return parts.join("\n");
  }

  /**
   * Runs the autonomous multi-turn tool loop on an active Chrome CDP session.
   */
  public static async run(ws: WebSocket, options: AgentLoopOptions): Promise<{ finalResponse: string; turnCount: number; filesModified: string[] }> {
    ToolExecutor.setWorkspaceRoot(options.workspaceDir);
    const maxTurns = options.maxTurns || 15;
    const filesModified: string[] = [];
    const filesRead: string[] = [];

    const sendWs = (method: string, params: any = {}): Promise<any> => {
      return new Promise((resolve) => {
        const id = Math.floor(Math.random() * 1000000);
        const handler = (data: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id === id) {
              ws.removeListener("message", handler);
              resolve(msg.result);
            }
          } catch {}
        };
        ws.on("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    // If ZIP upload requested, create and attach it
    if (options.uploadZip) {
      console.log(`[AgentLoop] Packaging workspace for full 1M context upload: ${options.workspaceDir}...`);
      const zipPath = CdpUploader.createWorkspaceZip(options.workspaceDir);
      if (zipPath) {
        await CdpUploader.attachFilesViaCdp(ws, [zipPath]);
      }
    }

    // Enforce target model and thinking effort in Chrome UI
    const targetModel = options.model || "argon";
    const targetThinking = options.thinkingLevel || "high";
    console.log(`[AgentLoop] Enforcing active mode: ${targetModel} (${targetThinking} thinking) in Chrome UI...`);
    let modelState = await this.ensureModelSelected(sendWs, targetModel, targetThinking);

    const { AccountRotator } = require("../bridge/account-rotator");
    await AccountRotator.syncFromActiveTab(sendWs);

    // Automated Account Failover if rate-limited on entry
    while (modelState?.rateLimited) {
      console.warn(`[AgentLoop] ⚠️ Account slot #${AccountRotator.getCurrentSlot()} reached quota limit: "${modelState.resetInfo || 'Locked'}". Rotating account...`);
      AccountRotator.markRateLimited(AccountRotator.getCurrentSlot(), modelState.resetInfo);

      const nextAccount = AccountRotator.getNextAvailableSlot();
      if (!nextAccount) {
        console.error(`[AgentLoop] ❌ All account slots in the pool are currently rate-limited.`);
        break;
      }

      console.log(`[AgentLoop] 🚀 Rotating to Account Slot #${nextAccount.slot}...`);
      const switchRes = await AccountRotator.switchToSlot(sendWs, nextAccount.slot);
      if (switchRes.success) {
        if (options.uploadZip) {
          console.log(`[AgentLoop] Re-attaching workspace ZIP to new account #${nextAccount.slot}...`);
          const zipPath = CdpUploader.createWorkspaceZip(options.workspaceDir);
          if (zipPath) {
            await CdpUploader.attachFilesViaCdp(ws, [zipPath]);
          }
        }
        modelState = await this.ensureModelSelected(sendWs, targetModel, targetThinking);
      } else {
        console.warn(`[AgentLoop] Failed to switch to slot #${nextAccount.slot}: ${switchRes.error}`);
        break;
      }
    }

    let nextPrompt = options.initialPrompt;
    let lastObservation = "";
    let turn = 0;
    let finalResponse = "";

    while (turn < maxTurns) {
      turn++;
      console.log(`\n[AgentLoop] Turn ${turn}/${maxTurns} dispatched to Gemini 4 Argon Web...`);

      // 1. Record existing response count
      const countRes = await sendWs("Runtime.evaluate", {
        expression: `document.querySelectorAll('model-response, message-content, [data-test-id="model-response-text"]').length`,
        returnByValue: true,
      });
      const initialCount = Number(countRes?.result?.value) || 0;

      // 2. Inject prompt into Quill
      await sendWs("Runtime.evaluate", {
        expression: `
          (function(text) {
            const rich = document.querySelector('rich-textarea');
            const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                          document.querySelector('div[contenteditable="true"]');
            if (rich && rich.__quill) {
              rich.__quill.focus();
              rich.__quill.setContents([{ insert: text }], 'user');
            } else if (input) {
              input.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
              document.execCommand('insertText', false, text);
              input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            }
          })(${JSON.stringify(nextPrompt)})
        `,
        returnByValue: true,
      });

      await sendWs("Input.insertText", { text: " " });
      await new Promise((r) => setTimeout(r, 60));

      // 3. Click Send
      await sendWs("Runtime.evaluate", {
        expression: `
          (function() {
            const btn = document.querySelector('button[aria-label*="Send message"], button[aria-label*="Send"], button.send-button');
            if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
              btn.click();
            }
          })()
        `,
        returnByValue: true,
      });

      // 4. Poll and stream response until completion
      let currentText = "";
      let lastLength = 0;
      let idleCount = 0;

      for (let poll = 0; poll < 1800; poll++) {
        await new Promise((r) => setTimeout(r, 100));

        const statusRes = await sendWs("Runtime.evaluate", {
          expression: `
            (function(initialCount) {
              const responses = document.querySelectorAll('model-response, message-content, [data-test-id="model-response-text"]');
              const isNew = responses.length > initialCount;
              let txt = '';
              if (responses.length > 0 && isNew) {
                const last = responses[responses.length - 1];
                const contentEl = last.querySelector('.response-content, .markdown, [data-test-id="model-response-text"]') || last;
                txt = (contentEl.innerText || contentEl.textContent || '').replace(/^Gemini said\\s*/i, '');
              }
              const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="stop"]');
              return {
                text: txt.trim(),
                isNew,
                generating: Boolean(stopBtn)
              };
            })(${initialCount})
          `,
          returnByValue: true,
        });

        const status = statusRes?.result?.value;
        if (status && status.isNew && status.text) {
          if (status.text.length > lastLength) {
            const delta = status.text.substring(lastLength);
            process.stdout.write(delta);
            options.onDelta?.(delta);
            lastLength = status.text.length;
            currentText = status.text;
            idleCount = 0;
          } else if (!status.generating && currentText.length > 0) {
            idleCount++;
            if (idleCount >= 8) {
              break;
            }
          }
        }
      }

      console.log("\n");

      // Mid-turn rate limit detection
      const isRateLimitedResponse =
        currentText.toLowerCase().includes("reached your limit") ||
        currentText.toLowerCase().includes("daily limit") ||
        currentText.toLowerCase().includes("switch to flash to continue") ||
        currentText.toLowerCase().includes("try again later or switch");

      if (isRateLimitedResponse) {
        console.warn(`\n[AgentLoop] ⚠️ Quota limit detected mid-task on turn ${turn}! Initiating seamless account rotation with context handoff...`);
        const resetInfoMatch = currentText.match(/resets\s+[^\n.,]+/i) || currentText.match(/\d{1,2}:\d{2}\s*(?:AM|PM)/i);
        AccountRotator.markRateLimited(AccountRotator.getCurrentSlot(), resetInfoMatch ? resetInfoMatch[0] : "Quota reached");

        const nextAccount = AccountRotator.getNextAvailableSlot();
        if (nextAccount) {
          console.log(`[AgentLoop] 🚀 Rotating to Account Slot #${nextAccount.slot}...`);
          const switchRes = await AccountRotator.switchToSlot(sendWs, nextAccount.slot);
          if (switchRes.success) {
            if (options.uploadZip) {
              console.log(`[AgentLoop] Re-attaching workspace ZIP to new account #${nextAccount.slot}...`);
              const zipPath = CdpUploader.createWorkspaceZip(options.workspaceDir);
              if (zipPath) {
                await CdpUploader.attachFilesViaCdp(ws, [zipPath]);
              }
            }
            await this.ensureModelSelected(sendWs, targetModel, targetThinking);

            // Construct handoff prompt preserving all context, inspected files, and modified files
            nextPrompt = AgentLoop.buildHandoffPrompt(
              options.userInstruction || options.initialPrompt,
              filesRead,
              filesModified,
              lastObservation,
              options.treeOverview
            );
            console.log(`[AgentLoop] 🔄 Injected context handoff dossier into Account #${nextAccount.slot}. Resuming execution!`);
            continue;
          }
        } else {
          console.error(`[AgentLoop] ❌ All account slots in the pool are rate-limited. Unable to continue.`);
          finalResponse = currentText;
          break;
        }
      }

      // 5. Check if the turn output contains a function_call block
      const call = this.extractToolCall(currentText);
      if (call) {
        options.onToolCall?.(call.name, call.args);
        console.log(`\n⚙️ [Local Tool Execution] Calling: ${call.name}(${JSON.stringify(call.args)})`);

        let result: ToolResult;
        if (call.name === "read_file") {
          result = ToolExecutor.readFile(call.args.filePath, call.args.startLine, call.args.endLine);
          if (result.success && !filesRead.includes(call.args.filePath)) {
            filesRead.push(call.args.filePath);
          }
        } else if (call.name === "write_file") {
          result = ToolExecutor.writeFile(call.args.filePath, call.args.content);
          if (result.success && !filesModified.includes(call.args.filePath)) {
            filesModified.push(call.args.filePath);
          }
        } else if (call.name === "list_directory") {
          result = ToolExecutor.listDirectory(call.args.dirPath, call.args.maxDepth);
        } else if (call.name === "run_command") {
          result = await ToolExecutor.runCommand(call.args.command);
        } else {
          result = { success: false, error: `Unknown tool: ${call.name}` };
        }

        options.onToolResult?.(call.name, result);

        const statusStr = result.success ? "SUCCESS" : "ERROR";
        console.log(`✅ [Tool Result: ${statusStr}]\n${(result.output || result.error || "").substring(0, 300)}...`);

        lastObservation = `Tool: ${call.name}\nResult:\n` + (result.success ? (result.output || "(Success)").substring(0, 3000) : `Error: ${result.error}`);

        // Format next prompt turn with observation
        nextPrompt = [
          `[Tool Observation for ${call.name}]:`,
          result.success ? result.output || "(Success)" : `Error: ${result.error}`,
          "",
          "Continue reasoning with this result. If more tool actions are needed, output the next ```function_call block. Otherwise, provide your complete final response.",
        ].join("\n");
      } else {
        // No more tool calls: Argon reached final answer!
        finalResponse = currentText;
        console.log(`\n🎉 [Agent Loop Complete] Argon concluded in ${turn} turn(s).`);
        break;
      }
    }

    return { finalResponse, turnCount: turn, filesModified };
  }

  private static extractToolCall(text: string): { name: string; args: any } | null {
    // 1. Try markdown code block ```function_call, ```tool_call, or ```json
    const codeBlockMatch = text.match(/```(?:function_call|tool_call|json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch && codeBlockMatch[1]) {
      const parsed = this.tryParseToolJson(codeBlockMatch[1]);
      if (parsed) return parsed;
    }

    // 2. Search for any {"name": "...", "args": ...} using balanced bracket extraction
    const marker = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_-]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(text)) !== null) {
      const startIdx = m.index;
      const jsonStr = this.extractBalancedJson(text, startIdx);
      if (jsonStr) {
        const parsed = this.tryParseToolJson(jsonStr);
        if (parsed) return parsed;
      }
    }

    return null;
  }

  private static tryParseToolJson(raw: string): { name: string; args: any } | null {
    try {
      // Clean duplicate commas (,,) and trailing commas before braces
      const clean = raw.trim().replace(/,\s*,+/g, ",").replace(/,\s*([}\]])/g, "$1");
      const obj = JSON.parse(clean);
      if (obj.name && (obj.args !== undefined || obj.parameters !== undefined)) {
        return { name: obj.name, args: obj.args ?? obj.parameters ?? {} };
      }
    } catch {}
    return null;
  }

  private static extractBalancedJson(text: string, startIndex: number): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return text.slice(startIndex, i + 1);
          }
        }
      }
    }
    return null;
  }

  public static async ensureModelSelected(
    sendWs: (method: string, params?: any) => Promise<any>,
    targetModel: string = "argon",
    targetThinking: string = "high"
  ): Promise<any> {
    const res = await sendWs("Runtime.evaluate", {
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
                                  modelOption.getAttribute('aria-disabled') === 'true' ||
                                  modelOption.hasAttribute('disabled') ||
                                  Boolean((modelOption as any).disabled);

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
          } else {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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

          // Post-selection verification to ensure model switched and did not silently stay on fallback
          const finalBtnText = (modeBtn.innerText || '').toLowerCase();
          const finalMatches = targetM.includes('argon') ? finalBtnText.includes('argon') :
                               targetM.includes('pro') ? finalBtnText.includes('pro') :
                               targetM.includes('flash-lite') || targetM.includes('lite') ? finalBtnText.includes('lite') :
                               targetM.includes('flash') ? (finalBtnText.includes('flash') && !finalBtnText.includes('lite')) : true;

          if (!finalMatches && !targetM.includes('flash-lite')) {
            return {
              rateLimited: true,
              resetInfo: "Target model \"" + targetModel + "\" could not be activated (active: \"" + modeBtn.innerText.trim() + "\")",
              text: modeBtn.innerText.trim()
            };
          }

          return { success: true, text: modeBtn.innerText.trim() };
        })(${JSON.stringify(targetModel)}, ${JSON.stringify(targetThinking)})
      `,
      awaitPromise: true,
      returnByValue: true
    });
    return res?.result?.value;
  }
}
