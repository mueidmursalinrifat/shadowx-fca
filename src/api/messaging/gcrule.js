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

async function mqttSetAdmin(ctx, userID, threadID, isAdmin) {
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
          label: "25",
          payload: JSON.stringify({
            thread_key: parseInt(threadID),
            contact_id: parseInt(userID),
            is_admin: isAdmin ? 1 : 0
          }),
          queue_name: "admin_status",
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
        type: "gc_rule_update",
        threadID,
        userID,
        action: isAdmin ? "admin" : "unadmin",
        senderID: ctx.userID,
        BotID: ctx.userID,
        timestamp: Date.now(),
        method: "mqtt"
      });
    });
  });
}

module.exports = (defaultFuncs, api, ctx) => {
  return async function gcrule(action, userID, threadID, callback) {
    let _callback;
    if (typeof threadID === "function") { _callback = threadID; threadID = null; }
    else if (typeof callback === "function") { _callback = callback; }

    let resolvePromise, rejectPromise;
    const returnPromise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    if (typeof _callback !== "function") {
      _callback = (err, data) => {
        if (err) return rejectPromise(err);
        resolvePromise(data);
      };
    }

    try {
      const validActions = ["admin", "unadmin"];
      action = String(action || "").toLowerCase();

      if (!validActions.includes(action))
        return _callback(null, { type: "error_gc_rule", error: `Invalid action. Must be: ${validActions.join(", ")}` });
      if (!userID) return _callback(null, { type: "error_gc_rule", error: "userID is required" });
      if (!threadID) return _callback(null, { type: "error_gc_rule", error: "threadID is required" });
      if (!ctx.mqttClient) return _callback(null, { type: "error_gc_rule", error: "Not connected to MQTT" });

      let threadInfo;
      try { threadInfo = await api.getThreadInfo(threadID); } catch {}

      if (threadInfo) {
        if (threadInfo.isGroup === false)
          return _callback(null, { type: "error_gc_rule", error: "Only for group chats" });

        const adminIDs = threadInfo.adminIDs || [];
        const isCurrentlyAdmin = adminIDs.some(a => String(a.id) === String(userID));

        if (action === "admin" && isCurrentlyAdmin)
          return _callback(null, { type: "error_gc_rule", error: "User is already an admin" });
        if (action === "unadmin" && !isCurrentlyAdmin)
          return _callback(null, { type: "error_gc_rule", error: "User is not an admin" });
      }

      const result = await retryOp(() => mqttSetAdmin(ctx, String(userID), String(threadID), action === "admin"));
      _callback(null, result);
    } catch (err) {
      _callback(null, { type: "error_gc_rule", error: err.message || "Unknown error" });
    }

    return returnPromise;
  };
};
