import express from "express";
import cors from "cors";
import { DEFAULT_CONFIG } from "../config";
import { ModelCatalog } from "./catalog";
import { StreamHandler } from "./stream-handler";
import { SessionAuth } from "../bridge/session-auth";
import { DomAutomation } from "../bridge/dom-automation";
import { ChromeScreencastService } from "../bridge/chrome-screencast";
import { HistoryStore } from "../bridge/history-store";
import { FileIngester } from "../bridge/file-ingester";
import { Server } from "http";

export class GatewayServer {
  private static app = express();
  private static server: Server | null = null;

  public static start(port: number = DEFAULT_CONFIG.port): Promise<number> {
    return new Promise((resolve, reject) => {
      this.app.use(cors());
      this.app.use(express.json({ limit: "50mb" }));

      // 1. Models catalog endpoints
      this.app.get("/v1beta/models", (_req, res) => {
        res.json(ModelCatalog.getModelsList());
      });

      this.app.get("/v1beta/models/:model", (req, res) => {
        const model = ModelCatalog.getModel(req.params.model);
        if (!model) {
          res.status(404).json({ error: { message: "Model not found" } });
          return;
        }
        res.json(model);
      });

      // 2. Stream generation endpoints (matching BetterGravity / Antigravity)
      this.app.post("/v1beta/models/:model:streamGenerateContent", (req, res) => {
        StreamHandler.handle(req, res);
      });

      // Also support non-streaming fallback
      this.app.post("/v1beta/models/:model:generateContent", (req, res) => {
        StreamHandler.handle(req, res);
      });

      // 3. Health & diagnostics
      this.app.get("/health", (_req, res) => {
        const auth = SessionAuth.getState();
        res.json({
          status: "ok",
          port,
          authenticated: auth.isLoggedIn,
          hasCsrfToken: Boolean(auth.snlm0e),
          activeModel: DEFAULT_CONFIG.selectedModel,
          thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
        });
      });

      // 4. Programmatic Live Webview endpoint (types on screen & saves to Gemini sidebar)
      this.app.post("/live-prompt", async (req, res) => {
        let promptText = req.body?.prompt;
        if (!promptText && (req.body?.folder || req.body?.file)) {
          try {
            const target = req.body.folder || req.body.file;
            const ingested = FileIngester.ingest(target, req.body.instruction);
            promptText = ingested.packagedContent;
          } catch (err: any) {
            res.status(400).json({ error: `File ingestion failed: ${err.message}` });
            return;
          }
        }

        if (!promptText) {
          res.status(400).json({ error: "Missing prompt or folder/file path" });
          return;
        }

        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        try {
          const targetModel = req.body?.model || "argon";
          const targetThinking = req.body?.thinking || "high";
          const result = await ChromeScreencastService.executeLivePrompt(
            promptText,
            (delta) => {
              res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
            },
            targetModel,
            targetThinking
          );

          let convId = "live";
          if (result.conversationUrl) {
            const m = result.conversationUrl.match(/\/app\/([a-zA-Z0-9_-]+)/);
            if (m) convId = m[1];
          }

          HistoryStore.add({
            model: "Gemini 4 Argon (Live Chrome Web)",
            thinkingLevel: "High",
            prompt: promptText,
            response: result.response,
            conversationId: convId,
            status: "200 OK (Saved to Google Sidebar)",
          });

          res.write(`data: [DONE]\n\n`);
          res.end();
        } catch (err: any) {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          res.end();
        }
      });

      // 5. History endpoint
      this.app.get("/history", (_req, res) => {
        res.json(HistoryStore.getAll());
      });

      this.server = this.app.listen(port, DEFAULT_CONFIG.host, () => {
        console.log(`[GatewayServer] Listening on http://${DEFAULT_CONFIG.host}:${port}`);
        resolve(port);
      });

      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public static stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
