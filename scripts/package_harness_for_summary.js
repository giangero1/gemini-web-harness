const fs = require('fs');
const path = require('path');

const root = 'D:\\gemini-web-harness';

const targetFiles = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'DOCUMENTATION.md',
  'src/config.ts',
  'src/main.ts',
  'src/bridge/browser-window.ts',
  'src/bridge/chrome-login.ts',
  'src/bridge/chrome-screencast.ts',
  'src/bridge/dom-automation.ts',
  'src/bridge/file-ingester.ts',
  'src/bridge/history-store.ts',
  'src/bridge/session-auth.ts',
  'src/bridge/stream-client.ts',
  'src/bridge/workspace-scanner.ts',
  'src/gateway/catalog.ts',
  'src/gateway/server.ts',
  'src/gateway/stream-handler.ts',
  'src/translator/context-tracker.ts',
  'src/translator/prompt-shim.ts',
  'src/translator/response-parser.ts',
  'src/ui/index.html',
  'scripts/call_web_gemini.js',
  'scripts/send_live_chrome_prompt.js',
  'scripts/check_chrome_page.js',
  'scripts/setup-bettergravity.js',
  'tests/models-catalog.test.ts',
  'tests/prompt-shim-antigravity.test.ts',
  'tests/response-parser.test.ts'
];

let totalBytes = 0;
const parts = [];

parts.push(`You are Gemini 4 Argon, Google's flagship frontier reasoning model with 1,000,000 token context running on Gemini Web.`);
parts.push(`Please read the complete source code, scripts, architecture specifications, and documentation of this project ("gemini-web-harness") below.`);
parts.push(`Then provide a thorough, structured, and comprehensive executive and architectural summary of the project.\n`);

parts.push(`Your summary should cover:`);
parts.push(`1. **Executive Overview & Core Purpose**: What is gemini-web-harness? What problem does it solve for Google Antigravity & local developers? Why does it exist (zero API cost, 1M context, Gemini 4 Argon / 3.1 Pro frontier reasoning)?`);
parts.push(`2. **High-Level System Architecture**: The components and data flow between Antigravity/CLI, the Express Gateway (port 8046), Electron main process, embedded <webview>, and the Google Gemini Web platform (gemini.google.com).`);
parts.push(`3. **Core Subsystems & Modules Breakdown**: Detailed breakdown of every core directory and component:`);
parts.push(`   - Gateway Server & Stream Handler (\`src/gateway/\`)`);
parts.push(`   - Bridge Layer (\`src/bridge/\`: DOM automation, instant OS clipboard injection, stream client, session auth, file ingester, history store, screencast)`);
parts.push(`   - Translator Layer (\`src/translator/\`: prompt shim, context tracker, response parser)`);
parts.push(`   - Desktop UI & Electron Management (\`src/main.ts\`, \`src/ui/index.html\`)`);
parts.push(`   - CLI & Scripting Tooling (\`scripts/call_web_gemini.js\`, setup scripts)`);
parts.push(`4. **Key Technical Innovations & Breakthroughs**: Explain the critical engineering breakthroughs implemented in this codebase (e.g. Quill DOM bypass with native OS clipboard paste under 50ms, reverse-engineered StreamGenerate protocol & cumulative SSE diffing, 80-element proto payload structure, session cookie persistence & SAPISID hashing, side-by-side Electron live UI).`);
parts.push(`5. **Testing, Verification & Quality Assurance**: What test suites exist, and how the gateway and parser behavior are validated.`);
parts.push(`6. **Conclusion & Developer Value**: Summary of the strategic advantages and workflow impact.\n`);

parts.push(`=== PROJECT FILE TREE & SIZES ===`);
for (const rel of targetFiles) {
  const full = path.join(root, rel);
  if (fs.existsSync(full)) {
    const stat = fs.statSync(full);
    parts.push(`- ${rel} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}
parts.push(`\n=== FULL RAW FILE CONTENTS (100% UNABRIDGED) ===\n`);

for (const rel of targetFiles) {
  const full = path.join(root, rel);
  if (fs.existsSync(full)) {
    const content = fs.readFileSync(full, 'utf8');
    totalBytes += Buffer.byteLength(content);
    const ext = path.extname(rel).replace('.', '') || 'text';
    parts.push(`### File: ${rel} (${full})\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
  } else {
    parts.push(`### File: ${rel} [FILE NOT FOUND]\n`);
  }
}

const finalPrompt = parts.join('\n');
const outPath = path.join(root, 'prompt_harness_summary.txt');
fs.writeFileSync(outPath, finalPrompt, 'utf8');

console.log(`Packaged ${targetFiles.length} files successfully!`);
console.log(`Total payload size: ${(totalBytes / 1024).toFixed(1)} KB (~${Math.ceil(finalPrompt.length / 4)} tokens)`);
console.log(`Output written to: ${outPath}`);
