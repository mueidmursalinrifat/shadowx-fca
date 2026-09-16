"use strict";

const { delay } = require("./client");

async function requestWithRetry(fn, retries = 3, baseDelay = 1000, ctx) {
  let lastError;
  const emit = (event, payload) => {
    try {
      if (ctx && ctx._emitter && typeof ctx._emitter.emit === "function") {
        ctx._emitter.emit(event, payload);
      }
    } catch {}
  };
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      if (
        e?.code === "ERR_INVALID_CHAR" ||
        (e?.message && e.message.includes("Invalid character in header"))
      ) {
        const err = new Error(
          "Invalid header content detected. Request aborted to prevent crash."
        );
        err.error = "Invalid header content";
        err.originalError = e;
        err.code = "ERR_INVALID_CHAR";
        return Promise.reject(err);
      }

      const status = e?.response?.status || e?.statusCode || 0;
      const url = e?.config?.url || "";
      const method = String(e?.config?.method || "").toUpperCase();
      if (status === 429) {
        emit("rateLimit", { status, url, method });
      }
      if (status >= 400 && status < 500 && status !== 429) {
        return e.response || Promise.reject(e);
      }
      if (i === retries - 1) {
        return e.response || Promise.reject(e);
      }
      const netCode = e?.code || "";
      const msg = e && e.message ? e.message : String(e || "");
      if (
        !status &&
        (netCode === "UND_ERR_CONNECT_TIMEOUT" ||
          netCode === "ETIMEDOUT" ||
          netCode === "ECONNRESET" ||
          netCode === "ECONNREFUSED" ||
          netCode === "ENOTFOUND" ||
          /timeout|connect timeout|network error|fetch failed/i.test(msg))
      ) {
        emit("networkError", {
          code: netCode,
          message: msg,
          url,
          method,
        });
      }

      const backoffDelay = Math.min(
        baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 200),
        30000
      );
      await delay(backoffDelay);
    }
  }
  const finalError = lastError || new Error("Request failed after retries");
  return Promise.reject(finalError);
}

module.exports = {
  requestWithRetry,
};
