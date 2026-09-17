"use strict";

const utils = require("../../utils/sifuShim");

const PRESENCE_CACHE     = new Map();
const PRESENCE_CACHE_TTL = 30 * 1000;
const CONCURRENCY        = 4;

function parsePresencePayload(payload, userID) {
  if (!payload) return { userID: String(userID), online: false, lastActive: null, device: null };

  const p = payload.presence_event_data || payload;

  const online      = !!(p.type === 'active' || p.c === 1 || p.la === 0);
  const lastActiveSec = p.la ?? p.last_active ?? null;
  const device      = p.p ? (p.p === 1 ? 'desktop' : p.p === 2 ? 'mobile' : 'unknown') : null;

  return {
    userID:     String(userID),
    online,
    lastActive: lastActiveSec ? new Date(lastActiveSec * 1000).toISOString() : null,
    lastActiveMs: lastActiveSec ? lastActiveSec * 1000 : null,
    device,
  };
}

async function fetchPresence(defaultFuncs, ctx, userID) {
  const cacheKey = `presence_${userID}`;
  const cached   = PRESENCE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < PRESENCE_CACHE_TTL) {
    return { ...cached.data, fromCache: true };
  }

  const form = {
    av:                       ctx.userID,
    __user:                   ctx.userID,
    __a:                      1,
    fb_dtsg:                  ctx.fb_dtsg,
    lsd:                      ctx.lsd || ctx.fb_dtsg,
    fb_api_caller_class:      "RelayModern",
    fb_api_req_friendly_name: "FriendingCometFriendsBirthdayPresenceQuery",
    variables: JSON.stringify({ userID: String(userID) }),
    server_timestamps: true,
    doc_id:            "4223330261032726",
  };

  let presence;
  try {
    const res     = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form);
    const checked = await utils.parseAndCheckLogin(ctx, defaultFuncs)(res);
    const node    = checked?.data?.user || checked?.data?.node;
    presence      = parsePresencePayload(node?.presence_event_data || node, userID);
  } catch (_) {
    presence = { userID: String(userID), online: false, lastActive: null, device: null, error: "fetch_failed" };
  }

  PRESENCE_CACHE.set(cacheKey, { data: presence, ts: Date.now() });
  return presence;
}

module.exports = (defaultFuncs, api, ctx) => {

  

  return async function getOnlinePresence(userIDs, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => { resolveFunc = resolve; rejectFunc = reject; });

    function done(err, result) {
      if (callback) return err ? callback(err) : callback(null, result);
      if (err) rejectFunc(err); else resolveFunc(result);
    }

    const ids = Array.isArray(userIDs) ? userIDs.filter(Boolean) : [userIDs].filter(Boolean);

    if (!ids.length) {
      done(new Error("getOnlinePresence: at least one userID is required"));
      return returnPromise;
    }

    if (options.skipCache) PRESENCE_CACHE.clear();

    const concurrency = options.concurrency || CONCURRENCY;

    try {
      const results = [];
      for (let i = 0; i < ids.length; i += concurrency) {
        const batch   = ids.slice(i, i + concurrency);
        const settled = await Promise.allSettled(batch.map(id => fetchPresence(defaultFuncs, ctx, id)));
        for (let bi = 0; bi < settled.length; bi++) {
          const r = settled[bi];
          if (r.status === 'fulfilled') {
            results.push(r.value);
          } else {
            results.push({ userID: String(batch[bi]), online: false, lastActive: null, device: null, error: r.reason?.message });
          }
        }
      }

      const out = ids.length === 1 ? results[0] : { count: results.length, results };
      done(null, out);
    } catch (err) {
      utils.error("getOnlinePresence", err.message || err);
      done(err);
    }

    return returnPromise;
  };
};
