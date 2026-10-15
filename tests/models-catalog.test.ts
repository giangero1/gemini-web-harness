import { ModelCatalog } from "../src/gateway/catalog";
import assert from "assert";

function runCatalogTests() {
  console.log("--- Starting ModelCatalog Tests ---");

  const list = ModelCatalog.getModelsList();
  assert(Array.isArray(list.models), "models property must be an array");
  assert(list.models.length >= 4, "Must expose at least 4 models");

  const modelNames = list.models.map(m => m.name);
  console.log("Exposed Models:", modelNames);

  assert(modelNames.includes("models/gemini-4-argon"), "Gemini 4 Argon must be present");
  assert(modelNames.includes("models/gemini-3.1-pro"), "Gemini 3.1 Pro must be present");
  assert(modelNames.includes("models/gemini-3.8-flash"), "Gemini 3.8 Flash must be present");
  assert(modelNames.includes("models/gemini-3.5-flash-lite"), "Gemini 3.5 Flash-Lite must be present");

  const argon = list.models.find(m => m.name === "models/gemini-4-argon");
  assert.strictEqual(argon?.inputTokenLimit, 1_000_000, "Argon context window must be 1,000,000 tokens");
  assert(argon?.supportedGenerationMethods.includes("streamGenerateContent"));

  console.log("✓ All ModelCatalog Tests Passed!");
}

runCatalogTests();
