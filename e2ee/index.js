"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHADOWX-FCA  E2EE Bridge  —  full dual-engine implementation
 * Dev by Mueid Mursalin Rifat
 *
 * Primary  : Signal Protocol + Noise WebSocket  (vendor/fb-e2ee.cjs)
 * Fallback : Native binary Labyrinth engine     (lib/index.mjs + messagix.so/dll)
 *
 * Connect flow:
 *   1. Read config.json → e2ee.enable must be true
 *   2. Try primary vendor engine (fb-e2ee.cjs) with 5s→10s auto-reconnect
 *   3. If primary fails → auto-fall back to native binary engine
 *   4. Both engines emit identical event shapes to listenE2EE
 * ═══════════════════════════════════════════════════════════════════════════
 */

var path   = require("path");
var fs     = require("fs");
var urlMod = require("url");
var http   = require("http");
var crypto = require("crypto");
var logger = require("../../logger");

// ─────────────────────────────────────────────────────────────────────────────
// § 0  CONFIG READER
// ─────────────────────────────────────────────────────────────────────────────
function _readE2EEConfig() {
    try {
        var cfgPath = path.join(process.cwd(), "config.json");
        if (!fs.existsSync(cfgPath)) return {};
        var cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        return (cfg && cfg.e2ee && typeof cfg.e2ee === "object") ? cfg.e2ee : {};
    } catch (_) { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 1  JID HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true for any E2EE JID (contains "@") */
function isE2EEChatJid(value) {
    return typeof value === "string" && value.indexOf("@") !== -1;
}

/** Extract numeric prefix from JID: "61568577897207:69@msgr" → "61568577897207" */
function _numericId(jid) {
    if (!jid) return "";
    var s = String(jid);
    var m = s.match(/^(\d+)/);
    return m ? m[1] : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2  LOCAL MEDIA SERVER  –  caches decrypted E2EE attachments as local URLs
// ─────────────────────────────────────────────────────────────────────────────
var _mediaCache  = new Map();
var _mediaServer = null;
var _mediaPort   = null;

function _cleanExpired() {
    var now = Date.now();
    _mediaCache.forEach(function (entry, id) {
        if (entry.expiry < now) _mediaCache.delete(id);
    });
}

function _startMediaServer() {
    if (_mediaServer && _mediaPort) return Promise.resolve(_mediaPort);
    return new Promise(function (resolve, reject) {
        var s = http.createServer(function (req, res) {
            var id    = req.url.replace(/^\/e2ee\//, "").split("?")[0];
            var entry = _mediaCache.get(id);
            if (!entry) { res.writeHead(404); return res.end("Not found"); }
            res.writeHead(200, {
                "Content-Type"  : entry.mimeType || "application/octet-stream",
                "Content-Length": entry.buffer.length,
                "Cache-Control" : "no-cache"
            });
            res.end(entry.buffer);
        });
        s.listen(0, "127.0.0.1", function () {
            _mediaPort   = s.address().port;
            _mediaServer = s;
            resolve(_mediaPort);
        });
        s.on("error", reject);
    });
}

async function storeMedia(buffer, mimeType) {
    var port = await _startMediaServer();
    _cleanExpired();
    var id = crypto.randomBytes(10).toString("hex");
    _mediaCache.set(id, {
        buffer  : buffer,
        mimeType: mimeType || "application/octet-stream",
        expiry  : Date.now() + 10 * 60 * 1000
    });
    return "http://127.0.0.1:" + port + "/e2ee/" + id;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3  PRIMARY ENGINE — vendor/fb-e2ee.cjs  (Signal Protocol)
// ─────────────────────────────────────────────────────────────────────────────
function _loadFBClient() {
    try {
        var vendorPath = path.join(__dirname, "vendor", "fb-e2ee.cjs");
        return require(vendorPath).FBClient;
    } catch (err) {
        throw new Error(
            "SHADOWX-FCA primary E2EE engine failed to load.\n" +
            "  Expected at: shadowx-fca/src/e2ee/vendor/fb-e2ee.cjs\n" +
            "  Cause: " + err.message
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4  FALLBACK ENGINE — lib/index.mjs  (native binary Labyrinth)
// ─────────────────────────────────────────────────────────────────────────────

// Polyfill File/Blob for Node < 20
(function _polyfillFileGlobal() {
    try {
        if (typeof globalThis.File === "undefined") {
            var b = require("buffer");
            if (b && typeof b.File === "function") globalThis.File = b.File;
        }
        if (typeof globalThis.Blob === "undefined") {
            var b2 = require("buffer");
            if (b2 && typeof b2.Blob === "function") globalThis.Blob = b2.Blob;
        }
    } catch (_) {}
})();

// ESM bundle at <shadowx-fca root>/lib/index.mjs
var _NATIVE_LIB_URL = urlMod.pathToFileURL(
    path.join(__dirname, "..", "..", "lib", "index.mjs")
).href;

async function _loadNativeClient() {
    var mod;
    try {
        var dynamicImport = new Function("specifier", "return import(specifier)");
        mod = await dynamicImport(_NATIVE_LIB_URL);
    } catch (err) {
        throw new Error(
            "SHADOWX-FCA native E2EE engine (lib/index.mjs) failed to load: " +
            (err && err.message ? err.message : String(err))
        );
    }
    if (!mod || !mod.Client)
        throw new Error("SHADOWX-FCA native E2EE bundle loaded but Client export not found");
    return mod.Client;
}

function _cookiesFromJar(ctx) {
    var out = {};
    var jar = [];
    try { jar = ctx.jar.getCookies("https://www.facebook.com"); } catch (_) {}
    jar.forEach(function (c) { if (c && c.key) out[c.key] = c.value; });
    if (!out.c_user && out.i_user) out.c_user = out.i_user;
    return out;
}

function _normalizeMediaInput(input) {
    if (Buffer.isBuffer(input)) return input;
    if (Array.isArray(input))   return Buffer.from(input);
    if (input && input.type === "Buffer" && Array.isArray(input.data)) return Buffer.from(input.data);
    if (typeof input === "string") return Buffer.from(input, "base64");
    throw new Error("E2EE media data must be Buffer, byte array, Buffer-JSON, or base64 string");
}

// ─── Event mappers (native fallback engine) ────────────────────────────────

function _isCallbackLike(v) { return v && typeof v.then === "function"; }

function _callUserCallback(cb, err, msg) {
    if (typeof cb !== "function") return;
    try {
        var r = cb(err, msg);
        if (_isCallbackLike(r)) r.catch(function (e) { logger.error("E2EE", e); });
    } catch (e) { logger.error("E2EE", e); }
}

function _parseMentions(arr, text) {
    var out = {};
    if (!Array.isArray(arr) || !text) return out;
    arr.forEach(function (m) {
        if (!m || m.userId == null) return;
        var o = Number(m.offset || 0), l = Number(m.length || 0);
        out[String(m.userId)] = text.substring(o, o + l);
    });
    return out;
}

function _normalizeAttType(t) {
    if (!t) return t;
    t = String(t).toLowerCase();
    if (t === "image")                return "photo";
    if (t === "document")             return "file";
    if (t === "voice" || t === "ptt") return "audio";
    return t;
}

function _normalizeAtt(a) {
    if (!a || typeof a !== "object") return a;
    return {
        type          : _normalizeAttType(a.type),
        ID            : a.stickerId != null ? String(a.stickerId) : undefined,
        url           : a.url,
        filename      : a.fileName,
        mimeType      : a.mimeType,
        fileSize      : a.fileSize != null ? String(a.fileSize) : undefined,
        width         : a.width,
        height        : a.height,
        duration      : a.duration,
        previewUrl    : a.previewUrl,
        description   : a.description,
        source        : a.sourceText,
        mediaKey      : a.mediaKey,
        mediaSha256   : a.mediaSha256,
        mediaEncSha256: a.mediaEncSha256,
        directPath    : a.directPath,
        latitude      : a.latitude,
        longitude     : a.longitude,
        isE2EE        : true
    };
}

function _mapMsg(ev) {
    var text = ev && ev.text ? String(ev.text) : "";
    var sid  = ev && ev.senderId != null ? _numericId(String(ev.senderId)) : "";
    var tid  = ev && ev.chatJid  ? String(ev.chatJid)
             : (ev && ev.threadId != null ? String(ev.threadId) : "");
    var messageReply = null;
    if (ev && ev.replyTo) {
        var _rtId = ev.replyTo.messageId != null ? ev.replyTo.messageId
                  : ev.replyTo.id != null ? ev.replyTo.id : undefined;
        var _rtSender = (ev.replyTo.senderId != null &&
                         typeof ev.replyTo.senderId !== "object")
                      ? _numericId(String(ev.replyTo.senderId)) : "";
        messageReply = {
            messageID: _rtId != null ? String(_rtId) : undefined,
            senderID:  _rtSender,
            body:      ev.replyTo.text != null ? String(ev.replyTo.text) : "",
            isE2EE:    true
        };
    }
    return {
        type        : messageReply ? "message_reply" : "message",
        senderID    : sid,
        body        : text,
        threadID    : tid,
        messageID   : ev.id != null ? String(ev.id) : ev.id,
        messageReply: messageReply,
        attachments : Array.isArray(ev.attachments) ? ev.attachments.map(_normalizeAtt) : [],
        mentions    : _parseMentions(ev.mentions, text),
        timestamp   : ev.timestampMs != null ? Number(ev.timestampMs) : Date.now(),
        isGroup     : /@group\.facebook\.com$/i.test(ev.chatJid || ""),
        isE2EE      : true,
        e2ee        : { chatJid: ev.chatJid, senderJid: ev.senderJid, replyTo: ev.replyTo || null, rawMentions: ev.mentions || [] },
        args        : text.trim() ? text.trim().split(/\s+/) : []
    };
}

function _mapEdit(ev) {
    var text = ev && ev.text ? String(ev.text) : "";
    return {
        type     : "e2ee_message_edit",
        senderID : ev && ev.senderId != null ? String(ev.senderId) : "",
        body     : text,
        threadID : ev && ev.chatJid ? String(ev.chatJid) : "",
        messageID: ev ? ev.messageId : undefined,
        timestamp: ev && ev.timestampMs != null ? Number(ev.timestampMs) : Date.now(),
        isGroup  : /@group\.facebook\.com$/i.test(ev && ev.chatJid ? ev.chatJid : ""),
        isE2EE   : true,
        e2ee     : { chatJid: ev ? ev.chatJid : undefined, senderJid: ev ? ev.senderJid : undefined },
        args     : text.trim() ? text.trim().split(/\s+/) : []
    };
}

function _mapReaction(ev) {
    return {
        type     : "e2ee_message_reaction",
        threadID : ev && ev.chatJid ? String(ev.chatJid) : "",
        messageID: ev ? ev.messageId : undefined,
        reaction : ev ? ev.reaction : undefined,
        senderID : ev && ev.senderId != null ? String(ev.senderId) : undefined,
        userID   : ev && ev.senderId != null ? String(ev.senderId) : undefined,
        isE2EE   : true,
        e2ee     : { chatJid: ev ? ev.chatJid : undefined, senderJid: ev ? ev.senderJid : undefined }
    };
}

function _mapReceipt(ev) {
    return {
        type : "e2ee_receipt",
        isE2EE: true,
        e2ee : {
            receiptType: ev ? ev.type : undefined,
            chatJid    : ev ? ev.chat : undefined,
            senderJid  : ev ? ev.sender : undefined,
            messageIds : ev ? ev.messageIds : []
        }
    };
}

// Global message-ID → JID maps (needed for reactions/unsend/edits to find JID)
global._e2eeMessageMap   = global._e2eeMessageMap   || new Map();
global._e2eeSenderJidMap = global._e2eeSenderJidMap || new Map();

function _regMsg(msgID, jid) {
    if (msgID && jid) global._e2eeMessageMap.set(String(msgID), String(jid));
}

// Attach all native bridge events → globalCallback
function _attachNativeEvents(nativeClient, state, globalCallback, ctx) {
    if (state.listenerAttached) return;
    state.listenerAttached = true;

    nativeClient.on("ready", function (p) {
        state.lastReadyPayload = p;
        logger.info("E2EE", "Native bridge ready.");
        _callUserCallback(globalCallback, null, { type: "e2ee_ready", isE2EE: true, data: p || null });
    });
    nativeClient.on("fullyReady", function () {
        state.nativeFullyReady = true;
        logger.success("E2EE", "Native bridge fully ready — E2EE active ✅");
        _callUserCallback(globalCallback, null, { type: "e2ee_fully_ready", isE2EE: true });
    });
    nativeClient.on("e2eeConnected", function () {
        logger.info("E2EE", "Native E2EE encryption bridge connected.");
        _callUserCallback(globalCallback, null, { type: "e2ee_connected", isE2EE: true });
    });
    nativeClient.on("deviceDataChanged", function (p) {
        if (p && p.deviceData) ctx._e2eeDeviceData = p.deviceData;
        _callUserCallback(globalCallback, null,
            { type: "e2ee_device_data_changed", isE2EE: true, deviceData: p ? p.deviceData : undefined });
    });
    nativeClient.on("e2eeMessage", function (ev) {
        var mapped = _mapMsg(ev);
        // Register message ID → JID so reactions/unsend can find the JID later
        if (mapped.messageID && mapped.threadID) {
            global._e2eeMessageMap.set(String(mapped.messageID), String(mapped.threadID));
        }
        if (mapped.messageID && ev.senderJid) {
            global._e2eeSenderJidMap.set(String(mapped.messageID), String(ev.senderJid));
        }
        if (ev.replyTo && ev.chatJid) {
            var _rtReg = ev.replyTo.messageId || ev.replyTo.id;
            if (_rtReg) global._e2eeMessageMap.set(String(_rtReg), String(ev.chatJid));
        }
        // Populate ctx.threadTypes for DM routing
        if (!mapped.isGroup && mapped.threadID) {
            ctx.threadTypes = ctx.threadTypes || {};
            ctx.threadTypes[String(mapped.threadID)] = "dm";
        }
        _callUserCallback(globalCallback, null, mapped);
    });
    nativeClient.on("e2eeMessageEdit", function (ev) {
        _callUserCallback(globalCallback, null, _mapEdit(ev));
    });
    nativeClient.on("e2eeReaction", function (ev) {
        _callUserCallback(globalCallback, null, _mapReaction(ev));
    });
    nativeClient.on("e2eeReceipt", function (ev) {
        _callUserCallback(globalCallback, null, _mapReceipt(ev));
    });
    nativeClient.on("error", function (err) {
        var msg = err && err.message ? err.message : String(err || "");
        if (/close 1006|unexpected EOF|ECONNRESET|ETIMEDOUT|read loop/i.test(msg)) {
            logger.warn("E2EE", "Native transient error (reconnecting): " + msg);
            return;
        }
        _callUserCallback(globalCallback, err || new Error("Unknown E2EE error"));
    });
    nativeClient.on("disconnected", function (info) {
        state.nativeConnected = false;
        state.nativeFullyReady = false;
        var rcCfg      = (_readE2EEConfig().reconnect) || {};
        var nativeDelay = (typeof rcCfg.nativeDelay === "number" && rcCfg.nativeDelay > 0) ? rcCfg.nativeDelay : 5000;
        var maxAtt      = (typeof rcCfg.maxAttempts  === "number" && rcCfg.maxAttempts  > 0) ? rcCfg.maxAttempts  : 3;
        logger.warn("E2EE", "Native bridge disconnected — reconnecting in " + (nativeDelay / 1000) + "s…");
        _callUserCallback(globalCallback, null, { type: "e2ee_disconnected", isE2EE: true, data: info || null });
        var nativeAttempt = 0;
        function _tryNativeReconnect() {
            if (state.nativeConnecting || state.nativeConnected) return;
            nativeAttempt++;
            setTimeout(function () {
                if (state.nativeConnecting || state.nativeConnected) return;
                state.nativeConnecting = true;
                nativeClient.connect()
                    .then(function () {
                        state.nativeConnected  = true;
                        state.nativeConnecting = false;
                        logger.success("E2EE", "Native bridge reconnected (attempt " + nativeAttempt + ").");
                    })
                    .catch(function (e) {
                        state.nativeConnecting = false;
                        logger.error("E2EE",
                            "Native reconnect attempt " + nativeAttempt + " failed: " +
                            (e && e.message ? e.message : e));
                        if (nativeAttempt < maxAtt) _tryNativeReconnect();
                        else logger.error("E2EE", "Native bridge gave up after " + maxAtt + " attempts.");
                    });
            }, nativeDelay);
        }
        _tryNativeReconnect();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  E2EEBridge CLASS  –  unified public API
// ─────────────────────────────────────────────────────────────────────────────

class E2EEBridge {
    constructor(ctx, api, defaultFuncs) {
        this.ctx          = ctx;
        this.api          = api;
        this.defaultFuncs = defaultFuncs || null;

        // Primary engine (fb-e2ee.cjs)
        this.client    = null;
        this.connected = false;

        // Native fallback engine (lib/index.mjs)
        this._nativeClient = null;
        this._nativeState  = { nativeConnected: false, nativeConnecting: false, nativeFullyReady: false, listenerAttached: false };
        this._useFallback  = false;

        this._messageCallback   = null;
        this._reconnectDisabled = false;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    ensureConnected() {
        if (!this.connected && !(this._useFallback && this._nativeState.nativeConnected)) {
            throw new Error("E2EE not connected. Call api.connectE2EE() first.");
        }
    }

    isConnected() {
        return this.connected || (this._useFallback && !!this._nativeState.nativeConnected);
    }

    onMessage(callback) {
        this._messageCallback = callback;
    }

    // ── public connect ────────────────────────────────────────────────────────

    async connect(deviceStorePath, userId) {
        // Idempotency — if already connected on either engine, return immediately
        if (this.connected || this._nativeState.nativeConnected) {
            logger.info("E2EE", "connect() called but E2EE is already connected — skipping.");
            return this;
        }

        var e2eeCfg = _readE2EEConfig();

        // Honour config.json e2ee.enable: true  OR  globalOptions.enableE2EE
        if (e2eeCfg.enable !== true &&
            !(this.ctx.globalOptions && this.ctx.globalOptions.enableE2EE === true)) {
            logger.warn("E2EE", "E2EE skipped — set e2ee.enable: true in config.json to activate.");
            return this;
        }

        userId = userId || this.ctx.userID;
        if (!deviceStorePath) {
            deviceStorePath = path.join(process.cwd(), ".shadowx-fca", "e2ee_device.json");
        }
        try { fs.mkdirSync(path.dirname(deviceStorePath), { recursive: true }); } catch (_) {}

        logger.info("E2EE", "Connecting E2EE — trying primary engine (Signal Protocol)…");

        try {
            await this._connectPrimary(deviceStorePath, userId);
            logger.success("E2EE", "E2EE connected ✅  [primary — Signal Protocol / Noise WebSocket]");
            this.ctx.globalOptions = this.ctx.globalOptions || {};
            this.ctx.globalOptions.enableE2EE = true;
            patchApiForE2EE(this.api, this.ctx);
            return this;
        } catch (primaryErr) {
            logger.warn("E2EE",
                "Primary engine failed (" +
                (primaryErr && primaryErr.message ? primaryErr.message : String(primaryErr)) +
                ") — switching to native binary fallback…");
        }

        try {
            await this._connectNativeFallback(e2eeCfg);
            logger.success("E2EE", "E2EE connected ✅  [fallback — native binary lib/index.mjs]");
            this.ctx.globalOptions = this.ctx.globalOptions || {};
            this.ctx.globalOptions.enableE2EE = true;
            patchApiForE2EE(this.api, this.ctx);
            return this;
        } catch (fallbackErr) {
            var msg = fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr);
            logger.error("E2EE", "Both E2EE engines failed. Last error: " + msg);
            throw new Error("SHADOWX-FCA E2EE: both primary and fallback engines failed. " + msg);
        }
    }

    // ── primary engine (fb-e2ee.cjs + Signal Protocol) ───────────────────────

    async _connectPrimary(deviceStorePath, userId) {
        var FBClient = _loadFBClient();
        var appState = this.api.getAppState();

        this.client = new FBClient({ appState, platform: "facebook" });

        var _ctx    = this.ctx;
        var _api    = this.api;
        var _dFuncs = this.defaultFuncs;

        var _adapter = {
            fb_dtsg:             _ctx.fb_dtsg,
            getCurrentUserID:    function () { return _api.getCurrentUserID(); },
            getAppState:         function () { return _api.getAppState(); },
            httpPost: async function (url, form) {
                var merged = Object.assign({}, form);
                if (!merged.fb_dtsg && _ctx.fb_dtsg) merged.fb_dtsg = _ctx.fb_dtsg;
                if (!merged.__user) merged.__user = _ctx.userID;
                var res = _dFuncs
                    ? await _dFuncs.post(url, _ctx.jar, merged)
                    : await new Promise(function (resolve, reject) {
                        require("request")(
                            { method: "POST", url: url, jar: _ctx.jar, form: merged, gzip: true },
                            function (err, r) { if (err) return reject(err); resolve(r); }
                        );
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
            listenMqtt:          function () { return; },
            stopListenMqtt:      function () {},
            setOptions:          function () {},
            sendMessage:         function (msg, tid, cb, replyTo) { return _api.sendMessage(msg, tid, cb, replyTo); },
            setMessageReaction:  function (r, mid, cb, f) { if (typeof _api.setMessageReaction === "function") return _api.setMessageReaction(r, mid, cb, f); },
            unsendMessage:       function (mid, cb) { if (typeof _api.unsendMessage === "function") return _api.unsendMessage(mid, cb); },
            sendTypingIndicator: function (t, tid, cb) { if (typeof _api.sendTypingIndicator === "function") return _api.sendTypingIndicator(t, tid, cb); },
            markAsRead:          function (tid, r, cb) { if (typeof _api.markAsRead === "function") return _api.markAsRead(tid, r, cb); },
            muteThread:          function (tid, s, cb) { if (typeof _api.muteThread === "function") return _api.muteThread(tid, s, cb); },
            setTitle:            function (t, tid, cb) { if (typeof _api.setTitle === "function") return _api.setTitle(t, tid, cb); },
            changeGroupImage:    function (img, tid, cb) { if (typeof _api.changeGroupImage === "function") return _api.changeGroupImage(img, tid, cb); },
        };

        global._fcanxE2EEAdapter = _adapter;
        var resolvedUserId;
        try {
            var result = await this.client.connect();
            resolvedUserId = result && result.userId;
        } finally {
            delete global._fcanxE2EEAdapter;
        }

        if (this.client.controller) {
            this.client.controller.api = _adapter;
        }

        logger.info("E2EE", "Opening Noise WebSocket…");
        var _devicePath = deviceStorePath;
        var _userId     = resolvedUserId || userId;
        await this.client.connectE2EE(_devicePath, _userId);

        // ── Auto-reconnect: configurable delay/retry/maxAttempts → fallback ────
        var _self = this;
        this.client.onEvent("disconnected", function _onDisconnect() {
            if (_self._reconnectDisabled || !_self.connected) return;
            var rcCfg  = (_readE2EEConfig().reconnect) || {};
            var delay1 = (typeof rcCfg.delay      === "number" && rcCfg.delay      > 0) ? rcCfg.delay      : 5000;
            var delay2 = (typeof rcCfg.retryDelay === "number" && rcCfg.retryDelay > 0) ? rcCfg.retryDelay : 10000;
            var maxAtt = (typeof rcCfg.maxAttempts === "number" && rcCfg.maxAttempts > 0) ? rcCfg.maxAttempts : 3;
            var attempt = 0;

            function _tryReconnect() {
                if (_self._reconnectDisabled || !_self.connected) return;
                attempt++;
                var isLast = attempt >= maxAtt;
                var nextDelay = attempt === 1 ? delay1 : delay2;
                logger.warn("E2EE",
                    "Noise WebSocket disconnected — reconnecting in " + (nextDelay / 1000) + "s… " +
                    "(attempt " + attempt + "/" + maxAtt + ")");
                setTimeout(async function () {
                    if (_self._reconnectDisabled || !_self.connected) return;
                    try {
                        await _self.client.connectE2EE(_devicePath, _userId);
                        logger.success("E2EE", "Primary E2EE reconnected (attempt " + attempt + ").");
                    } catch (err) {
                        logger.error("E2EE",
                            "Primary reconnect attempt " + attempt + " failed: " +
                            (err && err.message ? err.message : err));
                        if (!isLast) {
                            _tryReconnect();
                        } else {
                            logger.error("E2EE", "All " + maxAtt + " reconnect attempts failed — switching to native fallback.");
                            _self.connected = false;
                            _self._connectNativeFallback(_readE2EEConfig()).catch(function (e3) {
                                logger.error("E2EE", "Fallback after disconnect also failed: " + (e3 && e3.message ? e3.message : e3));
                            });
                        }
                    }
                }, nextDelay);
            }
            _tryReconnect();
        });

        // ── Forward e2ee_message events from primary ──────────────────────────
        var _selfCtx = this.ctx;
        var _selfCb  = this;
        this.client.onEvent("e2ee_message", function (msg) {
            if (!_selfCb._messageCallback) return;

            var senderID = msg.senderId ||
                (typeof msg.senderJid === "string" ? msg.senderJid.split(".")[0] : "");
            var mentions = {};
            if (Array.isArray(msg.mentions)) {
                msg.mentions.forEach(function (m) {
                    if (m && m.id) mentions[m.id] = m.text || "@" + m.id;
                });
            } else if (msg.mentions && typeof msg.mentions === "object") {
                mentions = msg.mentions;
            }
            var isReply = !!(msg.replyTo && msg.replyTo.messageId);
            var event = {
                type        : isReply ? "message_reply" : "message",
                senderID    : senderID,
                threadID    : msg.threadId,
                body        : msg.text || "",
                isE2EE      : true,
                isGroup     : !!msg.isGroup,
                timestamp   : msg.timestampMs || Date.now(),
                messageID   : msg.id || "",
                attachments : [],
                mentions    : mentions,
                args        : (msg.text || "").trim().split(/\s+/).filter(Boolean),
            };
            if (!event.isGroup && msg.threadId) {
                _selfCtx.threadTypes = _selfCtx.threadTypes || {};
                _selfCtx.threadTypes[String(msg.threadId)] = "dm";
            }
            if (isReply) {
                event.messageReply = {
                    messageID  : msg.replyTo.messageId,
                    senderID   : msg.replyTo.senderId || "",
                    threadID   : msg.threadId,
                    body       : msg.replyTo.text || "",
                    args       : (msg.replyTo.text || "").trim().split(/\s+/).filter(Boolean),
                    isE2EE     : true,
                    isGroup    : !!msg.isGroup,
                    mentions   : {},
                    attachments: []
                };
            }
            _selfCb._messageCallback(null, event);
        });

        this.client.onEvent("error", function (err) {
            if (err && (err.code === 1 || (err.message && err.message.includes("old counter")))) return;
            logger.error("E2EE", "Primary error: " + (err && err.message ? err.message : String(err)));
        });

        this.connected    = true;
        this._useFallback = false;
    }

    // ── native fallback engine (lib/index.mjs + koffi) ───────────────────────

    async _connectNativeFallback(e2eeCfg) {
        var NativeClient = await _loadNativeClient();
        var cookies      = _cookiesFromJar(this.ctx);

        if (!cookies.c_user || !cookies.xs) {
            throw new Error("Cannot start native E2EE: c_user/xs cookies missing");
        }

        var saveType = e2eeCfg.saveType || (e2eeCfg.memoryOnly === false ? "path" : "memory");
        var opts = {
            enableE2EE:     true,
            e2eeMemoryOnly: saveType !== "path",
            autoReconnect:  e2eeCfg.autoReconnect !== false,
            logLevel:       e2eeCfg.logLevel || "none",
        };
        if (saveType === "path" && e2eeCfg.devicePath) opts.devicePath = e2eeCfg.devicePath;
        if (this.ctx.globalOptions && this.ctx.globalOptions.e2eeDeviceData)
            opts.deviceData = this.ctx.globalOptions.e2eeDeviceData;
        if (!opts.deviceData && global._pendingE2eeDeviceData) {
            opts.deviceData = global._pendingE2eeDeviceData;
            delete global._pendingE2eeDeviceData;
        }

        this._nativeClient = new NativeClient(cookies, opts);
        this._nativeState  = {
            nativeConnected: false, nativeConnecting: false,
            nativeFullyReady: false, listenerAttached: false,
            lastReadyPayload: null
        };

        var _self = this;
        _attachNativeEvents(
            this._nativeClient,
            this._nativeState,
            function (err, ev) { if (typeof _self._messageCallback === "function") _self._messageCallback(err, ev); },
            this.ctx
        );

        await this._nativeClient.connect();
        this._nativeState.nativeConnected = true;
        this._useFallback = true;
        this.connected    = false; // primary not active
    }

    // ── ensure native client connected (lazy reconnect for send ops) ──────────

    async _ensureNativeClient() {
        if (this._nativeState.nativeConnected && this._nativeClient) return this._nativeClient;
        if (this._nativeState.nativeConnecting) {
            // wait for in-progress connect
            return new Promise(function (resolve, reject) {
                var t = setTimeout(function () { reject(new Error("E2EE native connect timeout")); }, 15000);
                var iv = setInterval(function () {
                    if (this._nativeState.nativeConnected && this._nativeClient) {
                        clearInterval(iv); clearTimeout(t); resolve(this._nativeClient);
                    }
                }.bind(this), 200);
            }.bind(this));
        }
        // Not connecting — try to reconnect
        await this._nativeClient.connect();
        this._nativeState.nativeConnected = true;
        return this._nativeClient;
    }

    // ── disconnect ────────────────────────────────────────────────────────────

    async disconnect() {
        this._reconnectDisabled = true;
        if (this.client) {
            try { await this.client.disconnect(); } catch (_) {}
        }
        if (this._nativeClient) {
            try { await this._nativeClient.disconnect(); } catch (_) {}
        }
        this.connected = false;
        this._nativeState.nativeConnected = false;
        logger.info("E2EE", "E2EE disconnected.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // § 6  SEND API — routes to whichever engine is active
    // ─────────────────────────────────────────────────────────────────────────

    async sendMessage(threadId, msg, replyToMessageId) {
        var text       = typeof msg === "string" ? msg : (msg && msg.body != null ? String(msg.body) : "");
        var attachment = (msg && typeof msg === "object") ? (msg.attachment || null) : null;

        // ── Native fallback path ──────────────────────────────────────────────
        if (this._useFallback && this._nativeClient) {
            var client = await this._ensureNativeClient();
            if (!attachment) {
                return client.sendE2EEMessage(threadId, text, { replyToId: replyToMessageId });
            }
            // Attachment via native sendMedia
            var list    = Array.isArray(attachment) ? attachment : [attachment];
            var results = [];
            for (var i = 0; i < list.length; i++) {
                var stream   = list[i];
                var buf      = await _streamToBuffer(stream);
                var fileName = stream.path ? require("path").basename(String(stream.path)) : "file.bin";
                var mimeType = _guessMime(fileName);
                try { mimeType = require("mime").getType(fileName) || mimeType; } catch (_) {}
                results.push(await this.sendMedia(threadId, _mimeToNativeType(mimeType), buf, {
                    mimeType: mimeType, caption: text, replyToId: replyToMessageId, filename: fileName
                }));
            }
            return results.length === 1 ? results[0] : results;
        }

        // ── Primary engine path ───────────────────────────────────────────────
        this.ensureConnected();

        if (!attachment) {
            return this.client.sendMessage({ threadId, text, replyToMessageId });
        }

        var pathMod  = require("path");
        var mimeLib;
        try { mimeLib = require("mime"); } catch (_) {}

        var list2    = Array.isArray(attachment) ? attachment : [attachment];
        var results2 = [];
        for (var j = 0; j < list2.length; j++) {
            var s        = list2[j];
            var data     = await _streamToBuffer(s);
            var fn       = (s.path ? pathMod.basename(String(s.path)) : "file.bin");
            var mt       = (mimeLib && mimeLib.getType(fn)) || _guessMime(fn);
            var inp      = { threadId, data, fileName: fn, mimeType: mt, caption: text || undefined, replyToMessageId };
            var r;
            if (mt.startsWith("image/"))      r = await this.client.sendImage(inp);
            else if (mt.startsWith("video/")) r = await this.client.sendVideo(inp);
            else if (mt.startsWith("audio/")) r = await this.client.sendAudio(inp);
            else                              r = await this.client.sendFile(inp);
            results2.push(r);
        }
        return results2.length === 1 ? results2[0] : results2;
    }

    async sendReaction(threadId, messageId, reaction, senderJid) {
        if (this._useFallback && this._nativeClient) {
            var client = await this._ensureNativeClient();
            return client.sendE2EEReaction(threadId, messageId, senderJid, reaction);
        }
        this.ensureConnected();
        return this.client.sendReaction({ threadId, messageId, reaction, senderJid });
    }

    async sendTyping(threadId, isTyping) {
        if (this._useFallback && this._nativeClient) {
            var client = await this._ensureNativeClient();
            return client.sendE2EETyping(threadId, isTyping !== false);
        }
        this.ensureConnected();
        return this.client.sendTyping({ threadId, isTyping: isTyping !== false });
    }

    async unsendMessage(messageId, threadId) {
        if (this._useFallback && this._nativeClient) {
            var client = await this._ensureNativeClient();
            return client.unsendE2EEMessage(threadId, messageId);
        }
        this.ensureConnected();
        return this.client.unsendMessage({ messageId, threadId });
    }

    async editMessage(threadId, messageId, newText) {
        if (this._useFallback && this._nativeClient) {
            var client = await this._ensureNativeClient();
            return client.editE2EEMessage(threadId, messageId, newText);
        }
        this.ensureConnected();
        return this.client.editMessage({ threadId, messageId, newText });
    }

    /**
     * sendMedia — full media send (native fallback only; primary uses sendMessage)
     * @param {string} jid       – E2EE thread JID
     * @param {string} mediaType – "image"|"video"|"audio"|"voice"|"file"|"document"|"sticker"
     * @param {Buffer|Array|string} data  – media bytes
     * @param {object} opts      – { mimeType, caption, filename, duration, width, height, ptt, replyToId, replyToSenderJid }
     */
    async sendMedia(jid, mediaType, data, opts) {
        if (!this._useFallback || !this._nativeClient)
            throw new Error("sendMedia is only available on the native fallback engine");
        var client = await this._ensureNativeClient();
        var buf    = _normalizeMediaInput(data);
        var o      = opts || {};
        var ntype  = String(mediaType || "").toLowerCase();
        switch (ntype) {
            case "image":
                return client.sendE2EEImage(jid, buf, o.mimeType || "image/jpeg",
                    { caption: o.caption || "", width: o.width, height: o.height,
                      replyToId: o.replyToId, replyToSenderJid: o.replyToSenderJid });
            case "video":
                return client.sendE2EEVideo(jid, buf, o.mimeType || "video/mp4",
                    { caption: o.caption || "", duration: o.duration,
                      width: o.width, height: o.height,
                      replyToId: o.replyToId, replyToSenderJid: o.replyToSenderJid });
            case "audio": case "voice": {
                var mime    = o.mimeType || "audio/ogg; codecs=opus";
                var isVoice = ntype === "voice" || !!o.ptt;
                return client.sendE2EEAudio(jid, buf, mime,
                    { ptt: isVoice, duration: o.duration != null ? Number(o.duration) : undefined,
                      replyToId: o.replyToId, replyToSenderJid: o.replyToSenderJid });
            }
            case "file": case "document":
                return client.sendE2EEDocument(jid, buf, o.filename || "file.bin",
                    o.mimeType || "application/octet-stream",
                    { replyToId: o.replyToId, replyToSenderJid: o.replyToSenderJid });
            case "sticker":
                return client.sendE2EESticker(jid, buf, o.mimeType || "image/webp",
                    { replyToId: o.replyToId, replyToSenderJid: o.replyToSenderJid });
            default:
                throw new Error("Unsupported E2EE mediaType: " + ntype);
        }
    }

    /**
     * downloadMedia — decrypt and download an E2EE attachment (native fallback only)
     * Returns: { data: Buffer, mimeType: string, fileSize: number }
     */
    async downloadMedia(opts) {
        if (!this._useFallback || !this._nativeClient)
            throw new Error("downloadMedia is only available on the native fallback engine");
        var client = await this._ensureNativeClient();
        var size   = opts.fileSize != null ? Number(opts.fileSize) : undefined;
        var res = await client.downloadE2EEMedia({
            directPath    : opts.directPath,
            mediaKey      : opts.mediaKey,
            mediaSha256   : opts.mediaSha256,
            mediaEncSha256: opts.mediaEncSha256,
            mediaType     : opts.mediaType,
            mimeType      : opts.mimeType,
            fileSize      : size
        });
        return { data: res.data, mimeType: res.mimeType, fileSize: Number(res.fileSize) };
    }

    /** Retrieve stored device data (native fallback only) */
    async getDeviceData() {
        if (!this._nativeClient) return null;
        var client = await this._ensureNativeClient();
        if (typeof client.getDeviceData === "function") return client.getDeviceData();
        return this.ctx._e2eeDeviceData || null;
    }

    getPublicKeys() {
        return {
            info  : "Keys managed by SHADOWX-FCA E2EE engine.",
            engine: this._useFallback ? "native binary (lib/index.mjs)" : "vendor (fb-e2ee.cjs / Signal Protocol)",
            dev   : "Dev by Mueid Mursalin Rifat",
            note  : "Identity + device keys are stored in the device-store file. Do NOT delete it.",
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7  patchApiForE2EE  –  adds E2EE helper methods onto the api object
//     Call once after buildAPI() when E2EE is enabled.
// ─────────────────────────────────────────────────────────────────────────────
function patchApiForE2EE(api, ctx) {
    // api.downloadE2EEMedia — decrypt and return raw bytes
    if (typeof api.downloadE2EEMedia !== "function") {
        api.downloadE2EEMedia = function (options) {
            if (!api.e2ee) throw new Error("E2EE not initialised");
            return api.e2ee.downloadMedia(options);
        };
    }

    // api.resolveE2EEAttachment — decrypt and store locally, returns att with url
    if (typeof api.resolveE2EEAttachment !== "function") {
        api.resolveE2EEAttachment = async function (att) {
            if (!att || !att.isE2EE) return att;
            if (att.url && /^https?:\/\//.test(att.url)) return att;
            if (!att.directPath || !att.mediaKey || !att.mediaSha256 || !att.mimeType) return att;
            try {
                var rawType = att.type === "photo" ? "image" : (att.type || "image");
                var res = await api.downloadE2EEMedia({
                    directPath    : att.directPath,
                    mediaKey      : att.mediaKey,
                    mediaSha256   : att.mediaSha256,
                    mediaEncSha256: att.mediaEncSha256 || undefined,
                    mediaType     : rawType,
                    mimeType      : att.mimeType,
                    fileSize      : Number(att.fileSize)
                });
                var localUrl = await storeMedia(res.data, res.mimeType || att.mimeType);
                return Object.assign({}, att, { url: localUrl });
            } catch (e) {
                logger.error("E2EE", "resolveE2EEAttachment failed: " + (e && e.message ? e.message : String(e)));
                return att;
            }
        };
    }

    // api.sendTypingE2EE
    if (typeof api.sendTypingE2EE !== "function") {
        api.sendTypingE2EE = function (chatJid, isTyping) {
            if (!isE2EEChatJid(chatJid)) return Promise.resolve();
            if (!api.e2ee) return Promise.resolve();
            return api.e2ee.sendTyping(chatJid, isTyping !== false).catch(function () {});
        };
    }

    // api.getE2EEDeviceData — retrieve device data (for persistence)
    if (typeof api.getE2EEDeviceData !== "function") {
        api.getE2EEDeviceData = function () {
            if (!api.e2ee) return Promise.resolve(null);
            if (typeof api.e2ee.getDeviceData === "function") return api.e2ee.getDeviceData();
            return Promise.resolve(ctx._e2eeDeviceData || null);
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    E2EEBridge,
    isE2EEChatJid,
    storeMedia,
    patchApiForE2EE
};

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _streamToBuffer(stream) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        stream.on("data",  function (c) { chunks.push(c); });
        stream.on("end",   function ()  { resolve(Buffer.concat(chunks)); });
        stream.on("error", reject);
    });
}

var _EXT_MIME = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    mkv: "video/x-matroska", webm: "video/webm",
    mp3: "audio/mpeg", ogg: "audio/ogg; codecs=opus", oga: "audio/ogg; codecs=opus",
    opus: "audio/ogg; codecs=opus", wav: "audio/wav", m4a: "audio/mp4",
    aac: "audio/aac", flac: "audio/flac",
    pdf: "application/pdf", txt: "text/plain", json: "application/json"
};

function _guessMime(fileName) {
    var ext = (fileName || "").split(".").pop().toLowerCase();
    return _EXT_MIME[ext] || "application/octet-stream";
}

function _mimeToNativeType(mime) {
    if (!mime) return "file";
    if (mime.startsWith("image/"))  return "image";
    if (mime.startsWith("video/"))  return "video";
    if (mime.startsWith("audio/"))  return "audio";
    return "file";
}
