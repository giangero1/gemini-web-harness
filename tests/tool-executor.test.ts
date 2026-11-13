import assert from "assert";
import path from "path";
import fs from "fs";
import { ToolExecutor } from "../src/agent/tool-executor";

async function runTests() {
  console.log("--- Starting ToolExecutor Security & Sandbox Tests ---");
  const testWorkspace = path.resolve(__dirname, "..");
  ToolExecutor.setWorkspaceRoot(testWorkspace);

  // 1. Whitelisted command execution
  console.log("Testing whitelisted command execution...");
  const validRes = await ToolExecutor.runCommand("node -v");
  assert.strictEqual(validRes.success, true, "Valid node -v should succeed");
  assert(validRes.output?.includes("v"), "Output should contain node version");
  console.log("✓ Test 1 Passed: Whitelisted executable allowed (node -v)");

  // 2. Non-whitelisted executable rejection
  console.log("Testing non-whitelisted executable rejection...");
  const nonAllowedRes = await ToolExecutor.runCommand("whoami");
  assert.strictEqual(nonAllowedRes.success, false, "whoami should be rejected");
  assert(nonAllowedRes.error?.includes("whitelist"), "Error should specify whitelist violation");
  console.log("✓ Test 2 Passed: Non-whitelisted binary blocked");

  // 3. Dangerous command chaining & subshell rejection
  console.log("Testing shell metacharacters and operator sanitization...");

  const dangerousCommands = [
    { cmd: "node -v & dir", label: "Single ampersand (&) chaining" },
    { cmd: "node -v && git status", label: "Double ampersand (&&) chaining" },
    { cmd: "node -v ; git status", label: "Semicolon (;) separator" },
    { cmd: "git status | dir", label: "Pipe (|) operator" },
    { cmd: "node -v > output.txt", label: "Redirect write (>)" },
    { cmd: "node -v >> output.txt", label: "Redirect append (>>)" },
    { cmd: "node -v < input.txt", label: "Redirect read (<)" },
    { cmd: "node -v ^& dir", label: "Caret (^) escape" },
    { cmd: "node -v `dir`", label: "Backtick subshell" },
    { cmd: "node -v $(dir)", label: "Dollar subshell $()" },
    { cmd: "node -v\ndir", label: "Newline separator (\\n)" },
    { cmd: "node -v\rdir", label: "Carriage return separator (\\r)" },
  ];

  for (const item of dangerousCommands) {
    const res = await ToolExecutor.runCommand(item.cmd);
    assert.strictEqual(res.success, false, `${item.label} should be blocked`);
    assert(
      res.error?.includes("Security Error") && res.error?.includes("disabled for safety"),
      `Expected security error for: ${item.cmd}, got: ${res.error}`
    );
  }
  console.log(`✓ Test 3 Passed: All ${dangerousCommands.length} dangerous shell operators blocked`);

  // 4. Workspace path traversal boundary checks
  console.log("Testing workspace directory traversal boundaries...");
  const traversalRead = ToolExecutor.readFile("../outside.txt");
  assert.strictEqual(traversalRead.success, false, "Parent traversal should fail");
  assert(traversalRead.error?.includes("escapes workspace boundary"), "Error should report boundary escape");

  const traversalWrite = ToolExecutor.writeFile("../outside_evil.txt", "malicious payload");
  assert.strictEqual(traversalWrite.success, false, "Parent traversal write should fail");
  assert(traversalWrite.error?.includes("escapes workspace boundary"), "Error should report boundary escape");

  const traversalList = ToolExecutor.listDirectory("../");
  assert.strictEqual(traversalList.success, false, "Parent traversal list should fail");
  assert(traversalList.error?.includes("escapes workspace boundary"), "Error should report boundary escape");
  console.log("✓ Test 4 Passed: Workspace escape boundary strictly enforced");

  // 5. Valid file operations within boundary
  console.log("Testing valid file operations within workspace...");
  const readConfig = ToolExecutor.readFile("src/config.ts", 1, 15);
  assert.strictEqual(readConfig.success, true, "Reading src/config.ts should succeed");
  assert(readConfig.output?.includes("HarnessConfig"), "Content should include HarnessConfig");
  console.log("✓ Test 5 Passed: Valid internal workspace reads work accurately");

  // 6. Backup directory configuration
  ToolExecutor.setBackupDirName(".test_backups");
  assert.strictEqual(ToolExecutor.getBackupDirName(), ".test_backups", "Backup dir setter works");
  ToolExecutor.setBackupDirName(".hydrogen_backups");
  console.log("✓ Test 6 Passed: Dynamic backup directory management verified");

  console.log("--- All ToolExecutor Security Tests Passed! ---");
}

runTests().catch((err) => {
  console.error("❌ ToolExecutor Test Failure:", err);
  process.exit(1);
});
