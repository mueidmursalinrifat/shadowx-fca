"use strict";

const { generateOfflineThreadingID } = require("../../utils/format");

/**
 * Forward a message to one or multiple threads.
 * @param {string} messageID - The ID of the message to forward.
 * @param {string|string[]} threadID - Thread ID or array of thread IDs to forward to.
 * @param {function} [callback] - Optional callback(err, results).
 * @returns {Promise}
 */
module.exports = function (defaultFuncs, api, ctx) {
  return async function forwardMessage(messageID, threadID, callback) {
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

    // Support forwarding to multiple threads
    const targets = Array.isArray(threadID) ? threadID : [threadID];

    const results = [];
    const errors = [];

    for (const tid of targets) {
      try {
        await new Promise((res, rej) => {
          const reqID = ++ctx.wsReqNumber;
          const taskID = ++ctx.wsTaskNumber;

          const taskPayload = {
            thread_id: String(tid),
            otid: generateOfflineThreadingID(),
            source: 65544,
            send_type: 5,
            sync_group: 1,
            mark_thread_read: 0,
            forwarded_msg_id: String(messageID),
            strip_forwarded_msg_caption: 0,
            initiating_source: 1
          };

          const content = {
            app_id: "2220391788200892",
            payload: JSON.stringify({
              data_trace_id: null,
              epoch_id: String((BigInt(Date.now()) << 22n)),
              tasks: [
                {
                  failure_count: null,
                  label: "46",
                  payload: JSON.stringify(taskPayload),
                  queue_name: String(tid),
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
            errors.push({ threadID: tid, error: err.message || String(err) });
            return res(); // continue to next thread
          }

          const timeout = setTimeout(() => {
            ctx.mqttClient.removeListener("message", handleRes);
            errors.push({ threadID: tid, error: "forwardMessage timed out." });
            res();
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

              results.push({ threadID: tid, messageID: String(messageID) });
              res();
            } catch (err) {
              clearTimeout(timeout);
              ctx.mqttClient.removeListener("message", handleRes);
              errors.push({ threadID: tid, error: err.message || String(err) });
              res();
            }
          };

          ctx.mqttClient.on("message", handleRes);
        });
      } catch (err) {
        errors.push({ threadID: tid, error: err.message || String(err) });
      }
    }

    const finalResult = { success: results, failed: errors };

    if (errors.length > 0 && results.length === 0) {
      callback({ error: "All forwards failed.", details: errors });
    } else {
      callback(null, finalResult);
    }

    return returnPromise;
  };
};
