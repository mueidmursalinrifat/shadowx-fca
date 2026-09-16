"use strict";

/**
 * Pin or unpin a message in a thread.
 * @param {string} messageID - The ID of the message to pin/unpin.
 * @param {string} threadID - The thread ID where the message is.
 * @param {boolean} [pin=true] - true to pin, false to unpin.
 * @param {function} [callback] - Optional callback(err, result).
 * @returns {Promise}
 */
module.exports = function (defaultFuncs, api, ctx) {
  return function pinMessage(messageID, threadID, pin, callback) {
    // Handle optional pin param
    if (typeof pin === "function") {
      callback = pin;
      pin = true;
    }
    if (typeof pin !== "boolean") pin = true;

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (!callback) {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    if (!messageID || !threadID) {
      const err = { error: "messageID and threadID are required." };
      callback(err);
      return returnPromise;
    }

    if (!ctx.mqttClient || !ctx.mqttClient.connected) {
      const err = { error: "Not connected to MQTT. Please try again later." };
      callback(err);
      return returnPromise;
    }

    const reqID = ++ctx.wsReqNumber;
    const taskID = ++ctx.wsTaskNumber;

    // label 682 = pin, label 683 = unpin
    const label = pin ? "682" : "683";

    const taskPayload = {
      thread_id: String(threadID),
      message_id: String(messageID)
    };

    const content = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: String((BigInt(Date.now()) << 22n)),
        tasks: [
          {
            failure_count: null,
            label,
            payload: JSON.stringify(taskPayload),
            queue_name: String(threadID),
            task_id: taskID
          }
        ],
        version_id: "6903494529735864"
      }),
      request_id: reqID,
      type: 3
    };

    try {
      ctx.mqttClient.publish("/ls_req", JSON.stringify(content), { qos: 1, retain: false });
    } catch (err) {
      const e = { error: "Failed to publish pinMessage: " + (err && err.message ? err.message : String(err)) };
      callback(e);
      return returnPromise;
    }

    const timeout = setTimeout(() => {
      ctx.mqttClient.removeListener("message", handleRes);
      callback({ error: "pinMessage timed out." });
    }, 15000);

    const handleRes = (topic, message) => {
      if (topic !== "/ls_resp") return;
      try {
        let jsonMsg = JSON.parse(message.toString());
        if (!jsonMsg.payload) return;
        jsonMsg.payload = JSON.parse(jsonMsg.payload);
        if (jsonMsg.request_id !== reqID) return;

        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", handleRes);

        callback(null, {
          messageID: String(messageID),
          threadID: String(threadID),
          pinned: pin
        });
      } catch (err) {
        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", handleRes);
        callback({ error: "Failed to parse pinMessage response: " + (err && err.message ? err.message : String(err)) });
      }
    };

    ctx.mqttClient.on("message", handleRes);
    return returnPromise;
  };
};
