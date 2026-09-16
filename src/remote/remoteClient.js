"use strict";

const WebSocket = require("ws");
const logger = require("../../func/logger");

function createRemoteClient(api, ctx, cfg) {
  if (!cfg || !cfg.enabled || !cfg.url) return null;

  const url = String(cfg.url);
  const token = cfg.token ? String(cfg.token) : null;
  const autoReconnect = cfg.autoReconnect !== false;
  const emitter = ctx && ctx._emitter;

  let ws = null;
  let closed = false;
  let reconnectTimer = null;

  function log(message, level = "info") {
    logger(`[remote] ${message}`, level);
  }

  function scheduleReconnect() {
    if (!autoReconnect || closed) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) connect();
    }, 5000);
  }

  function safeEmit(event, payload) {
    try {
      if (emitter && typeof emitter.emit === "function") {
        emitter.emit(event, payload);
      }
    } catch { }
  }

  function connect() {
    try {
      ws = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
    } catch (e) {
      log(`connect error: ${e && e.message ? e.message : String(e)}`, "warn");
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      log("connected", "info");
      const payload = {
        type: "hello",
        userID: ctx && ctx.userID,
        region: ctx && ctx.region,
        version: require("../../package.json").version
      };
      try {
        ws.send(JSON.stringify(payload));
      } catch { }
      safeEmit("remoteConnected", payload);
    });

    ws.on("message", data => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      switch (msg.type) {
        case "ping":
          try {
            ws.send(JSON.stringify({ type: "pong" }));
          } catch { }
          break;
        case "stop":
          safeEmit("remoteStop", msg);
          break;
        case "broadcast":
          safeEmit("remoteBroadcast", msg.payload || {});
          break;
        default:
          safeEmit("remoteMessage", msg);
          break;
      }
    });

    ws.on("close", () => {
      log("disconnected", "warn");
      safeEmit("remoteDisconnected");
      if (!closed) scheduleReconnect();
    });

    ws.on("error", err => {
      log(`error: ${err && err.message ? err.message : String(err)}`, "warn");
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      } catch { }
    }
  };
}

module.exports = {
  createRemoteClient
};

