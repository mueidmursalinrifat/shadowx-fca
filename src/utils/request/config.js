"use strict";

const { sanitizeHeaders } = require("./sanitize");
const { jar, client } = require("./client");
const { getAgentForProxy } = require("./proxy");

function cfg(base = {}) {
  const { reqJar, headers, params, agent, timeout, proxyUrl } = base;
  // Prefer an explicit per-session proxy (ctx.globalOptions.proxy, threaded
  // in from methods.js) over the process-wide default set by setProxy().
  // This keeps one account's proxy/IP change from silently affecting
  // another account's in-flight session in the same process.
  const resolvedAgent = agent || (proxyUrl !== undefined ? getAgentForProxy(proxyUrl) : undefined);
  return {
    headers: sanitizeHeaders(headers),
    params,
    jar: reqJar || jar,
    withCredentials: true,
    timeout: timeout || 60000,
    httpAgent: resolvedAgent || client.defaults.httpAgent,
    httpsAgent: resolvedAgent || client.defaults.httpsAgent,
    proxy: false,
    validateStatus: (s) => s >= 200 && s < 600,
  };
}

module.exports = {
  cfg,
};
