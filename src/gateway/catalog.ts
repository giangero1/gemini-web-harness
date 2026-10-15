import { MODELS } from "../config";

export interface GenAiModelInfo {
  name: string;
  version: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
}

export class ModelCatalog {
  public static getModelsList(): { models: GenAiModelInfo[] } {
    const models: GenAiModelInfo[] = Object.values(MODELS).map(m => ({
      name: `models/${m.id}`,
      version: "web-live",
      displayName: m.displayName,
      description: m.description,
      inputTokenLimit: m.contextWindow,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
        "countTokens",
      ],
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
    }));

    return { models };
  }

  public static getModel(modelId: string): GenAiModelInfo | undefined {
    const cleanId = modelId.replace("models/", "");
    const found = MODELS[cleanId];
    if (!found) return undefined;

    return {
      name: `models/${found.id}`,
      version: "web-live",
      displayName: found.displayName,
      description: found.description,
      inputTokenLimit: found.contextWindow,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
      ],
    };
  }
}
