"use strict";

const utils = require("../../utils/sifuShim");

const _catalogueCache = new Map();
const CACHE_TTL       = 8 * 60 * 1000; 

function parseGradient(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return [raw]; } }
  return [];
}

function hexToRgb(hex) {
  if (!hex) return null;
  const c = hex.replace(/^#/, '').replace(/^[Ff]{2}/, '');
  if (c.length !== 6) return null;
  return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16) };
}
function lum({ r, g, b }) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function isDark(hex) { const r = hexToRgb(hex); return r ? lum(r) < 0.179 : null; }

function normalizeThemeEntry(raw) {
  if (!raw || !raw.id) return null;
  const gradients = parseGradient(raw.gradient_colors || raw.gradientColors);
  const bg        = raw.background_asset?.image?.uri || raw.backgroundImage || null;
  const primary   = gradients[0] || raw.fallback_color || raw.fallbackColor || null;

  return {
    id:                         raw.id,
    name:                       raw.accessibility_label || raw.name || '',
    description:                raw.description || null,

    
    primary_color:              primary,
    fallback_color:             raw.fallback_color || raw.fallbackColor || null,
    gradient_colors:            gradients,
    background_gradient_colors: parseGradient(raw.background_gradient_colors || raw.backgroundGradientColors),
    inbound_message_gradient_colors: parseGradient(raw.inbound_message_gradient_colors || raw.inboundMessageGradientColors),
    message_text_color:         raw.message_text_color || raw.messageTextColor || null,
    inbound_message_text_color: raw.inbound_message_text_color || raw.inboundMessageTextColor || null,
    title_bar_text_color:       raw.title_bar_text_color || raw.titleBarTextColor || null,
    title_bar_button_tint_color: raw.title_bar_button_tint_color || raw.titleBarButtonTintColor || null,
    title_bar_background_color: raw.title_bar_background_color || raw.titleBarBackgroundColor || null,
    title_bar_attribution_color: raw.title_bar_attribution_color || raw.titleBarAttributionColor || null,
    composer_background_color:  raw.composer_background_color || raw.composerBackgroundColor || null,
    composer_input_background_color: raw.composer_input_background_color || raw.composerInputBackgroundColor || null,
    composer_tint_color:        raw.composer_tint_color || raw.composerTintColor || null,
    primary_button_background_color: raw.primary_button_background_color || raw.primaryButtonBackgroundColor || null,
    reaction_pill_background_color: raw.reaction_pill_background_color || raw.reactionPillBackgroundColor || null,
    secondary_text_color:       raw.secondary_text_color || raw.secondaryTextColor || null,
    tertiary_text_color:        raw.tertiary_text_color || raw.tertiaryTextColor || null,
    hot_like_color:             raw.hot_like_color || raw.hotLikeColor || null,
    app_color_mode:             raw.app_color_mode || raw.appColorMode || null,
    normal_theme_id:            raw.normal_theme_id || raw.normalThemeId || null,
    theme_idx:                  raw.theme_idx,

    
    backgroundImage: bg,
    iconImage:       raw.icon_asset?.image?.uri || raw.iconAsset || null,
    background_asset: raw.background_asset || null,
    icon_asset:      raw.icon_asset || null,

    
    is_dark: isDark(primary),
  };
}

module.exports = function (defaultFuncs, api, ctx) {

  

  return async function getTheme(threadID, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    if (!threadID) {
      const err = new Error("getTheme: threadID is required");
      if (callback) return callback(err);
      throw err;
    }

    let resolveFunc, rejectFunc;
    const promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });

    function done(err, data) {
      if (callback) return err ? callback(err) : callback(null, data);
      if (err) rejectFunc(err); else resolveFunc(data);
    }

    
    const cacheKey = `catalogue::${threadID}`;
    if (options.useCache !== false) {
      const hit = _catalogueCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < CACHE_TTL) {
        utils.log("getTheme", `Cache hit for thread ${threadID}`);
        const data = applyFilters(hit.data, options);
        done(null, data);
        return promise;
      }
    }

    const form = {
      av:                         ctx.userID,
      __user:                     ctx.userID,
      fb_dtsg:                    ctx.fb_dtsg,
      lsd:                        ctx.lsd || ctx.fb_dtsg,
      fb_api_caller_class:        'RelayModern',
      fb_api_req_friendly_name:   'MWPThreadThemeQuery_AllThemesQuery',
      variables:                  JSON.stringify({ version: "default" }),
      server_timestamps:          true,
      doc_id:                     '24474714052117636',
    };

    try {
      const resData = await defaultFuncs
        .post("https://www.facebook.com/api/graphql/", ctx.jar, form, null, {
          "x-fb-friendly-name": "MWPThreadThemeQuery_AllThemesQuery",
          "x-fb-lsd":           ctx.lsd,
          "referer":            `https://www.facebook.com/messages/t/${threadID}`,
        })
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

      if (resData.errors) throw new Error(JSON.stringify(resData.errors));
      if (!resData.data?.messenger_thread_themes) throw new Error("getTheme: No theme data in response");

      const rawList = resData.data.messenger_thread_themes;
      const baseThemes = rawList.map(normalizeThemeEntry).filter(Boolean);

      let themes = baseThemes;

      
      if (options.resolveDetails !== false && api.fetchThemeData) {
        themes = await Promise.all(
          baseThemes.map(async base => {
            try {
              const detail = await api.fetchThemeData(base.id, { useCache: true });
              return { ...base, ...detail };
            } catch {
              return base;
            }
          })
        );
      }

      
      if (options.useCache !== false) {
        _catalogueCache.set(cacheKey, { data: themes, ts: Date.now() });
      }

      utils.log("getTheme", `Loaded ${themes.length} theme(s) for thread ${threadID}`);
      done(null, applyFilters(themes, options));
    } catch (err) {
      utils.error("getTheme", err.message || err);
      done(err);
    }

    return promise;
  };

  function applyFilters(themes, options) {
    let out = themes;
    if (options.search) {
      const q = options.search.toLowerCase();
      out = out.filter(t => (t.name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
    }
    if (options.searchColor) {
      const col = options.searchColor.toLowerCase().replace(/^#/, '');
      out = out.filter(t => (t.gradient_colors || []).some(c => c.toLowerCase().includes(col)));
    }
    return out;
  }
};
