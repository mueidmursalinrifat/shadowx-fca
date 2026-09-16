"use strict";

var utils = require("../../utils/utils");
var logger = require("../../utils/logger");

var ALLOWED = {
    attachment: true, url: true, sticker: true, emoji: true,
    emojiSize: true, body: true, mentions: true, location: true,
    replyToMessage: true, forwardAttachmentIds: true
};

var EMOJI_SIZES = { small: 1, medium: 2, large: 3 };

function toEmojiSize(size) {
    if (typeof size === "number" && !isNaN(size)) return Math.min(3, Math.max(1, size));
    if (typeof size === "string" && size in EMOJI_SIZES) return EMOJI_SIZES[size];
    return 1;
}

function hasLinks(text) {
    return /(https?:\/\/|www\.|t\.me\/|fb\.me\/|youtu\.be\/|facebook\.com\/|youtube\.com\/)/i.test(text);
}

function buildMentionData(msg, baseBody) {
    if (!Array.isArray(msg.mentions) || !msg.mentions.length) return null;
    var ids = [], offsets = [], lengths = [], types = [];
    for (var i = 0; i < msg.mentions.length; i++) {
        var mention = msg.mentions[i];
        // Ensure tag always has @ prefix — Facebook counts @ in both offset and length
        var tag = String(mention.tag || "");
        if (tag && !tag.startsWith("@")) tag = "@" + tag;
        var fromIndex = Number.isInteger(mention.fromIndex) ? mention.fromIndex : 0;
        var offset = baseBody.indexOf(tag, fromIndex);
        if (offset === -1) {
            // Fallback: search for bare name without @
            offset = baseBody.indexOf(tag.slice(1), fromIndex);
        }
        if (offset < 0) offset = 0;
        ids.push(String(mention.id || 0));
        offsets.push(offset);
        lengths.push(tag.length);   // includes @ — matches Facebook's expectation
        types.push("p");
    }
    return {
        mention_ids: ids.join(","),
        mention_offsets: offsets.join(","),
        mention_lengths: lengths.join(","),
        mention_types: types.join(",")
    };
}

function extractIdsFromPayload(payload) {
    var messageID = null, threadID = null;
    function walk(node) {
        if (!Array.isArray(node)) return;
        if (node[0] === 5 && (node[1] === "replaceOptimsiticMessage" || node[1] === "replaceOptimisticMessage")) {
            messageID = String(node[3]);
        }
        if (node[0] === 5 && node[1] === "writeCTAIdToThreadsTable") {
            var candidate = node[2];
            if (Array.isArray(candidate) && candidate[0] === 19) threadID = String(candidate[1]);
        }
        for (var i = 0; i < node.length; i++) walk(node[i]);
    }
    try { walk(payload && payload.step); } catch (_) { }
    return { threadID, messageID };
}

function publishLsRequestWithAck(mqttClient, content, requestId, timeout) {
    timeout = timeout || 15000;
    return new Promise((resolve, reject) => {
        var timer = setTimeout(() => {
            mqttClient.removeListener('message', onMessage);
            reject(new Error('MQTT sendMessage timed out after ' + timeout + 'ms'));
        }, timeout);

        function onMessage(topic, message) {
            if (topic !== '/ls_resp') return;
            try {
                var data = JSON.parse(message.toString());
                if (String(data.request_id) === String(requestId)) {
                    clearTimeout(timer);
                    mqttClient.removeListener('message', onMessage);
                    var extracted = extractIdsFromPayload(data.payload ? JSON.parse(data.payload) : {});
                    resolve({ threadID: extracted.threadID, messageID: extracted.messageID });
                }
            } catch (_) { }
        }

        mqttClient.on('message', onMessage);
        mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1 }, err => {
            if (err) {
                clearTimeout(timer);
                mqttClient.removeListener('message', onMessage);
                reject(err);
            }
        });
    });
}

module.exports = function (defaultFuncs, api, ctx) {
    var uploadAttachmentFn = require('../messaging/uploadAttachment')(defaultFuncs, api, ctx);

    async function uploadAttachments(attachments) {
        if (!Array.isArray(attachments)) attachments = [attachments];
        return uploadAttachmentFn(attachments);
    }

    async function sendViaMqtt(msg, threadID, replyToMessage) {
        var mqttClient = ctx.mqttClient || global.mqttClient;
        if (!mqttClient) throw new Error('MQTT client not available');

        var baseBody = msg.body != null ? String(msg.body) : "";
        var requestId = Math.floor(100 + Math.random() * 900);
        var epoch = (BigInt(Date.now()) << 22n).toString();

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
            text_has_links: hasLinks(baseBody) ? 1 : 0,
            multitab_env: 0,
            metadata_dataclass: JSON.stringify({ media_accessibility_metadata: { alt_text: null } })
        };

        var mentionData = buildMentionData(msg, baseBody);
        if (mentionData) payload0.mention_data = mentionData;

        if (msg.sticker) { payload0.send_type = 2; payload0.sticker_id = msg.sticker; }
        if (msg.emoji) { payload0.send_type = 1; payload0.text = msg.emoji; payload0.hot_emoji_size = toEmojiSize(msg.emojiSize); }

        if (msg.location && msg.location.latitude != null && msg.location.longitude != null) {
            payload0.send_type = 1;
            payload0.location_data = {
                coordinates: { latitude: msg.location.latitude, longitude: msg.location.longitude },
                is_current_location: Boolean(msg.location.current),
                is_live_location: Boolean(msg.location.live)
            };
        }

        var effectiveReplyTo = replyToMessage || msg.replyToMessage;
        if (effectiveReplyTo) {
            payload0.reply_metadata = {
                reply_source_id: effectiveReplyTo,
                reply_source_type: 1,
                reply_type: 0
            };
        }

        if (msg.attachment) {
            payload0.send_type = 3;
            if (payload0.text === "") payload0.text = null;
            payload0.attachment_fbids = [];
            var list = Array.isArray(msg.attachment) ? msg.attachment : [msg.attachment];
            var preuploaded = [], toUpload = [];
            for (var item of list) {
                if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "string") {
                    preuploaded.push(String(item[1]));
                } else if (utils.isReadableStream(item)) {
                    toUpload.push(item);
                }
            }
            if (preuploaded.length) payload0.attachment_fbids = payload0.attachment_fbids.concat(preuploaded);
            if (msg.forwardAttachmentIds && msg.forwardAttachmentIds.length) {
                payload0.attachment_fbids = payload0.attachment_fbids.concat(msg.forwardAttachmentIds.map(String));
            }

            if (toUpload.length) {
                var uploaded = await uploadAttachments(toUpload);
                for (var u of uploaded) {
                    if (!u) continue;
                    var fbid = u.image_id || u.video_id || u.audio_id || u.file_id || u.sticker_id || u.gif_id;
                    if (!fbid) {
                        var firstKey = Object.keys(u).find(function(k) { return u[k] && /^\d+$/.test(String(u[k])); });
                        if (firstKey) fbid = u[firstKey];
                    }
                    if (fbid) payload0.attachment_fbids.push(String(fbid));
                }
            }
            if (!payload0.attachment_fbids.length) delete payload0.attachment_fbids;
        }

        var tasks = [
            {
                label: '46',
                payload: JSON.stringify(payload0),
                queue_name: String(threadID),
                task_id: 400,
                failure_count: null
            },
            {
                label: '21',
                payload: JSON.stringify({
                    thread_id: String(threadID),
                    last_read_watermark_ts: Date.now(),
                    sync_group: 1
                }),
                queue_name: String(threadID),
                task_id: 401,
                failure_count: null
            }
        ];

        var content = {
            app_id: '2220391788200892',
            payload: JSON.stringify({
                tasks: tasks,
                epoch_id: epoch,
                version_id: '24804310205905615',
                data_trace_id: '#' + Buffer.from(String(Math.random())).toString('base64').replace(/=+$/, '')
            }),
            request_id: requestId,
            type: 3
        };

        return publishLsRequestWithAck(mqttClient, content, requestId, 15000);
    }

    return async function sendMessage(msg, threadID, callback, replyToMessage, isSingleUser) {
        if (typeof msg === "string") msg = { body: msg };
        if (typeof callback !== "function") { callback = null; }

        var resolve, reject;
        var promise = new Promise((res, rej) => { resolve = res; reject = rej; });

        for (var key in msg) {
            if (!ALLOWED[key]) {
                var err = { error: "sendMessage: Unknown property '" + key + "'" };
                if (callback) callback(err);
                else reject(err);
                return promise;
            }
        }

        // Auto-detect isSingleUser from ctx.threadTypes if not explicitly provided.
        // parseDelta in listenMqtt.js populates ctx.threadTypes[senderID] = 'dm' | 'group'
        if (isSingleUser === undefined && ctx.threadTypes) {
            isSingleUser = ctx.threadTypes[String(threadID)] === 'dm';
        }

        // DM attachment sends — skip MQTT entirely.
        // For E2EE DMs: route through the E2EE bridge (Noise WebSocket, Signal Protocol).
        //   Facebook strips attachment_fbids from MQTT messages in E2EE threads
        //   (can't re-encrypt CDN attachments on the fly), so MQTT silently drops them.
        //   The vendor's client.sendImage/sendVideo/sendAudio encrypts the file data
        //   and sends via the Noise WebSocket — the only path that actually delivers
        //   attachments in E2EE threads.
        // For non-E2EE DMs: use OldMessage.
        //   /messaging/send/ with other_user_fbid routing works for plain DMs.
        //   (For E2EE DMs it returns 404 because the endpoint is deprecated for those.)
        if (isSingleUser && msg.attachment) {
            var useE2EE = api.e2ee && typeof api.e2ee.isConnected === "function" && api.e2ee.isConnected();
            if (useE2EE) {
                try {
                    var e2eeResult = await api.e2ee.sendMessage(String(threadID), msg, replyToMessage);
                    var wrapped = e2eeResult && e2eeResult.messageId
                        ? { threadID: String(threadID), messageID: String(e2eeResult.messageId) }
                        : e2eeResult;
                    if (callback) callback(null, wrapped);
                    else resolve(wrapped);
                } catch (e2eeErr) {
                    logger.error("sendMessage", "E2EE DM attachment send failed: " + (e2eeErr.message || e2eeErr));
                    if (callback) callback(e2eeErr);
                    else reject(e2eeErr);
                }
            } else {
                try {
                    var omResult = await new Promise((res2, rej2) => {
                        api.OldMessage(msg, threadID, (err2, data2) => err2 ? rej2(err2) : res2(data2), replyToMessage, true);
                    });
                    if (callback) callback(null, omResult);
                    else resolve(omResult);
                } catch (omErr) {
                    logger.error("sendMessage", "DM attachment via OldMessage failed: " + (omErr.error || omErr.message || omErr));
                    if (callback) callback(omErr);
                    else reject(omErr);
                }
            }
            return promise;
        }

        try {
            var result = await sendViaMqtt(msg, threadID, replyToMessage);
            if (callback) callback(null, result);
            else resolve(result);
        } catch (mqttErr) {
            logger.warn("sendMessage", "MQTT failed, falling back to OldMessage: " + (mqttErr.message || mqttErr));
            try {
                var fbResult = await new Promise((res2, rej2) => {
                    api.OldMessage(msg, threadID, (err2, data2) => err2 ? rej2(err2) : res2(data2), replyToMessage, isSingleUser);
                });
                if (callback) callback(null, fbResult);
                else resolve(fbResult);
            } catch (fbErr) {
                logger.error("sendMessage", fbErr.error || fbErr.message || fbErr);
                if (callback) callback(fbErr);
                else reject(fbErr);
            }
        }

        return promise;
    };
};