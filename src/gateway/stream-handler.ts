import { Request, Response } from "express";
import { PromptShim } from "../translator/prompt-shim";
import { ResponseParser } from "../translator/response-parser";
import { ContextTracker } from "../translator/context-tracker";
import { StreamClient } from "../bridge/stream-client";
import { DomAutomation } from "../bridge/dom-automation";
import { ChromeScreencastService } from "../bridge/chrome-screencast";
import { HistoryStore } from "../bridge/history-store";
import { MODELS, DEFAULT_CONFIG } from "../config";

export class StreamHandler {
  public static async handle(req: Request, res: Response): Promise<void> {
    const rawParam = req.params.model;
    const rawModel = Array.isArray(rawParam) ? rawParam[0] : (rawParam || DEFAULT_CONFIG.selectedModel);
    const modelKey = String(rawModel).replace("models/", "");
    const modelDef = MODELS[modelKey] || MODELS[DEFAULT_CONFIG.selectedModel];

    // Setup SSE response headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      // 1. Compile GenAI request and tools
      const { prompt, hasTools } = PromptShim.compile(req.body);
      const sessionKey = ContextTracker.getSessionKey(prompt);
      const existingTriple = ContextTracker.getSession(sessionKey);

      const activeModelKey = DEFAULT_CONFIG.selectedModel;
      const activeModelDef = MODELS[activeModelKey] || modelDef;

      console.log(`[StreamHandler] Incoming request for "${modelKey}" -> Routing to Web Model: ${activeModelDef.displayName} (${DEFAULT_CONFIG.thinkingLevel} thinking)`);
      console.log(`[StreamHandler] Prompt: "${prompt.substring(0, 80).replace(/\n/g, ' ')}..."`);

      const parser = new ResponseParser();

      // 2. Execute via Chrome CDP (Fastest, authentic Argon execution)
      let liveSuccess = false;
      try {
        console.log(`[StreamHandler] Routing prompt to Google Chrome CDP for authentic Argon execution...`);
        const result = await ChromeScreencastService.executeLivePrompt(
          prompt,
          (delta: string) => {
            const sseChunks = parser.parseChunk(delta, false);
            for (const chunk of sseChunks) {
              res.write(chunk);
            }
          },
          DEFAULT_CONFIG.selectedModel || "argon",
          DEFAULT_CONFIG.thinkingLevel || "high"
        );

        let convId = "live";
        if (result.conversationUrl) {
          const m = result.conversationUrl.match(/\/app\/([a-zA-Z0-9_-]+)/);
          if (m) convId = m[1];
        }

        HistoryStore.add({
          model: `Gemini 4 Argon (${result.activeModel || "High Thinking"})`,
          thinkingLevel: DEFAULT_CONFIG.thinkingLevel || "High",
          prompt: prompt,
          response: result.response,
          conversationId: convId,
          status: "200 OK (Chrome CDP)",
        });
        liveSuccess = true;
      } catch (liveErr: any) {
        console.warn(`[StreamHandler] Chrome CDP execution failed: ${liveErr.message}. Attempting fallback to DomAutomation...`);
        try {
          const result = await DomAutomation.executeLivePrompt(prompt, (delta) => {
            const sseChunks = parser.parseChunk(delta, false);
            for (const chunk of sseChunks) {
              res.write(chunk);
            }
          });
          HistoryStore.add({
            model: "Gemini 4 Argon (Electron Fallback)",
            thinkingLevel: DEFAULT_CONFIG.thinkingLevel || "High",
            prompt: prompt,
            response: result.response,
            conversationId: "fallback",
            status: "200 OK (Fallback)",
          });
          liveSuccess = true;
        } catch (fbErr: any) {
          console.error(`[StreamHandler] Fallback also failed: ${fbErr.message}`);
          res.status(500).json({
            error: {
              message: `Gemini execution failed on both Chrome CDP and Electron webview: ${liveErr.message}`
            }
          });
          return;
        }
      }

      // 3. Finalize and close SSE stream
      const finalChunks = parser.finalize();
      for (const chunk of finalChunks) {
        res.write(chunk);
      }

      res.end();
    } catch (err: any) {
      console.error("[StreamHandler] Error during generation:", err);
      // Emit error SSE event
      const errorPayload = {
        error: {
          code: 500,
          message: err?.message || "Internal error in Gemini Web Harness",
          status: "INTERNAL",
        },
      };
      res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
      res.end();
    }
  }
}
