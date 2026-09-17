"use strict";

const utils = require("../../utils/sifuShim");

const _cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000; 

const PROMPT_ENRICHERS = [
  { re: /\bnature\b/i,        add: ", lush greenery, organic textures, earthy tones" },
  { re: /\bocean|sea\b/i,     add: ", deep blues, aqua gradients, bioluminescent wave patterns" },
  { re: /\bspace|galaxy\b/i,  add: ", cosmic purples, starfield depth, nebula glow, zero-gravity" },
  { re: /\bsunset\b/i,        add: ", warm amber, golden-hour glow, gradient horizon fade" },
  { re: /\bneon\b/i,          add: ", cyberpunk aesthetic, high-contrast vivid saturation, grid glow" },
  { re: /\bminimal\b/i,       add: ", clean whitespace, muted tones, geometric precision" },
  { re: /\bvintage\b/i,       add: ", muted sepia, retro film-grain palette, nostalgic warmth" },
  { re: /\bforest\b/i,        add: ", deep canopy greens, dappled forest light, mossy hues" },
  { re: /\bfire|flame\b/i,    add: ", molten ember reds, scorched black, dynamic orange heat" },
  { re: /\bpastel\b/i,        add: ", soft blush rose, lavender mist, peachy cloud tones" },
  { re: /\bcity|urban\b/i,    add: ", concrete greys, skyline neon, metropolitan night glow" },
  { re: /\bwinter|snow\b/i,   add: ", icy blue-white, frosted crystal clarity, cold silence" },
  { re: /\bspring|bloom\b/i,  add: ", fresh petal pink, verdant growth, dewdrop luminosity" },
  { re: /\boutdoor|adventure\b/i, add: ", rugged terrain, horizon distance, open-sky freedom" },
];

function enrichPrompt(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let out = raw.trim();
  for (const { re, add } of PROMPT_ENRICHERS) {
    if (re.test(out) && !out.toLowerCase().includes(add.slice(2, 14))) {
      out += add;
      break;
    }
  }
  return out;
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const c = hex.replace(/^#/, '').replace(/^[Ff]{2}/, '');
  if (c.length !== 6) return null;
  return {
    r: parseInt(c.slice(0, 2), 16),
    g: parseInt(c.slice(2, 4), 16),
    b: parseInt(c.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }) {
  const lin = v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function isDark(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return relativeLuminance(rgb) < 0.179;
}

function wcagContrast(hex1, hex2) {
  const r1 = hexToRgb(hex1), r2 = hexToRgb(hex2);
  if (!r1 || !r2) return null;
  const L1 = relativeLuminance(r1), L2 = relativeLuminance(r2);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

function scoreTheme(t) {
  let s = 40;
  const grads = t.gradient_colors || [];

  if (grads.length >= 2) s += 10;
  if (grads.length >= 3) s += 5;
  if (t.preview_image_urls?.light_mode) s += 15;
  if (t.preview_image_urls?.dark_mode  && t.preview_image_urls.dark_mode !== t.preview_image_urls.light_mode) s += 8;
  if (t.alternative_themes?.length)    s += 7;
  if (t.background_asset)              s += 5;

  if (grads.length >= 2) {
    const ratio = wcagContrast(grads[0], grads[grads.length - 1]);
    if (ratio !== null) {
      if (ratio > 3)  s += 5;
      if (ratio > 4.5) s += 5;
      if (ratio > 7)  s += 5;
    }
  }

  return Math.min(100, s);
}

function extractUrl(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  return obj.uri || obj.url || null;
}

function extractGradient(theme) {
  const raw = theme.gradient_colors || theme.gradient || theme.colors;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return [raw]; }
  }
  return [];
}

function normalizeTheme(theme, index) {
  const t = { ...theme };

  
  let lightUrl = null, darkUrl = null;
  const previewSrc = t.preview_image_urls || t.preview_images || t.preview_urls;

  if (previewSrc) {
    if (typeof previewSrc === 'string') {
      lightUrl = darkUrl = previewSrc;
    } else if (Array.isArray(previewSrc)) {
      lightUrl = extractUrl(previewSrc[0]);
      darkUrl  = extractUrl(previewSrc[1]) || lightUrl;
    } else {
      lightUrl = extractUrl(previewSrc.light_mode) || extractUrl(previewSrc.light);
      darkUrl  = extractUrl(previewSrc.dark_mode)  || extractUrl(previewSrc.dark);
    }
  }

  if (!lightUrl) lightUrl = extractUrl(t.background_asset?.image) || extractUrl(t.icon_asset?.image);
  if (!darkUrl && Array.isArray(t.alternative_themes) && t.alternative_themes.length) {
    const alt = t.alternative_themes[0];
    darkUrl = extractUrl(alt?.background_asset?.image) || extractUrl(alt?.icon_asset?.image);
  }
  if (lightUrl && !darkUrl) darkUrl = lightUrl;
  if (darkUrl  && !lightUrl) lightUrl = darkUrl;
  if (lightUrl || darkUrl)  t.preview_image_urls = { light_mode: lightUrl, dark_mode: darkUrl };

  
  t.gradient_colors = extractGradient(theme);

  
  t.primary_color   = theme.primary_color || theme.fallback_color || t.gradient_colors[0] || null;

  
  t.is_dark         = t.primary_color ? isDark(t.primary_color) : null;

  
  if (t.gradient_colors.length >= 2) {
    t.gradient_contrast = wcagContrast(t.gradient_colors[0], t.gradient_colors[t.gradient_colors.length - 1]);
  }

  
  t.accessibility_score = scoreTheme(t);
  t.rank                = index;

  
  t.backgroundImage = extractUrl(t.background_asset?.image) || lightUrl || null;

  return t;
}

function buildForm(ctx, prompt, numThemes) {
  return {
    av: ctx.userID,
    __aaid: 0,
    __user: ctx.userID,
    __a: 1,
    dpr: 1,
    __ccg: "EXCELLENT",
    __spin_r: ctx.__spin_r || "1027673511",
    __spin_b: ctx.__spin_b || "trunk",
    __spin_t: Date.now(),
    lsd: ctx.lsd || ctx.fb_dtsg,
    qpl_active_flow_ids: "25308101,25309433,521482085",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "useGenerateAIThemeMutation",
    variables: JSON.stringify({
      input: {
        client_mutation_id: String(Date.now() % 1e9),
        actor_id: ctx.userID,
        bypass_cache: true,
        caller: "MESSENGER",
        num_themes: numThemes,
        prompt,
      }
    }),
    server_timestamps: true,
    doc_id: "23873748445608673",
    fb_api_analytics_tags: JSON.stringify(["qpl_active_flow_ids=25308101,25309433,521482085"]),
    fb_dtsg: ctx.fb_dtsg,
  };
}

async function fetchRaw(defaultFuncs, ctx, form, maxRetries = 3, baseMs = 700) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await defaultFuncs
        .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

      if (res.errors) {
        const msg = res.errors[0]?.message || JSON.stringify(res.errors);
        throw Object.assign(new Error(msg), { isFatal: true });
      }

      const payload = res?.data?.xfb_generate_ai_themes_from_prompt;
      if (!payload?.themes?.length)
        throw Object.assign(new Error("No themes returned for the given prompt"), { isFatal: true });

      return payload.themes;
    } catch (err) {
      lastErr = err;
      if (err.isFatal || attempt >= maxRetries) throw err;
      const wait = baseMs * Math.pow(2, attempt - 1) + Math.random() * 300;
      utils.warn("createAITheme", `Attempt ${attempt} failed (${err.message}) — retry in ${Math.round(wait)}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = function (defaultFuncs, api, ctx) {

  

  return async function createAITheme(prompt, numThemes, options, callback) {
    
    if (typeof numThemes === 'function')                           { callback = numThemes; numThemes = 3; options = {}; }
    else if (typeof numThemes === 'object' && numThemes !== null) { options = numThemes; numThemes = 3; }
    if (typeof options === 'function')                            { callback = options; options = {}; }
    options   = options || {};
    numThemes = Math.max(1, Math.min(10, Number.isFinite(+numThemes) ? +numThemes : 3));

    let resolveFunc, rejectFunc;
    const promise = new Promise((res, rej) => { resolveFunc = res; rejectFunc = rej; });

    function done(err, data) {
      if (callback) return err ? callback(err) : callback(null, data);
      if (err) rejectFunc(err); else resolveFunc(data);
    }

    
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      done(new Error("createAITheme: 'prompt' must be a non-empty string"));
      return promise;
    }

    const rawPrompt   = prompt.trim();
    const finalPrompt = options.enrichPrompt !== false ? enrichPrompt(rawPrompt) : rawPrompt;
    const cacheKey    = `${finalPrompt}::${numThemes}`;

    
    if (options.useCache !== false) {
      const hit = _cache.get(cacheKey);
      if (hit && Date.now() - hit.ts < CACHE_TTL) {
        utils.log("createAITheme", `Cache hit — "${rawPrompt}"`);
        done(null, hit.data);
        return promise;
      }
    }

    utils.log("createAITheme", `Generating ${numThemes} theme(s) — "${rawPrompt}"`);
    if (finalPrompt !== rawPrompt)
      utils.log("createAITheme", `Enriched prompt: "${finalPrompt}"`);

    try {
      const retries = options.retries || 3;
      let rawThemes;

      if (options.parallel && numThemes > 5) {
        const half = Math.ceil(numThemes / 2);
        const [a, b] = await Promise.all([
          fetchRaw(defaultFuncs, ctx, buildForm(ctx, finalPrompt, half),          retries),
          fetchRaw(defaultFuncs, ctx, buildForm(ctx, finalPrompt, numThemes - half), retries),
        ]);
        rawThemes = [...a, ...b];
      } else {
        rawThemes = await fetchRaw(defaultFuncs, ctx, buildForm(ctx, finalPrompt, numThemes), retries);
      }

      const themes = rawThemes.map((t, i) => normalizeTheme(t, i));

      
      themes.sort((a, b) => (b.accessibility_score || 0) - (a.accessibility_score || 0));
      themes.forEach((t, i) => { t.rank = i; });

      if (options.useCache !== false)
        _cache.set(cacheKey, { data: themes, ts: Date.now() });

      utils.log("createAITheme", `Done — ${themes.length} theme(s) generated`);
      done(null, themes);
    } catch (err) {
      utils.error("createAITheme", err.message || err);
      done(err);
    }

    return promise;
  };
};
