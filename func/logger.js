"use strict";

const chalk = require("chalk");
const gradient = require("gradient-string");

const themes = [
  "blue",
  "dream2",
  "dream",
  "fiery",
  "rainbow",
  "pastel",
  "cristal",
  "red",
  "aqua",
  "pink",
  "retro",
  "sunlight",
  "teen",
  "summer",
  "flower",
  "ghost",
  "hacker"
];

function buildGradient(name) {
  const t = String(name || "").toLowerCase();

  switch (t) {
    case "blue":
      return gradient([
        { color: "#1affa3", pos: 0 },
        { color: "#00d9ff", pos: 0.25 },
        { color: "#7b61ff", pos: 0.5 },
        { color: "#ff4fd8", pos: 0.75 },
        { color: "#1affa3", pos: 1 }
      ]);

    case "dream2":
      return gradient("#00c6ff", "#7b2cff", "#ff4fd8");

    case "dream":
      return gradient([
        { color: "#00c6ff", pos: 0 },
        { color: "#7b2cff", pos: 0.3 },
        { color: "#ffcc00", pos: 0.55 },
        { color: "#ff4fd8", pos: 0.8 },
        { color: "#00c6ff", pos: 1 }
      ]);

    case "fiery":
      return gradient("#ff2100", "#ff6a00", "#ffd000");

    case "rainbow":
      return gradient.rainbow;

    case "pastel":
      return gradient.pastel;

    case "cristal":
      return gradient.cristal;

    case "red":
      return gradient("#ff003c", "#ff7b00");

    case "aqua":
      return gradient("#0066ff", "#00eaff");

    case "pink":
      return gradient("#ff4fd8", "#8b00ff");

    case "retro":
      return gradient.retro;

    case "sunlight":
      return gradient("#ff8c00", "#ffe600");

    case "teen":
      return gradient.teen;

    case "summer":
      return gradient.summer;

    case "flower":
      return gradient("#00c6ff", "#8b00ff", "#ffe600", "#55ff77");

    case "ghost":
      return gradient.mind;

    case "hacker":
      return gradient("#39ff14", "#00c853", "#00ff88");

    default:
      return gradient("#243aff", "#4687f0", "#8a2be2");
  }
}

const themeName = themes[Math.floor(Math.random() * themes.length)];
const co = buildGradient(themeName);

function formatPrefix(type) {
  const name = String(type || "INFO").toUpperCase();

  if (name === "WARN") {
    return chalk.bold.hex("#ffb000")("[ SHADOWX-FCA⚡ ]");
  }

  if (name === "ERROR") {
    return chalk.bold.hex("#ff3b30")("[ SHADOWX-FCA⚡ ]");
  }

  if (name === "SUCCESS") {
    return chalk.bold.hex("#00ff88")("[ SHADOWX-FCA⚡ ]");
  }

  if (name === "DEBUG") {
    return chalk.bold.hex("#8888ff")("[ SHADOWX-FCA⚡ ]");
  }

  return chalk.bold(co("[ SHADOWX-FCA⚡ ]"));
}

function formatMessage(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\n+/g, "\n");
}

module.exports = (text, type = "info") => {
  const message = formatMessage(text);
  const prefix = formatPrefix(type);

  process.stderr.write(`${prefix} ${co(">")} ${message}\n`);
};
