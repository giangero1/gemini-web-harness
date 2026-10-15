import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import WebSocket from "ws";

export class CdpUploader {
  /**
   * Zips a workspace directory safely, excluding ignored directories.
   */
  public static createWorkspaceZip(workspaceDir: string): string {
    const tempDir = os.tmpdir();
    const zipPath = path.join(tempDir, `argon_workspace_${Date.now()}.zip`);
    const scriptPath = path.join(tempDir, `argon_zip_${Date.now()}.ps1`);

    const psScript = [
      `$dest = '${zipPath.replace(/'/g, "''")}'`,
      `$src = '${path.resolve(workspaceDir).replace(/'/g, "''")}'`,
      `$exclude = @('node_modules', '.git', 'dist', 'build', 'chrome_profile', 'cloned_profile', '.chatgpt_profile', 'videos', 'tools', 'output', 'data', '.argon_backups', '__pycache__', '.pytest_cache')`,
      `$files = Get-ChildItem -Path $src -Recurse | Where-Object {`,
      `  $item = $_`,
      `  $skip = $false`,
      `  foreach ($e in $exclude) {`,
      `    if ($item.FullName -match "[\\\\/]$e([\\\\/]|$)") {`,
      `      $skip = $true`,
      `      break`,
      `    }`,
      `  }`,
      `  -not $skip -and -not $item.PSIsContainer -and ($item.Length -lt 2MB)`,
      `} | Select-Object -ExpandProperty FullName`,
      `if ($files.Count -gt 0) {`,
      `  Compress-Archive -Path $files -DestinationPath $dest -CompressionLevel Optimal -Force`,
      `}`,
    ].join("\r\n");

    try {
      fs.writeFileSync(scriptPath, psScript, "utf8");
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
        timeout: 60000,
        stdio: "ignore",
      });
      fs.unlinkSync(scriptPath);

      if (fs.existsSync(zipPath)) {
        const stat = fs.statSync(zipPath);
        console.log(`[CdpUploader] Workspace ZIP created: ${zipPath} (${(stat.size / 1024).toFixed(1)} KB)`);
        return zipPath;
      }
    } catch (err: any) {
      console.warn(`[CdpUploader] ZIP creation fallback: ${err.message}`);
      try {
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      } catch {}
    }

    return "";
  }

  /**
   * Uses Chrome DevTools Protocol to attach one or more files directly to the Gemini Web file input.
   */
  public static async attachFilesViaCdp(ws: WebSocket, filePaths: string[]): Promise<boolean> {
    const existing = filePaths.filter((p) => fs.existsSync(p));
    if (existing.length === 0) {
      console.error("[CdpUploader] No valid files found to upload.");
      return false;
    }

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

    try {
      // 1. Enable DOM domain
      await sendWs("DOM.enable");

      // 2. Locate document root
      const doc = await sendWs("DOM.getDocument", { depth: -1 });
      if (!doc?.root?.nodeId) {
        console.error("[CdpUploader] Could not get DOM document root.");
        return false;
      }

      // 3. Find file input
      let nodeRes = await sendWs("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      });

      // If input[type="file"] is not yet in DOM, click the '+' attachment button to instantiate it
      if (!nodeRes?.nodeId) {
        await sendWs("Runtime.evaluate", {
          expression: `
            (function() {
              const addBtn = document.querySelector('button[aria-label*="Add"], button[aria-label*="Upload"], button[aria-label*="attachment"], [data-test-id*="file-upload"]');
              if (addBtn) addBtn.click();
            })()
          `,
        });
        await new Promise((r) => setTimeout(r, 600));

        // Re-query document
        const newDoc = await sendWs("DOM.getDocument", { depth: -1 });
        if (newDoc?.root?.nodeId) {
          nodeRes = await sendWs("DOM.querySelector", {
            nodeId: newDoc.root.nodeId,
            selector: 'input[type="file"]',
          });
        }
      }

      if (!nodeRes?.nodeId) {
        console.error("[CdpUploader] input[type='file'] element not found in Gemini Web DOM.");
        return false;
      }

      // 4. Set files via CDP
      await sendWs("DOM.setFileInputFiles", {
        nodeId: nodeRes.nodeId,
        files: existing,
      });

      console.log(`[CdpUploader] Successfully attached ${existing.length} file(s) via CDP: ${existing.map((f) => path.basename(f)).join(", ")}`);

      // 5. Wait for upload card or progress bar in DOM
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const check = await sendWs("Runtime.evaluate", {
          expression: `
            (function() {
              const fileCards = document.querySelectorAll('[data-test-id*="attachment"], .attachment-container, file-preview, mat-chip');
              const progressBar = document.querySelector('mat-progress-bar, [role="progressbar"]');
              return {
                cardCount: fileCards.length,
                uploading: Boolean(progressBar)
              };
            })()
          `,
          returnByValue: true,
        });

        if (check?.result?.value?.cardCount > 0 && !check.result.value.uploading) {
          console.log("[CdpUploader] File upload confirmed ready in Gemini Web UI.");
          return true;
        }
      }

      return true;
    } catch (err: any) {
      console.error(`[CdpUploader] CDP file upload failed: ${err.message}`);
      return false;
    }
  }
}
