"use strict";

const utils = require("../../utils/sifuShim");

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

const VALID_REACTIONS = new Set([
  '😍', '😆', '😮', '😢', '😠', '😡', '😲', '😂', '😭',
  '👍', '👎', '❤️', '🎉', '👏', '🔥', '🤔', '💯', '🥰',
  '🙏', '🤣', '😊', '🥺', '💀', '😎', '🤯', '😴', '🤮',
  '🔪', '🐒', '🦊', '🐱', '🎁', '💋', '💔', '❤', '🫶',
  '🤝', '💪', '🙌', '👀', '🫠', '🤡', '💩', '👻', '🤖',
  
  '🐍', '🐥', '🐶', '🐸', '🐧', '🦋', '🌹', '🌸', '🍀',
  '🦁', '🐯', '🐻', '🐼', '🐨', '🦄', '🐉', '🦅', '🦆',
  '🐠', '🐙', '🦊', '🦝', '🦔', '🐺', '🦜', '🦩', '🐬',
  
  '✨', '⭐', '🌟', '💫', '🌈', '☀️', '🌙', '⚡', '🌊',
  
  '🥳', '🤩', '😏', '😈', '👿', '🤫', '🧐', '😬', '🙄',
  '😅', '😋', '😇', '🥴', '😤', '😪', '😵', '🤐', '😑',
  
  '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💗',
  '💓', '💞', '💝', '💘', '💕', '💖', '💟', '♥️',
  
  '🍕', '🍔', '🎂', '🍭', '🎮', '🎵', '🎶', '🏆', '💎',
  '🚀', '💥', '🎯', '🎪', '🎠', '🎡', '🎢', '🎭', '🎨',
  '',
]);

const MULTI_REACT_DELAY_MS = 250;

async function graphqlReaction(defaultFuncs, ctx, reaction, messageID, retries, baseMs) {
  const action = reaction === '' ? 'REMOVE_REACTION' : 'ADD_REACTION';
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const defData = await defaultFuncs.postFormData(
        "https://www.facebook.com/webgraphql/mutation/",
        ctx.jar,
        {},
        {
          doc_id:    "1491398900900362",
          variables: JSON.stringify({
            data: {
              client_mutation_id: String(ctx.clientMutationId != null ? ctx.clientMutationId++ : Math.floor(Math.random() * 1e9)),
              actor_id:           ctx.userID,
              action,
              message_id:         messageID,
              reaction,
            }
          }),
          dpr: 1,
        }
      );

      const resData = await utils.parseAndCheckLogin(ctx, defaultFuncs)(defData);
      if (!resData) throw new Error("setMessageReaction: GraphQL returned empty object");
      if (resData.error) throw new Error(JSON.stringify(resData.error));
      return resData;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || /fatal|auth|checkpoint/i.test(err.message)) throw err;
      const wait = baseMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      utils.warn("setMessageReaction", `Retry ${attempt}/${retries} for ${messageID} in ${Math.round(wait)}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function mqttReaction(ctx, reaction, messageID, threadID) {
  if (!ctx.mqttClient) throw new Error("setMessageReaction: MQTT client not available");

  ctx.wsReqNumber  = (ctx.wsReqNumber  || 0) + 1;
  ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

  const taskPayload = {
    thread_key:       threadID.toString(),
    timestamp_ms:     Date.now(),
    message_id:       messageID,
    reaction,
    actor_id:         ctx.userID,
    reaction_style:   null,
    sync_group:       1,
    send_attribution: Math.random() < 0.5 ? 65537 : 524289,
  };

  const content = {
    app_id:     '2220391788200892',
    payload:    JSON.stringify({
      data_trace_id: null,
      epoch_id:      parseInt(utils.generateOfflineThreadingID ? utils.generateOfflineThreadingID() : Date.now()),
      tasks:         [{
        failure_count: null,
        label:         '29',
        payload:       JSON.stringify(taskPayload),
        queue_name:    JSON.stringify(['reaction', messageID]),
        task_id:       ctx.wsTaskNumber,
      }],
      version_id: '7158486590867448',
    }),
    request_id: ctx.wsReqNumber,
    type:       3,
  };

  return new Promise((resolve, reject) => {
    ctx.mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1, retain: false }, err => {
      if (err) reject(new Error(`MQTT publish failed: ${err.message}`));
      else resolve({ success: true, method: 'mqtt', messageID, reaction });
    });
  });
}

async function sendSingleReaction(defaultFuncs, ctx, reaction, msgId, threadID, options) {
  const retries = options.retries || 3;
  const baseMs  = 500;
  const useMqtt = options.preferMqtt !== false && ctx.mqttClient && !!threadID;

  if (useMqtt) {
    try {
      return await mqttReaction(ctx, reaction, msgId, threadID);
    } catch (mqttErr) {
      utils.warn("setMessageReaction", `MQTT failed for ${msgId} — falling back to GraphQL: ${mqttErr.message}`);
    }
  }
  return await graphqlReaction(defaultFuncs, ctx, reaction, msgId, retries, baseMs);
}

module.exports = function (defaultFuncs, api, ctx) {

  return async function setMessageReaction(reaction, messageID, threadID, options, callback) {
    if (typeof threadID === 'object' && !Array.isArray(threadID)) { options = threadID; threadID = null; }
    if (typeof threadID === 'function') { callback = threadID; threadID = null; options = {}; }
    if (typeof options  === 'function') { callback = options;  options  = {}; }
    options = options || {};

    if (reaction === undefined || reaction === null) {
      throw new Error("setMessageReaction: reaction is required (emoji, array of emojis, or '' to remove)");
    }

    const BOMB_KEYWORDS = new Set(['all', 'bomb', 'bombemoji', 'reactall']);
    const isBomb = !Array.isArray(reaction) && typeof reaction === 'string' && BOMB_KEYWORDS.has(reaction.trim().toLowerCase());
    const rawReactions = isBomb
      ? [...VALID_REACTIONS].filter(r => r !== '')
      : (Array.isArray(reaction) ? reaction : [reaction]);
    const reactions    = rawReactions.flatMap(r => (typeof r === 'string' && r !== '') ? splitEmojis(r) : [r]);
    const ids          = Array.isArray(messageID) ? messageID : [messageID];
    const delayMs    = options.delayMs ?? MULTI_REACT_DELAY_MS;
    const results    = [];

    let resolveFunc, rejectFunc;
    const promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });

    function done(err, data) {
      if (callback) return err ? callback(err) : callback(null, data);
      if (err) rejectFunc(err); else resolveFunc(data);
    }

    try {
      for (const msgId of ids) {
        const msgResults = [];

        for (let i = 0; i < reactions.length; i++) {
          const r = reactions[i];

          if (r !== '' && !VALID_REACTIONS.has(r)) {
            utils.warn("setMessageReaction", `Emoji "${r}" is non-standard but will be attempted`);
          }

          const res = await sendSingleReaction(defaultFuncs, ctx, r, msgId, threadID, options);
          msgResults.push(res);

          if (i < reactions.length - 1) {
            await new Promise(rr => setTimeout(rr, delayMs + Math.random() * 100));
          }
        }

        results.push(reactions.length === 1 ? msgResults[0] : msgResults);
      }

      const out = ids.length === 1 ? results[0] : results;
      done(null, out);
    } catch (err) {
      utils.error("setMessageReaction", err.message || err);
      done(err);
    }

    return promise;
  };

  setMessageReaction.bomb = function(messageID, threadID, options, callback) {
    return setMessageReaction('bomb', messageID, threadID, options, callback);
  };

  setMessageReaction.remove = function(messageID, threadID, options, callback) {
    return setMessageReaction('', messageID, threadID, options, callback);
  };

  setMessageReaction.getValidReactions = () => [...VALID_REACTIONS].filter(r => r !== '');

  return setMessageReaction;
};
