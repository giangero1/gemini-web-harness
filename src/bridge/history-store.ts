import fs from "fs";
import path from "path";

export interface ConversationRecord {
  id: string;
  timestamp: string;
  model: string;
  thinkingLevel: string;
  prompt: string;
  response: string;
  conversationId?: string;
  latencyMs?: number;
  status: string;
  envelopeJson?: string;
  toolCalls?: Array<{ name: string; args: Record<string, any> }>;
}

export class HistoryStore {
  private static filePath = path.resolve(process.env.HARNESS_ROOT || path.resolve(__dirname, "..", ".."), ".conversations.json");

  public static getAll(): ConversationRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  public static add(entry: Omit<ConversationRecord, "id" | "timestamp">): ConversationRecord {
    const list = this.getAll();
    const record: ConversationRecord = {
      id: "conv_" + Date.now(),
      timestamp: new Date().toLocaleTimeString() + " " + new Date().toLocaleDateString(),
      ...entry,
    };

    list.unshift(record); // newest first
    // keep last 50
    const trimmed = list.slice(0, 50);

    try {
      fs.writeFileSync(this.filePath, JSON.stringify(trimmed, null, 2), "utf8");
    } catch (err) {
      console.error("[HistoryStore] Failed to save conversation history:", err);
    }

    return record;
  }
}
