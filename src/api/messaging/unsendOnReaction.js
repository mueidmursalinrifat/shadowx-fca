"use strict";

const utils = require("../../utils/sifuShim");

module.exports = function (defaultFuncs, api, ctx) {
    const state = {
        enabled: false,
        sentIds: new Map(), 
        opts: {
            triggers:    null,
            delay:       0,
            ignoreSelf:  true,
            maxTracked:  1000,
            trackTtlMs:  24 * 60 * 60 * 1000,
            onUnsend:    null,
            onError:     null,
        },
        originals: {
            sendMessage:     null,
            sendMessageMqtt: null,
            listenMqtt:      null,
        },
        cleanupTimer: null,
    };

   
    function trackMessage(messageID) {
        if (messageID == null) return;
        const id = String(messageID);
        if (state.sentIds.size >= state.opts.maxTracked && !state.sentIds.has(id)) {
            const oldest = state.sentIds.keys().next().value;
            if (oldest != null) state.sentIds.delete(oldest);
        }
        state.sentIds.set(id, Date.now());
    }

    function untrackMessage(messageID) {
        if (messageID == null) return;
        state.sentIds.delete(String(messageID));
    }

    function isTracked(messageID) {
        if (messageID == null) return false;
        const id = String(messageID);
        const ts = state.sentIds.get(id);
        if (!ts) return false;
        if (Date.now() - ts > state.opts.trackTtlMs) {
            state.sentIds.delete(id);
            return false;
        }
        return true;
    }

    function startCleanup() {
        if (state.cleanupTimer) return;
        state.cleanupTimer = setInterval(() => {
            const cutoff = Date.now() - state.opts.trackTtlMs;
            for (const [id, ts] of state.sentIds) {
                if (ts < cutoff) state.sentIds.delete(id);
            }
        }, 5 * 60 * 1000);
        if (state.cleanupTimer.unref) state.cleanupTimer.unref();
    }

    function stopCleanup() {
        if (state.cleanupTimer) clearInterval(state.cleanupTimer);
        state.cleanupTimer = null;
    }

    
    function wrapSendFunction(name) {
        if (typeof api[name] !== "function") return;
        if (state.originals[name]) return;

        const orig = api[name].bind(api);
        state.originals[name] = api[name];

        api[name] = function (...args) {
            let cbIndex = -1;
            for (let i = args.length - 1; i >= 0; i--) {
                if (typeof args[i] === "function") { cbIndex = i; break; }
            }
            const userCb = cbIndex >= 0 ? args[cbIndex] : null;

            const recordInfo = (info) => {
                if (info && info.messageID) trackMessage(info.messageID);
            };

            if (userCb) {
                args[cbIndex] = (err, info) => {
                    if (!err) recordInfo(info);
                    userCb(err, info);
                };
            }

            const result = orig(...args);

            if (result && typeof result.then === "function") {
                return result.then((info) => { recordInfo(info); return info; });
            }
            return result;
        };
    }

    function unwrapSend(name) {
        if (state.originals[name]) {
            api[name] = state.originals[name];
            state.originals[name] = null;
        }
    }

   
    function wrapListenMqtt() {
        if (typeof api.listenMqtt !== "function") return;
        if (state.originals.listenMqtt) return;

        const orig = api.listenMqtt.bind(api);
        state.originals.listenMqtt = api.listenMqtt;

        const wrapped = function (userCb) {
            return orig((err, event) => {
                if (!err && event && event.type === "message_reaction") {
                    handle(event).catch(() => {});
                }
                if (typeof userCb === "function") userCb(err, event);
            });
        };

        api.listenMqtt = wrapped;
        if (api.listen === state.originals.listenMqtt) api.listen = wrapped;
    }

    function unwrapListenMqtt() {
        if (state.originals.listenMqtt) {
            const orig = state.originals.listenMqtt;
            api.listenMqtt = orig;
            if (api.listen) api.listen = orig;
            state.originals.listenMqtt = null;
        }
    }

    
    async function handle(event) {
        if (!state.enabled) return false;
        if (!event || event.type !== "message_reaction") return false;
        if (state.opts.ignoreSelf && event.senderID === ctx.userID) return false;
        if (state.opts.triggers && state.opts.triggers.length > 0
            && !state.opts.triggers.includes(event.reaction)) return false;
        if (!isTracked(event.messageID)) return false;

        try {
            if (state.opts.delay > 0) {
                await new Promise((r) => setTimeout(r, state.opts.delay));
            }
            await api.unsendMessage(event.messageID);
            untrackMessage(event.messageID);

            if (typeof state.opts.onUnsend === "function") {
                try { state.opts.onUnsend(event); } catch (_) {}
            }
            return true;
        } catch (e) {
            if (typeof state.opts.onError === "function") {
                try { state.opts.onError(e, event); } catch (_) {}
            } else {
                utils.warn("fca-sifu", "unsendOnReaction failed:", e.message || e);
            }
            return false;
        }
    }

   
    function enable(opts = {}) {
        if (opts && typeof opts === "object") {
            for (const k of Object.keys(opts)) {
                if (k in state.opts) state.opts[k] = opts[k];
            }
        }
        if (state.opts.triggers != null && !Array.isArray(state.opts.triggers)) {
            state.opts.triggers = [state.opts.triggers];
        }

        if (!state.enabled) {
            wrapSendFunction("sendMessage");
            wrapSendFunction("sendMessageMqtt");
            wrapListenMqtt();
            startCleanup();
            state.enabled = true;
            utils.log("fca-sifu", "unsendOnReaction: enabled");
        } else {
            utils.log("fca-sifu", "unsendOnReaction: options updated");
        }
        return main;
    }

    function disable() {
        if (!state.enabled) return main;
        unwrapSend("sendMessage");
        unwrapSend("sendMessageMqtt");
        unwrapListenMqtt();
        stopCleanup();
        state.sentIds.clear();
        state.enabled = false;
        utils.log("fca-sifu", "unsendOnReaction: disabled");
        return main;
    }

    
    function main(opts) { return enable(opts); }

    main.enable           = enable;
    main.disable          = disable;
    main.handle           = handle;
    main.trackMessage     = trackMessage;
    main.untrackMessage   = untrackMessage;
    main.clearTracked     = () => state.sentIds.clear();
    main.getTrackedCount  = () => state.sentIds.size;
    main.isEnabled        = () => state.enabled;
    main.getOptions       = () => ({ ...state.opts });

    return main;
};
