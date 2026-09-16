"use strict";

const { getType, generateOfflineThreadingID, generateTimestampRelative, generateThreadingID, getCurrentTimestamp } = require("../../utils/format");
const { parseAndCheckLogin } = require("../../utils/client");
const log = require("../../../func/logAdapter");

module.exports = function (defaultFuncs, api, ctx) {
  function setTitleNoMqtt(newTitle, threadID, callback) {
    if (!callback && (getType(threadID) === "Function" || getType(threadID) === "AsyncFunction")) throw { error: "please pass a threadID as a second argument." };
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
    var messageAndOTID = generateOfflineThreadingID();
    var form = {
      client: "mercury",
      action_type: "ma-type:log-message",
      author: "fbid:" + ctx.userID,
      author_email: "",
      coordinates: "",
      timestamp: Date.now(),
      timestamp_absolute: "Today",
      timestamp_relative: generateTimestampRelative(),
      timestamp_time_passed: "0",
      is_unread: false,
      is_cleared: false,
      is_forward: false,
      is_filtered_content: false,
      is_spoof_warning: false,
      source: "source:chat:web",
      "source_tags[0]": "source:chat",
      status: "0",
      offline_threading_id: messageAndOTID,
      message_id: messageAndOTID,
      threading_id: generateThreadingID(ctx.clientID),
      manual_retry_cnt: "0",
      thread_fbid: threadID,
      thread_name: newTitle,
      thread_id: threadID,
      log_message_type: "log:thread-name"
    };
    defaultFuncs
      .post("https://www.facebook.com/messaging/set_thread_name/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (resData.error && resData.error === 1545012) throw { error: "Cannot change chat title: Not member of chat." };
        if (resData.error && resData.error === 1545003) throw { error: "Cannot set title of single-user chat." };
        if (resData.error) throw resData;
        return callback();
      })
      .catch(function (err) {
        log.error("setTitle", err);
        return callback(err);
      });
    return returnPromise;
  };
  function setTitleMqtt(newTitle, threadID, callback) {
    if (!ctx.mqttClient) {
      throw new Error("Not connected to MQTT");
    }
    if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
    const reqID = ++ctx.wsReqNumber;
    var resolveFunc = function () { };
    var rejectFunc = function () { };
    var returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    const done = (err, data) => {
      if (err) {
        if (callback) callback(err);
        return rejectFunc(err);
      }
      if (callback) callback(null, data);
      resolveFunc(data);
    };
    var form = JSON.stringify({
      "app_id": "2220391788200892",
      "payload": JSON.stringify({
        epoch_id: generateOfflineThreadingID(),
        tasks: [
          {
            failure_count: null,
            label: '32',
            payload: JSON.stringify({
              "thread_key": threadID,
              "thread_name": newTitle,
              "sync_group": 1
            }),
            queue_name: threadID,
            task_id: Math.random() * 1001 << 0
          }
        ],
        version_id: '8798795233522156'
      }),
      "request_id": reqID,
      "type": 3
    });
    ctx.mqttClient.publish("/ls_req", form, { qos: 1, retain: false }, (err) => {
      if (err) return done(err);
      done(null, { success: true });
    });
    return returnPromise;
  };
  return function setTitle(newTitle, threadID, callback) {
    if (ctx.mqttClient) {
      try {
        return setTitleMqtt(newTitle, threadID, callback);
      } catch (e) {
        return setTitleNoMqtt(newTitle, threadID, callback);
      }
    } else {
      return setTitleNoMqtt(newTitle, threadID, callback);
    }
  };
};
