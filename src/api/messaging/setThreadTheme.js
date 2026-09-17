"use strict";

const utils = require("../../utils/sifuShim");
const { globalShield } = require("../../utils/sifuShim");

const THEME_CACHE = new Map();
const THEME_CACHE_TTL = 10 * 60 * 1000;
const THEME_HISTORY = [];
const MAX_HISTORY = 200;

const COLOR_PALETTE = {
  blue: '196241301102133',
  purple: '370940413392601',
  green: '169463077092846',
  pink: '230032715012014',
  orange: '175615189761153',
  red: '2136751179887052',
  yellow: '2058653964378557',
  teal: '417639218648241',
  black: '539927563794799',
  white: '2873642392710980',
  default: '196241301102133'
};

async function retryOp(fn, retries = 4, base = 500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const transient = /network|timeout|ECONNRESET|ETIMEDOUT|5\d\d|429/i.test(String(err?.message || err));
      if (!transient) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 300));
    }
  }
}

async function fetchBootloader(defaultFuncs, ctx) {
  const now = Date.now();
  const params = new URLSearchParams({
    modules: 'LSUpdateThreadTheme,LSUpdateThreadCustomEmoji,LSUpdateThreadThemePayloadCacheKey',
    __aaid: 0,
    __user: ctx.userID,
    __a: 1,
    __req: utils.getSignatureID(),
    __hs: '20352.HYP:comet_pkg.2.1...0',
    dpr: 1,
    __ccg: 'EXCELLENT',
    __rev: '1027396270',
    __s: utils.getSignatureID(),
    fb_dtsg_ag: ctx.fb_dtsg,
    jazoest: ctx.jazoest,
    __spin_r: '1027396270',
    __spin_b: 'trunk',
    __spin_t: now
  });
  await defaultFuncs.get(`https://www.facebook.com/ajax/bootloader-endpoint/?${params}`, ctx.jar)
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs));
}

async function fetchAvailableThemes(defaultFuncs, ctx) {
  const cacheKey = 'available_themes';
  const cached = THEME_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < THEME_CACHE_TTL) return cached.data;

  const now = Date.now();
  const form = {
    av: ctx.userID,
    __user: ctx.userID,
    __a: 1,
    __req: utils.getSignatureID(),
    __hs: '20352.HYP:comet_pkg.2.1...0',
    dpr: 1,
    fb_dtsg: ctx.fb_dtsg,
    jazoest: ctx.jazoest,
    lsd: ctx.fb_dtsg,
    __spin_r: '1027396270',
    __spin_b: 'trunk',
    __spin_t: now,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'MWPThreadThemeQuery_AllThemesQuery',
    variables: JSON.stringify({ version: 'default' }),
    server_timestamps: true,
    doc_id: '24474714052117636'
  };

  const res = await defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form)
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

  const themes = res?.data?.messenger_thread_themes || [];
  THEME_CACHE.set(cacheKey, { data: themes, ts: Date.now() });
  return themes;
}

async function resolveThemeID(themeData, availableThemes) {
  if (typeof themeData === 'string') {
    const s = themeData.trim();
    if (/^[0-9]+$/.test(s)) return { id: s, emoji: '👍' };

    const found = availableThemes.find(t =>
      t.accessibility_label && t.accessibility_label.toLowerCase().includes(s.toLowerCase())
    );
    if (found) return { id: found.id, emoji: found.default_emoji || '👍' };

    const paletteID = COLOR_PALETTE[s.toLowerCase()];
    if (paletteID) return { id: paletteID, emoji: '👍' };

    return { id: COLOR_PALETTE.default, emoji: '👍' };
  } else if (typeof themeData === 'object' && themeData !== null) {
    return {
      id: themeData.themeId || themeData.theme_id || themeData.id || COLOR_PALETTE.default,
      emoji: themeData.emoji || themeData.customEmoji || '👍'
    };
  }
  return { id: COLOR_PALETTE.default, emoji: '👍' };
}

async function legacySetTheme(defaultFuncs, ctx, threadID, themeId) {
  const legacyBody = {
    dpr: 1,
    queries: JSON.stringify({
      o0: {
        doc_id: '1727493033983591',
        query_params: {
          data: {
            actor_id: ctx.userID,
            client_mutation_id: '0',
            source: 'SETTINGS',
            theme_id: themeId,
            thread_id: threadID
          }
        }
      }
    })
  };

  const res = await defaultFuncs.post('https://www.facebook.com/api/graphqlbatch/', ctx.jar, legacyBody)
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

  if (res && !res[0]?.o0?.errors) return { success: true, method: 'legacy', themeId };
  throw new Error('Legacy theme set failed: ' + JSON.stringify(res?.[0]?.o0?.errors));
}

async function graphqlSetTheme(defaultFuncs, ctx, threadID, themeId, emoji) {
  const now = Date.now();
  const form = {
    av: ctx.userID,
    __user: ctx.userID,
    __a: 1,
    __req: utils.getSignatureID(),
    fb_dtsg: ctx.fb_dtsg,
    jazoest: ctx.jazoest,
    lsd: ctx.fb_dtsg,
    __spin_r: '1027396270',
    __spin_b: 'trunk',
    __spin_t: now,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'MessengerThreadThemeUpdateMutation',
    variables: JSON.stringify({
      input: {
        actor_id: ctx.userID,
        client_mutation_id: String(Math.floor(Math.random() * 10000)),
        source: 'SETTINGS',
        thread_id: threadID.toString(),
        theme_id: themeId.toString(),
        custom_emoji: emoji
      }
    }),
    server_timestamps: true,
    doc_id: '9734829906576883'
  };

  const res = await defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form)
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

  if (res?.errors?.length) throw new Error('GraphQL theme error: ' + JSON.stringify(res.errors));
  if (res?.data?.messenger_thread_theme_update?.errors?.length) {
    throw new Error('Theme update error: ' + JSON.stringify(res.data.messenger_thread_theme_update.errors));
  }

  return { success: true, method: 'graphql', themeId };
}

async function mqttSetTheme(ctx, threadID, themeId) {
  if (!ctx.mqttClient) throw new Error('MQTT not connected');

  const tasks = [
    { label: 1013, queue: ['ai_generated_theme', String(threadID)] },
    { label: 1037, queue: ['msgr_custom_thread_theme', String(threadID)] },
    { label: 1028, queue: ['thread_theme_writer', String(threadID)] },
    { label: 43, queue: 'thread_theme', extra: { source: null, payload: null } }
  ];

  const results = [];
  for (const { label, queue, extra } of tasks) {
    ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
    ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;

    const msg = {
      app_id: '772021112871879',
      payload: JSON.stringify({
        epoch_id: parseInt(utils.generateOfflineThreadingID()),
        tasks: [{
          failure_count: null,
          label: String(label),
          payload: JSON.stringify({ thread_key: threadID, theme_fbid: themeId, sync_group: 1, ...(extra || {}) }),
          queue_name: typeof queue === 'string' ? queue : JSON.stringify(queue),
          task_id: ctx.wsTaskNumber
        }],
        version_id: '24227364673632991'
      }),
      request_id: ctx.wsReqNumber,
      type: 3
    };

    await new Promise((resolve, reject) => {
      ctx.mqttClient.publish('/ls_req', JSON.stringify(msg), { qos: 1, retain: false }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    results.push({ label, queue });
  }

  return { success: true, method: 'mqtt', themeId, tasks: results.length };
}

function recordHistory(op) {
  THEME_HISTORY.unshift({ ...op, ts: Date.now() });
  if (THEME_HISTORY.length > MAX_HISTORY) THEME_HISTORY.length = MAX_HISTORY;
}

module.exports = function (defaultFuncs, api, ctx) {
  return function setThreadTheme(threadID, themeData, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!options || typeof options !== 'object') options = {};
    const {
      preferMqtt = !!ctx.mqttClient,
      preferLegacy = true,
      skipBootloader = true,
      fetchThemes = true
    } = options;

    let resolveFunc, rejectFunc;
    const promise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof callback !== 'function') {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    if (!threadID) return callback({ error: 'setThreadTheme: threadID is required' });

    (async () => {
      try {
        const now = Date.now();

        if (!skipBootloader) {
          try { await retryOp(() => fetchBootloader(defaultFuncs, ctx)); } catch (_) {}
        }

        let availableThemes = [];
        if (fetchThemes) {
          try { availableThemes = await retryOp(() => fetchAvailableThemes(defaultFuncs, ctx)); } catch (_) {}
        }

        const { id: chosenThemeId, emoji: chosenEmoji } = await resolveThemeID(themeData, availableThemes);

        await globalShield.addSmartDelay();

        let result;

        if (preferMqtt && ctx.mqttClient) {
          try {
            result = await retryOp(() => mqttSetTheme(ctx, threadID, chosenThemeId));
          } catch (mqttErr) {
            utils.warn('setThreadTheme', 'MQTT failed, using HTTP:', mqttErr.message);
            if (preferLegacy) {
              try { result = await retryOp(() => legacySetTheme(defaultFuncs, ctx, threadID, chosenThemeId)); }
              catch (_) { result = await retryOp(() => graphqlSetTheme(defaultFuncs, ctx, threadID, chosenThemeId, chosenEmoji)); }
            } else {
              result = await retryOp(() => graphqlSetTheme(defaultFuncs, ctx, threadID, chosenThemeId, chosenEmoji));
            }
          }
        } else if (preferLegacy) {
          try { result = await retryOp(() => legacySetTheme(defaultFuncs, ctx, threadID, chosenThemeId)); }
          catch (legacyErr) {
            utils.warn('setThreadTheme', 'Legacy failed, using GraphQL:', legacyErr.message);
            result = await retryOp(() => graphqlSetTheme(defaultFuncs, ctx, threadID, chosenThemeId, chosenEmoji));
          }
        } else {
          result = await retryOp(() => graphqlSetTheme(defaultFuncs, ctx, threadID, chosenThemeId, chosenEmoji));
        }

        const themeList = availableThemes.length
          ? availableThemes.map(t => ({ id: t.id, name: t.accessibility_label, description: t.description }))
          : null;

        const finalResult = {
          threadID: String(threadID),
          themeId: chosenThemeId,
          customEmoji: chosenEmoji,
          method: result.method,
          success: true,
          timestamp: now,
          availableThemes: themeList
        };

        THEME_CACHE.set(`thread_theme_${threadID}`, { result: finalResult, ts: Date.now() });
        recordHistory({ threadID: String(threadID), themeId: chosenThemeId, method: result.method });
        utils.log('setThreadTheme', `Set theme ${chosenThemeId} on thread ${threadID} via ${result.method}`);

        callback(null, finalResult);
      } catch (err) {
        utils.error('setThreadTheme', err);
        callback(err);
      }
    })();

    return promise;
  };

  Object.assign(module.exports, {
    getColorPalette: () => ({ ...COLOR_PALETTE }),
    getHistory: (limit = 30) => THEME_HISTORY.slice(0, limit),
    clearCache: () => { THEME_CACHE.clear(); return { success: true }; }
  });
};
