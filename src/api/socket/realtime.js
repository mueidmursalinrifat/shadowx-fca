"use strict";

const { WebSocket } = require('undici');
const EventEmitter = require('events');
const utils = require("../../utils/sifuShim");
const HttpsProxyAgent = require('https-proxy-agent');

const REALTIME_METRICS = { connected: 0, disconnected: 0, messagesReceived: 0, errors: 0, reconnects: 0 };
const REALTIME_LOG = [];
const MAX_LOG = 200;
const NOTIF_HANDLERS = new Map();
const MIDDLEWARE_STACK = [];

function logEvent(event, data = {}) {
  const entry = { event, ts: Date.now(), ...data };
  REALTIME_LOG.unshift(entry);
  if (REALTIME_LOG.length > MAX_LOG) REALTIME_LOG.length = MAX_LOG;
}

function formatNotification(data) {
  if (!data.data || !data.data.viewer) return null;
  const notifEdge = data.data.viewer.notifications_page?.edges?.[1]?.node?.notif;
  if (!notifEdge) return null;

  return {
    type: 'notification',
    notifID: notifEdge.notif_id,
    body: notifEdge.body?.text,
    senderID: Object.keys(notifEdge.tracking?.from_uids || {})[0],
    url: notifEdge.url,
    timestamp: notifEdge.creation_time?.timestamp,
    seenState: notifEdge.seen_state,
    rawEdge: notifEdge
  };
}

function classifyMessage(jsonData) {
  if (jsonData.code === 200) return 'status';
  if (jsonData.data?.viewer?.notifications_page) return 'notification';
  if (jsonData.type === 'presence') return 'presence';
  if (jsonData.type === 'friend_request') return 'friend_request';
  if (jsonData.data?.xhrPayload) return 'xhr';
  if (jsonData.event === 'friend_request_confirmed') return 'friend_confirmed';
  return 'payload';
}

async function runMiddlewares(message, middlewares) {
  let msg = message;
  for (const mw of middlewares) {
    try { msg = (await mw(msg)) || msg; } catch (err) {
      utils.warn('realtime', `Middleware error: ${err.message}`);
    }
  }
  return msg;
}

function buildSubscriptions(userID) {
  return [
    '{"x-dgw-app-XRSS-method":"Falco","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:USER_ACTIVITY_UPDATE_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"9525970914181809","x-dgw-app-XRSS-routing_hint":"UserActivitySubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:ACTOR_GATEWAY_EXPERIENCE_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"24191710730466150","x-dgw-app-XRSS-routing_hint":"CometActorGatewayExperienceSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    `{"x-dgw-app-XRSS-method":"FBLQ:comet_notifications_live_query_experimental","x-dgw-app-XRSS-doc_id":"9784489068321501","x-dgw-app-XRSS-actor_id":"${userID}","x-dgw-app-XRSS-page_id":"${userID}","x-dgw-app-XRSS-request_stream_retry":"false","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}`,
    '{"x-dgw-app-XRSS-method":"FBGQLS:FRIEND_REQUEST_CONFIRM_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"9687616244672204","x-dgw-app-XRSS-routing_hint":"FriendingCometFriendRequestConfirmSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:FRIEND_REQUEST_RECEIVE_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"24047008371656912","x-dgw-app-XRSS-routing_hint":"FriendingCometFriendRequestReceiveSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:RTWEB_CALL_BLOCKED_SETTING_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"24429620016626810","x-dgw-app-XRSS-routing_hint":"RTWebCallBlockedSettingSubscription_CallBlockSettingSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"PresenceUnifiedJSON","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:MESSENGER_CHAT_TABS_NOTIFICATION_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"23885219097739619","x-dgw-app-XRSS-routing_hint":"MWChatTabsNotificationSubscription_MessengerChatTabsNotificationSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:BATCH_NOTIFICATION_STATE_CHANGE_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"30300156509571373","x-dgw-app-XRSS-routing_hint":"CometBatchNotificationsStateChangeSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:NOTIFICATION_STATE_CHANGE_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"23864641996495578","x-dgw-app-XRSS-routing_hint":"CometNotificationsStateChangeSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}',
    '{"x-dgw-app-XRSS-method":"FBGQLS:NOTIFICATION_STATE_CHANGE_SUBSCRIBE","x-dgw-app-XRSS-doc_id":"9754477301332178","x-dgw-app-XRSS-routing_hint":"CometFriendNotificationsStateChangeSubscription","x-dgw-app-xrs-body":"true","x-dgw-app-XRS-Accept-Ack":"RSAck","x-dgw-app-XRSS-http_referer":"https://www.facebook.com/friends"}'
  ];
}

module.exports = function (defaultFuncs, api, ctx) {
  return function listenRealtime(options = {}) {
    const {
      keepAliveMs = 10000,
      maxReconnectDelay = 60000,
      reconnectBaseMs = 1000,
      maxReconnectAttempts = Infinity,
      pingPayload = 'ping'
    } = options;

    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);

    let ws = null;
    let reconnectTimeout = null;
    let keepAliveInterval = null;
    let stopped = false;
    let reconnectAttempts = 0;
    let totalMessages = 0;
    let connectionStartTime = null;

    const subscriptions = buildSubscriptions(ctx.userID);

    async function handleMessage(data) {
      try {
        const text = typeof data.text === 'function' ? await data.text() : String(data);
        const jsonStart = text.indexOf('{');
        if (jsonStart === -1) return;

        let jsonData;
        try { jsonData = JSON.parse(text.substring(jsonStart)); } catch { return; }

        REALTIME_METRICS.messagesReceived++;
        totalMessages++;

        const processed = MIDDLEWARE_STACK.length ? await runMiddlewares(jsonData, MIDDLEWARE_STACK) : jsonData;
        const msgType = classifyMessage(processed);

        logEvent(`message:${msgType}`, { size: text.length });

        if (NOTIF_HANDLERS.has(msgType)) {
          for (const handler of NOTIF_HANDLERS.get(msgType)) {
            try { handler(processed); } catch (err) {
              utils.warn('realtime', `Handler error for ${msgType}:`, err.message);
            }
          }
        }

        if (processed.code === 200) {
          emitter.emit('success', processed);
          return;
        }

        const formattedNotif = formatNotification(processed);
        if (formattedNotif) {
          emitter.emit('notification', formattedNotif);
          emitter.emit(msgType, formattedNotif);
        } else {
          emitter.emit('payload', processed);
          emitter.emit(msgType, processed);
        }
      } catch (err) {
        REALTIME_METRICS.errors++;
        utils.error('realtime', 'Message parse error:', err.message || err);
        emitter.emit('error', err);
      }
    }

    function scheduleReconnect() {
      if (stopped || reconnectAttempts >= maxReconnectAttempts) return;
      reconnectAttempts++;
      REALTIME_METRICS.reconnects++;

      const backoff = Math.min(maxReconnectDelay, reconnectBaseMs * Math.pow(2, Math.min(reconnectAttempts, 7)));
      const jitter = Math.floor(Math.random() * 1500);
      const delay = backoff + jitter;

      clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(connect, delay);
      logEvent('reconnect_scheduled', { attempt: reconnectAttempts, delay });
      utils.warn('realtime', `Reconnect #${reconnectAttempts} in ${delay}ms`);
    }

    async function connect() {
      if (stopped) return;

      try {
        const queryParams = new URLSearchParams({
          'x-dgw-appid': '2220391788200892',
          'x-dgw-appversion': '0',
          'x-dgw-authtype': '1:0',
          'x-dgw-version': '5',
          'x-dgw-uuid': ctx.userID,
          'x-dgw-tier': 'prod',
          'x-dgw-deviceid': ctx.clientID,
          'x-dgw-app-stream-group': 'group1'
        });

        const url = `wss://gateway.facebook.com/ws/realtime?${queryParams.toString()}`;
        const cookies = ctx.jar.getCookiesSync('https://www.facebook.com').join('; ');

        const wsOptions = {
          headers: {
            Cookie: cookies,
            Origin: 'https://www.facebook.com',
            'User-Agent': ctx.globalOptions?.userAgent || 'Mozilla/5.0',
            Referer: 'https://www.facebook.com',
            Host: new URL(url).hostname,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        };

        if (ctx.globalOptions?.proxy) wsOptions.agent = new HttpsProxyAgent(ctx.globalOptions.proxy);

        ws = new WebSocket(url, wsOptions);

        ws.onopen = () => {
          reconnectAttempts = 0;
          connectionStartTime = Date.now();
          REALTIME_METRICS.connected++;
          logEvent('connected');
          utils.log('realtime', 'WebSocket connected');

          subscriptions.forEach((payload, index) => {
            const prefix = Buffer.from([14, index, 0, payload.length]);
            const suffix = Buffer.from([0, 0]);
            ws.send(Buffer.concat([prefix, Buffer.from(payload), suffix]));
          });

          keepAliveInterval = setInterval(() => {
            if (ws && ws.readyState === ws.OPEN) ws.send(pingPayload);
          }, keepAliveMs);

          emitter.emit('connected', { reconnectAttempts, timestamp: Date.now() });
        };

        ws.onmessage = (event) => {
          const { data } = event;
          if (data instanceof Blob) handleMessage(data);
          else if (typeof data === 'string') handleMessage(new Blob([data]));
          else if (data instanceof ArrayBuffer) handleMessage(new Blob([data]));
          else utils.warn('realtime', 'Unknown message type:', typeof data);
        };

        ws.onerror = (err) => {
          if (stopped) return;
          REALTIME_METRICS.errors++;
          logEvent('error', { message: err.message || String(err) });
          utils.error('realtime', 'Socket error:', err.message || err);
          emitter.emit('error', err);
        };

        ws.onclose = (event) => {
          if (stopped) return;
          REALTIME_METRICS.disconnected++;
          logEvent('closed', { code: event.code, reason: event.reason });
          utils.warn('realtime', `Socket closed (code: ${event.code})`);
          clearInterval(keepAliveInterval);
          emitter.emit('disconnected', { code: event.code, reason: event.reason, timestamp: Date.now() });
          scheduleReconnect();
        };
      } catch (err) {
        if (stopped) return;
        REALTIME_METRICS.errors++;
        logEvent('connect_error', { message: err.message });
        utils.error('realtime', 'Connection error:', err.message);
        emitter.emit('error', err);
        clearInterval(keepAliveInterval);
        scheduleReconnect();
      }
    }

    connect();

    emitter.stop = (reason = 'manual') => {
      stopped = true;
      clearInterval(keepAliveInterval);
      clearTimeout(reconnectTimeout);
      if (ws) { try { ws.close(1000, reason); } catch (_) {} }
      logEvent('stopped', { reason });
      utils.log('realtime', `Stopped (reason: ${reason})`);
    };

    emitter.getMetrics = () => ({
      ...REALTIME_METRICS,
      totalMessages,
      uptime: connectionStartTime ? Date.now() - connectionStartTime : 0,
      reconnectAttempts,
      isConnected: ws?.readyState === 1
    });

    emitter.getLog = (limit = 50) => REALTIME_LOG.slice(0, limit);

    emitter.addMiddleware = (fn) => {
      if (typeof fn !== 'function') throw new TypeError('realtime.addMiddleware: expected a function');
      MIDDLEWARE_STACK.push(fn);
      return () => { const idx = MIDDLEWARE_STACK.indexOf(fn); if (idx !== -1) MIDDLEWARE_STACK.splice(idx, 1); };
    };

    emitter.on_type = (type, handler) => {
      if (!NOTIF_HANDLERS.has(type)) NOTIF_HANDLERS.set(type, []);
      NOTIF_HANDLERS.get(type).push(handler);
      return () => {
        const arr = NOTIF_HANDLERS.get(type);
        if (arr) { const i = arr.indexOf(handler); if (i !== -1) arr.splice(i, 1); }
      };
    };

    emitter.reconnect = () => {
      if (ws) { try { ws.close(); } catch (_) {} }
      clearInterval(keepAliveInterval);
      setTimeout(connect, 100);
    };

    return emitter;
  };
};
