"use strict";

function generateOfflineThreadingId() {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 4294967295);
  return String((BigInt(now) << BigInt(22)) | BigInt(rand & 0x3FFFFF));
}

module.exports = function (defaultFuncs, api, ctx) {
  return function editMessage(text, messageID, callback) {
    let resolveFunc;
    let rejectFunc;

    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const handleCallback = (err, data) => {
      if (typeof callback === "function") {
        callback(err, data);
      }
      if (err) {
        rejectFunc(err);
      } else {
        resolveFunc(data);
      }
    };

    if (!ctx.mqttClient) {
      handleCallback({ error: "Not connected to MQTT" });
      return returnPromise;
    }

    if (!messageID || !text) {
      handleCallback({ error: "messageID and text are required." });
      return returnPromise;
    }

    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

    const reqID = ctx.wsReqNumber;

    const context = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: parseInt(generateOfflineThreadingId()),
        tasks: [
          {
            failure_count: null,
            label: "742",
            payload: JSON.stringify({
              message_id: messageID,
              text: text,
            }),
            queue_name: "edit_message",
            task_id: ctx.wsTaskNumber,
          },
        ],
        version_id: "6903494529735864",
      }),
      request_id: reqID,
      type: 3,
    };

    const cleanup = () => {
      if (ctx.mqttClient) {
        ctx.mqttClient.removeListener("message", handleRes);
      }
    };

    const handleRes = (topic, message) => {
      if (topic !== "/ls_resp") return;
      try {
        let jsonMsg = JSON.parse(message.toString());
        if (!jsonMsg.payload) return;

        if (typeof jsonMsg.payload === "string") {
          jsonMsg.payload = JSON.parse(jsonMsg.payload);
        }

        if (jsonMsg.request_id != reqID) return;

        clearTimeout(timeout);
        cleanup();
        handleCallback(null, { messageID, body: text });
      } catch (e) {
        clearTimeout(timeout);
        cleanup();
        handleCallback(null, { messageID, body: text });
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      handleCallback(null, { messageID, body: text });
    }, 5000);

    ctx.mqttClient.on("message", handleRes);
    ctx.mqttClient.publish("/ls_req", JSON.stringify(context), { qos: 1, retain: false });

    return returnPromise;
  };
};
