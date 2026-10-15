const fs = require("fs");
const path = require("path");

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming");
const bgDir = path.join(appData, "BetterGravity");
const settingsPath = path.join(bgDir, "settings.json");
const storagePath = path.join(bgDir, "storage.json");

if (!fs.existsSync(bgDir)) {
  console.error(`[Error] BetterGravity directory not found at ${bgDir}`);
  process.exit(1);
}

// 1. Update settings.json to enable gemini-api-key plugin
if (fs.existsSync(settingsPath)) {
  try {
    let raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
    const settings = JSON.parse(raw);
    if (!settings.plugins) settings.plugins = { enabled: [], developerMode: true };
    if (!Array.isArray(settings.plugins.enabled)) settings.plugins.enabled = [];

    if (!settings.plugins.enabled.includes("gemini-api-key")) {
      settings.plugins.enabled.push("gemini-api-key");
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      console.log("[Settings] Enabled gemini-api-key plugin in BetterGravity settings.");
    } else {
      console.log("[Settings] gemini-api-key plugin is already enabled.");
    }
  } catch (err) {
    console.error("[Settings Error]", err);
  }
}

// 2. Update storage.json to route to port 8046
if (fs.existsSync(storagePath)) {
  try {
    let raw = fs.readFileSync(storagePath, "utf8").replace(/^\uFEFF/, "");
    const storage = JSON.parse(raw);
    storage["gemini-api-key"] = {
      "setting:baseUrl": "http://127.0.0.1:8046",
      "setting:apiKey": "gemini-web-harness-active",
      "setting:stream": true,
      "setting:thoughts": true,
    };
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2), "utf8");
    console.log("[Storage] Configured gemini-api-key: baseUrl=http://127.0.0.1:8046, stream=true, thoughts=true");
  } catch (err) {
    console.error("[Storage Error]", err);
  }
}

console.log("BetterGravity integration configured successfully! Restart Antigravity to activate.");
