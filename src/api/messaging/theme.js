"use strict";

const utils = require("../../utils/sifuShim");

const _undoStack = new Map(); 

function pushUndo(threadID, themeID, themeName) {
  if (!_undoStack.has(threadID)) _undoStack.set(threadID, []);
  const stack = _undoStack.get(threadID);
  stack.push({ themeID, themeName, ts: Date.now() });
  if (stack.length > 5) stack.shift(); 
}

function fuzzyScore(name, query) {
  const n = name.toLowerCase(), q = query.toLowerCase();
  if (n === q)          return 100;
  if (n.startsWith(q))  return 80;
  if (n.includes(q))    return 60;
  
  let qi = 0;
  for (let ni = 0; ni < n.length && qi < q.length; ni++) {
    if (n[ni] === q[qi]) qi++;
  }
  return qi === q.length ? 30 : 0;
}

module.exports = function (defaultFuncs, api, ctx) {

  
  async function fetchThemes(threadID) {
    const form = {
      av:                       ctx.userID,
      __user:                   ctx.userID,
      fb_dtsg:                  ctx.fb_dtsg,
      lsd:                      ctx.lsd || ctx.fb_dtsg,
      fb_api_caller_class:      'RelayModern',
      fb_api_req_friendly_name: 'MWPThreadThemeQuery_AllThemesQuery',
      variables:                JSON.stringify({ version: "default" }),
      server_timestamps:        true,
      doc_id:                   '24474714052117636',
    };

    const resData = await defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, form, null, {
        "x-fb-friendly-name": "MWPThreadThemeQuery_AllThemesQuery",
        "x-fb-lsd":           ctx.lsd,
        "referer":            `https://www.facebook.com/messages/t/${threadID}`,
      })
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

    if (resData.errors) throw new Error(JSON.stringify(resData.errors));
    if (!resData.data?.messenger_thread_themes) throw new Error("Could not retrieve theme list");

    return resData.data.messenger_thread_themes.map(t => {
      if (!t?.id) return null;
      return {
        id:                            t.id,
        name:                          t.accessibility_label || t.name || '',
        description:                   t.description || null,
        appColorMode:                  t.app_color_mode,
        composerBackgroundColor:       t.composer_background_color,
        backgroundGradientColors:      t.background_gradient_colors,
        titleBarButtonTintColor:       t.title_bar_button_tint_color,
        inboundMessageGradientColors:  t.inbound_message_gradient_colors,
        titleBarTextColor:             t.title_bar_text_color,
        composerTintColor:             t.composer_tint_color,
        titleBarAttributionColor:      t.title_bar_attribution_color,
        composerInputBackgroundColor:  t.composer_input_background_color,
        hotLikeColor:                  t.hot_like_color,
        backgroundImage:               t.background_asset?.image?.uri || null,
        messageTextColor:              t.message_text_color,
        inboundMessageTextColor:       t.inbound_message_text_color,
        primaryButtonBackgroundColor:  t.primary_button_background_color,
        titleBarBackgroundColor:       t.title_bar_background_color,
        tertiaryTextColor:             t.tertiary_text_color,
        reactionPillBackgroundColor:   t.reaction_pill_background_color,
        secondaryTextColor:            t.secondary_text_color,
        fallbackColor:                 t.fallback_color,
        gradientColors:                t.gradient_colors,
        normalThemeId:                 t.normal_theme_id,
        iconAsset:                     t.icon_asset?.image?.uri || null,
      };
    }).filter(Boolean);
  }

  
  async function publishThemeViaMqtt(threadID, themeID, themeName, initiatorID) {
    if (!ctx.mqttClient) throw new Error("Not connected to MQTT");

    const publish = (label, queueName, extra = {}) => {
      ctx.wsReqNumber  = (ctx.wsReqNumber  || 0) + 1;
      ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
      const reqId  = ctx.wsReqNumber;
      const taskId = ctx.wsTaskNumber;

      const content = {
        app_id:  ctx.appID || '2220391788200892',
        payload: JSON.stringify({
          epoch_id:   parseInt(utils.generateOfflineThreadingID ? utils.generateOfflineThreadingID() : Date.now()),
          tasks:      [{
            failure_count: null,
            label,
            payload: JSON.stringify({ thread_key: threadID.toString(), theme_fbid: themeID.toString(), sync_group: 1, ...extra }),
            queue_name: queueName,
            task_id:    taskId,
          }],
          version_id: '24631415369801570',
        }),
        request_id: reqId,
        type:       3,
      };

      return new Promise((res, rej) => {
        ctx.mqttClient.publish('/ls_req', JSON.stringify(content), { qos: 1, retain: false }, err => {
          if (err) rej(new Error(`MQTT publish failed (label ${label}): ${err.message}`));
          else res();
        });
      });
    };

    
    await Promise.all([
      publish('1013', 'ai_generated_theme'),
      publish('1037', 'msgr_custom_thread_theme'),
      publish('1028', 'thread_theme_writer'),
      publish('43',   'thread_theme', { source: null, payload: null }),
    ]);

    return {
      type:      "thread_theme_update",
      threadID,
      themeID,
      themeName,
      senderID:  initiatorID,
      BotID:     ctx.userID,
      timestamp: Date.now(),
    };
  }

  
  function normaliseArgs(themeName, threadID, callback, initiatorID) {
    let _cb, _tid = threadID, _init = initiatorID;

    if (typeof callback === 'function' || typeof callback === 'object' && callback?.constructor?.name === 'AsyncFunction') {
      _cb   = callback;
      _init = initiatorID;
    } else if (typeof threadID === 'function') {
      _cb   = threadID;
      _tid  = null;
      _init = callback;
    } else if (typeof callback === 'string') {
      _init = callback;
    }

    return { _cb, _tid: _tid || ctx.threadID, _init: _init || ctx.userID };
  }

  
  

  return async function theme(themeName, threadID, callback, initiatorID) {
    const { _cb: rawCb, _tid, _init } = normaliseArgs(themeName, threadID, callback, initiatorID);

    let _resolveFunc, _rejectFunc;
    const finalPromise = new Promise((res, rej) => { _resolveFunc = res; _rejectFunc = rej; });

    const _callback = rawCb || ((err, data) => { if (err) _rejectFunc(err); else _resolveFunc(data); });

    if (!_tid)      return _callback(new Error("theme: threadID is required"));
    if (!themeName) return _callback(new Error("theme: themeName is required"));

    try {
      const normalised = themeName.trim().toLowerCase();

      
      if (normalised === 'list') {
        const themes = await fetchThemes(_tid);
        return _callback(null, themes);
      }

      
      if (normalised === 'undo') {
        const stack = _undoStack.get(_tid);
        if (!stack || stack.length < 2) return _callback(new Error("No previous theme to undo to for this thread"));
        stack.pop(); 
        const prev = stack[stack.length - 1];
        const event = await publishThemeViaMqtt(_tid, prev.themeID, prev.themeName, _init);
        return _callback(null, event);
      }

      
      if (normalised.startsWith('ai:')) {
        const prompt = themeName.slice(3).trim();
        if (!prompt) return _callback(new Error("theme: AI prompt is required after 'ai:'"));
        if (!api.createAITheme) return _callback(new Error("createAITheme is not available"));

        const aiThemes = await api.createAITheme(prompt, 1, { enrichPrompt: true });
        if (!aiThemes?.length) return _callback(new Error("AI theme generation returned no results"));

        const best = aiThemes[0];
        if (!best.id) return _callback(new Error("AI theme has no usable ID"));

        pushUndo(_tid, best.id, best.name || prompt);
        const event = await publishThemeViaMqtt(_tid, best.id, best.name || prompt, _init);
        return _callback(null, { ...event, aiTheme: best });
      }

      
      if (themeName.startsWith('#')) {
        const explicitId = themeName.slice(1).trim();
        pushUndo(_tid, explicitId, explicitId);
        const event = await publishThemeViaMqtt(_tid, explicitId, explicitId, _init);
        return _callback(null, event);
      }

      
      const themes = await fetchThemes(_tid);

      let matched = null;

      
      matched = themes.find(t => t.id === normalised);

      
      if (!matched && /^\d+$/.test(normalised)) {
        const idx = parseInt(normalised, 10);
        matched = themes[idx] || themes.find(t => t.id === normalised);
      }

      
      if (!matched) matched = themes.find(t => t.name.toLowerCase() === normalised);

      
      if (!matched) matched = themes.find(t => t.name.toLowerCase().startsWith(normalised));

      
      if (!matched) matched = themes.find(t => t.name.toLowerCase().includes(normalised));

      
      if (!matched) {
        const scored = themes
          .map(t => ({ t, score: fuzzyScore(t.name, normalised) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score);
        matched = scored[0]?.t || null;
      }

      if (!matched) {
        const names = themes.slice(0, 8).map(t => t.name).join(', ');
        return _callback(new Error(`Theme "${themeName}" not found. Available themes include: ${names}`));
      }

      pushUndo(_tid, matched.id, matched.name);
      const event = await publishThemeViaMqtt(_tid, matched.id, matched.name, _init);
      _callback(null, event);

    } catch (err) {
      const finalError = err instanceof Error ? err : new Error(err?.message || err?.error || 'Unknown theme error');
      _callback(finalError);
    }

    return finalPromise;
  };
};
