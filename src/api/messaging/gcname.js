"use strict";

const utils = require("../../utils/sifuShim");

async function retryOp(fn, retries = 3, base = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

async function mqttSetName(ctx, newName, threadID, initiatorID) {
  return new Promise((resolve, reject) => {
    if (!ctx.mqttClient) return reject(new Error("MQTT not connected"));

    const reqID = ++ctx.wsReqNumber;
    const taskID = ++ctx.wsTaskNumber;

    const context = JSON.stringify({
      app_id: ctx.appID || "2220391788200892",
      payload: JSON.stringify({
        epoch_id: parseInt(utils.generateOfflineThreadingID()),
        tasks: [{
          failure_count: null,
          label: "32",
          payload: JSON.stringify({
            thread_key: String(threadID),
            thread_name: newName,
            sync_group: 1
          }),
          queue_name: String(threadID),
          task_id: taskID
        }],
        version_id: "24631415369801570"
      }),
      request_id: reqID,
      type: 3
    });

    ctx.mqttClient.publish("/ls_req", context, { qos: 1, retain: false }, (err) => {
      if (err) return reject(new Error(`MQTT publish failed: ${err.message}`));
      resolve({
        type: "thread_name_update",
        threadID,
        newName,
        senderID: initiatorID,
        BotID: ctx.userID,
        timestamp: Date.now(),
        method: "mqtt"
      });
    });
  });
}

async function httpSetName(defaultFuncs, ctx, newName, threadID) {
  const form = {
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "MessengerUpdateThreadNameMutation",
    doc_id: "4648919335181350",
    variables: JSON.stringify({
      input: {
        thread_id: String(threadID),
        name: newName,
        actor_id: ctx.userID,
        client_mutation_id: String(Math.round(Math.random() * 10000))
      }
    })
  };
  const res = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form)
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs));
  if (res.errors) throw new Error(JSON.stringify(res.errors));
  return { type: "thread_name_update", threadID, newName, method: "http", timestamp: Date.now() };
}

module.exports = (defaultFuncs, api, ctx) => {
  return function gcname(newName, threadID, callback, initiatorID) {
    let _callback, _initiatorID;
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const cbType = utils.getType(callback);
    if (cbType === "Function" || cbType === "AsyncFunction") {
      _callback = callback;
      _initiatorID = initiatorID;
    } else if (utils.getType(threadID) === "Function" || utils.getType(threadID) === "AsyncFunction") {
      _callback = threadID;
      threadID = null;
      _initiatorID = callback;
    } else if (cbType === "String") {
      _initiatorID = callback;
    }

    _initiatorID = _initiatorID || ctx.userID;
    threadID = threadID || ctx.threadID;

    const finalCb = (err, data) => {
      if (typeof _callback === "function") _callback(err, data);
      if (err) rejectFunc(err); else resolveFunc(data);
    };

    if (!threadID) return finalCb(new Error("gcname: threadID is required")), returnPromise;
    if (typeof newName !== "string") return finalCb(new Error("gcname: newName must be a string")), returnPromise;

    (async () => {
      try {
        let result;
        if (ctx.mqttClient) {
          try {
            result = await retryOp(() => mqttSetName(ctx, newName, String(threadID), _initiatorID));
          } catch (mqttErr) {
            utils.warn("gcname", "MQTT failed, using HTTP:", mqttErr.message);
            result = await retryOp(() => httpSetName(defaultFuncs, ctx, newName, threadID));
          }
        } else {
          result = await retryOp(() => httpSetName(defaultFuncs, ctx, newName, threadID));
        }
        finalCb(null, result);
      } catch (err) {
        utils.error("gcname", err);
        finalCb(err);
      }
    })();

    return returnPromise;
  };
};
