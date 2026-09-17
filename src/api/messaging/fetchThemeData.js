"use strict";

const utils = require("../../utils/sifuShim");

const _themeCache  = new Map();
const CACHE_TTL    = 10 * 60 * 1000; 

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const c = hex.replace(/^#/, '').replace(/^[Ff]{2}/, '');
  if (c.length !== 6) return null;
  return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16) };
}

function luminance({ r, g, b }) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function isDark(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? luminance(rgb) < 0.179 : null;
}

function contrastRatio(hex1, hex2) {
  const r1 = hexToRgb(hex1), r2 = hexToRgb(hex2);
  if (!r1 || !r2) return null;
  const [hi, lo] = luminance(r1) > luminance(r2) ? [luminance(r1), luminance(r2)] : [luminance(r2), luminance(r1)];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

function extractUri(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  return obj.uri || obj.url || null;
}

function parseGradient(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return [raw]; } }
  return [];
}

function normalizeThemeData(data) {
  const gradients    = parseGradient(data.gradient_colors);
  const inboundGrads = parseGradient(data.inbound_message_gradient_colors) || gradients;
  const primaryColor = gradients[0] || data.fallback_color || null;
  const bgImage      = extractUri(data.background_asset?.image);

  const out = {
    id:                             data.id,
    name:                           data.accessibility_label || data.name || null,
    description:                    data.description || null,

    
    primary_color:                  primaryColor,
    fallback_color:                 data.fallback_color || null,
    gradient_colors:                gradients,
    inbound_message_gradient_colors: inboundGrads,
    message_text_color:             data.message_text_color || data.fallback_color || null,
    title_bar_text_color:           data.title_bar_text_color || null,
    title_bar_button_tint_color:    data.title_bar_button_tint_color || data.fallback_color || null,
    title_bar_background_color:     data.title_bar_background_color || null,
    composer_input_background_color: data.composer_input_background_color || data.fallback_color || null,
    composer_background_color:      data.composer_background_color || null,
    composer_tint_color:            data.composer_tint_color || null,
    primary_button_background_color: data.primary_button_background_color || null,

    
    background_asset: data.background_asset || null,
    icon_asset:       data.icon_asset       || null,
    backgroundImage:  bgImage,
    iconImage:        extractUri(data.icon_asset?.image) || null,

    
    preview_image_urls: (() => {
      const src = data.preview_image_urls || data.preview_images;
      if (!src) return bgImage ? { light_mode: bgImage, dark_mode: bgImage } : null;
      if (typeof src === 'string')   return { light_mode: src, dark_mode: src };
      if (Array.isArray(src))        return { light_mode: extractUri(src[0]), dark_mode: extractUri(src[1]) || extractUri(src[0]) };
      const l = extractUri(src.light_mode || src.light);
      const d = extractUri(src.dark_mode  || src.dark) || l;
      return l || d ? { light_mode: l || d, dark_mode: d || l } : null;
    })(),

    
    is_dark:                  isDark(primaryColor),
    gradient_contrast:        gradients.length >= 2 ? contrastRatio(gradients[0], gradients[gradients.length - 1]) : null,

    
    alternative_themes: data.alternative_themes || [],
  };

  
  let score = 40;
  if (gradients.length >= 2)         score += 10;
  if (gradients.length >= 3)         score += 5;
  if (out.preview_image_urls?.light_mode) score += 15;
  if (out.backgroundImage)           score += 8;
  if (out.alternative_themes.length) score += 7;
  if (out.gradient_contrast && out.gradient_contrast > 4.5) score += 15;
  out.accessibility_score = Math.min(100, score);

  return out;
}

async function fetchOne(defaultFuncs, ctx, themeID, retries = 3, baseMs = 600) {
  const cacheKey = `theme::${themeID}`;
  const hit = _themeCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const DOC_IDS = [
    "9734829906576883",
    "7984786008208234",
    "6127487927337559",
    "23873748445608673",
  ];

  const baseForm = {
    av:                         ctx.userID,
    __user:                     ctx.userID,
    __a:                        1,
    __req:                      utils.getSignatureID ? utils.getSignatureID() : '1',
    fb_dtsg:                    ctx.fb_dtsg,
    lsd:                        ctx.lsd || ctx.fb_dtsg,
    jazoest:                    ctx.jazoest,
    fb_api_caller_class:        "RelayModern",
    fb_api_req_friendly_name:   "MWPThreadThemeProviderQuery",
    variables:                  JSON.stringify({ id: themeID.toString() }),
    server_timestamps:          true,
  };

  let lastErr;
  for (const docId of DOC_IDS) {
    const form = Object.assign({}, baseForm, { doc_id: docId });
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await defaultFuncs
          .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

        if (res.errors) {
          lastErr = Object.assign(new Error(res.errors[0]?.message || JSON.stringify(res.errors)), { isFatal: false });
          break;
        }

        const raw = res?.data?.messenger_thread_theme;
        if (!raw) {
          lastErr = Object.assign(new Error(`fetchThemeData: no data for theme ${themeID}`), { isFatal: false });
          break;
        }

        const normalized = normalizeThemeData(raw);
        _themeCache.set(cacheKey, { data: normalized, ts: Date.now() });
        return normalized;
      } catch (err) {
        lastErr = err;
        if (attempt >= retries) break;
        const wait = baseMs * Math.pow(2, attempt - 1) + Math.random() * 250;
        utils.warn("fetchThemeData", `Attempt ${attempt} failed (doc_id ${docId}) for theme ${themeID} — retry in ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr || new Error(`fetchThemeData: no data for theme ${themeID}`);
}

module.exports = function (defaultFuncs, api, ctx) {

  

  return async function fetchThemeData(themeID, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    let resolveFunc, rejectFunc;
    const promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });

    function done(err, data) {
      if (callback) return err ? callback(err) : callback(null, data);
      if (err) rejectFunc(err); else resolveFunc(data);
    }

    if (!themeID) {
      done(new Error("fetchThemeData: themeID is required"));
      return promise;
    }

    const isBatch   = Array.isArray(themeID);
    const ids       = isBatch ? themeID : [themeID];
    const retries   = options.retries || 3;
    const resolveAlt = options.resolveAlternatives !== false;

    try {
      
      const results = await Promise.all(ids.map(id => fetchOne(defaultFuncs, ctx, id, retries)));

      
      if (resolveAlt) {
        await Promise.all(results.map(async theme => {
          if (!Array.isArray(theme.alternative_themes) || !theme.alternative_themes.length) return;
          const altIds = theme.alternative_themes.map(a => (typeof a === 'string' ? a : a?.id)).filter(Boolean);
          if (!altIds.length) return;
          try {
            theme.alternative_themes = await Promise.all(
              altIds.map(id => fetchOne(defaultFuncs, ctx, id, Math.max(1, retries - 1)).catch(() => id))
            );
          } catch (_) {}
        }));
      }

      const out = isBatch ? results : results[0];
      done(null, out);
    } catch (err) {
      utils.error("fetchThemeData", err.message || err);
      done(err);
    }

    return promise;
  };
};
