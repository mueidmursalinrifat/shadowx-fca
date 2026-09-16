const { getType } = require("../src/utils/format");
const { setProxy } = require("../src/utils/request");
const logger = require("../func/logger");
const { getIdentity } = require("../src/utils/clientIdentity");
const Boolean_Option = [
  "online",
  "selfListen",
  "listenEvents",
  "updatePresence",
  "forceLogin",
  "autoMarkRead",
  "listenTyping",
  "autoReconnect",
  "emitReady",
  "selfListenEvent"
];
function setOptions(globalOptions, options) {
  for (const key of Object.keys(options || {})) {
    if (Boolean_Option.includes(key)) {
      globalOptions[key] = Boolean(options[key]);
      continue;
    }
    switch (key) {
      case "userAgent": {
        // Resolve through the centralized identity module so a custom UA still
        // gets internally-consistent sec-ch-ua/platform/arch hints instead of
        // silently keeping mismatched defaults from elsewhere in the code.
        // Note: once a session is connected, its identity is cached on ctx
        // (see src/utils/clientIdentity.js#getSessionIdentity) and will not
        // change mid-session even if this is called again - this call only
        // affects future/new sessions started from this globalOptions object.
        globalOptions.userAgent = getIdentity(options.userAgent).userAgent;
        break;
      }
      case "proxy": {
        if (typeof options.proxy !== "string") {
          delete globalOptions.proxy;
          setProxy();
        } else {
          globalOptions.proxy = options.proxy;
          setProxy(globalOptions.proxy);
        }
        break;
      }
      default: {
        logger("setOptions Unrecognized option given to setOptions: " + key, "warn");
        break;
      }
    }
  }
}
module.exports = { setOptions, Boolean_Option };
