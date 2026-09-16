"use strict";

const log = require("../../../func/logAdapter");
const { getType, generateOfflineThreadingID } = require("../../utils/format");

module.exports = function (defaultFuncs, api, ctx) {
  return function deleteMessage(messageOrMessages, callback) {
    let resolveFunc = function () {};
    let rejectFunc = function () {};
    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    if (!callback) {
      callback = function (err) {
        if (err) {
          return rejectFunc(err);
        }
        resolveFunc();
      };
    }

    if (getType(messageOrMessages) !== "Array") {
      messageOrMessages = [messageOrMessages];
    }

    if (!ctx || !ctx.mqttClient) {
      const err = new Error("Not connected to MQTT");
      callback(err);
      return rejectFunc(err);
    }

    const epochId = String(generateOfflineThreadingID());
    if (typeof ctx.wsTaskNumber !== "number") ctx.wsTaskNumber = 0;
    if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;

    const tasks = messageOrMessages.map((threadID) => {
      const threadKey = String(threadID);
      const taskPayload = `{"thread_key":${threadKey},"remove_type":0,"sync_group":1}`;
      return {
        failure_count: null,
        label: "146",
        payload: taskPayload,
        queue_name: threadKey,
        task_id: ++ctx.wsTaskNumber,
      };
    });

    const payload = `{"epoch_id":${epochId},"tasks":${JSON.stringify(
      tasks,
    )},"version_id":"25909428212080747"}`;

    const reqID = ++ctx.wsReqNumber;
    const form = JSON.stringify({
      app_id: "2220391788200892",
      payload,
      request_id: reqID,
      type: 3,
    });

    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        ctx.mqttClient?.removeListener("message", handleRes);
      } catch (e) {
        // ignore
      }
    };

    const handleRes = (topic, message) => {
      if (topic !== "/ls_resp") return;
      let msg;
      try {
        msg = JSON.parse(message.toString());
      } catch {
        return;
      }
      if (msg.request_id !== reqID) return;
      cleanup();
      try {
        msg.payload =
          typeof msg.payload === "string"
            ? JSON.parse(msg.payload)
            : msg.payload;
      } catch {}
      callback(null, { success: true, response: msg.payload });
      resolveFunc({ success: true, response: msg.payload });
    };

    try {
      ctx.mqttClient.on("message", handleRes);
    } catch (err) {
      cleanup();
      log.error("deleteMessage", err);
      callback(err);
      rejectFunc(err);
      return returnPromise;
    }

    timer = setTimeout(() => {
      const err = new Error("MQTT response timeout");
      cleanup();
      log.error("deleteMessage", err);
      callback(err);
      rejectFunc(err);
    }, 20000);

    try {
      ctx.mqttClient.publish(
        "/ls_req",
        form,
        { qos: 1, retain: false },
        (err) => {
          if (err) {
            cleanup();
            log.error("deleteMessage", err);
            callback(err);
            rejectFunc(err);
          }
        },
      );
    } catch (err) {
      cleanup();
      log.error("deleteMessage", err);
      callback(err);
      rejectFunc(err);
    }

    return returnPromise;
  };
};
