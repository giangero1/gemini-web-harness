import { net } from "electron";
import { SessionAuth } from "./session-auth";
import { GeminiSessionTriple } from "../translator/context-tracker";
import { THINKING_LEVEL_MAP, DEFAULT_CONFIG } from "../config";
import crypto from "crypto";

export interface StreamGenerateOptions {
  prompt: string;
  modelCategory: number;
  thinkingLevel: "low" | "medium" | "high";
  sessionTriple?: GeminiSessionTriple;
  onDelta: (text: string, isThought?: boolean) => void;
  onTriple: (triple: GeminiSessionTriple) => void;
}

export class StreamClient {
  private static bl = "boq_assistant-bard-web-server_20260716.08_p0";

  public static async executeStream(options: StreamGenerateOptions): Promise<void> {
    const authState = SessionAuth.getState();
    if (!authState.isLoggedIn || !authState.snlm0e) {
      throw new Error("Gemini Web session is not authenticated. Please log in via the harness window.");
    }

    const thinkMode = THINKING_LEVEL_MAP[options.thinkingLevel] ?? 0;
    const reqid = Math.floor(Date.now() % 1_000_000);

    // Build the 80-element inner array
    const inner: any[] = new Array(80).fill(null);
    inner[0] = [options.prompt, 0, null, null, null, null, 0];
    inner[1] = ["en"];

    if (options.sessionTriple) {
      inner[2] = [
        options.sessionTriple.conversationId,
        options.sessionTriple.responseId,
        options.sessionTriple.choiceId,
        null, null, null, null, null, null, ""
      ];
    } else {
      inner[2] = ["", "", "", null, null, null, null, null, null, ""];
    }

    inner[6] = [0];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[thinkMode]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    inner[41] = DEFAULT_CONFIG.temporaryChats ? [1] : null; // null saves chat to Gemini Web history
    inner[45] = 1;
    inner[53] = 0;
    inner[59] = crypto.randomUUID();
    inner[61] = [];
    inner[68] = 1;
    inner[79] = options.modelCategory;

    const outer = [null, JSON.stringify(inner)];
    const params = new URLSearchParams();
    params.set("f.req", JSON.stringify(outer));
    params.set("at", authState.snlm0e);

    const postBody = params.toString();
    const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${this.bl}&hl=en&_reqid=${reqid}&rt=c`;

    return new Promise((resolve, reject) => {
      const request = net.request({
        method: "POST",
        url,
        partition: SessionAuth.getPartition(),
      });

      request.setHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
      request.setHeader("Origin", "https://gemini.google.com");
      request.setHeader("Referer", "https://gemini.google.com/app");
      request.setHeader("X-Same-Domain", "1");
      const authHeader = SessionAuth.getFreshAuthHeader();
      if (authHeader) {
        request.setHeader("Authorization", authHeader);
      }

      let buffer = "";
      let emittedText = "";

      request.on("response", (response) => {
        if (response.statusCode >= 400) {
          reject(new Error(`StreamGenerate returned HTTP error ${response.statusCode}`));
          return;
        }

        response.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          buffer += text;

          // Parse chunked responses
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(")]}'")) continue;

            try {
              // Google sends line length, then line content
              let jsonStr = trimmed;
              if (/^\d+$/.test(trimmed)) continue; // skip length indicator lines

              const parsed = JSON.parse(jsonStr);
              if (Array.isArray(parsed) && parsed[0] && parsed[0][2]) {
                const payloadStr = parsed[0][2];
                const innerData = typeof payloadStr === "string" ? JSON.parse(payloadStr) : payloadStr;

                // Extract conversation triple [conversation_id, response_id, choice_id]
                if (Array.isArray(innerData) && innerData[1]) {
                  const tripleData = innerData[1];
                  if (Array.isArray(tripleData) && tripleData.length >= 3 && tripleData[0]) {
                    options.onTriple({
                      conversationId: tripleData[0],
                      responseId: tripleData[1],
                      choiceId: tripleData[2],
                    });
                  }
                }

                // Extract response candidate text chunk
                // candidate text is at innerData[4][0][1][0]
                if (Array.isArray(innerData) && innerData[4] && innerData[4][0]) {
                  const candidate = innerData[4][0];
                  if (candidate[1] && candidate[1][0]) {
                    const fullText = candidate[1][0];
                    if (fullText.length > emittedText.length) {
                      const delta = fullText.substring(emittedText.length);
                      emittedText = fullText;
                      options.onDelta(delta);
                    }
                  }
                }
              }
            } catch {
              // Partial line in chunk, ignore until next chunk
            }
          }
        });

        response.on("end", () => {
          resolve();
        });

        response.on("error", (err) => {
          reject(err);
        });
      });

      request.on("error", (err) => {
        reject(err);
      });

      request.write(postBody);
      request.end();
    });
  }
}
