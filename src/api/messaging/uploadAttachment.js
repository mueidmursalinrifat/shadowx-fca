"use strict";

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const { URL } = require("url");
const log = require("../../../func/logAdapter");
const { getIdentity } = require("../../utils/clientIdentity");

// Resolved from the same centralized identity as every other subsystem
// (HTTP requests, MQTT) so upload requests never claim a different Chrome
// version/sec-ch-ua than the rest of the session. Do not hard-code a
// separate browser version here. This part is stateless/pure, so it's safe
// to keep at module scope - it's read-only and identical for every session
// using the default identity.
const DEFAULT_IDENTITY = getIdentity();
const DEFAULT_UA = DEFAULT_IDENTITY.userAgent;

const TOKEN_CACHE_TTL = 5 * 60 * 1000;

// NOTE ON SESSION ISOLATION:
// Previously `http` (the axios instance), `cookieJar`, and `tokenCache` were
// module-level `let` variables. Since a Node `require()` cache is a
// singleton, every account/session that called this module's exported
// factory in the same process was silently sharing (and overwriting) the
// SAME axios instance, cookie jar, and cached fb_dtsg/lsd tokens. Logging in
// a second account would clobber the first account's cookie jar and token
// cache mid-session - the same class of bug as the shared CookieJar issue
// fixed in module/loginHelper.js, but specific to the upload path.
//
// Fix: every piece of session-scoped state now lives on a `sess` object
// created fresh inside the exported factory (one per login()/session) and
// is passed explicitly to the helper functions below instead of being read
// from module scope.

function cleanJSON(x) {
  if (typeof x !== "string") return x;
  const s = x.replace(/^for\s*\(;;\);\s*/i, "");
  try { return JSON.parse(s); } catch { return s; }
}

function pick(re, html, i = 1) {
  const m = html && html.match(re);
  return m ? m[i] : "";
}

function getFrom(html, a, b) {
  const i = html.indexOf(a);
  if (i < 0) return;
  const start = i + a.length;
  const j = html.indexOf(b, start);
  return j < 0 ? undefined : html.slice(start, j);
}

function respFinalUrl(res) {
  return (res && (res.url || res.requestUrl)) || "";
}

function detectCheckpoint(res) {
  const url = String(respFinalUrl(res) || "");
  const body = typeof res?.body === "string" ? res.body : "";
  const hit =
    /\/checkpoint\//i.test(url) ||
    /(?:href|action)\s*=\s*["']https?:\/\/[^"']*\/checkpoint\//i.test(body) ||
    /"checkpoint"|checkpoint_title|checkpointMain|id="checkpoint"/i.test(body) ||
    (/login\.php/i.test(url) && /checkpoint/i.test(body));
  return { hit, url: url || (body.match(/https?:\/\/[^"']*\/checkpoint\/[^"'<>]*/i)?.[0] || "") };
}

function checkpointError(res) {
  const d = detectCheckpoint(res);
  if (!d.hit) return null;
  const e = new Error("Checkpoint required");
  e.code = "CHECKPOINT";
  e.checkpoint = true;
  e.url = d.url || "https://www.facebook.com/checkpoint/";
  e.status = res?.statusCode || res?.status;
  return e;
}

async function httpGet(sess, pageUrl, ua, headers = {}) {
  const host = new URL(pageUrl).hostname;
  const referer = `https://${host}/`;
  const baseHeaders = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": DEFAULT_IDENTITY.acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    Connection: "keep-alive",
    Host: host,
    Origin: `https://${host}`,
    Referer: referer,
    "Sec-Ch-Prefers-Color-Scheme": "dark",
    "Sec-Ch-Ua": DEFAULT_IDENTITY.secChUa,
    "Sec-Ch-Ua-Full-Version-List": DEFAULT_IDENTITY.secChUaFullVersionList,
    "Sec-Ch-Ua-Mobile": DEFAULT_IDENTITY.secChUaMobile,
    "Sec-Ch-Ua-Model": '""',
    "Sec-Ch-Ua-Platform": DEFAULT_IDENTITY.secChUaPlatform,
    "Sec-Ch-Ua-Platform-Version": DEFAULT_IDENTITY.secChUaPlatformVersion,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": ua || DEFAULT_UA,
    "x-fb-rlafr": "0"
  };
  const res = await sess.http.get(pageUrl, {
    headers: { ...baseHeaders, ...headers },
    timeout: 30000
  });
  const cp = checkpointError(res);
  if (cp) throw cp;
  return typeof res.data === "string" ? res.data : String(res.data || "");
}

async function getTokens(sess, ua, forceRefresh = false) {
  const now = Date.now();
  const cache = sess.tokenCache;
  if (!forceRefresh && cache.data && (now - cache.time) < TOKEN_CACHE_TTL) {
    return cache.data;
  }
  try {
    const html = await httpGet(sess, "https://www.facebook.com/", ua, { Referer: "https://www.facebook.com/" });
    const fb_dtsg = getFrom(html, '"DTSGInitData",[],{"token":"', '",') || html.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1] || "";
    const jazoest = getFrom(html, 'name="jazoest" value="', '"') || getFrom(html, "jazoest=", '",') || html.match(/name="jazoest"\s+value="([^"]+)"/)?.[1] || "";
    const lsd = getFrom(html, '["LSD",[],{"token":"', '"}') || html.match(/name="lsd"\s+value="([^"]+)"/)?.[1] || "";
    const spin_r = pick(/"__spin_r":(\d+)/, html) || "";
    const spin_t = pick(/"__spin_t":(\d+)/, html) || "";
    const rev = pick(/"__rev":(\d+)/, html) || "";

    if (!fb_dtsg || !lsd) {
      // Cố gắng fallback nếu regex fail, nhưng thường là do cookie die
      if (!cache.data) throw new Error("Failed to fetch fb_dtsg or LSD from Facebook");
    }

    cache.data = { lsd, fb_dtsg, jazoest, spin_r, spin_t, rev };
    cache.time = now;
    return cache.data;
  } catch (e) {
    if (cache.data) {
      log.warn("[uploadAttachment] Token fetch failed, using cached tokens: " + (e.message || e));
      return cache.data;
    }
    throw e;
  }
}

function getType(obj) { return Object.prototype.toString.call(obj).slice(8, -1); }
function isReadableStream(obj) { return obj instanceof stream.Readable && (getType(obj._read) === "Function" || getType(obj._read) === "AsyncFunction") && getType(obj._readableState) === "Object"; }
function fromBuffer(buf) { return stream.Readable.from(buf); }
function parseDataUrl(s) { const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(s); if (!m) return null; const mime = m[1] || "application/octet-stream"; const isB64 = !!m[2]; const data = isB64 ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8"); return { mime, data }; }

function filenameFromUrl(u, headers) {
  try {
    const urlObj = new URL(u);
    let filename = path.basename(urlObj.pathname) || `file-${Date.now()}`;
    const cd = headers && (headers["content-disposition"] || headers["Content-Disposition"]);
    if (cd) {
      const m = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(cd);
      if (m) filename = decodeURIComponent(m[1].replace(/"/g, ""));
    }
    return filename;
  } catch {
    return `file-${Date.now()}`;
  }
}

async function normalizeOne(sess, input, ua) {
  if (!input) throw new Error("Invalid input");
  if (Buffer.isBuffer(input)) return { stream: fromBuffer(input), filename: `file-${Date.now()}.bin`, contentType: "application/octet-stream" };
  if (typeof input === "string") {
    if (/^https?:\/\//i.test(input)) {
      const resp = await sess.http.get(input, {
        headers: {
          "User-Agent": ua,
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache"
        },
        timeout: 30000,
        responseType: "stream"
      });
      const s = resp.data;
      const filename = filenameFromUrl(input, resp.headers);
      return { stream: s, filename };
    }
    if (input.startsWith("data:")) {
      const p = parseDataUrl(input);
      if (!p) throw new Error("Bad data URL");
      return { stream: fromBuffer(p.data), filename: `file-${Date.now()}`, contentType: p.mime };
    }
    if (fs.existsSync(input) && fs.statSync(input).isFile()) {
      return { stream: fs.createReadStream(input), filename: path.basename(input) };
    }
    throw new Error(`Unsupported string input: ${input}`);
  }
  if (isReadableStream(input)) {
    return { stream: input, filename: `file-${Date.now()}` };
  }
  if (typeof input === "object") {
    if (input.buffer && Buffer.isBuffer(input.buffer)) {
      const filename = input.filename || `file-${Date.now()}.bin`;
      const contentType = input.contentType || "application/octet-stream";
      return { stream: fromBuffer(input.buffer), filename, contentType };
    }
    if (input.data && Buffer.isBuffer(input.data)) {
      const filename = input.filename || `file-${Date.now()}.bin`;
      const contentType = input.contentType || "application/octet-stream";
      return { stream: fromBuffer(input.data), filename, contentType };
    }
    if (input.stream && isReadableStream(input.stream)) {
      const filename = input.filename || `file-${Date.now()}`;
      const contentType = input.contentType;
      return { stream: input.stream, filename, contentType };
    }
    if (input.url) {
      return normalizeOne(sess, String(input.url), ua);
    }
    if (input.path && fs.existsSync(input.path) && fs.statSync(input.path).isFile()) {
      return { stream: fs.createReadStream(input.path), filename: input.filename || path.basename(input.path), contentType: input.contentType };
    }
  }
  throw new Error("Unrecognized input");
}

function mapAttachmentDetails(data) {
  const out = [];
  if (!data || typeof data !== "object") return out;

  const stack = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const id = cur.video_id || cur.image_id || cur.audio_id || cur.file_id || cur.fbid || cur.id || cur.upload_id || cur.gif_id;
    const idKey =
      cur.video_id ? "video_id" :
        cur.image_id ? "image_id" :
          cur.audio_id ? "audio_id" :
            cur.file_id ? "file_id" :
              cur.gif_id ? "gif_id" :
                cur.fbid ? "fbid" :
                  id ? "id" : null;
    const filename = cur.filename || cur.file_name || cur.name || cur.original_filename;
    const filetype = cur.filetype || cur.mime_type || cur.type || cur.content_type;
    let thumbnail = cur.thumbnail_src || cur.thumbnail_url || cur.preview_url || cur.thumbSrc || cur.thumb_url || cur.image_preview_url || cur.large_preview_url;
    if (!thumbnail) {
      const m = cur.media || cur.thumbnail || cur.thumb || cur.image_data || cur.video_data || cur.preview;
      thumbnail = m?.thumbnail_src || m?.thumbnail_url || m?.src || m?.uri || m?.url;
    }
    if (idKey) {
      const o = {};
      o[idKey] = id;
      if (filename) o.filename = filename;
      if (filetype) o.filetype = filetype;
      if (thumbnail) o.thumbnail_src = thumbnail;
      out.push(o);
    }
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }

  if (!out.length && data.payload && Array.isArray(data.payload.metadata)) {
    return data.payload.metadata.slice();
  }

  return out;
}

function pLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    if (queue.length) queue.shift()();
  };
  return fn => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(v => { resolve(v); next(); }).catch(e => { reject(e); next(); });
    };
    if (active < n) run(); else queue.push(run);
  });
}

// Hàm upload core xử lý request
async function singleUpload(sess, urlBase, file, ua, tokens, retries = 2) {
  const form = new FormData();
  // QUAN TRỌNG: Chỉ append file, KHÔNG append fb_dtsg vào body nữa
  form.append("farr", file.stream, { filename: file.filename, contentType: file.contentType });

  const headers = {
    ...form.getHeaders(),
    Accept: "*/*",
    "Accept-Language": DEFAULT_IDENTITY.acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": ua,
    "x-asbd-id": "359341",
    "x-fb-lsd": tokens.lsd || "",
    "x-fb-friendly-name": "MercuryUpload",
    "x-fb-request-analytics-tags": JSON.stringify({
      network_tags: {
        product: "256002347743983",
        purpose: "none",
        request_category: "graphql",
        retry_attempt: "0"
      },
      application_tags: "graphservice"
    }),
    "sec-ch-prefers-color-scheme": "dark",
    "sec-ch-ua": DEFAULT_IDENTITY.secChUa,
    "sec-ch-ua-mobile": DEFAULT_IDENTITY.secChUaMobile,
    "sec-ch-ua-platform": DEFAULT_IDENTITY.secChUaPlatform,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    Origin: "https://www.facebook.com",
    Referer: "https://www.facebook.com/",
    "x-fb-rlafr": "0",
    Connection: "keep-alive"
  };

  // Build URL với query string tokens
  const finalUrl = new URL(urlBase);
  finalUrl.searchParams.set("fb_dtsg", tokens.fb_dtsg);
  finalUrl.searchParams.set("jazoest", tokens.jazoest);
  finalUrl.searchParams.set("lsd", tokens.lsd);
  finalUrl.searchParams.set("__aaid", "0");
  finalUrl.searchParams.set("__ccg", "EXCELLENT");

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await sess.http.post(finalUrl.toString(), form, {
        headers,
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      return res;
    } catch (e) {
      if (attempt === retries) throw e;
      if (e.code === "ETIMEDOUT" || e.code === "ECONNRESET" || (e.response && e.response.status >= 500)) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      throw e;
    }
  }
}

module.exports = function (defaultFuncs, api, ctx) {
  const ua = ctx?.options?.userAgent || DEFAULT_UA;

  // One session object per factory call (i.e. per login()/account), instead
  // of the old module-level `http`/`cookieJar`/`tokenCache` singletons that
  // every session in the process used to share and clobber. `ctx.jar` is
  // itself already per-session (see module/loginHelper.js), so reusing it
  // here (instead of creating yet another jar) also keeps upload requests
  // and the rest of the session's HTTP traffic consistent with each other.
  const sessionJar = ctx.jar instanceof CookieJar ? ctx.jar : new CookieJar();
  const sess = {
    http: null,
    tokenCache: { data: null, time: 0 }
  };

  // Axios instance
  sess.http = wrapper(axios.create({
    timeout: 60000,
    headers: {
      "User-Agent": ua,
      "Accept-Language": DEFAULT_IDENTITY.acceptLanguage,
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive"
    },
    maxRedirects: 5,
    validateStatus: () => true
  }));
  sess.http.defaults.withCredentials = true;
  sess.http.defaults.jar = sessionJar;

  async function uploadCore(link, opts, callback) {
    if (typeof opts === "function") { callback = opts; opts = undefined; }
    const options = {
      concurrency: Math.max(1, Math.min(5, Number(opts?.concurrency || 3))),
      mode: opts?.mode === "single" ? "single" : "parallel"
    };

    let resolveFunc = function () { };
    let rejectFunc = function () { };
    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    if (!callback) {
      callback = function (err, data) {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    (async () => {
      try {
        const inputsArr = Array.isArray(link) ? link : [link];
        if (!inputsArr.length) {
          const e = new Error("No files to upload");
          callback(e);
          return;
        }

        let tokens = await getTokens(sess, ua);
        const normAll = await Promise.all(inputsArr.map(x => normalizeOne(sess, x, ua)));

        // Base QS setup
        const qs = [];
        const userId = (ctx && (ctx.userID || ctx.userId)) ? String(ctx.userID || ctx.userId) : "";
        if (userId) qs.push(`__user=${encodeURIComponent(userId)}`);
        qs.push("__a=1");
        qs.push("dpr=1");
        const reqId = Math.floor(Math.random() * 36 ** 2).toString(36);
        qs.push(`__req=${encodeURIComponent(reqId)}`);
        if (tokens.spin_r) qs.push(`__spin_r=${encodeURIComponent(tokens.spin_r)}`);
        if (tokens.spin_t) qs.push(`__spin_t=${encodeURIComponent(tokens.spin_t)}`);
        if (tokens.rev) qs.push(`__rev=${encodeURIComponent(tokens.rev)}`);
        qs.push("__spin_b=trunk");
        qs.push("__comet_req=15");

        const baseUrl = `https://www.facebook.com/ajax/mercury/upload.php?${qs.join("&")}`;

        if (options.mode === "single") {
          const f = normAll[0];
          const res = await singleUpload(sess, baseUrl, f, ua, tokens);

          const cp = checkpointError(res);
          if (cp) { sess.tokenCache.data = null; throw cp; }

          const data = cleanJSON(res.data);
          const ids = mapAttachmentDetails(data);

          if (!ids.length) {
            const e = new Error("UploadFb returned no metadata/ids");
            e.code = "NO_METADATA";
            e.status = res.status;
            e.body = typeof data === "string" ? data.slice(0, 500) : data;
            throw e;
          }
          log.info(`[uploadAttachment] success ${ids.length} item(s) status ${res.status}`);
          callback(null, { status: res.status, ids, raw: data });
          return;
        }

        // Parallel mode
        const limit = pLimit(options.concurrency);
        const tasks = normAll.map(f => () => singleUpload(sess, baseUrl, f, ua, tokens));
        const results = await Promise.all(tasks.map(t => limit(t)));

        const ids = [];
        const errors = [];
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          try {
            const cp = checkpointError(res);
            if (cp) { sess.tokenCache.data = null; throw cp; }

            const data = cleanJSON(res.data);
            const fileIds = mapAttachmentDetails(data);
            if (!fileIds.length) {
              log.warn(`[uploadAttachment] File ${i + 1} returned no metadata/ids`);
              continue;
            }
            ids.push(...fileIds);
          } catch (e) {
            errors.push({ index: i, error: e });
            log.error(`[uploadAttachment] Upload ${i + 1} failed: ${e.message || e}`);
          }
        }

        if (ids.length === 0 && errors.length > 0) {
          throw errors[0].error;
        }

        log.info(`[uploadAttachment] success ${ids.length}/${normAll.length} item(s)`);
        callback(null, { status: 200, ids, raw: null, errors: errors.length > 0 ? errors : undefined });
      } catch (e) {
        if (e.code === "CHECKPOINT" || (e.response && [401, 403].includes(e.response.status))) {
          sess.tokenCache.data = null;
          try {
            await getTokens(sess, ua, true);
            log.info("[uploadAttachment] Tokens refreshed after error");
          } catch (refreshErr) {
            log.error("[uploadAttachment] Token refresh failed: " + (refreshErr.message || refreshErr));
          }
        }
        log.error(`[uploadAttachment] error ${e.code || e.status || ""} ${e.message || e}`);
        callback(e);
      }
    })().catch(err => {
      log.error("[uploadAttachment] Unhandled promise rejection: " + (err.message || err));
      rejectFunc(err);
    });

    return returnPromise;
  }

  return function uploadAttachment(attachments, callback) {
    if (!attachments) throw { error: "Please pass an attachment or an array of attachments." };

    if (typeof callback === "function") {
      return uploadCore(attachments, { mode: "parallel" }, (err, result) => {
        if (err) return callback(err);
        callback(null, result && Array.isArray(result.ids) ? result.ids : []);
      }).then(result => (result && Array.isArray(result.ids) ? result.ids : []));
    }

    return uploadCore(attachments, { mode: "parallel" }).then(result => result && Array.isArray(result.ids) ? result.ids : []);
  };
};
