"use strict";

const utils = require("../../utils/sifuShim");
const { globalShield } = require("../../utils/sifuShim");

const PREVIEW_CACHE = new Map();
const PREVIEW_CACHE_TTL = 15 * 60 * 1000;
const SHARE_HISTORY = [];
const MAX_HISTORY = 200;
const INFLIGHT_PREVIEWS = new Map();

const FALLBACK_DOC_IDS = [
  '28939050904374351',
  '9553764061351979',
  '6419764884719809'
];

async function retryOp(fn, retries = 4, base = 600) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const transient = /network|timeout|ECONNRESET|ETIMEDOUT|5\d\d|429/i.test(String(err?.message || err));
      if (!transient) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 300));
    }
  }
}

function formatPreviewResult(data) {
  if (data.errors) throw data.errors[0];
  const previewData = data.data?.xma_preview_data;
  if (!previewData) throw { error: 'Could not generate a preview for this post.' };

  return {
    postID: previewData.post_id,
    header: previewData.header_title,
    subtitle: previewData.subtitle_text,
    title: previewData.title_text,
    previewImage: previewData.preview_url,
    favicon: previewData.favicon_url,
    headerImage: previewData.header_image_url,
    timestamp: Date.now()
  };
}

function isPersistedQueryError(resData) {
  if (!resData?.errors) return false;
  return resData.errors.some(e => {
    const msg = (e.message || '').toLowerCase();
    return msg.includes('persistedquerynotfound') ||
      (msg.includes('document') && msg.includes('not found')) ||
      msg.includes('persisted query');
  });
}

async function tryFetchPreview(defaultFuncs, ctx, postID, docId) {
  const form = {
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'CometXMAProxyShareablePreviewQuery',
    variables: JSON.stringify({ shareable_id: postID.toString(), scale: 3 }),
    doc_id: docId
  };

  const resData = await defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form)
    .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

  if (isPersistedQueryError(resData)) {
    throw Object.assign(new Error(`doc_id "${docId}" expired or not found`), { isExpiredDocId: true });
  }

  return formatPreviewResult(resData);
}

function recordHistory(op) {
  SHARE_HISTORY.unshift({ ...op, ts: Date.now() });
  if (SHARE_HISTORY.length > MAX_HISTORY) SHARE_HISTORY.length = MAX_HISTORY;
}

module.exports = function (defaultFuncs, api, ctx) {

  const getPostPreview = async function getPostPreview(postID, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!options || typeof options !== 'object') options = {};

    const {
      skipCache = false,
      tryFallbackDocIds = true,
      timeout = 15000
    } = options;

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const cb = (err, data) => {
      if (callback) callback(err, data);
      if (err) return rejectFunc(err);
      resolveFunc(data);
    };

    if (!postID) {
      cb({ error: 'share: A postID is required to generate a preview.' });
      return returnPromise;
    }

    const pid = postID.toString();
    const cacheKey = `preview_${pid}`;

    if (!skipCache) {
      const cached = PREVIEW_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.ts < PREVIEW_CACHE_TTL) {
        cb(null, { ...cached.result, fromCache: true });
        return returnPromise;
      }
    }

    if (INFLIGHT_PREVIEWS.has(pid)) {
      try {
        const r = await INFLIGHT_PREVIEWS.get(pid);
        cb(null, r);
      } catch (err) { cb(err); }
      return returnPromise;
    }

    const promise = (async () => {
      const docIds = [
        ctx.options?.sharePreviewDocId,
        ...FALLBACK_DOC_IDS
      ].filter(Boolean);

      let lastErr;

      for (const docId of docIds) {
        try {
          await globalShield.addSmartDelay();
          const result = await retryOp(() => tryFetchPreview(defaultFuncs, ctx, pid, docId));
          PREVIEW_CACHE.set(cacheKey, { result, ts: Date.now() });
          recordHistory({ postID: pid, docId, success: true });
          utils.log('share', `Preview fetched for post ${pid} using doc_id ${docId}`);
          return { ...result, docIdUsed: docId };
        } catch (err) {
          lastErr = err;
          if (err.isExpiredDocId) {
            utils.warn('share', `doc_id "${docId}" expired, trying next`);
            if (!tryFallbackDocIds) break;
          } else {
            utils.warn('share', `Preview fetch failed with doc_id "${docId}":`, err.message || err);
            if (!tryFallbackDocIds) break;
          }
        }
      }

      throw Object.assign(lastErr || new Error('All doc_ids exhausted'), {
        hint: 'Update ctx.options.sharePreviewDocId with current value from Messenger traffic (CometXMAProxyShareablePreviewQuery)',
        triedDocIds: docIds
      });
    })();

    INFLIGHT_PREVIEWS.set(pid, promise);

    try {
      const r = await promise;
      cb(null, r);
    } catch (err) {
      utils.error('share', err);
      cb(err);
    } finally {
      INFLIGHT_PREVIEWS.delete(pid);
    }

    return returnPromise;
  };

  getPostPreview.batch = async function batchPreviews(postIDs, options = {}) {
    const results = [];
    const errors = [];
    for (const postID of postIDs) {
      try {
        const r = await getPostPreview(postID, options);
        results.push(r);
      } catch (err) {
        errors.push({ postID, error: err.message || String(err) });
      }
    }
    return { success: errors.length === 0, results, errors, timestamp: Date.now() };
  };

  getPostPreview.clearCache = (postID) => {
    if (postID) PREVIEW_CACHE.delete(`preview_${postID}`);
    else PREVIEW_CACHE.clear();
    return { success: true };
  };

  getPostPreview.getHistory = (limit = 30) => SHARE_HISTORY.slice(0, limit);
  getPostPreview.updateDocId = (docId) => { if (!ctx.options) ctx.options = {}; ctx.options.sharePreviewDocId = docId; };

  return getPostPreview;
};
