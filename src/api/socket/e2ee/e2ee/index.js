"use strict";

/**
 * SHADOWX E2EE Bridge — Signal Protocol + Noise WebSocket
 *
 * Uses SHADOWX's own native E2EE engine bundled at ./vendor/fb-e2ee.cjs.
 * No external npm package needed — all E2EE code is owned by SHADOWX.
 *
 * Direct deps (fca/package.json): @signalapp/libsignal-client, protobufjs,
 *   @noble/curves, @noble/hashes
 *
 * Full protocol stack:
 *   • @signalapp/libsignal-client — Signal Protocol (Double Ratchet)
 *   • Noise_XX_25519_AESGCM_SHA256 WebSocket handshake
 *   • WA-binary + Protobuf message encoding
 *   • ICDC device registration with Facebook
 */

const path = require("path");
const logger = require("../../../utils/shadowx-logger");

function loadFBClient() {
    try {
        const vendorPath = path.join(__dirname, "vendor", "fb-e2ee.cjs");
        return require(vendorPath).FBClient;
    } catch (err) {
        throw new Error(
            "SHADOWX E2EE engine failed to load.\n" +
            "  Expected at: fca/src/e2ee/vendor/fb-e2ee.cjs\n" +
            "  Cause: " + err.message
        );
    }
}

class E2EEBridge {
    constructor(ctx, api, defaultFuncs) {
        this.ctx = ctx;
        this.api = api;
        this.defaultFuncs = defaultFuncs || null;
        this.client = null;
        this.connected = false;
        this._messageCallback = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup
    // ─────────────────────────────────────────────────────────────────────────

    async connect(deviceStorePath, userId) {
        const fs = require("fs");

        userId = userId || this.ctx.userID;

        // Default to .shadowx/e2ee_device.json in the user's project directory
        if (!deviceStorePath) {
            deviceStorePath = path.join(process.cwd(), ".shadowx", "e2ee_device.json");
        }

        // Auto-create parent directory — users don't need to create it manually
        try {
            fs.mkdirSync(path.dirname(deviceStorePath), { recursive: true });
        } catch (_) {}

        logger.info("E2EE", "Device store: " + deviceStorePath);

        const FBClient = loadFBClient();

        // Re-use the already-loaded session from SHADOWX's cookie jar
        const appState = this.api.getAppState();

        this.client = new FBClient({
            appState,
            platform: "facebook",
        });

        // Build the SHADOWX adapter that replaces fb-messenger-e2ee's internal
        // fca-unofficial login.  fb-messenger-e2ee calls
        //   this.gateway.login(appState)
        // inside connect() which triggers a *second* fca-unofficial login and
        // crashes when the network call returns undefined.
        // By replacing gateway.login BEFORE connect() we prevent that entirely.
        const _ctx = this.ctx;
        const _shadowxApi = this.api;
        const _defaultFuncs = this.defaultFuncs;

        const _shadowxAdapter = {
            fb_dtsg: _ctx.fb_dtsg,
            getCurrentUserID: () => _shadowxApi.getCurrentUserID(),
            getAppState: () => _shadowxApi.getAppState(),
            httpPost: async function (url, form) {
                var merged = Object.assign({}, form);
                if (!merged.fb_dtsg && _ctx.fb_dtsg) merged.fb_dtsg = _ctx.fb_dtsg;
                if (!merged.__user) merged.__user = _ctx.userID;
                const res = _defaultFuncs
                    ? await _defaultFuncs.post(url, _ctx.jar, merged)
                    : await new Promise(function (resolve, reject) {
                        require("request")({ method: "POST", url: url, jar: _ctx.jar, form: merged, gzip: true },
                            function (err, r) { if (err) return reject(err); resolve(r); });
                    });
                if (typeof res === "string")
                    return res;
                if (res && typeof res === "object") {
                    var body = res.data != null ? res.data : (res.body != null ? res.body : "");
                    if (typeof body === "string")
                        return body;
                    if (body != null) {
                        try { return JSON.stringify(body); } catch (_) {}
                    }
                }
                return "";
            },
            // listenMqtt — fb-e2ee.cjs calls this to route non-E2EE MQTT events.
            // SHADOWX has its own separate MQTT listener so we provide a no-op stub
            // to prevent a competing second listener from being started.
            listenMqtt: function () { return; },
            stopListenMqtt: function () {},
            setOptions: function () {},
            // Delegate messaging methods to SHADOWX's real api
            sendMessage: function (msg, threadID, callback, replyToMessage) {
                return _shadowxApi.sendMessage(msg, threadID, callback, replyToMessage);
            },
            setMessageReaction: function (reaction, messageID, callback, force) {
                if (typeof _shadowxApi.setMessageReaction === "function")
                    return _shadowxApi.setMessageReaction(reaction, messageID, callback, force);
            },
            unsendMessage: function (messageID, callback) {
                if (typeof _shadowxApi.unsendMessage === "function")
                    return _shadowxApi.unsendMessage(messageID, callback);
            },
            sendTypingIndicator: function (isTyping, threadID, callback) {
                if (typeof _shadowxApi.sendTypingIndicator === "function")
                    return _shadowxApi.sendTypingIndicator(isTyping, threadID, callback);
            },
            markAsRead: function (threadID, read, callback) {
                if (typeof _shadowxApi.markAsRead === "function")
                    return _shadowxApi.markAsRead(threadID, read, callback);
            },
            muteThread: function (threadID, muteSeconds, callback) {
                if (typeof _shadowxApi.muteThread === "function")
                    return _shadowxApi.muteThread(threadID, muteSeconds, callback);
            },
            setTitle: function (newTitle, threadID, callback) {
                if (typeof _shadowxApi.setTitle === "function")
                    return _shadowxApi.setTitle(newTitle, threadID, callback);
            },
            changeGroupImage: function (image, threadID, callback) {
                if (typeof _shadowxApi.changeGroupImage === "function")
                    return _shadowxApi.changeGroupImage(image, threadID, callback);
            },
        };

        // Inject the adapter as a global so that fb-e2ee.cjs's internal
        // require("../../vendor/fca-unofficial") login() intercepts it and
        // skips the real Facebook login, returning SHADOWX's session instead.
        global._shadowxE2EEAdapter = _shadowxAdapter;

        logger.info("E2EE", "Bootstrapping auth via vendored E2EE engine (SHADOWX session)...");
        let resolvedUserId;
        try {
            const connectResult = await this.client.connect();
            resolvedUserId = connectResult && connectResult.userId;
        } finally {
            delete global._shadowxE2EEAdapter;
        }

        // Also patch controller.api (used for CAT/ICDC calls after connect)
        if (this.client.controller) {
            this.client.controller.api = _shadowxAdapter;
        }

        logger.info("E2EE", "Opening Noise WebSocket (Signal Protocol)...");
        const _e2eeDevicePath = deviceStorePath;
        const _e2eeUserId     = resolvedUserId || userId;
        await this.client.connectE2EE(_e2eeDevicePath, _e2eeUserId);

        // Auto-reconnect the Noise WebSocket whenever it drops unexpectedly.
        // `this.connected` stays true through reconnect cycles; it's only set
        // false by an explicit api.e2ee.disconnect() call.
        const _self = this;
        this.client.onEvent("disconnected", function _onE2EEDisconnected() {
            if (!_self.connected) return; // intentional disconnect — skip
            logger.warn("E2EE", "Noise WebSocket disconnected — reconnecting in 5s...");
            setTimeout(async function () {
                if (!_self.connected) return;
                try {
                    await _self.client.connectE2EE(_e2eeDevicePath, _e2eeUserId);
                    logger.success("E2EE", "E2EE WebSocket reconnected.");
                } catch (err) {
                    logger.error("E2EE", "E2EE reconnect failed: " + (err && err.message ? err.message : String(err)));
                    // Retry again after another 10s if reconnect failed
                    if (_self.connected) {
                        setTimeout(async function () {
                            if (!_self.connected) return;
                            try {
                                await _self.client.connectE2EE(_e2eeDevicePath, _e2eeUserId);
                                logger.success("E2EE", "E2EE WebSocket reconnected (retry).");
                            } catch (err2) {
                                logger.error("E2EE", "E2EE reconnect retry failed: " + (err2 && err2.message ? err2.message : String(err2)));
                            }
                        }, 10000);
                    }
                }
            }, 5000);
        });

        // Forward incoming E2EE messages to the registered callback.
        this.client.onEvent("e2ee_message", (msg) => {
            if (!this._messageCallback) return;

            const senderID =
                msg.senderId ||
                (typeof msg.senderJid === "string" ? msg.senderJid.split(".")[0] : "");

            // Build mentions: vendor surfaces an array [{ id, text }] or object
            var mentions = {};
            if (Array.isArray(msg.mentions)) {
                msg.mentions.forEach(function(m) {
                    if (m && m.id) mentions[m.id] = m.text || "@" + m.id;
                });
            } else if (msg.mentions && typeof msg.mentions === "object") {
                mentions = msg.mentions;
            }

            const isReply = !!(msg.replyTo && msg.replyTo.messageId);

            const event = {
                type:        isReply ? "message_reply" : "message",
                senderID,
                threadID:    msg.threadId,
                body:        msg.text || "",
                isE2EE:      true,
                isGroup:     !!msg.isGroup,
                timestamp:   msg.timestampMs || Date.now(),
                messageID:   msg.id || "",
                attachments: [],
                mentions,
                args:        (msg.text || "").trim().split(/\s+/).filter(Boolean),
            };

            // Populate ctx.threadTypes so that sendMessage.js can detect this
            // as a DM and route attachments through OldMessage (not MQTT).
            // E2EE DM messages arrive via the Noise WebSocket — not MQTT — so
            // parseDelta never sees them and ctx.threadTypes stays empty unless
            // we populate it here.
            if (!event.isGroup && msg.threadId) {
                this.ctx.threadTypes = this.ctx.threadTypes || {};
                this.ctx.threadTypes[String(msg.threadId)] = 'dm';
            }

            // Populate messageReply so reply handlers work the same as in MQTT
            if (isReply) {
                event.messageReply = {
                    messageID: msg.replyTo.messageId,
                    senderID:  msg.replyTo.senderId || "",
                    threadID:  msg.threadId,
                    body:      msg.replyTo.text || "",
                    args:      (msg.replyTo.text || "").trim().split(/\s+/).filter(Boolean),
                    isE2EE:    true,
                    isGroup:   !!msg.isGroup,
                    mentions:  {},
                    attachments: []
                };
            }

            this._messageCallback(null, event);
        });

        // Surface connection errors so the bot log shows them.
        // Silently ignore DuplicatedMessage errors — these are harmless replays on reconnect.
        this.client.onEvent("error", (err) => {
            if (err && (err.code === 1 || (err.message && err.message.includes("old counter")))) return;
            logger.error("E2EE", "E2EE error: " + (err && err.message ? err.message : String(err)));
        });

        this.connected = true;
        logger.success("E2EE", "E2EE active — Signal Protocol / Noise WebSocket (vendored)");
        return this;
    }

    ensureConnected() {
        if (!this.connected || !this.client) {
            throw new Error("E2EE not connected. Call api.connectE2EE() first.");
        }
    }

    isConnected() {
        return this.connected;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Send API  (all go through the Noise WebSocket)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Send a message on an E2EE (or non-E2EE) thread.
     *
     * msg can be:
     *   - string              → plain text
     *   - { body, attachment} → text + one or more readable streams
     *
     * Attachments on E2EE threads are encrypted and sent via the Noise WebSocket.
     * Attachments on non-E2EE threads fall back to api.sendMessage (SHADOWX's own).
     */
    async sendMessage(threadId, msg, replyToMessageId) {
        this.ensureConnected();

        const text = typeof msg === "string" ? msg : (msg && msg.body != null ? String(msg.body) : "");
        const attachment = (msg && typeof msg === "object") ? (msg.attachment || null) : null;

        if (!attachment) {
            return this.client.sendMessage({ threadId, text, replyToMessageId });
        }

        // Always use the vendor's Noise WebSocket path for attachments.
        // The isE2EEThreadId() check was removed because:
        //   1. It frequently returns false for valid E2EE DM thread IDs (user-id format),
        //      which caused fallback to api.sendMessage → MQTT, where Facebook strips
        //      attachment_fbids from the E2EE envelope → attachment silently dropped.
        //   2. This method is only called when the thread is KNOWN to be an E2EE DM
        //      (sendMessage.js routes here only when isSingleUser=true AND e2ee.isConnected()).
        //   3. client.sendImage/sendVideo/sendAudio handle the JID conversion internally
        //      (100055943906136 → 100055943906136.0@msgr) so the threadId format is fine.

        // E2EE path: read stream(s) → Buffer, detect type, send via vendor
        const path = require("path");
        let mime;
        try { mime = require("mime"); } catch (_) {}

        const list = Array.isArray(attachment) ? attachment : [attachment];
        const results = [];

        for (const stream of list) {
            const data = await _streamToBuffer(stream);
            const fileName = (stream.path ? path.basename(String(stream.path)) : "file.bin");
            const mimeType = (mime && mime.getType(fileName)) || _guessMime(fileName);

            const input = { threadId, data, fileName, mimeType, caption: text || undefined, replyToMessageId };

            console.log(`[E2EEBridge] sendMessage attachment: fileName=${fileName}, mimeType=${mimeType}, size=${data.length} bytes, threadId=${threadId}`);
            let result;
            if (mimeType.startsWith("image/")) {
                result = await this.client.sendImage(input);
            } else if (mimeType.startsWith("video/")) {
                result = await this.client.sendVideo(input);
            } else if (mimeType.startsWith("audio/")) {
                result = await this.client.sendAudio(input);
            } else {
                result = await this.client.sendFile(input);
            }
            console.log(`[E2EEBridge] send result:`, JSON.stringify(result));
            results.push(result);
        }

        return results.length === 1 ? results[0] : results;
    }

    async sendReaction(threadId, messageId, reaction, senderJid) {
        this.ensureConnected();
        return this.client.sendReaction({ threadId, messageId, reaction, senderJid });
    }

    async sendTyping(threadId, isTyping) {
        this.ensureConnected();
        return this.client.sendTyping({ threadId, isTyping: isTyping !== false });
    }

    async unsendMessage(messageId, threadId) {
        this.ensureConnected();
        return this.client.unsendMessage({ messageId, threadId });
    }

    async editMessage(threadId, messageId, newText) {
        this.ensureConnected();
        return this.client.editMessage({ threadId, messageId, newText });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Receive API
    // ─────────────────────────────────────────────────────────────────────────

    onMessage(callback) {
        this._messageCallback = callback;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Info / lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    getPublicKeys() {
        return {
            info: "Keys managed by vendored E2EE engine (Signal Protocol / Noise handshake).",
            note: "Identity + device keys are stored in the device-store file. Do NOT delete it.",
        };
    }

    async disconnect() {
        if (this.client) {
            try { await this.client.disconnect(); } catch (_) {}
        }
        this.connected = false;
        logger.info("E2EE", "E2EE disconnected.");
    }
}

module.exports = { E2EEBridge };

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _streamToBuffer(stream) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        stream.on("data", function (c) { chunks.push(c); });
        stream.on("end", function () { resolve(Buffer.concat(chunks)); });
        stream.on("error", reject);
    });
}

function _guessMime(fileName) {
    var ext = (fileName || "").split(".").pop().toLowerCase();
    var map = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime",
        avi: "video/x-msvideo", mkv: "video/x-matroska",
        mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
        m4a: "audio/mp4", aac: "audio/aac", opus: "audio/ogg; codecs=opus",
        pdf: "application/pdf", zip: "application/zip"
    };
    return map[ext] || "application/octet-stream";
}
