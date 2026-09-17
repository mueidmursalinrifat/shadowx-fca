"use strict";

const utils = require("../../utils/sifuShim");

const _cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000;

const ENRICHERS = [
  { re: /\bnature\b/i,         add: ", organic texture, earth tones, lush flora" },
  { re: /\bocean|sea\b/i,      add: ", deep blue gradients, aquamarine shimmer, bioluminescent waves" },
  { re: /\bspace|galaxy\b/i,   add: ", cosmic purple nebula, starfield depth, zero-gravity glow" },
  { re: /\bneon\b/i,           add: ", cyberpunk grid, vivid saturation, high-contrast glow lines" },
  { re: /\bsunset\b/i,         add: ", amber horizon, golden-hour warmth, gradient sky fade" },
  { re: /\bforest\b/i,         add: ", deep canopy greens, dappled light, mossy tranquility" },
  { re: /\bfire|flame\b/i,     add: ", scorched black, molten orange, ember heat shimmer" },
  { re: /\bminimal\b/i,        add: ", clean whitespace, geometric precision, calm neutrals" },
  { re: /\bvintage\b/i,        add: ", film grain sepia, nostalgic warmth, muted retro palette" },
  { re: /\bpastel\b/i,         add: ", soft blush, peachy cloud tones, lavender mist" },
  { re: /\bwinter|snow\b/i,    add: ", frosted crystal blue-white, cold clarity, silent snowfall" },
  { re: /\bcity|urban\b/i,     add: ", metropolitan neon, steel-grey concrete, skyline silhouette" },
];

function enrichPrompt(raw) {
  let s = raw.trim();
  for (const { re, add } of ENRICHERS) {
    if (re.test(s) && !s.includes(add.slice(2, 12))) { s += add; break; }
  }
  return s;
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
function wcag(h1, h2) {
  const r1 = hexToRgb(h1), r2 = hexToRgb(h2);
  if (!r1 || !r2) return null;
  const [hi, lo] = lum(r1) > lum(r2) ? [lum(r1), lum(r2)] : [lum(r2), lum(r1)];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}
function parseGradient(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return [raw]; } }
  return [];
}
function extractUri(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  return obj.uri || obj.url || null;
}

function accessibilityScore(t) {
  let s = 40;
  const g = t.colors?.gradient || [];
  if (g.length >= 2) s += 10;
  if (g.length >= 3) s += 5;
  if (t.images?.background)   s += 12;
  if (t.images?.icon)          s += 5;
  if (t.alternativeThemes?.length) s += 8;
  if (t.preview_image_urls?.light_mode) s += 10;
  if (t.gradient_contrast && t.gradient_contrast > 4.5) s += 10;
  return Math.min(100, s);
}

function normalizeTheme(raw, idx) {
  const g  = parseGradient(raw.gradient_colors || raw.background_gradient_colors);
  const bg = extractUri(raw.background_asset?.image);
  const ic = extractUri(raw.icon_asset?.image);

  const preview = (() => {
    const src = raw.preview_image_urls || raw.preview_images;
    if (!src) return bg ? { light_mode: bg, dark_mode: bg } : null;
    if (typeof src === 'string') return { light_mode: src, dark_mode: src };
    if (Array.isArray(src)) return { light_mode: extractUri(src[0]), dark_mode: extractUri(src[1]) || extractUri(src[0]) };
    const l = extractUri(src.light_mode || src.light);
    const d = extractUri(src.dark_mode  || src.dark) || l;
    return (l || d) ? { light_mode: l || d, dark_mode: d || l } : null;
  })();

  const primary = g[0] || raw.fallback_color || null;

  const out = {
    success: true,
    themeId: raw.id,
    name:    raw.accessibility_label || raw.name || `Theme ${idx + 1}`,
    description: raw.description || null,
    serialNumber: idx + 1,
    rank:    idx,

    colors: {
      primary:                  primary,
      fallback:                 raw.fallback_color || null,
      gradient:                 g,
      backgroundGradient:       parseGradient(raw.background_gradient_colors),
      inboundMessageGradient:   parseGradient(raw.inbound_message_gradient_colors),
      messageText:              raw.message_text_color || null,
      titleBarText:             raw.title_bar_text_color || null,
      titleBarButton:           raw.title_bar_button_tint_color || null,
      titleBarBackground:       raw.title_bar_background_color || null,
      composerBackground:       raw.composer_background_color || null,
      composerInputBackground:  raw.composer_input_background_color || null,
      composerTint:             raw.composer_tint_color || null,
      primaryButton:            raw.primary_button_background_color || null,
    },

    images: { background: bg, icon: ic },
    backgroundImage:    bg,
    iconImage:          ic,
    preview_image_urls: preview,

    is_dark:            isDark(primary),
    gradient_contrast:  g.length >= 2 ? wcag(g[0], g[g.length - 1]) : null,

    alternativeThemes: Array.isArray(raw.alternative_themes)
      ? raw.alternative_themes.map(a => ({
          id:              a.id,
          name:            a.accessibility_label || a.name || null,
          backgroundImage: extractUri(a.background_asset?.image) || null,
          iconImage:       extractUri(a.icon_asset?.image) || null,
          gradient_colors: parseGradient(a.gradient_colors),
          is_dark:         isDark(a.fallback_color || null),
        }))
      : [],
  };

  out.accessibility_score = accessibilityScore(out);
  return out;
}

function buildForm(ctx, input) {
  return {
    av:                         ctx.userID,
    __aaid:                     0,
    __user:                     ctx.userID,
    __a:                        1,
    __req:                      utils.getSignatureID ? utils.getSignatureID() : '1',
    __hs:                       "20358.HYP:comet_pkg.2.1...0",
    dpr:                        1,
    __ccg:                      "EXCELLENT",
    __rev:                      "1027673511",
    __s:                        utils.getSignatureID ? utils.getSignatureID() : '1',
    __hsi:                      "7554561631547849479",
    __comet_req:                15,
    fb_dtsg:                    ctx.fb_dtsg,
    jazoest:                    ctx.jazoest,
    lsd:                        ctx.lsd || ctx.fb_dtsg,
    __spin_r:                   "1027673511",
    __spin_b:                   "trunk",
    __spin_t:                   Date.now(),
    __crn:                      "comet.fbweb.MWInboxHomeRoute",
    qpl_active_flow_ids:        "25309433,521485406",
    fb_api_caller_class:        "RelayModern",
    fb_api_req_friendly_name:   "useGenerateAIThemeMutation",
    variables:                  JSON.stringify({ input }),
    server_timestamps:          true,
    doc_id:                     "23873748445608673",
    fb_api_analytics_tags:      JSON.stringify(["qpl_active_flow_ids=25309433,521485406"]),
  };
}

const ERROR_MAP = [
  { test: e => /not authorized/i.test(e?.message),      msg: "This account doesn't have permission to generate AI themes." },
  { test: e => /rate.?limit/i.test(e?.message),         msg: "Rate limit reached. Please wait a moment before retrying." },
  { test: e => /invalid/i.test(e?.message),             msg: "Invalid parameters. Please review your prompt and options." },
  { test: e => e?.statusCode === 403,                   msg: "Access denied. Your account may not support Meta AI themes." },
  { test: e => e?.statusCode === 429,                   msg: "Too many requests. Please slow down." },
  { test: e => /network|timeout|econnreset/i.test(e?.message), msg: "Network error. Please check your connection and retry." },
];

function friendlyError(err) {
  for (const { test, msg } of ERROR_MAP) if (test(err)) return msg;
  return "An unexpected error occurred while generating the theme.";
}

async function attemptFetch(defaultFuncs, ctx, form, retries, baseMs) {
  for (let i = 1; i <= retries; i++) {
    try {
      const raw     = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form);
      const checked = await utils.parseAndCheckLogin(ctx, defaultFuncs)(raw);

      if (checked.errors) {
        const msg = (Array.isArray(checked.errors) ? checked.errors[0]?.message : null) || JSON.stringify(checked.errors);
        throw Object.assign(new Error(msg), { isFatal: true });
      }

      const payload = checked?.data?.xfb_generate_ai_themes_from_prompt;
      if (!payload)                                  throw Object.assign(new Error("No AI theme payload in response"), { isFatal: true });
      if (!Array.isArray(payload.themes) || !payload.themes.length) throw Object.assign(new Error("No themes generated for prompt"), { isFatal: true });

      return payload;
    } catch (err) {
      if (err.isFatal || i >= retries) throw err;
      const wait = baseMs * Math.pow(2, i - 1) + Math.random() * 200;
      utils.warn("produceMetaTheme", `Retry ${i}/${retries} in ${Math.round(wait)}ms — ${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

module.exports = function (defaultFuncs, api, ctx) {

  

  return function produceMetaTheme(prompt, opts, callback) {
    let resolveFunc, rejectFunc;
    const promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });

    if (typeof opts === 'function') { callback = opts; opts = {}; }
    opts = opts || {};
    if (typeof callback !== 'function') {
      callback = (err, data) => { if (err) rejectFunc(err); else resolveFunc(data); };
    }

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      callback({ error: "Prompt is required and must be a non-empty string" });
      return promise;
    }

    const rawPrompt   = prompt.trim();
    const finalPrompt = opts.enrichPrompt !== false ? enrichPrompt(rawPrompt) : rawPrompt;
    const numThemes   = Math.max(1, Math.min(5, Number.isFinite(+opts.numThemes) ? +opts.numThemes : 1));
    const retries     = opts.retries || 3;
    const cacheKey    = `meta::${finalPrompt}::${numThemes}`;

    
    if (opts.useCache !== false) {
      const hit = _cache.get(cacheKey);
      if (hit && Date.now() - hit.ts < CACHE_TTL) {
        utils.log("produceMetaTheme", `Cache hit — "${rawPrompt}"`);
        callback(null, hit.data);
        return promise;
      }
    }

    utils.log("produceMetaTheme", `Generating ${numThemes} theme(s) for: "${rawPrompt}"`);

    const input = {
      client_mutation_id: String(Date.now() % 1e9),
      actor_id:           ctx.userID,
      bypass_cache:       true,
      caller:             "MESSENGER",
      num_themes:         numThemes,
      prompt:             finalPrompt,
    };
    if (opts.imageUrl) input.image_url = opts.imageUrl;

    const form = buildForm(ctx, input);

    (async () => {
      try {
        const payload   = await attemptFetch(defaultFuncs, ctx, form, retries, 700);
        const themes    = payload.themes.map(normalizeTheme);

        
        themes.sort((a, b) => (b.accessibility_score || 0) - (a.accessibility_score || 0));
        themes.forEach((t, i) => { t.rank = i; t.serialNumber = i + 1; });

        const best = themes[0];
        const out = {
          success: true,
          count:   themes.length,
          themes,
          
          themeId:            best.themeId,
          name:               best.name,
          description:        best.description,
          colors:             best.colors,
          images:             best.images,
          backgroundImage:    best.backgroundImage,
          iconImage:          best.iconImage,
          preview_image_urls: best.preview_image_urls,
          is_dark:            best.is_dark,
          accessibility_score: best.accessibility_score,
          gradient_contrast:  best.gradient_contrast,
          alternativeThemes:  best.alternativeThemes,
        };

        if (opts.useCache !== false) _cache.set(cacheKey, { data: out, ts: Date.now() });
        utils.log("produceMetaTheme", `Done — ${themes.length} theme(s), best score: ${best.accessibility_score}`);
        callback(null, out);
      } catch (err) {
        utils.error("produceMetaTheme", err.message || err);
        callback({
          error:         friendlyError(err),
          originalError: err?.message || String(err),
          statusCode:    err?.statusCode || null,
        });
      }
    })();

    return promise;
  };
};
