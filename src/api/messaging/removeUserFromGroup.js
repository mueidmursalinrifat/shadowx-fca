"use strict";

const { getType, generateOfflineThreadingID } = require("../../utils/format");

module.exports = function (defaultFuncs, api, ctx) {
  return function removeUserFromGroup(userID, threadID, callback) {
    if (!ctx.mqttClient) {
      const err = new Error("Not connected to MQTT");
      if (callback) return callback(err);
      return Promise.reject(err);
    }
    if (!callback && (getType(threadID) === "Function" || getType(threadID) === "AsyncFunction")) throw { error: "please pass a threadID as a second argument." };
    if (getType(threadID) !== "Number" && getType(threadID) !== "String") throw { error: "threadID should be of type Number or String and not " + getType(threadID) + "." };
    if (getType(userID) !== "Number" && getType(userID) !== "String") throw { error: "userID should be of type Number or String and not " + getType(userID) + "." };
    var resolveFunc = function () { };
    var rejectFunc = function () { };
    var returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    if (!callback) {
      callback = function (err, data) {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }
    if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
    const reqID = ++ctx.wsReqNumber;
    var form = JSON.stringify({
      "app_id": "2220391788200892",
      "payload": JSON.stringify({
        epoch_id: generateOfflineThreadingID(),
        tasks: [
          {
            failure_count: null,
            label: '140',
            payload: JSON.stringify({
              "thread_id": threadID,
              "contact_id": userID,
              "sync_group": 1
            }),
            queue_name: 'remove_participant_v2',
            task_id: Math.random() * 1001 << 0
          }
        ],
        version_id: '25002366262773827'
      }),
      "request_id": reqID,
      "type": 3
    });
    ctx.mqttClient.publish('/ls_req', form, (err, data) => {
      if (err) {
        callback(err, null);
        rejectFunc(err);
      } else {
        callback(null, true);
        resolveFunc(true);
      }
    });
    return returnPromise;
  };
};
