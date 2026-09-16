"use strict";

var utils = require("../../utils/utils");
var logger = require("../../utils/logger");
var bluebird = require("bluebird");

var allowedProperties = {
    attachment: true, url: true, sticker: true, emoji: true,
    emojiSize: true, body: true, mentions: true, location: true,
};

module.exports = function (defaultFuncs, api, ctx) {

    function uploadAttachment(attachments, callback) {
        var uploads = [];
        for (var i = 0; i < attachments.length; i++) {
            if (!utils.isReadableStream(attachments[i])) {
                return callback({ error: "Attachment must be a readable stream." });
            }
            uploads.push(
                defaultFuncs.postFormData("https://upload.facebook.com/ajax/mercury/upload.php", ctx.jar, {
                    upload_1024: attachments[i],
                    voice_clip: "true"
                })
                    .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
                    .then(resData => {
                        if (resData.error) throw resData;
                        return resData.payload.metadata[0];
                    })
            );
        }
        bluebird.all(uploads)
            .then(resData => callback(null, resData))
            .catch(err => { logger.error("OldMessage.upload", err); callback(err); });
    }

    function getUrl(url, callback) {
        defaultFuncs.post("https://www.facebook.com/message_share_attachment/fromURI/", ctx.jar, {
            image_height: 960, image_width: 960, uri: url
        })
            .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
            .then(resData => {
                if (resData.error) return callback(resData);
                if (!resData.payload) return callback({ error: "Invalid URL" });
                callback(null, resData.payload.share_data.share_params);
            })
            .catch(err => { logger.error("OldMessage.getUrl", err); callback(err); });
    }

    function sendContent(form, threadID, isSingleUser, messageAndOTID, callback) {
        if (utils.getType(threadID) === "Array") {
            for (var i = 0; i < threadID.length; i++) form["specific_to_list[" + i + "]"] = "fbid:" + threadID[i];
            form["specific_to_list[" + threadID.length + "]"] = "fbid:" + ctx.userID;
            form["client_thread_id"] = "root:" + messageAndOTID;
        } else {
            if (isSingleUser) {
                form["specific_to_list[0]"] = "fbid:" + threadID;
                form["specific_to_list[1]"] = "fbid:" + ctx.userID;
                form["other_user_fbid"] = threadID;
            } else {
                form["thread_fbid"] = threadID;
            }
        }

        if (ctx.globalOptions.pageID) {
            form["author"] = "fbid:" + ctx.globalOptions.pageID;
            form["specific_to_list[1]"] = "fbid:" + ctx.globalOptions.pageID;
            form["creator_info[creatorID]"] = ctx.userID;
            form["creator_info[creatorType]"] = "direct_admin";
        }

        defaultFuncs.post("https://www.facebook.com/messaging/send/", ctx.jar, form)
            .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
            .then(resData => {
                if (!resData.payload) throw resData;
                var messageID = (resData.payload.actions && resData.payload.actions[0] &&
                    resData.payload.actions[0].message_id) || null;
                var threadID2 = resData.payload.thread_fbid ||
                    (resData.payload.actions && resData.payload.actions[0] && resData.payload.actions[0].thread_fbid);
                callback(null, {
                    threadID: threadID2 ? String(threadID2) : String(threadID),
                    messageID: messageID ? String(messageID) : null,
                    timestamp: resData.payload.timestamp
                });
            })
            .catch(err => { logger.error("OldMessage.send", err); callback(err); });
    }

    function send(form, threadID, isSingleUser, callback) {
        var messageAndOTID = utils.generateOfflineThreadingID();
        form.client = "mercury";
        form.action_type = "ma-type:user-generated-message";
        form.timestamp = Date.now();
        form.timestamp_absolute = "Today";
        form.timestamp_relative = "12:00";
        form.timestamp_time_passed = "0";
        form.is_unread = false;
        form.is_cleared = false;
        form.is_forward = false;
        form.is_filtered_content = false;
        form.is_filtered_content_bec = false;
        form.is_filtered_content_account = false;
        form.is_filtered_content_quasar = false;
        form.is_filtered_content_invalid_app = false;
        form.is_not_supported = false;
        form.message_id = messageAndOTID;
        form.offline_threading_id = messageAndOTID;
        form.ephemeral_ttl_mode = 0;
        form.manual_retry_cnt = 0;
        form.has_attachment = false;
        form.signatureID = utils.getGUID().replace(/-/g, "").slice(0, 8);
        sendContent(form, threadID, isSingleUser, messageAndOTID, callback);
    }

    return function OldMessage(msg, threadID, callback, replyToMessage, isSingleUser) {
        if (typeof msg === "string") msg = { body: msg };

        if (msg.body && /(https?:\/\/|www\.|t\.me\/|fb\.me\/|youtu\.be\/|facebook\.com\/|youtube\.com\/)/i.test(msg.body)) {
            return require('./sendMessage')(defaultFuncs, api, ctx)(msg, threadID, callback, replyToMessage, false);
        }

        var resolveFunc = () => { };
        var rejectFunc = () => { };
        var promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });
        if (!callback) {
            callback = (err, data) => err ? rejectFunc(err) : resolveFunc(data);
        }

        for (var key in msg) {
            if (!allowedProperties[key]) {
                return callback({ error: "OldMessage: Unknown property '" + key + "'" });
            }
        }

        var form = {};
        if (msg.body) form.body = msg.body;

        if (msg.mentions && Array.isArray(msg.mentions)) {
            form.body = msg.body || "";
            form['profile_to_mention[0]'] = msg.mentions.map(m => m.id).join(",");
        }

        if (replyToMessage) form.replied_to_message_id = replyToMessage;

        if (msg.sticker) {
            form["has_attachment"] = true;
            form["sticker_id"] = msg.sticker;
            return send(form, threadID, isSingleUser, callback);
        }

        if (msg.emoji) {
            form.body = msg.emoji;
            var size = msg.emojiSize || "small";
            form["emoji_size"] = size;
            return send(form, threadID, isSingleUser, callback);
        }

        if (msg.url) {
            return getUrl(msg.url, (err, shareData) => {
                if (err) return callback(err);
                form["has_attachment"] = true;
                form["image_ids[0]"] = shareData.image_ids && shareData.image_ids[0];
                form["share_params"] = JSON.stringify(shareData);
                send(form, threadID, isSingleUser, callback);
            });
        }

        if (msg.attachment) {
            var attachments = Array.isArray(msg.attachment) ? msg.attachment : [msg.attachment];
            return uploadAttachment(attachments, (err, uploaded) => {
                if (err) return callback(err);
                form["has_attachment"] = true;
                uploaded.forEach((u, i) => {
                    if (u.image_id) form["image_ids[" + i + "]"] = u.image_id;
                    else if (u.video_id) form["video_ids[" + i + "]"] = u.video_id;
                    else if (u.file_id) form["file_ids[" + i + "]"] = u.file_id;
                    else if (u.audio_id) form["audio_ids[" + i + "]"] = u.audio_id;
                });
                send(form, threadID, isSingleUser, callback);
            });
        }

        send(form, threadID, isSingleUser, callback);
        return promise;
    };
};
