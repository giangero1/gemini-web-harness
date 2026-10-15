import { ResponseParser } from "../src/translator/response-parser";
import assert from "assert";

function runTests() {
  console.log("--- Starting ResponseParser Tests ---");

  // Test 1: Plain text streaming
  {
    const parser = new ResponseParser();
    const chunks = parser.parseChunk("Hello, how can I assist you today?");
    assert.strictEqual(chunks.length, 1);
    assert(chunks[0].includes("Hello, how can I assist you today?"));
    const finalChunks = parser.finalize();
    assert(finalChunks[0].includes("finishReason"));
    console.log("✓ Test 1 Passed: Plain text streaming");
  }

  // Test 2: Tool call extraction
  {
    const parser = new ResponseParser();
    const toolCallMarkdown = "```function_call\n{\n  \"name\": \"view_file\",\n  \"args\": {\n    \"AbsolutePath\": \"D:/test.txt\",\n    \"StartLine\": 1,\n    \"EndLine\": 50\n  }\n}\n```";
    
    // Send in two parts to simulate streaming
    const part1 = parser.parseChunk(toolCallMarkdown.slice(0, 30));
    const part2 = parser.parseChunk(toolCallMarkdown.slice(30));

    const allChunks = [...part1, ...part2];
    const functionCallChunk = allChunks.find(c => c.includes("functionCall"));
    assert(functionCallChunk, "Should have emitted an SSE chunk containing functionCall");
    assert(functionCallChunk.includes("view_file"), "Tool name must be view_file");
    assert(functionCallChunk.includes("D:/test.txt"), "Path argument must match");
    console.log("✓ Test 2 Passed: Function call extraction & SSE formatting");
  }

  // Test 3: Thought stream parsing
  {
    const parser = new ResponseParser();
    const thoughtChunks = parser.parseChunk("Analyzing project structure...", true);
    assert.strictEqual(thoughtChunks.length, 1);
    assert(thoughtChunks[0].includes('"thought":true'));
    console.log("✓ Test 3 Passed: Thought chunk formatting");
  }

  console.log("--- All ResponseParser Tests Passed! ---");
}

runTests();
