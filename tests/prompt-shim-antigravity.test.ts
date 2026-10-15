import { PromptShim, GenAiRequest } from "../src/translator/prompt-shim";
import { WorkspaceScanner } from "../src/bridge/workspace-scanner";
import assert from "assert";

function runTests() {
  console.log("--- Starting Antigravity Prompt Shim & Workspace Scanner Tests ---");

  // Test 1: JSON Envelope Framing Mode (<antigravity_context_json>)
  {
    const req: GenAiRequest = {
      systemInstruction: { parts: [{ text: "Maintain documentation integrity." }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "view_file",
              description: "View contents of a file",
              parameters: { properties: { AbsolutePath: { type: "STRING" } } },
            },
          ],
        },
      ],
      contents: [
        {
          role: "user",
          parts: [{ text: "Can you inspect index.html?" }],
        },
      ],
    };

    const compiled = PromptShim.compile(req, { framingMode: "json_envelope" });
    assert.strictEqual(compiled.framingMode, "json_envelope");
    assert.strictEqual(compiled.hasTools, true);
    assert.strictEqual(compiled.toolCount, 1);

    // Verify Backend Agent Header
    assert(
      compiled.prompt.includes("Act as the model backend for the Google Antigravity autonomous coding agent task"),
      "Must include Antigravity backend agent header"
    );

    // Verify Envelope tags
    assert(compiled.prompt.includes("<antigravity_context_json>"), "Must include opening <antigravity_context_json> tag");
    assert(compiled.prompt.includes("</antigravity_context_json>"), "Must include closing </antigravity_context_json> tag");
    assert(compiled.prompt.includes("<antigravity_transport_resume>"), "Must include resume trigger tag");

    // Verify Envelope JSON contents
    assert(compiled.envelopeJson, "Must export parsed envelopeJson string");
    const parsedEnvelope = JSON.parse(compiled.envelopeJson);
    assert.strictEqual(parsedEnvelope.protocol, "antigravity-gemini-web");
    assert.strictEqual(parsedEnvelope.declared_tools[0].name, "view_file");
    assert.strictEqual(parsedEnvelope.system_instructions[0], "Maintain documentation integrity.");
    assert.strictEqual(parsedEnvelope.messages[0].parts[0].text, "Can you inspect index.html?");

    console.log("✓ Test 1 Passed: Strict <antigravity_context_json> Envelope Compilation");
  }

  // Test 2: Markdown Hierarchy Framing Mode
  {
    const req: GenAiRequest = {
      systemInstruction: { parts: [{ text: "Be concise." }] },
      contents: [
        {
          role: "user",
          parts: [{ text: "Explain quantum teleportation." }],
        },
      ],
    };

    const compiled = PromptShim.compile(req, { framingMode: "markdown_hierarchy" });
    assert.strictEqual(compiled.framingMode, "markdown_hierarchy");
    assert.strictEqual(compiled.hasTools, false);
    assert(compiled.prompt.includes("[Antigravity Backend Protocol]"));
    assert(compiled.prompt.includes("[System Instructions]\nBe concise."));
    assert(compiled.prompt.includes("User:\nExplain quantum teleportation."));

    console.log("✓ Test 2 Passed: Markdown Hierarchy Framing Mode");
  }

  // Test 3: WorkspaceScanner Dynamic File Discovery
  {
    const summary = WorkspaceScanner.scan("D:\\gemini-web-harness");
    assert(summary.totalFiles > 5, "Should detect workspace files");
    assert(summary.sampleFilesByCategory.entry.length > 0, "Should detect entrypoints (main.ts/server.ts)");
    assert(summary.sampleFilesByCategory.module.length > 0, "Should detect module files");

    console.log(`✓ Test 3 Passed: WorkspaceScanner scanned ${summary.totalFiles} files across ${summary.workspaceRoot}`);
  }

  // Test 4: Generalized Demonstration Suite Scenarios
  {
    const scenarios = WorkspaceScanner.getDynamicScenarios("D:\\gemini-web-harness");
    assert.strictEqual(scenarios.length >= 5, true, "Must provide at least 5 standard categories");

    const authScenario = scenarios.find((s) => s.id === "auth-check");
    const toolScenario = scenarios.find((s) => s.id === "antigravity-tool-proto");
    const archScenario = scenarios.find((s) => s.id === "arch-audit");
    const forensicScenario = scenarios.find((s) => s.id === "forensic-bug-hunt");
    const mathScenario = scenarios.find((s) => s.id === "frontier-math");

    assert(authScenario, "Auth scenario must exist");
    assert(toolScenario, "Tool protocol simulation must exist");
    assert(toolScenario.prompt.includes("Autonomous Coding Agent Protocol"), "Tool scenario must test protocol");
    assert(archScenario && archScenario.targetPath, "Architecture scenario must have targetPath");
    assert(forensicScenario && forensicScenario.targetPath, "Forensic scenario must have targetPath");
    assert(mathScenario, "Math reasoning scenario must exist");

    console.log("✓ Test 4 Passed: Dynamic Demonstration Suite Generation");
  }

  console.log("--- All Antigravity Prompt Shim & Workspace Scanner Tests Passed Successfully! ---");
}

runTests();
