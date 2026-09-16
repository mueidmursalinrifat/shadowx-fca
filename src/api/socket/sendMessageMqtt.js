"use strict";

var utils = require("../../utils/utils");

module.exports = function (defaultFuncs, api, ctx) {
    return function sendMessageMqtt(msg, threadID, callback, replyToMessage) {
        if (typeof msg === "string") msg = { body: msg };
        var mqttClient = ctx.mqttClient || global.mqttClient;
        if (!mqttClient) {
            var err = { error: "MQTT not connected. Call listenMqtt first." };
            if (typeof callback === "function") return callback(err);
            return Promise.reject(err);
        }

        ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
        ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

        var baseBody = msg.body != null ? String(msg.body) : "";
        var hasLinks = typeof baseBody === "string" && /(https?:\/\/|www\.|t\.me\/|fb\.me\/|youtu\.be\/|facebook\.com\/|youtube\.com\/)/i.test(baseBody);
        var requestId = ctx.wsReqNumber;

        var payload0 = {
            thread_id: String(threadID),
            otid: utils.generateOfflineThreadingID(),
            source: 2097153,
            send_type: 1,
            sync_group: 1,
            mark_thread_read: 1,
            text: baseBody === "" ? null : baseBody,
            initiating_source: 0,
            skip_url_preview_gen: 1,
            text_has_links: hasLinks ? 1 : 0,
            multitab_env: 0
        };

        if (msg.sticker) { payload0.send_type = 2; payload0.sticker_id = msg.sticker; }
        if (replyToMessage || msg.replyToMessage) {
            payload0.reply_metadata = {
                reply_source_id: replyToMessage || msg.replyToMessage,
                reply_source_type: 1,
                reply_type: 0
            };
        }

        var content = {
            app_id: '2220391788200892',
            payload: JSON.stringify({
                tasks: [{
                    failure_count: null,
                    label: '46',
                    payload: JSON.stringify(payload0),
                    queue_name: String(threadID),
                    task_id: ctx.wsTaskNumber
                }],
                epoch_id: utils.generateOfflineThreadingID(),
                version_id: '7214102258676893'
            }),
            request_id: requestId,
            type: 3
        };

        if (typeof callback === "function") {
            ctx.reqCallbacks[requestId] = callback;
        }

        mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1 });
        return Promise.resolve({ requestId });
    };
};