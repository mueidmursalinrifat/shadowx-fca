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

async function mqttGcMember(ctx, action, users, threadID) {
  return new Promise((resolve, reject) => {
    if (!ctx.mqttClient) return reject(new Error("MQTT not connected"));

    const reqID  = ++ctx.wsReqNumber;
    const taskID = ++ctx.wsTaskNumber;

    let queryPayload, query;

    if (action === "add") {
      queryPayload = {
        thread_key: parseInt(threadID),
        contact_ids: users.map(id => parseInt(id)),
        sync_group: 1
      };
      query = {
        failure_count: null,
        label: "23",
        payload: JSON.stringify(queryPayload),
        queue_name: threadID,
        task_id: taskID
      };
    } else {
      queryPayload = { thread_id: threadID, contact_id: users[0], sync_group: 1 };
      query = {
        failure_count: null,
        label: "140",
        payload: JSON.stringify(queryPayload),
        queue_name: "remove_participant_v2",
        task_id: taskID
      };
    }

    const context = JSON.stringify({
      app_id: ctx.appID || "2220391788200892",
      payload: JSON.stringify({
        epoch_id: parseInt(utils.generateOfflineThreadingID()),
        tasks: [query],
        version_id: "24631415369801570"
      }),
      request_id: reqID,
      type: 3
    });

    ctx.mqttClient.publish("/ls_req", context, { qos: 1, retain: false }, (err) => {
      if (err) return reject(err);
      resolve({
        type: "gc_member_update",
        threadID,
        userIDs: users,
        action,
        senderID: ctx.userID,
        BotID: ctx.userID,
        timestamp: Date.now(),
        method: "mqtt"
      });
    });
  });
}

module.exports = (defaultFuncs, api, ctx) => {
  return async function gcmember(action, userIDs, threadID, callback) {
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
      const validActions = ["add", "remove"];
      action = String(action || "").toLowerCase();

      if (!validActions.includes(action))
        return _callback(null, { type: "error_gc", error: `Invalid action. Must be one of: ${validActions.join(", ")}` });
      if (!userIDs || (Array.isArray(userIDs) && userIDs.length === 0))
        return _callback(null, { type: "error_gc", error: "userIDs is required" });
      if (!threadID)
        return _callback(null, { type: "error_gc", error: "threadID is required" });
      if (!ctx.mqttClient)
        return _callback(null, { type: "error_gc", error: "Not connected to MQTT" });

      const users = Array.isArray(userIDs) ? userIDs.map(String) : [String(userIDs)];

      
      let threadInfo = null;
      try { threadInfo = await api.getThreadInfo(String(threadID)); } catch {}

      if (threadInfo) {
        if (threadInfo.isGroup === false)
          return _callback(null, { type: "error_gc", error: "This feature is only for group chats" });

        const currentMembers = threadInfo.participantIDs || [];

        if (action === "add") {
          const alreadyIn = users.filter(id => currentMembers.includes(id));
          if (alreadyIn.length === users.length)
            return _callback(null, { type: "error_gc", error: "All specified users are already in the group" });
          const toAdd = users.filter(id => !currentMembers.includes(id));
          const result = await retryOp(() => mqttGcMember(ctx, "add", toAdd, String(threadID)));
          return _callback(null, result);
        }

        
        const userToRemove = users[0];
        if (!currentMembers.includes(userToRemove))
          return _callback(null, { type: "error_gc", error: `User ${userToRemove} is not in this group` });
      }

      const result = await retryOp(() => mqttGcMember(ctx, action, users, String(threadID)));
      _callback(null, result);
    } catch (err) {
      _callback(null, { type: "error_gc", error: err.message || "An unknown error occurred" });
    }

    return returnPromise;
  };
};
