const logger = require("./logger");

function formatArgs(args) {
  const [prefix, msg] = args;

  // Single argument: log as-is
  if (msg === undefined) {
    if (prefix instanceof Error) {
      return prefix.stack || prefix.message || String(prefix);
    }
    return String(prefix);
  }

  // Two arguments: mimic npmlog("tag", message)
  const tag = prefix == null ? "" : String(prefix);
  if (msg instanceof Error) {
    const base = msg.message || String(msg);
    return tag ? `${tag}: ${base}` : base;
  }
  const text = msg == null ? "" : String(msg);
  return tag ? `${tag}: ${text}` : text;
}

const log = {
  info: (...args) => logger(formatArgs(args), "info"),
  warn: (...args) => logger(formatArgs(args), "warn"),
  error: (...args) => logger(formatArgs(args), "error"),
  verbose: (...args) => logger(formatArgs(args), "info"),
  silly: (...args) => logger(formatArgs(args), "info")
};

module.exports = log;

