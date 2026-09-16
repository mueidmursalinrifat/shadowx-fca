"use strict";

const https = require("https");
const pkg = require("../../package.json");

function getLatestVersion(cb) {
  const req = https.get(
    "https://registry.npmjs.org/shadowx-fca/latest",
    { headers: { "Accept": "application/json" } },
    (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { cb(null, JSON.parse(data).version); }
        catch { cb(new Error("parse failed")); }
      });
    }
  );
  req.on("error", cb);
  req.setTimeout(5000, () => { req.destroy(); cb(new Error("timeout")); });
}

function compareVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function checkForUpdate(logger) {
  const current = pkg.version;
  getLatestVersion((err, latest) => {
    if (err || !latest) return;
    if (compareVersion(current, latest) < 0) {
      if (typeof logger === "function") {
        logger(`⚡ SHADOWX-FCA update available — v${current} → v${latest}. Upgrade: npm install shadowx-fca@latest`, "warn");
      } else {
        console.warn(`\x1b[33m[SHADOWX-FCA] ⚡ update available — v${current} → v${latest} | npm install shadowx-fca@latest\x1b[0m`);
      }
    }
  });
}

module.exports = { checkForUpdate };
