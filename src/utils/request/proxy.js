"use strict";

const { HttpsProxyAgent } = require("https-proxy-agent");
const { client } = require("./client");

// Per-proxy-URL agent cache so we don't create a new agent (and socket pool)
// on every single request, while still letting different sessions in the
// same process use different proxies (or no proxy) without stepping on each
// other. Keyed by the proxy URL string; "" represents "no proxy".
const agentCache = new Map();

function getAgentForProxy(proxyUrl) {
  const key = proxyUrl || "";
  if (!key) return undefined;
  if (agentCache.has(key)) return agentCache.get(key);
  const agent = new HttpsProxyAgent(key);
  agentCache.set(key, agent);
  return agent;
}

// Global default proxy setter, kept for backward compatibility with
// existing callers (api.setOptions({ proxy })) and single-account use.
// NOTE: this changes the DEFAULT used only when a request doesn't specify
// its own per-session proxy (see cfg() in ./config.js, which now prefers
// ctx.globalOptions.proxy when present). In a multi-account process, each
// account's requests should carry their own ctx.globalOptions.proxy so
// calling setProxy() for one account can no longer change another running
// account's outbound IP mid-session - that accidental cross-session proxy
// change was flagged as a real risk for "abnormal session" detection.
function setProxy(proxyUrl) {
  if (!proxyUrl) {
    client.defaults.httpAgent = undefined;
    client.defaults.httpsAgent = undefined;
    client.defaults.proxy = false;
    return;
  }
  const agent = getAgentForProxy(proxyUrl);
  client.defaults.httpAgent = agent;
  client.defaults.httpsAgent = agent;
  client.defaults.proxy = false;
}

module.exports = {
  setProxy,
  getAgentForProxy,
};
