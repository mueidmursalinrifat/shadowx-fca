"use strict";

var url = require("url");
var stream = require("stream");
var bluebird = require("bluebird");
var querystring = require("querystring");
var request = bluebird.promisify(require("request").defaults({ jar: true }));

function setProxy(proxyUrl) {
    if (typeof proxyUrl === "undefined") {
        request = bluebird.promisify(require("request").defaults({ jar: true }));
    } else {
        request = bluebird.promisify(require("request").defaults({ jar: true, proxy: proxyUrl }));
    }
}

function sanitizeHeaderValue(value) {
    if (value === null || value === undefined) return "";
    var str = String(value);
    if (str.trim().startsWith("[") && str.trim().endsWith("]")) {
        try {
            var parsed = JSON.parse(str);
            if (Array.isArray(parsed)) return "";
        } catch (_) { }
    }
    str = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F\r\n\[\]]/g, "").trim();
    return str;
}

function sanitizeHeaderName(name) {
    if (!name || typeof name !== "string") return "";
    return name.replace(/[^\x21-\x7E]/g, "").trim();
}

function getHeaders(reqUrl, options, ctx, customHeader) {
    options = options || {};
    var host;
    try { host = new URL(reqUrl).host; } catch (_) { host = reqUrl.replace("https://", "").split("/")[0]; }
    var ua = options.userAgent ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
    var referer = options.referer || "https://www.facebook.com/";
    var origin = referer.replace(/\/+$/, "");
    var contentType = options.contentType || "application/x-www-form-urlencoded";
    var acceptLang = options.acceptLanguage || "en-US,en;q=0.9";

    var headers = {
        Host: sanitizeHeaderValue(host),
        Origin: sanitizeHeaderValue(origin),
        Referer: sanitizeHeaderValue(referer),
        "User-Agent": sanitizeHeaderValue(ua),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "Accept-Language": sanitizeHeaderValue(acceptLang),
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": sanitizeHeaderValue(contentType),
        Connection: "keep-alive",
        DNT: "1",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "X-Requested-With": "XMLHttpRequest",
        Pragma: "no-cache",
        "Cache-Control": "no-cache"
    };

    if (ctx && ctx.region) {
        var regionVal = sanitizeHeaderValue(ctx.region);
        if (regionVal) headers["X-MSGR-Region"] = regionVal;
    }

    if (customHeader && typeof customHeader === "object") {
        for (var key in customHeader) {
            if (!Object.prototype.hasOwnProperty.call(customHeader, key)) continue;
            var val = customHeader[key];
            if (val === null || val === undefined || typeof val === "function" || typeof val === "object") continue;
            var sk = sanitizeHeaderName(key);
            var sv = sanitizeHeaderValue(val);
            if (sk && sv !== "") headers[sk] = sv;
        }
    }

    var sanitized = {};
    for (var k in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
        var sk2 = sanitizeHeaderName(k);
        var sv2 = sanitizeHeaderValue(headers[k]);
        if (sk2 && sv2 !== "") sanitized[sk2] = sv2;
    }
    return sanitized;
}

function isReadableStream(obj) {
    return (
        obj instanceof stream.Stream &&
        (getType(obj._read) === "Function" || getType(obj._read) === "AsyncFunction") &&
        getType(obj._readableState) === "Object"
    );
}

function get(reqUrl, jar, qs, options, ctx) {
    if (getType(qs) === "Object") {
        for (var prop in qs) {
            if (qs.hasOwnProperty(prop) && getType(qs[prop]) === "Object") qs[prop] = JSON.stringify(qs[prop]);
        }
    }
    var op = {
        headers: getHeaders(reqUrl, options, ctx),
        timeout: 60000,
        qs: qs,
        url: reqUrl,
        method: "GET",
        jar: jar,
        gzip: true
    };
    return request(op);
}

function post(reqUrl, jar, form, options, ctx, customHeader) {
    var op = {
        headers: getHeaders(reqUrl, options, ctx, customHeader),
        timeout: 60000,
        url: reqUrl,
        method: "POST",
        form: form,
        jar: jar,
        gzip: true
    };
    return request(op);
}

function postFormData(reqUrl, jar, form, qs, options, ctx) {
    var headers = getHeaders(reqUrl, options, ctx);
    headers["Content-Type"] = "multipart/form-data";
    var op = {
        headers: headers,
        timeout: 60000,
        url: reqUrl,
        method: "POST",
        formData: form,
        qs: qs,
        jar: jar,
        gzip: true
    };
    return request(op);
}

function getJar() {
    return require("request").jar();
}

function getAppState(jar) {
    return jar.getCookies("https://www.facebook.com").map(c => ({
        key: c.key,
        value: c.value,
        domain: c.domain,
        path: c.path,
        hostOnly: c.hostOnly,
        creation: c.creation,
        lastAccessed: c.lastAccessed
    }));
}

function saveCookies(jar) {
    return function (res) {
        var cookies = res.headers["set-cookie"];
        if (cookies) {
            if (!Array.isArray(cookies)) cookies = [cookies];
            cookies.forEach(c => {
                try { jar.setCookie(c, "https://www.facebook.com"); } catch (_) { }
            });
        }
        return res;
    };
}

function getType(obj) {
    return Object.prototype.toString.call(obj).slice(8, -1);
}

function getFrom(str, startToken, endToken) {
    var start = str.indexOf(startToken) + startToken.length;
    if (start < startToken.length) return "";
    var end = str.indexOf(endToken, start);
    if (end < 0) return "";
    return str.slice(start, end);
}

function generateOfflineThreadingID() {
    var ret = Date.now();
    var value = Math.floor(Math.random() * 4294967295);
    var str = ("0000000000000000000000" + value.toString(2)).slice(-22);
    var msgs = ret.toString(2) + str;
    return binaryToDecimal(msgs);
}

function binaryToDecimal(data) {
    var ret = "";
    while (data !== "0") {
        var end = 0;
        var fullName = "";
        for (var i = 0; i < data.length; i++) {
            end = 2 * end + parseInt(data[i], 10);
            if (end >= 10) { fullName += "1"; end -= 10; }
            else fullName += "0";
        }
        ret = end.toString() + ret;
        data = fullName.slice(fullName.indexOf("1"));
    }
    return ret;
}

function generateThreadingID(clientID) {
    var k = Date.now();
    var l = Math.floor(Math.random() * 4294967295);
    return "<" + k + ":" + l + "-" + clientID + "@mail.projektitan.com>";
}

function getGUID() {
    var s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return s4() + s4() + "-" + s4() + "-" + s4() + "-" + s4() + "-" + s4() + s4() + s4();
}

function arrToForm(arr) {
    return arr.reduce((obj, item) => {
        obj[item.name] = item.val;
        return obj;
    }, {});
}

function formatCookie(arr, domain) {
    return arr[0] + "=" + arr[1] + ";domain=." + domain + ".com";
}

function formatID(id) {
    return id && id.replace ? id.replace(/\D/g, "") : String(id);
}

function decodeClientPayload(payload) {
    try {
        return JSON.parse(String.fromCharCode.apply(null, payload));
    } catch (_) {
        return null;
    }
}

function parseAndCheckLogin(ctx, defaultFuncs) {
    return function (res) {
        if (res.statusCode >= 500 && res.statusCode < 600) {
            throw { error: "Facebook internal server error: " + res.statusCode, res };
        }
        if (res.statusCode === 404 || res.statusCode === 410) {
            throw { error: "Endpoint not found: " + res.statusCode, res };
        }
        if (!res.body) throw { error: "Empty response body", res };

        var body = res.body;
        if (typeof body !== "string") body = JSON.stringify(body);

        var stripped = body;
        for (var prefix of ["for (;;);", "throw 1; /* "])
            if (stripped.startsWith(prefix)) { stripped = stripped.slice(prefix.length); break; }

        var data;
        try {
            var lines = stripped.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length > 1) {
                data = lines.map(l => JSON.parse(l));
            } else {
                data = JSON.parse(stripped);
            }
        } catch (e) {
            throw { error: "Could not parse JSON: " + e.message, body: body.slice(0, 200) };
        }

        if (!Array.isArray(data)) {
            if (data.error === 1357001) throw { error: "Not logged in" };
            if (data.error === 1357004) throw { error: "Request failed" };
        }
        return data;
    };
}

function makeDefaults(html, userID, ctx) {
    function postWithDefaults(reqUrl, jar, form, options, customHeader) {
        var merged = Object.assign({
            __user: userID,
            __req: (++ctx.req_ID).toString(36),
            __a: 1,
            fb_dtsg: ctx.fb_dtsg || ""
        }, form);
        return post(reqUrl, jar, merged, options, ctx, customHeader);
    }

    function getWithDefaults(reqUrl, jar, qs, options) {
        return get(reqUrl, jar, qs, options, ctx);
    }

    function postFormDataWithDefaults(reqUrl, jar, form, qs) {
        var mergedQs = Object.assign({
            __user: userID,
            __req: (++ctx.req_ID).toString(36),
            __a: 1,
            fb_dtsg: ctx.fb_dtsg || ""
        }, qs);
        return postFormData(reqUrl, jar, form, mergedQs, {}, ctx);
    }

    return {
        post: postWithDefaults,
        get: getWithDefaults,
        postFormData: postFormDataWithDefaults
    };
}

function _formatAttachment(attachment, atch) {
    atch = atch || attachment.mercury || {};
    // Also pull in mercuryJSON if mercury was empty
    if (attachment.mercuryJSON && !atch.attach_type && !atch.blob_attachment && !atch.sticker_attachment) {
        try { Object.assign(atch, JSON.parse(attachment.mercuryJSON)); } catch (_) {}
    }

    var attach_type = atch.attach_type;
    var preview = atch.metadata || {};
    var attach = {
        type: "unknown",
        ID: attachment.attach_fbid ? attachment.attach_fbid.toString() : null,
    };

    switch (attach_type) {
        case "photo":
            attach.type = "photo";
            attach.name = atch.name;
            attach.filename = atch.filename || atch.fileName;
            attach.url = preview.url || atch.metadata && atch.metadata.url;
            attach.previewUrl = atch.preview_url || null;
            attach.largePreviewUrl = atch.large_preview_url || null;
            attach.width = preview.dimensions ? (preview.dimensions.width || preview.dimensions.split && parseInt(preview.dimensions.split(",")[0]) || 0) : 0;
            attach.height = preview.dimensions ? (preview.dimensions.height || preview.dimensions.split && parseInt(preview.dimensions.split(",")[1]) || 0) : 0;
            break;
        case "video":
            attach.type = "video";
            attach.name = atch.name;
            attach.filename = atch.filename;
            attach.url = preview.url;
            attach.width = preview.dimensions ? preview.dimensions.width : 0;
            attach.height = preview.dimensions ? preview.dimensions.height : 0;
            attach.duration = preview.duration;
            break;
        case "audio":
            attach.type = "audio";
            attach.name = atch.name;
            attach.filename = atch.filename;
            attach.url = preview.url;
            attach.duration = preview.duration;
            break;
        case "file":
            attach.type = "file";
            attach.name = atch.name;
            attach.filename = atch.filename;
            attach.url = preview.url;
            attach.size = preview.size;
            attach.mimeType = atch.mimeType;
            break;
        case "animated_image":
            attach.type = "animated_image";
            attach.name = atch.name;
            attach.filename = atch.filename;
            attach.previewUrl = atch.preview_url || null;
            attach.url = (preview && preview.image_data && preview.image_data.url)
                || atch.url || atch.thumbnail_url || null;
            break;
        case "sticker":
            attach.type = "sticker";
            attach.url = atch.url;
            attach.stickerID = (preview.stickerID && preview.stickerID.toString())
                || (attachment.attach_fbid && attachment.attach_fbid.toString()) || null;
            attach.ID = attach.stickerID;
            attach.packID = (preview.packID && preview.packID.toString()) || (atch.pack ? atch.pack.id : null);
            attach.spriteUrl = preview.spriteURI || atch.sprite_image;
            attach.spriteUrl2x = preview.spriteURI2x || atch.sprite_image_2x;
            attach.width = preview.width || atch.width;
            attach.height = preview.height || atch.height;
            attach.caption = atch.caption;
            attach.description = atch.description;
            attach.frameCount = preview.frameCount || atch.frame_count;
            attach.frameRate = preview.frameRate || atch.frame_rate;
            attach.framesPerRow = preview.framesPerRow || atch.frames_per_row;
            attach.framesPerCol = preview.framesPerCol || atch.frames_per_column;
            break;
        default: {
            // blob_attachment lives inside atch (mercury) for MQTT delta messages.
            // Fall back to attachment.blob_attachment for ForcedFetch / getThreadHistory paths.
            var blob = atch.blob_attachment || attachment.blob_attachment;
            if (blob) {
                var typename = blob.__typename || "";
                switch (typename) {
                    case "MessageImage":
                        attach.type = "photo";
                        attach.url = (blob.large_preview || blob.preview || {}).uri || null;
                        attach.previewUrl = (blob.preview || {}).uri || null;
                        attach.largePreviewUrl = (blob.large_preview || {}).uri || null;
                        attach.width = (blob.large_preview || {}).width || 0;
                        attach.height = (blob.large_preview || {}).height || 0;
                        break;
                    case "MessageVideo":
                        attach.type = "video";
                        attach.url = blob.playable_url_quality_hd || blob.playable_url || null;
                        attach.duration = blob.playable_duration_in_ms;
                        break;
                    case "MessageAudio":
                        attach.type = "audio";
                        attach.url = blob.playable_url || null;
                        attach.duration = blob.playable_duration_in_ms;
                        attach.audioType = blob.audio_type;
                        attach.isVoiceMail = blob.is_voicemail;
                        break;
                    case "MessageFile":
                        attach.type = "file";
                        attach.url = blob.url || null;
                        attach.mimeType = blob.content_type;
                        break;
                    case "MessageAnimatedImage":
                        attach.type = "animated_image";
                        attach.url = (blob.animated_image || blob.preview || {}).uri || null;
                        attach.previewUrl = (blob.preview || {}).uri || null;
                        break;
                    default:
                        attach.type = typename.toLowerCase() || "unknown";
                }
                attach.filename = blob.filename;
                attach.name = blob.filename;
                attach.ID = blob.legacy_attachment_id || blob.message_file_fbid || attach.ID;
            }

            // sticker_attachment lives inside atch (mercury) in MQTT delta messages
            if (!blob && atch.sticker_attachment) {
                var sticker = atch.sticker_attachment;
                attach.type = "sticker";
                attach.stickerID = sticker.id ? sticker.id.toString() : attach.ID;
                attach.ID = attach.stickerID;
                attach.url = sticker.url || null;
                attach.packID = sticker.pack ? sticker.pack.id : null;
                attach.width = sticker.width;
                attach.height = sticker.height;
                attach.frameCount = sticker.frame_count;
                attach.frameRate = sticker.frame_rate;
                attach.framesPerRow = sticker.frames_per_row;
                attach.framesPerCol = sticker.frames_per_column;
                attach.spriteUrl = sticker.sprite_image;
                attach.spriteUrl2x = sticker.sprite_image_2x;
            }
        }
    }
    return attach;
}

function _splitCsv(str) {
    if (!str) return [];
    return String(str).split(",").map(s => s.trim()).filter(Boolean);
}

function _extractMentions(delta, body) {
    var mentions = {};
    var d = delta.data || {};

    // Strategy 1: prng JSON array [{i, o, l}] — legacy delta format
    try {
        if (d.prng) {
            JSON.parse(d.prng).forEach(function(u) {
                if (u && u.i != null)
                    mentions[u.i] = body.substring(u.o || 0, (u.o || 0) + (u.l || 0));
            });
        }
    } catch (_) {}

    // Strategy 2: flat CSV fields in data (data.mention_ids / mentions_ids / mentionIds)
    if (!Object.keys(mentions).length) {
        var mids = _splitCsv(d.mention_ids || d.mentions_ids || d.mentionIds);
        var mos  = _splitCsv(d.mention_offsets || d.mentions_offsets || d.mentionOffsets);
        var mls  = _splitCsv(d.mention_lengths || d.mentions_lengths || d.mentionLengths);
        for (var i = 0; i < mids.length; i++) {
            var o = parseInt(mos[i]) || 0, l = parseInt(mls[i]) || 0;
            if (mids[i]) mentions[mids[i]] = body.substring(o, o + l);
        }
    }

    // Strategy 3: ranges / profileRanges array (newer delta format)
    if (!Object.keys(mentions).length) {
        var ranges = [];
        if (Array.isArray(delta.ranges))           ranges = delta.ranges;
        else if (Array.isArray(d.ranges))          ranges = d.ranges;
        else if (Array.isArray(delta.profileRanges)) ranges = delta.profileRanges;
        else if (Array.isArray(d.profileRanges))   ranges = d.profileRanges;
        else if (typeof d.ranges === "string")     { try { ranges = JSON.parse(d.ranges); } catch (_) {} }
        ranges.forEach(function(r) {
            var id  = (r && r.entity && r.entity.id) || (r && r.id) || (r && r.i);
            var ro  = r && (r.offset  != null ? r.offset  : r.o);
            var rl  = r && (r.length  != null ? r.length  : r.l);
            if (id && rl) mentions[id] = body.substring(ro || 0, (ro || 0) + rl);
        });
    }

    // Strategy 4: Gb protobuf nested format — Facebook encodes mentions inside
    // messageMetadata.data.data.Gb.asMap.data when sending via the newer Gb path.
    // Reference: stfca formatDeltaMessage (confirmed working in v1.3.2+)
    if (!Object.keys(mentions).length) {
        try {
            var md2 = delta.messageMetadata || {};
            var gbData = md2.data && md2.data.data && md2.data.data.Gb &&
                         md2.data.data.Gb.asMap && md2.data.data.Gb.asMap.data;
            if (gbData) {
                for (var key in gbData) {
                    if (!Object.prototype.hasOwnProperty.call(gbData, key)) continue;
                    var entry = gbData[key];
                    if (entry && entry.asMap && entry.asMap.data) {
                        var ed = entry.asMap.data;
                        var gid = ed.id && ed.id.asLong ? String(ed.id.asLong) : null;
                        var go  = parseInt(ed.offset && ed.offset.asLong ? ed.offset.asLong : 0, 10);
                        var gl  = parseInt(ed.length && ed.length.asLong ? ed.length.asLong : 0, 10);
                        if (gid != null) mentions[gid] = body.substring(go, go + gl);
                    }
                }
            }
        } catch (_) {}
    }

    return mentions;
}

function formatDeltaMessage(v) {
    var delta = v.delta;
    var md = delta.messageMetadata || {};
    var body = delta.body || "";
    var mentions = _extractMentions(delta, body);
    var threadKey = md.threadKey || {};
    var threadID = (threadKey.threadFbId || threadKey.otherUserFbId || "").toString();
    return {
        type: "message",
        senderID: (md.actorFbId || "").toString(),
        body: body,
        threadID: formatID(threadID),
        messageID: md.messageId,
        attachments: (delta.attachments || []).map(att => {
            var mercury = att.mercury || {};
            if (att.mercuryJSON) {
                try { Object.assign(mercury, JSON.parse(att.mercuryJSON)); } catch (_) { }
            }
            var x;
            try { x = _formatAttachment(att, mercury); }
            catch (ex) { x = { type: "unknown", error: ex }; }
            return x;
        }),
        args: body.trim().split(/\s+/),
        mentions: mentions,
        timestamp: parseInt(md.timestamp),
        isGroup: !!threadKey.threadFbId,
        participantIDs: (md.cid && md.cid.canonicalParticipantFbids) ? md.cid.canonicalParticipantFbids.map(e => e.toString()) : []
    };
}

function _getAdminTextMessageType(delta) {
    switch (delta.type) {
        case "joinable_group_link_mode_change": return "log:link-status";
        case "magic_words":                     return "log:magic-words";
        case "change_thread_theme":             return "log:thread-color";
        case "change_thread_icon":              return "log:thread-icon";
        case "change_thread_nickname":          return "log:user-nickname";
        case "change_thread_admins":            return "log:thread-admins";
        case "group_poll":                      return "log:thread-poll";
        case "change_thread_approval_mode":     return "log:thread-approval-mode";
        case "messenger_call_log":
        case "participant_joined_group_call":   return "log:thread-call";
        case "pin_messages_v2":
        case "unpin_messages_v2":               return "log:thread-pinned";
        case "confirm_friend_request":          return "log:confirmed-friend-request";
        case "shared_album_delete":
        case "shared_album_addition":           return "log:shared-album";
        default:                                return delta.type || "log:unknown";
    }
}

function formatDeltaEvent(delta) {
    var md = delta.messageMetadata || {};
    var threadKey = md.threadKey || {};
    var threadID = (threadKey.threadFbId || threadKey.otherUserFbId || "").toString();
    var participantIDs = (delta.participants || []).map(function(p) { return p.toString(); });

    switch (delta.class) {
        case "AdminTextMessage":
            return {
                type: "event",
                threadID: formatID(threadID),
                messageID: md.messageId,
                author: (md.actorFbId || "").toString(),
                logMessageType: _getAdminTextMessageType(delta),
                logMessageData: delta.untypedData || {},
                logMessageBody: md.adminText || "",
                participantIDs: participantIDs,
                timestamp: parseInt(md.timestamp)
            };
        case "ThreadName":
            return {
                type: "event",
                threadID: formatID(threadID),
                messageID: md.messageId,
                author: (md.actorFbId || "").toString(),
                logMessageType: "log:thread-name",
                logMessageData: { name: delta.name },
                logMessageBody: md.adminText || "",
                participantIDs: participantIDs,
                timestamp: parseInt(md.timestamp)
            };
        case "ParticipantsAddedToGroupThread":
            return {
                type: "event",
                threadID: formatID(threadID),
                messageID: md.messageId,
                author: (md.actorFbId || "").toString(),
                logMessageType: "log:subscribe",
                logMessageData: { addedParticipants: delta.addedParticipants || [] },
                logMessageBody: md.adminText || "",
                participantIDs: participantIDs,
                timestamp: parseInt(md.timestamp)
            };
        case "ParticipantLeftGroupThread":
            return {
                type: "event",
                threadID: formatID(threadID),
                messageID: md.messageId,
                author: (md.actorFbId || "").toString(),
                logMessageType: "log:unsubscribe",
                logMessageData: { leftParticipantFbId: (delta.leftParticipantFbId || "").toString() },
                logMessageBody: md.adminText || "",
                participantIDs: participantIDs,
                timestamp: parseInt(md.timestamp)
            };
        default:
            return {
                type: "event",
                threadID: formatID(threadID),
                messageID: md.messageId,
                author: (md.actorFbId || "").toString(),
                logMessageType: delta.class || "unknown",
                logMessageData: delta.untypedData || {},
                logMessageBody: md.adminText || "",
                participantIDs: participantIDs,
                timestamp: parseInt(md.timestamp)
            };
    }
}

function wrapCallback(callback) {
    var resolve, reject;
    var promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    if (!callback) {
        callback = (err, data) => err ? reject(err) : resolve(data);
    }
    return { callback, promise };
}

module.exports = {
    setProxy,
    get,
    post,
    postFormData,
    getJar,
    getAppState,
    saveCookies,
    getType,
    getFrom,
    getHeaders,
    isReadableStream,
    generateOfflineThreadingID,
    generateThreadingID,
    getGUID,
    arrToForm,
    formatCookie,
    formatID,
    decodeClientPayload,
    parseAndCheckLogin,
    makeDefaults,
    _formatAttachment,
    formatDeltaMessage,
    formatDeltaEvent,
    wrapCallback,
};
