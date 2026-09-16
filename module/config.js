const fs = require("fs");
const path = require("path");
const logger = require("../func/logger");
const defaultConfig = {
  autoUpdate: true,
  mqtt: { enabled: true, reconnectInterval: 3600 },
  autoLogin: true,
  // SECURITY: intentionally no default value here. Sending Facebook
  // credentials to a third-party server should be an explicit,
  // operator-chosen opt-in (see module/loginHelper.js#loginViaAPI), never a
  // silent default. Set this in fca-config.json only if you trust the
  // server you're pointing it at.
  apiServer: "",
  apiKey: "",
  credentials: { email: "", password: "", twofactor: "" },
  antiGetInfo: {
    AntiGetThreadInfo: false,
    AntiGetUserInfo: false
  },
  remoteControl: {
    enabled: false,
    url: "",
    token: "",
    autoReconnect: true
  }
};

function loadConfig() {
  const configPath = path.join(process.cwd(), "fca-config.json");
  let config;
  if (!fs.existsSync(configPath)) {
    config = defaultConfig;
  } else {
    try {
      const fileContent = fs.readFileSync(configPath, "utf8");
      config = Object.assign({}, defaultConfig, JSON.parse(fileContent));
    } catch (err) {
      logger(`Error reading config file: ${err.message}`, "error");
      config = defaultConfig;
    }
  }
  return { config, configPath };
}

module.exports = { loadConfig, defaultConfig };