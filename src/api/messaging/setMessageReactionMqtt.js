"use strict";

const utils = require("../../utils/sifuShim");
const { globalShield } = require("../../utils/sifuShim");

function splitEmojis(str) {
  if (!str && str !== '') return [''];
  if (str === '') return [''];
  try {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const parts = [...seg.segment(str)].map(s => s.segment);
    return parts.length > 1 ? parts : [str];
  } catch (_) {
    const m = str.match(/\p{Emoji_Presentation}[\p{Emoji_Modifier}\uFE0F\u20E3]?(?:\u200D(?:\p{Emoji_Presentation}[\p{Emoji_Modifier}\uFE0F\u20E3]?))*|./gsu);
    return (m && m.length > 1) ? m : [str];
  }
}

const REACTION_CACHE   = new Map();
const REACTION_HISTORY = [];
const MAX_HISTORY      = 300;

const VALID_REACTIONS = new Set([
  '❤️', '❤', '😆', '😮', '😢', '😠', '😡', '😍', '😂', '😭',
  '👍', '👎', '🎉', '💯', '🔥', '🤔', '🥰', '🙏', '🤣', '😊',
  '🥺', '💀', '😎', '🤯', '😴', '🤮', '💔', '🫶', '🤝', '💪',
  '🙌', '👀', '🫠', '🤡', '💩', '👻', '🤖', '🔪', '🐒', '🦊',
  '🐱', '🎁', '💋', '😲', '👏', '',
]);

const MULTI_REACT_DELAY_MS = 250;

async function retryOp(fn, retries = 3, base = 400) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const isTransient = /network|timeout|ECONNRESET|5\d\d|429/i.test(String(err?.message || err));
      if (!isTransient) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

function mqttPublishReaction(ctx, reaction, messageID, threadID) {
  return new Promise((resolve, reject) => {
    ctx.wsReqNumber  = (ctx.wsReqNumber  || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

    const reqID       = ctx.wsReqNumber;
    const taskPayload = {
      thread_key:       String(threadID),
      timestamp_ms:     Date.now(),
      message_id:       String(messageID),
      reaction:         reaction || '',
      actor_id:         ctx.userID,
      reaction_style:   null,
      sync_group:       1,
      send_attribution: Math.random() < 0.5 ? 65537 : 524289,
    };

    const content = {
      app_id:  '2220391788200892',
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id:      parseInt(utils.generateOfflineThreadingID()),
        tasks: [{
          failure_count: null,
          label:         '29',
          payload:       JSON.stringify(taskPayload),
          queue_name:    JSON.stringify(['reaction', String(messageID)]),
          task_id:       ctx.wsTaskNumber,
        }],
        version_id: '7158486590867448',
      }),
      request_id: reqID,
      type:       3,
    };

    let handled = false;
    const onResp = (topic, message) => {
      if (topic !== '/ls_resp' || handled) return;
      let j;
      try { j = JSON.parse(message.toString()); j.payload = JSON.parse(j.payload); } catch { return; }
      if (j.request_id !== reqID) return;
      handled = true;
      clearTimeout(timer);
      ctx.mqttClient.removeListener('message', onResp);
      resolve({ success: true, method: 'mqtt_ack', requestID: reqID });
    };

    const timer = setTimeout(() => {
      if (!handled) {
        handled = true;
        ctx.mqttClient.removeListener('message', onResp);
        resolve({ success: true, method: 'mqtt_noack', requestID: reqID });
      }
    }, 10000);

    ctx.mqttClient.on('message', onResp);
    ctx.mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1, retain: false }, (err) => {
      if (err && !handled) {
        handled = true;
        clearTimeout(timer);
        ctx.mqttClient.removeListener('message', onResp);
        reject(err);
      }
    });
  });
}

async function httpSetReaction(defaultFuncs, ctx, reaction, messageID, threadID) {
  const form = {
    message_id:  String(messageID),
    thread_fbid: String(threadID),
    reaction:    reaction || '',
    viewer_fbid: ctx.userID,
  };

  const res = await defaultFuncs.post(
    'https://www.facebook.com/reactions/setmessagereaction',
    ctx.jar,
    form
  ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));

  if (res && res.error) throw res;
  return { success: true, method: 'http', messageID: String(messageID), threadID: String(threadID), reaction };
}

function recordHistory(op) {
  REACTION_HISTORY.unshift({ ...op, ts: Date.now() });
  if (REACTION_HISTORY.length > MAX_HISTORY) REACTION_HISTORY.length = MAX_HISTORY;
}

async function sendOneEmoji(defaultFuncs, ctx, emoji, messageID, threadID, opts) {
  const { preferMqtt, fallbackHttp } = opts;

  if (preferMqtt && ctx.mqttClient) {
    try {
      return await retryOp(() => mqttPublishReaction(ctx, emoji, messageID, threadID));
    } catch (mqttErr) {
      utils.warn('setMessageReactionMqtt', `MQTT failed for "${emoji}", trying HTTP: ${mqttErr.message}`);
      if (fallbackHttp) {
        return await retryOp(() => httpSetReaction(defaultFuncs, ctx, emoji, messageID, threadID));
      }
      throw mqttErr;
    }
  } else if (fallbackHttp) {
    return await retryOp(() => httpSetReaction(defaultFuncs, ctx, emoji, messageID, threadID));
  } else {
    throw new Error('setMessageReactionMqtt: MQTT not connected and HTTP fallback disabled');
  }
}

module.exports = function (defaultFuncs, api, ctx) {

  const setMessageReactionMqtt = async function setMessageReactionMqtt(reaction, messageID, threadID, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!options || typeof options !== 'object') options = {};

    const {
      skipCache    = false,
      preferMqtt   = true,
      validate     = true,
      fallbackHttp = true,
      delayMs      = MULTI_REACT_DELAY_MS,
    } = options;

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc  = reject;
    });

    if (typeof callback !== 'function') {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    try {
      if (!messageID) throw new Error('setMessageReactionMqtt: messageID is required');
      if (!threadID)  throw new Error('setMessageReactionMqtt: threadID is required');

      const BOMB_KEYWORDS = new Set(['all', 'bomb', 'bombemoji', 'reactall']);
      const isBomb = !Array.isArray(reaction) && typeof reaction === 'string' && BOMB_KEYWORDS.has(reaction.trim().toLowerCase());
      const rawReactions = isBomb
        ? [...VALID_REACTIONS].filter(r => r !== '')
        : (Array.isArray(reaction) ? reaction : [reaction]);
      const reactions    = rawReactions.flatMap(r => (typeof r === 'string' && r !== '') ? splitEmojis(r) : [r]);

      if (validate) {
        for (const r of reactions) {
          if (r !== '' && r !== null && !VALID_REACTIONS.has(r)) {
            utils.warn('setMessageReactionMqtt', `Emoji "${r}" is non-standard but will be attempted`);
          }
        }
      }

      const cacheKey = `react_${messageID}_${ctx.userID}`;
      if (!skipCache && reactions.length === 1) {
        const cached = REACTION_CACHE.get(cacheKey);
        if (cached && cached.reaction === reactions[0] && (Date.now() - cached.ts < 3000)) {
          return callback(null, { success: true, fromCache: true, reaction: reactions[0], messageID: String(messageID) });
        }
      }

      await globalShield.addSmartDelay();

      const opts   = { preferMqtt, fallbackHttp };
      const results = [];

      for (let i = 0; i < reactions.length; i++) {
        const emoji  = reactions[i];
        const result = await sendOneEmoji(defaultFuncs, ctx, emoji, messageID, threadID, opts);
        results.push({ ...result, reaction: emoji });

        recordHistory({ reaction: emoji, messageID: String(messageID), threadID: String(threadID), method: result.method });
        utils.log('setMessageReactionMqtt', `Reacted "${emoji}" on message ${messageID}`);

        if (i < reactions.length - 1) {
          await new Promise(r => setTimeout(r, delayMs + Math.random() * 100));
        }
      }

      const lastReaction = reactions[reactions.length - 1];
      REACTION_CACHE.set(cacheKey, { reaction: lastReaction, ts: Date.now() });

      const out = reactions.length === 1
        ? { ...results[0], messageID: String(messageID), threadID: String(threadID) }
        : { success: true, results, messageID: String(messageID), threadID: String(threadID), count: results.length };

      callback(null, out);

    } catch (err) {
      utils.error('setMessageReactionMqtt', err);
      callback(err);
    }

    return returnPromise;
  };

  setMessageReactionMqtt.batch = async function batchReact(reactions, threadID, options = {}) {
    const results = [];
    const errors  = [];
    for (const { reaction, messageID } of reactions) {
      try {
        const r = await setMessageReactionMqtt(reaction, messageID, threadID, options);
        results.push(r);
      } catch (err) {
        errors.push({ messageID, error: err.message });
      }
      await new Promise(r => setTimeout(r, 150 + Math.random() * 100));
    }
    return { success: errors.length === 0, results, errors };
  };

  setMessageReactionMqtt.remove = function removeReaction(messageID, threadID, options, callback) {
    return setMessageReactionMqtt('', messageID, threadID, options, callback);
  };

  setMessageReactionMqtt.bomb = function(messageID, threadID, options, callback) {
    return setMessageReactionMqtt('bomb', messageID, threadID, options, callback);
  };

  setMessageReactionMqtt.getHistory      = (limit = 50) => REACTION_HISTORY.slice(0, limit);
  setMessageReactionMqtt.getValidReactions = () => Array.from(VALID_REACTIONS).filter(r => r !== '');

  return setMessageReactionMqtt;
};
