"use strict";

const delay = ms => new Promise(r => setTimeout(r, ms));

function createEmit(ctx) {
  return (event, payload) => {
    try {
      if (ctx && ctx._emitter && typeof ctx._emitter.emit === "function") {
        ctx._emitter.emit(event, payload);
      }
    } catch { }
  };
}

function headerOf(headers, name) {
  if (!headers) return;
  const k = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}

function buildUrl(cfg) {
  try {
    return cfg?.baseURL
      ? new URL(cfg.url || "/", cfg.baseURL).toString()
      : cfg?.url || "";
  } catch {
    return cfg?.url || "";
  }
}

function formatCookie(arr, service) {
  const n = String(arr?.[0] || "");
  const v = String(arr?.[1] || "");
  return `${n}=${v}; Domain=.${service}.com; Path=/; Secure`;
}

module.exports = {
  delay,
  createEmit,
  headerOf,
  buildUrl,
  formatCookie
};
