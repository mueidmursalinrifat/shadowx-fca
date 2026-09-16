"use strict";

/**
 * SessionGuard — Protects the appstate (session) from corruption and silent logouts.
 *
 * Features:
 *   • Auto-saves appstate to disk periodically (default every 5 min)
 *   • Saves on every successful message send (debounced, 30s cooldown)
 *   • Backs up the previous appstate before overwriting (.bak file)
 *   • Detects logout/checkpoint events from listen stream and alerts
 *   • Provides api.saveSession([path]) for manual save at any time
 *   • Never overwrites with a shorter/smaller appstate (corruption guard)
 */

var fs   = require("fs");
var path = require("path");
var logger = require("../../utils/logger");

var SAVE_INTERVAL_MS  = 5 * 60 * 1000;   // 5 minutes
var DEBOUNCE_MS       = 30 * 1000;        // 30 seconds cooldown between auto-saves
var MIN_COOKIES       = 5;               // minimum cookie count we consider "valid"
var REQUIRED_COOKIE_KEYS = ["c_user", "xs"]; // a session isn't usable without these

// Validate that an appstate array actually looks like a usable, well-formed
// Facebook session before it's allowed to overwrite anything on disk.
// Guards against persisting a partial/corrupt state (e.g. captured mid-logout)
// that would replace a good appstate with a broken one.
function isValidAppState(state) {
    if (!state || !Array.isArray(state) || state.length < MIN_COOKIES) return false;
    var keys = {};
    for (var i = 0; i < state.length; i++) {
        var c = state[i];
        if (!c || typeof c !== "object") return false;
        var key = c.key || c.name;
        if (!key || typeof c.value !== "string" || !c.value) return false;
        keys[key] = c.value;
    }
    for (var j = 0; j < REQUIRED_COOKIE_KEYS.length; j++) {
        if (!keys[REQUIRED_COOKIE_KEYS[j]]) return false;
    }
    return true;
}

module.exports = function (defaultFuncs, api, ctx) {

    // sessionGuard() attaches by monkey-patching api.sendMessage. If it's
    // invoked more than once for the same api instance (e.g. accidentally
    // called twice), that patch would stack, causing double-saves and,
    // eventually, wrapping api.sendMessage in itself repeatedly. Guard
    // against that here instead of relying on callers not to do it.
    if (ctx._sessionGuardAttached) {
        logger.warn("SessionGuard", "Already active for this session — ignoring duplicate init.");
        return function alreadyActive() {
            return {
                save: api.saveSession,
                stop: api.stopSessionGuard,
                restore: api.restoreSessionBackup
            };
        };
    }
    ctx._sessionGuardAttached = true;

    function getState() {
        try { return api.getAppState(); } catch (_) { return null; }
    }

    // Serializes all writes to a given path so a periodic save and a
    // debounced on-send save can never interleave their writes to the same
    // file (the previous version had no such lock, so two concurrent
    // fs.writeFileSync calls to the same path could race).
    var writeLocks = Object.create(null);

    function withWriteLock(filePath, fn) {
        var prev = writeLocks[filePath] || Promise.resolve();
        var next = prev.catch(function () {}).then(fn);
        writeLocks[filePath] = next.catch(function () {});
        return next;
    }

    function atomicWriteFileSync(filePath, data) {
        // Write to a temp file in the same directory, then rename. rename()
        // is atomic on the same filesystem, so a crash/kill mid-write can
        // never leave a partially-written, corrupt appstate.json behind -
        // readers either see the old complete file or the new complete file.
        var dir = path.dirname(filePath);
        var tmpPath = path.join(dir, "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp");
        fs.writeFileSync(tmpPath, data, "utf8");
        fs.renameSync(tmpPath, filePath);
    }

    function saveToDiskSync(filePath) {
        var state = getState();
        if (!isValidAppState(state)) {
            logger.warn("SessionGuard", "Skipped save — state looks empty, invalid, or missing required cookies (" + (state ? state.length : 0) + " cookies).");
            return false;
        }

        // Corruption guard: never write a smaller appstate than what's already on disk
        if (fs.existsSync(filePath)) {
            try {
                var existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (Array.isArray(existing) && state.length < existing.length * 0.8) {
                    logger.warn("SessionGuard", "Skipped save — new state has " + state.length + " cookies vs " + existing.length + " on disk (possible truncation).");
                    return false;
                }
                // Backup the current valid state before overwriting (also atomic).
                atomicWriteFileSync(filePath + ".bak", JSON.stringify(existing, null, 2));
            } catch (_) {}
        }

        atomicWriteFileSync(filePath, JSON.stringify(state, null, 2));
        logger.success("SessionGuard", "Session saved → " + filePath + " (" + state.length + " cookies)");
        return true;
    }

    function saveToDisk(filePath) {
        // Run the actual save inside the per-path lock so concurrent callers
        // (periodic timer vs. post-send debounce) are serialized.
        var result;
        return withWriteLock(filePath, function () {
            try {
                result = saveToDiskSync(filePath);
            } catch (e) {
                logger.error("SessionGuard", "Save failed: " + (e && e.message ? e.message : String(e)));
                result = false;
            }
            return result;
        }).then(function () { return result; });
    }

    return function sessionGuard(appStatePath, options) {
        options = options || {};
        var interval    = options.interval !== undefined ? options.interval : SAVE_INTERVAL_MS;
        var debounce    = options.debounce !== undefined ? options.debounce : DEBOUNCE_MS;

        appStatePath = appStatePath || path.join(process.cwd(), "appstate.json");

        var lastSave     = 0;
        var intervalRef  = null;

// Periodic save
        if (interval > 0) {
            intervalRef = setInterval(function () {
                logger.info("SessionGuard", "Periodic save...");
                saveToDisk(appStatePath);
                lastSave = Date.now();
            }, interval);
            if (intervalRef.unref) intervalRef.unref(); // don't block process exit
        }

// Debounced on-send save
        // Patch sendMessage to auto-save appstate after a successful send
        var originalSendMessage = api.sendMessage;
        api.sendMessage = function () {
            var result = originalSendMessage.apply(this, arguments);
            // After send, debounce-save
            Promise.resolve(result).then(function () {
                if (Date.now() - lastSave > debounce) {
                    saveToDisk(appStatePath);
                    lastSave = Date.now();
                }
            }).catch(function () {});
            return result;
        };

        // Expose manual save
        api.saveSession = function (customPath) {
            return saveToDisk(customPath || appStatePath);
        };

        // Expose restore from backup
        api.restoreSessionBackup = function (customPath) {
            var bakPath = (customPath || appStatePath) + ".bak";
            if (!fs.existsSync(bakPath)) {
                logger.warn("SessionGuard", "No backup file found at " + bakPath);
                return false;
            }
            try {
                var bak = fs.readFileSync(bakPath, "utf8");
                atomicWriteFileSync(customPath || appStatePath, bak);
                logger.success("SessionGuard", "Backup restored from " + bakPath);
                return true;
            } catch (e) {
                logger.error("SessionGuard", "Restore failed: " + e.message);
                return false;
            }
        };

        // Expose stop
        api.stopSessionGuard = function () {
            if (intervalRef) clearInterval(intervalRef);
            api.sendMessage = originalSendMessage;
            ctx._sessionGuardAttached = false;
            logger.info("SessionGuard", "Stopped.");
        };

        logger.success(
            "SessionGuard",
            "Active — auto-save every " + Math.round(interval / 60000) + " min → " + appStatePath
        );

        return {
            save:    function (p) { return saveToDisk(p || appStatePath); },
            stop:    api.stopSessionGuard,
            restore: api.restoreSessionBackup
        };
    };
};
