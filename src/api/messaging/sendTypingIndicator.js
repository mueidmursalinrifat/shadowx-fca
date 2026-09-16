"use strict";
const { getType } = require("../../utils/format");
module.exports = function (defaultFuncs, api, ctx) {
  return function sendTyping(threadID, isTyping, options, callback) {
    var resolveFunc = function () { };
    var rejectFunc = function () { };
    var returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    if (getType(options) == "Function" || getType(options) == "AsyncFunction") {
      callback = options;
      options = {};
    }
    options = options || {};
    if (!callback || getType(callback) != "Function" && getType(callback) != "AsyncFunction") {
      callback = function (err, data) {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }
    if (!threadID) {
      return callback(new Error("threadID is required"));
    }
    if (!ctx.mqttClient) {
      const err = new Error("Not connected to MQTT");
      callback(err);
      rejectFunc(err);
      return returnPromise;
    }
    if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
    const threadIDs = Array.isArray(threadID) ? threadID : [threadID];
    threadIDs.forEach(tid => {
      var isGroupThread = getType(tid) === "Array" ? 0 : 1;
      var threadType = isGroupThread ? 2 : 1;
      var duration = options.duration || 10000;
      var autoStop = options.autoStop !== false;
      var attribution = options.type || 0;
      const publishTypingStatus = (isTypingStatus) => {
        ctx.mqttClient.publish('/ls_req',
          JSON.stringify({
            app_id: "772021112871879",
            payload: JSON.stringify({
              label: "3",
              payload: JSON.stringify({
                "thread_key": parseInt(tid),
                "is_group_thread": isGroupThread,
                "is_typing": isTypingStatus ? 1 : 0,
                "attribution": attribution,
                "sync_group": 1,
                "thread_type": threadType
              }),
              version: "8965252033599983"
            }),
            request_id: ++ctx.wsReqNumber,
            type: 4
          }),
          {
            qos: 1,
            retain: false,
          }
        );
      };
      publishTypingStatus(isTyping);
      if (isTyping && autoStop) {
        setTimeout(() => {
          publishTypingStatus(false);
        }, duration);
      }
    });
    callback(null, true);
    return returnPromise;
  };
};
