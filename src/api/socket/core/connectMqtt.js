"use strict";
/**
 * MQTT/WebSocket listener for Facebook Messenger real-time events.
 * Connects to edge-chat.facebook.com, subscribes to topics, parses deltas and typing/presence.
 */
const { formatID } = require("../../../utils/format");
const { getSessionIdentity } = require("../../../utils/clientIdentity");

const DEFAULT_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 10; // cap consecutive network-failure reconnects; does not apply to confirmed auth failures (those never reconnect)
const T_MS_WAIT_TIMEOUT_MS = 5000;

// Exponential backoff with jitter, based on how many *consecutive* reconnect
// attempts have happened for this session (reset to 0 on a successful
// "connect" event). This replaces the old fixed 2s-every-time behavior,
// which could hammer the endpoint in a tight loop during real outages.
function computeBackoff(ctx, baseMs) {
  const attempt = (ctx._reconnectAttempts || 0);
  const exp = Math.min(baseMs * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
  const jitter = Math.floor(Math.random() * Math.min(1000, exp * 0.2));
  return Math.min(exp + jitter, MAX_RECONNECT_DELAY_MS);
}

module.exports = function createListenMqtt(deps) {
  const { WebSocket, mqtt, HttpsProxyAgent, buildStream, buildProxy,
    topics, parseDelta, getTaskResponseData, logger, emitAuth
  } = deps;

  return function listenMqtt(defaultFuncs, api, ctx, globalCallback) {

    function scheduleReconnect(delayMs) {
      const base = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;
      if (ctx._reconnectTimer) {
        logger("mqtt reconnect already scheduled", "warn");
        return; // debounce
      }
      if (ctx._ending) {
        // Covers confirmed logout/checkpoint/blocked-login/invalid-session:
        // emitAuth() sets ctx._ending = true before this is ever reached for
        // those cases, so we never auto-reconnect after a confirmed auth failure.
        logger("mqtt reconnect skipped - ending", "warn");
        return;
      }
      ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
      if (ctx._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logger(`mqtt reconnect attempts exceeded (${MAX_RECONNECT_ATTEMPTS}); giving up and surfacing error`, "error");
        globalCallback({ type: "stop_listen", error: "Max reconnect attempts exceeded" }, null);
        return;
      }
      const ms = typeof delayMs === "number" ? delayMs : computeBackoff(ctx, base);
      logger(`mqtt will reconnect in ${ms}ms (attempt ${ctx._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, "warn");
      ctx._reconnectTimer = setTimeout(() => {
        ctx._reconnectTimer = null;
        if (!ctx._ending) {
          listenMqtt(defaultFuncs, api, ctx, globalCallback);
        }
      }, ms);
    }
    function isEndingLikeError(msg) {
      return /No subscription existed|client disconnecting|socket hang up|ECONNRESET/i.test(msg || "");
    }

    // Ensure only one MQTT connection exists for this session, and that any
    // previous connection is fully closed (listeners removed, socket ended)
    // before a new one is opened. Without this, a reconnect racing with a
    // still-live prior connection could leave two live sockets publishing/
    // subscribing under the same session, which looks like an invalid/
    // duplicate session to the server.
    if (ctx.mqttClient) {
      try {
        ctx.mqttClient.removeAllListeners();
        if (ctx.mqttClient.connected) ctx.mqttClient.end(true);
      } catch (_) { }
      ctx.mqttClient = undefined;
    }

    // Resolve the identity ONCE per session (cached on ctx) so MQTT and HTTP
    // never disagree about User-Agent / Accept-Language mid-session.
    const identity = getSessionIdentity(ctx);

    const chatOn = ctx.globalOptions.online;
    const sessionID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
    const username = {
      u: ctx.userID, s: sessionID, chat_on: chatOn, fg: false, d: ctx.clientId,
      ct: "websocket", aid: 219994525426954, aids: null, mqtt_sid: "",
      cp: 3, ecp: 10, st: [], pm: [], dc: "", no_auto_fg: true, gas: null, pack: [], p: null, php_override: ""
    };

    const cookies = api.getCookies();
    let host;
    if (ctx.mqttEndpoint) host = `${ctx.mqttEndpoint}&sid=${sessionID}&cid=${ctx.clientId}`;
    else if (ctx.region) host = `wss://edge-chat.facebook.com/chat?region=${ctx.region.toLowerCase()}&sid=${sessionID}&cid=${ctx.clientId}`;
    else host = `wss://edge-chat.facebook.com/chat?sid=${sessionID}&cid=${ctx.clientId}`;

    const options = {
      clientId: "mqttwsclient",
      protocolId: "MQIsdp",
      protocolVersion: 3,
      username: JSON.stringify(username),
      clean: true,
      wsOptions: {
        headers: {
          Cookie: cookies,
          Origin: "https://www.facebook.com",
          "User-Agent": identity.userAgent,
          Referer: "https://www.facebook.com/",
          Host: "edge-chat.facebook.com",
          Connection: "Upgrade",
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Accept-Encoding": "gzip, deflate, br",
          // Must match the Accept-Language used for HTTP requests in this same
          // session (src/utils/headers.js) - it previously hard-coded "vi,en;q=0.9"
          // here while HTTP requests defaulted to "en-US,en;q=0.9,vi;q=0.8",
          // which is a contradictory-client signal between the two channels.
          "Accept-Language": identity.acceptLanguage,
          "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits"
        },
        origin: "https://www.facebook.com",
        protocolVersion: 13,
        binaryType: "arraybuffer"
      },
      keepalive: 30,
      reschedulePings: true,
      reconnectPeriod: 0,
      connectTimeout: 5000
    };
    if (ctx.globalOptions.proxy !== undefined) {
      const agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
      options.wsOptions.agent = agent;
    }

    ctx.mqttClient = new mqtt.Client(
      () => buildStream(options, new WebSocket(host, options.wsOptions), buildProxy()),
      options
    );
    const mqttClient = ctx.mqttClient;

    mqttClient.on("error", function (err) {
      const msg = String(err && err.message ? err.message : err || "");
      if ((ctx._ending || ctx._cycling) && /No subscription existed|client disconnecting/i.test(msg)) {
        logger(`mqtt expected during shutdown: ${msg}`, "info");
        return;
      }

      if (/Invalid header flag bits|must be 0x0 for puback/i.test(msg)) {
        logger(`mqtt puback ignored: ${msg}`, "warn");
        return;
      }

      if (/Not logged in|Not logged in.|blocked the login|401|403/i.test(msg)) {
        try {
          if (mqttClient && mqttClient.connected) {
            mqttClient.end(true);
          }
        } catch (_) { }
        return emitAuth(ctx, api, globalCallback,
          /blocked/i.test(msg) ? "login_blocked" : "not_logged_in",
          msg
        );
      }
      logger(`mqtt error: ${msg}`, "error");
      try {
        if (mqttClient && mqttClient.connected) {
          mqttClient.end(true);
        }
      } catch (_) { }
      if (ctx._ending || ctx._cycling) return;

      if (ctx.globalOptions.autoReconnect && !ctx._ending) {
        // Let scheduleReconnect() compute the exponential-backoff delay
        // itself (instead of always passing the same fixed base delay),
        // so repeated network failures back off instead of retrying every
        // ~2s indefinitely.
        scheduleReconnect();
      } else {
        globalCallback({ type: "stop_listen", error: msg || "Connection refused" }, null);
      }
    });

    mqttClient.on("connect", function () {
      if (process.env.OnStatus === undefined) {
        logger("fca-unofficial", "info");
        process.env.OnStatus = true;
      }
      ctx._cycling = false;
      // A successful connect means the session/identity/network are fine -
      // reset the backoff counter so a later transient failure starts a
      // fresh backoff sequence instead of inheriting a long delay from an
      // unrelated earlier outage.
      ctx._reconnectAttempts = 0;

      topics.forEach(t => mqttClient.subscribe(t));


      const queue = {
        sync_api_version: 11, max_deltas_able_to_process: 100, delta_batch_size: 500,
        encoding: "JSON", entity_fbid: ctx.userID, initial_titan_sequence_id: ctx.lastSeqId, device_params: null
      };
      const topic = ctx.syncToken ? "/messenger_sync_get_diffs" : "/messenger_sync_create_queue";
      if (ctx.syncToken) { queue.last_seq_id = ctx.lastSeqId; queue.sync_token = ctx.syncToken; }
      mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
      mqttClient.publish("/foreground_state", JSON.stringify({ foreground: chatOn }), { qos: 1 });
      mqttClient.publish("/set_client_settings", JSON.stringify({ make_user_available_when_in_foreground: true }), { qos: 1 });
      let rTimeout = setTimeout(function () {
        rTimeout = null;
        if (ctx._ending) {
          logger("mqtt t_ms timeout skipped - ending", "warn");
          return;
        }
        logger("mqtt t_ms timeout, cycling", "warn");
        try {
          if (mqttClient && mqttClient.connected) {
            mqttClient.end(true);
          }
        } catch (_) { }
        scheduleReconnect();
      }, T_MS_WAIT_TIMEOUT_MS);

      // Store timeout reference for cleanup
      ctx._rTimeout = rTimeout;

      ctx.tmsWait = function () {
        if (rTimeout) {
          clearTimeout(rTimeout);
          rTimeout = null;
        }
        if (ctx._rTimeout) {
          delete ctx._rTimeout;
        }
        if (ctx.globalOptions.emitReady) globalCallback({ type: "ready", error: null });
        delete ctx.tmsWait;
      };
    });

    mqttClient.on("message", function (topic, message) {
      if (ctx._ending) return; // Ignore messages if ending
      try {
        let jsonMessage = Buffer.isBuffer(message) ? Buffer.from(message).toString() : message;
        try {
          jsonMessage = JSON.parse(jsonMessage);
        } catch (parseErr) {
          logger(`mqtt message parse error for topic ${topic}: ${parseErr && parseErr.message ? parseErr.message : String(parseErr)}`, "warn");
          jsonMessage = {};
        }

        if (jsonMessage.type === "jewel_requests_add") {
          globalCallback(null, { type: "friend_request_received", actorFbId: jsonMessage.from.toString(), timestamp: Date.now().toString() });
        } else if (jsonMessage.type === "jewel_requests_remove_old") {
          globalCallback(null, { type: "friend_request_cancel", actorFbId: jsonMessage.from.toString(), timestamp: Date.now().toString() });
        } else if (topic === "/t_ms") {
          if (ctx.tmsWait && typeof ctx.tmsWait == "function") ctx.tmsWait();
          if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
            ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
            ctx.syncToken = jsonMessage.syncToken;
          }
          if (jsonMessage.lastIssuedSeqId) ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
          for (const dlt of (jsonMessage.deltas || [])) {
            parseDelta(defaultFuncs, api, ctx, globalCallback, { delta: dlt });
          }
        } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
          const typ = {
            type: "typ",
            isTyping: !!jsonMessage.state,
            from: jsonMessage.sender_fbid.toString(),
            threadID: formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString())
          };
          globalCallback(null, typ);
        } else if (topic === "/orca_presence") {
          if (!ctx.globalOptions.updatePresence) {
            for (const data of (jsonMessage.list || [])) {
              const presence = { type: "presence", userID: String(data.u), timestamp: data.l * 1000, statuses: data.p };
              globalCallback(null, presence);
            }
          }
        } else if (topic === "/ls_resp") {
          const parsedPayload = JSON.parse(jsonMessage.payload);
          const reqID = jsonMessage.request_id;
          const tasks = ctx.tasks;
          if (tasks && tasks instanceof Map && tasks.has(reqID)) {
            const taskData = tasks.get(reqID);
            const { type: taskType, callback: taskCallback } = taskData;
            const taskRespData = getTaskResponseData(taskType, parsedPayload);
            if (taskRespData == null) taskCallback("error", null);
            else taskCallback(null, Object.assign({ type: taskType, reqID }, taskRespData));
          }
        }
      } catch (ex) {
        const errMsg = ex && ex.message ? ex.message : String(ex || "Unknown error");
        logger(`mqtt message handler error: ${errMsg}`, "error");
        // Don't crash on message parsing errors, just log and continue
      }
    });

    mqttClient.on("close", function () {
      if (ctx._ending || ctx._cycling) {
        logger("mqtt close expected", "info");
        return;
      }
      logger("mqtt connection closed", "warn");
      if (ctx.globalOptions.autoReconnect && !ctx._ending) {
        scheduleReconnect();
      }
    });

    mqttClient.on("disconnect", () => {
      if (ctx._ending || ctx._cycling) {
        logger("mqtt disconnect expected", "info");
        return;
      }
      logger("mqtt disconnected", "warn");
      if (ctx.globalOptions.autoReconnect && !ctx._ending) {
        scheduleReconnect();
      }
    });
  };
};
