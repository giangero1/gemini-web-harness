import assert from "assert";
import { AgentLoop } from "../src/agent/agent-loop";

async function runTests() {
  console.log("--- Starting AgentLoop Multi-Tool Parser & Execution Tests ---");

  // 1. Single tool call in ```function_call
  const singleResponse = `
I need to inspect the configuration file first.
\`\`\`function_call
{"name": "read_file", "args": {"filePath": "src/config.ts", "startLine": 1, "endLine": 20}}
\`\`\`
  `;
  const singleCalls = AgentLoop.extractAllToolCalls(singleResponse);
  assert.strictEqual(singleCalls.length, 1, "Should extract exactly 1 tool call");
  assert.strictEqual(singleCalls[0].name, "read_file");
  assert.strictEqual(singleCalls[0].args.filePath, "src/config.ts");
  console.log("✓ Test 1 Passed: Single tool call extracted cleanly");

  // 2. Multiple tool calls across separate markdown blocks
  const multiBlockResponse = `
Let me inspect both files to understand the architecture.
\`\`\`function_call
{"name": "read_file", "args": {"filePath": "src/agent/agent-loop.ts"}}
\`\`\`
And also check the tool executor:
\`\`\`function_call
{"name": "read_file", "args": {"filePath": "src/agent/tool-executor.ts"}}
\`\`\`
  `;
  const multiBlockCalls = AgentLoop.extractAllToolCalls(multiBlockResponse);
  assert.strictEqual(multiBlockCalls.length, 2, "Should extract 2 tool calls from distinct code blocks");
  assert.strictEqual(multiBlockCalls[0].name, "read_file");
  assert.strictEqual(multiBlockCalls[0].args.filePath, "src/agent/agent-loop.ts");
  assert.strictEqual(multiBlockCalls[1].name, "read_file");
  assert.strictEqual(multiBlockCalls[1].args.filePath, "src/agent/tool-executor.ts");
  console.log("✓ Test 2 Passed: Multiple distinct markdown blocks extracted in order");

  // 3. Multiple tool calls in a single JSON array
  const arrayResponse = `
\`\`\`json
[
  {"name": "list_directory", "args": {"dirPath": "src", "maxDepth": 2}},
  {"name": "run_command", "args": {"command": "git status"}}
]
\`\`\`
  `;
  const arrayCalls = AgentLoop.extractAllToolCalls(arrayResponse);
  assert.strictEqual(arrayCalls.length, 2, "Should extract 2 tool calls from JSON array");
  assert.strictEqual(arrayCalls[0].name, "list_directory");
  assert.strictEqual(arrayCalls[1].name, "run_command");
  assert.strictEqual(arrayCalls[1].args.command, "git status");
  console.log("✓ Test 3 Passed: JSON array of tool calls parsed accurately");

  // 4. Raw inline JSON without markdown blocks
  const rawInlineResponse = `
I will check the directory now:
{"name": "list_directory", "args": {"dirPath": "."}}
  `;
  const rawCalls = AgentLoop.extractAllToolCalls(rawInlineResponse);
  assert.strictEqual(rawCalls.length, 1, "Should extract raw inline JSON tool call");
  assert.strictEqual(rawCalls[0].name, "list_directory");
  console.log("✓ Test 4 Passed: Raw inline JSON parsed when code block omitted");

  // 5. Tolerant JSON repair (trailing commas, duplicate commas)
  const dirtyJsonResponse = `
\`\`\`function_call
{
  "name": "write_file",,
  "args": {
    "filePath": "src/test.txt",
    "content": "sample content",,
  },
}
\`\`\`
  `;
  const dirtyCalls = AgentLoop.extractAllToolCalls(dirtyJsonResponse);
  assert.strictEqual(dirtyCalls.length, 1, "Should repair dirty commas in JSON");
  assert.strictEqual(dirtyCalls[0].name, "write_file");
  assert.strictEqual(dirtyCalls[0].args.filePath, "src/test.txt");
  console.log("✓ Test 5 Passed: JSON syntax repair handles trailing/duplicate commas");

  // 6. Conversational response with no tool calls
  const plainResponse = `
I have completed the refactoring and all tests pass with zero errors. The harness is fully solid!
  `;
  const emptyCalls = AgentLoop.extractAllToolCalls(plainResponse);
  assert.strictEqual(emptyCalls.length, 0, "Plain prose should produce 0 tool calls");
  console.log("✓ Test 6 Passed: Standard markdown prose cleanly recognized as terminal turn");

  console.log("--- All AgentLoop Multi-Tool Tests Passed! ---");
}

runTests().catch((err) => {
  console.error("❌ AgentLoop Multi-Tool Test Failure:", err);
  process.exit(1);
});
