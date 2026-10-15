#!/usr/bin/env node
/**
 * Official Google Chrome for Testing Auto-Downloader
 * Downloads and extracts a portable, self-contained Google Chrome binary to .chrome-bin
 * Requires ZERO administrative permissions.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const TARGET_DIR = path.resolve(__dirname, "..", ".chrome-bin");
const CHROME_EXE = path.join(TARGET_DIR, "chrome-win64", "chrome.exe");

async function getDownloadUrl() {
  return new Promise((resolve, reject) => {
    https.get(
      "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
      (res) => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Failed to fetch Chrome version metadata (HTTP ${res.statusCode})`));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const win64 = data.channels?.Stable?.downloads?.chrome?.find(
              (d) => d.platform === "win64"
            );
            if (!win64 || !win64.url) {
              return reject(new Error("Windows 64-bit Chrome download URL not found in metadata"));
            }
            resolve(win64.url);
          } catch (err) {
            reject(err);
          }
        });
      }
    ).on("error", reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const getWithRedirect = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return getWithRedirect(res.headers.location);
        }
        if (res.statusCode >= 400) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
        let downloadedBytes = 0;
        let lastReport = 0;

        res.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          file.write(chunk);
          if (totalBytes > 0) {
            const now = Date.now();
            if (now - lastReport > 200 || downloadedBytes === totalBytes) {
              lastReport = now;
              const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
              if (onProgress) {
                onProgress(percent, downloadedBytes, totalBytes);
              }
            }
          }
        });

        res.on("end", () => {
          file.end(() => resolve());
        });
      }).on("error", (err) => {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
    };

    getWithRedirect(url);
  });
}

async function ensurePortableChrome(onProgress) {
  if (fs.existsSync(CHROME_EXE)) {
    console.log(`[Chrome Provisioner] Portable Chrome already exists at: ${CHROME_EXE}`);
    return CHROME_EXE;
  }

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  console.log("[Chrome Provisioner] Fetching latest official Google Chrome for Testing release...");
  const downloadUrl = await getDownloadUrl();
  console.log(`[Chrome Provisioner] Downloading from: ${downloadUrl}`);

  const zipPath = path.join(TARGET_DIR, "chrome-win64.zip");
  
  await downloadFile(downloadUrl, zipPath, (percent, curr, total) => {
    const mb = (curr / 1024 / 1024).toFixed(1);
    const totalMb = (total / 1024 / 1024).toFixed(1);
    process.stdout.write(`\r[Chrome Provisioner] Downloading Chrome: ${percent}% (${mb} MB / ${totalMb} MB)`);
    if (onProgress) onProgress(percent, mb, totalMb);
  });

  console.log("\n[Chrome Provisioner] Extracting archive (this takes ~5-10s)...");
  if (onProgress) onProgress(100, "Extracting", "");

  // Use native PowerShell Expand-Archive for reliable unzipping
  const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${TARGET_DIR}' -Force"`;
  execSync(cmd, { stdio: "inherit" });

  try {
    fs.unlinkSync(zipPath);
  } catch {}

  if (!fs.existsSync(CHROME_EXE)) {
    throw new Error(`Extraction finished but binary not found at ${CHROME_EXE}`);
  }

  console.log(`[Chrome Provisioner] ✅ Portable Google Chrome ready at: ${CHROME_EXE}`);
  return CHROME_EXE;
}

if (require.main === module) {
  ensurePortableChrome()
    .then((p) => {
      console.log(`Successfully verified Chrome: ${p}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Chrome Provisioner Error]", err);
      process.exit(1);
    });
}

module.exports = { ensurePortableChrome, CHROME_EXE, TARGET_DIR };
