const fs = require("fs");
const path = require("path");

function getTree(dir, depth = 0) {
  if (depth > 2) return "";
  let out = "";
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".chrome-profile" || e.name === ".git") continue;
    out += "  ".repeat(depth) + (e.isDirectory() ? "[DIR] " : "[FILE] ") + e.name + "\n";
    if (e.isDirectory()) {
      out += getTree(path.join(dir, e.name), depth + 1);
    }
  }
  return out;
}

const root = "D:\\gemini-web-harness";
const tree = getTree(root);
const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");

const prompt = `You are Gemini 4 Argon analyzing a local codebase on the user's PC.
Here is the directory tree of D:\\gemini-web-harness:
${tree}

Here is the package.json:
${pkg}

Please review this folder, explain the architecture you see, identify its primary purpose, and summarize each core component clearly.`;

fs.writeFileSync("D:\\gemini-web-harness\\prompt_folder_review.txt", prompt, "utf8");
console.log("Prompt prepared successfully! Total characters:", prompt.length);
