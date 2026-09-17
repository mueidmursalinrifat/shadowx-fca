"use strict";

const utils = require("../../utils/sifuShim");
const { globalShield } = require("../../utils/sifuShim");

const FOLLOW_CACHE = new Map();
const CACHE_TTL = 2 * 60 * 1000;

async function retryOp(fn, retries = 3, base = 600) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 250));
    }
  }
}

module.exports = (defaultFuncs, api, ctx) => {
  return async function follow(senderID, shouldFollow, callback) {
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof shouldFollow === "function") { callback = shouldFollow; shouldFollow = true; }
    if (typeof callback !== "function") {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    try {
      if (!senderID) throw new Error("follow: senderID is required");
      if (typeof shouldFollow !== "boolean") shouldFollow = true;

      const cacheKey = `follow_${senderID}_${shouldFollow}`;
      const cached = FOLLOW_CACHE.get(cacheKey);
      if (cached && (Date.now() - cached.ts < CACHE_TTL)) return callback(null, cached.data);

      await globalShield.addSmartDelay();

      let form;
      if (shouldFollow) {
        form = {
          av: ctx.userID,
          fb_api_req_friendly_name: "CometUserFollowMutation",
          fb_api_caller_class: "RelayModern",
          doc_id: "25472099855769847",
          variables: JSON.stringify({
            input: {
              attribution_id_v2: "ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,via_cold_start," + Date.now() + ",723451,250100865708545,,",
              is_tracking_encrypted: true,
              subscribe_location: "PROFILE",
              subscribee_id: String(senderID),
              tracking: null,
              actor_id: ctx.userID,
              client_mutation_id: String(Math.round(Math.random() * 20))
            },
            scale: 1
          })
        };
      } else {
        form = {
          av: ctx.userID,
          fb_api_req_friendly_name: "CometUserUnfollowMutation",
          fb_api_caller_class: "RelayModern",
          doc_id: "25472099855769847",
          variables: JSON.stringify({
            action_render_location: "WWW_COMET_FRIEND_MENU",
            input: {
              attribution_id_v2: "ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,tap_search_bar," + Date.now() + ",602597,250100865708545,,",
              is_tracking_encrypted: true,
              subscribe_location: "PROFILE",
              tracking: null,
              unsubscribee_id: String(senderID),
              actor_id: ctx.userID,
              client_mutation_id: String(Math.round(Math.random() * 20))
            },
            scale: 1
          })
        };
      }

      const res = await retryOp(() =>
        defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      );

      if (res.errors) throw new Error(JSON.stringify(res.errors));

      const data = {
        success: true,
        action: shouldFollow ? "follow" : "unfollow",
        targetUserID: String(senderID),
        actorID: ctx.userID,
        timestamp: Date.now(),
        response: res.data || null
      };

      FOLLOW_CACHE.set(cacheKey, { data, ts: Date.now() });
      callback(null, data);
    } catch (err) {
      utils.error("follow", err);
      callback(err);
    }

    return returnPromise;
  };
};
