"use strict";

const utils = require("../../utils/sifuShim");

const _cache    = new Map();
const CACHE_TTL = 6 * 60 * 1000; 

const THEME_ID_RE  = /^\d{10,}$/;
const THREAD_ID_RE = /^\d{7,}$/;

function defaultThemeInfo(identifier, extras) {
  return Object.assign({
    threadID:       identifier,
    threadName:     '',
    participantCount: 0,
    isGroup:        null,
    color:          null,
    emoji:          '👍',
    theme_id:       null,
    theme_color:    null,
    gradient_colors: null,
    backgroundImage: null,
    is_dark:        null,
    is_default:     true,
  }, extras || {});
}

module.exports = function (defaultFuncs, api, ctx) {

  

  return async function getThemeInfo(identifier, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    if (!identifier) {
      const err = new Error("getThemeInfo: identifier is required (threadID or themeID)");
      if (callback) return callback(err);
      throw err;
    }

    let resolveFunc, rejectFunc;
    const promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });

    function done(err, data) {
      if (callback) return err ? callback(err) : callback(null, data);
      if (err) rejectFunc(err); else resolveFunc(data);
    }

    const id       = identifier.toString().trim();
    const cacheKey = `themeinfo::${id}`;

    if (options.useCache !== false) {
      const hit = _cache.get(cacheKey);
      if (hit && Date.now() - hit.ts < CACHE_TTL) {
        done(null, hit.data);
        return promise;
      }
    }

    
    if (THEME_ID_RE.test(id) && api.fetchThemeData) {
      try {
        const themeData = await api.fetchThemeData(id, { useCache: options.useCache !== false });
        const result = Object.assign({ _type: 'theme' }, themeData);
        if (options.useCache !== false) _cache.set(cacheKey, { data: result, ts: Date.now() });
        done(null, result);
      } catch (themeErr) {
        
        utils.warn("getThemeInfo", `Theme fetch failed for ${id}: ${themeErr.message} — trying as thread`);
        await resolveAsThread(id, options, done, cacheKey);
      }
      return promise;
    }

    
    await resolveAsThread(id, options, done, cacheKey);
    return promise;

    async function resolveAsThread(tid, opts, finish, ck) {
      let threadInfo = null;
      try {
        threadInfo = await api.getThreadInfo(tid);
      } catch (tiErr) {
        utils.warn("getThemeInfo", `getThreadInfo failed: ${tiErr.message}`);
        const fallback = defaultThemeInfo(tid, { error: tiErr.message || 'Could not retrieve thread info' });
        if (opts.useCache !== false) _cache.set(ck, { data: fallback, ts: Date.now() });
        finish(null, fallback);
        return;
      }

      if (!threadInfo) {
        const fallback = defaultThemeInfo(tid);
        if (opts.useCache !== false) _cache.set(ck, { data: fallback, ts: Date.now() });
        finish(null, fallback);
        return;
      }

      const info = Array.isArray(threadInfo) ? threadInfo[0] : threadInfo;

      const base = {
        _type:            'thread',
        threadID:         tid,
        threadName:       info.threadName || info.name || '',
        participantCount: info.participantIDs?.length || 0,
        isGroup:          info.isGroup || false,
        color:            info.color || null,
        emoji:            info.emoji || '👍',
        theme_id:         info.theme_id || info.themeID || null,
        theme_color:      info.theme_color || info.color || null,
        gradient_colors:  info.gradient_colors || null,
        backgroundImage:  info.backgroundImage || null,
        is_dark:          null,
        is_default:       !info.color && !info.theme_id,
        muteUntil:        info.muteUntil || null,
        unreadCount:      info.unreadCount || 0,
      };

      
      if (opts.fetchActiveTheme !== false && base.theme_id && api.fetchThemeData) {
        try {
          const activeTheme = await api.fetchThemeData(base.theme_id, { useCache: true });
          Object.assign(base, {
            active_theme:   activeTheme,
            gradient_colors: activeTheme.gradient_colors || base.gradient_colors,
            backgroundImage: activeTheme.backgroundImage || base.backgroundImage,
            is_dark:         activeTheme.is_dark,
            theme_color:     activeTheme.primary_color || base.theme_color,
          });
        } catch (_) {}
      }

      if (opts.useCache !== false) _cache.set(ck, { data: base, ts: Date.now() });
      finish(null, base);
    }
  };
};
