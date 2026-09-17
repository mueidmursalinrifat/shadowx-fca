"use strict";

const utils = require("../../utils/sifuShim");
const { globalShield } = require("../../utils/sifuShim");

async function retryOp(fn, retries = 3, base = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

async function mqttSetEmoji(ctx, emoji, threadID, initiatorID) {
  return new Promise((resolve, reject) => {
    const reqID = ++ctx.wsReqNumber;
    const taskID = ++ctx.wsTaskNumber;

    const context = JSON.stringify({
      app_id: ctx.appID || "2220391788200892",
      payload: JSON.stringify({
        epoch_id: parseInt(utils.generateOfflineThreadingID()),
        tasks: [{
          failure_count: null,
          label: "100003",
          payload: JSON.stringify({
            thread_key: String(threadID),
            custom_emoji: emoji,
            avatar_sticker_instruction_key_id: null,
            sync_group: 1
          }),
          queue_name: "thread_quick_reaction",
          task_id: taskID
        }],
        version_id: "24631415369801570"
      }),
      request_id: reqID,
      type: 3
    });

    ctx.mqttClient.publish("/ls_req", context, { qos: 1, retain: false }, (err) => {
      if (err) return reject(err);
      resolve({
        type: "thread_emoji_update",
        threadID,
        newEmoji: emoji,
        senderID: initiatorID,
        BotID: ctx.userID,
        timestamp: Date.now(),
        method: "mqtt"
      });
    });
  });
}

async function httpSetEmoji(defaultFuncs, ctx, emoji, threadID, initiatorID) {
  const form = {
    emoji_choice: emoji,
    thread_or_other_fbid: threadID
  };
  const res = await defaultFuncs.post(
    "https://www.facebook.com/messaging/save_thread_emoji/?source=thread_settings&__pc=EXP1%3Amessengerdotcom_pkg",
    ctx.jar, form
  ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
  if (res.error === 1357031) throw { error: "Thread has no messages yet. Send a message first." };
  if (res.error) throw res;
  return {
    type: "thread_emoji_update",
    threadID,
    newEmoji: emoji,
    senderID: initiatorID,
    BotID: ctx.userID,
    timestamp: Date.now(),
    method: "http"
  };
}

module.exports = (defaultFuncs, api, ctx) => {
  return function emojiSet(emoji, threadID, callback, initiatorID) {
    let _callback, _initiatorID;
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const type = utils.getType(callback);
    if (type === "Function" || type === "AsyncFunction") {
      _callback = callback;
      _initiatorID = initiatorID;
    } else if (utils.getType(threadID) === "Function" || utils.getType(threadID) === "AsyncFunction") {
      _callback = threadID;
      threadID = null;
      _initiatorID = callback;
    } else if (type === "String") {
      _initiatorID = callback;
      _callback = undefined;
    }

    if (typeof _callback !== "function") {
      _callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    } else {
      const orig = _callback;
      _callback = (err, data) => {
        orig(err, data);
        if (err) rejectFunc(err); else resolveFunc(data);
      };
    }

    _initiatorID = _initiatorID || ctx.userID;
    threadID = threadID || ctx.threadID;

    if (!emoji) return _callback(new Error("emoji: emoji character is required")), returnPromise;
    if (!threadID) return _callback(new Error("emoji: threadID is required")), returnPromise;

    (async () => {
      try {
        await globalShield.addSmartDelay();
        let result;
        if (ctx.mqttClient) {
          try {
            result = await retryOp(() => mqttSetEmoji(ctx, emoji, threadID, _initiatorID));
          } catch (mqttErr) {
            utils.warn("emoji", "MQTT failed, using HTTP:", mqttErr.message);
            result = await retryOp(() => httpSetEmoji(defaultFuncs, ctx, emoji, threadID, _initiatorID));
          }
        } else {
          result = await retryOp(() => httpSetEmoji(defaultFuncs, ctx, emoji, threadID, _initiatorID));
        }
        _callback(null, result);
      } catch (err) {
        utils.error("emoji", err);
        _callback(err);
      }
    })();

    return returnPromise;
  };
};
