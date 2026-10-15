export interface HarnessConfig {
  port: number;
  host: string;
  selectedModel: string;
  thinkingLevel: "low" | "medium" | "high";
  pacingDelayMs: number;
  temporaryChats: boolean;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  webCategory: number;
  description: string;
  supportsThinking: boolean;
  contextWindow: number;
}

// Live models verified directly from Gemini Web
export const MODELS: Record<string, ModelDefinition> = {
  "gemini-4-argon": {
    id: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    webCategory: 8, // Flagship frontier category (or mapped to Argon)
    description: "Google DeepMind's flagship frontier reasoning model for complex coding and multi-step tasks",
    supportsThinking: true,
    contextWindow: 1_000_000,
  },
  "gemini-3.1-pro": {
    id: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    webCategory: 3, // PRO
    description: "Advanced reasoning and deep problem solving",
    supportsThinking: true,
    contextWindow: 1_000_000,
  },
  "gemini-3.8-flash": {
    id: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    webCategory: 1, // FAST
    description: "Fast, comprehensive general-purpose assistance",
    supportsThinking: true,
    contextWindow: 1_000_000,
  },
  "gemini-3.5-flash-lite": {
    id: "gemini-3.5-flash-lite",
    displayName: "Gemini 3.5 Flash-Lite",
    webCategory: 6, // FLASH_LITE
    description: "Lowest latency responses for fast queries",
    supportsThinking: false,
    contextWindow: 32_768,
  },
};

// Thinking effort levels mapping (Επίπεδο σκέψης)
export const THINKING_LEVEL_MAP: Record<"low" | "medium" | "high", number> = {
  low: 4,     // Minimal / shallow thinking
  medium: 2,  // Balanced thinking
  high: 0,    // Deepest thinking
};

export const DEFAULT_CONFIG: HarnessConfig = {
  port: 8046,
  host: "127.0.0.1",
  selectedModel: "gemini-4-argon",
  thinkingLevel: "high",
  pacingDelayMs: 350,
  temporaryChats: false,
};
