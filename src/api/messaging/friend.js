"use strict";

const utils = require("../../utils/sifuShim");

const FRIEND_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function retryOp(fn, retries = 3, base = 600) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 250));
    }
  }
}

function formatFriends(data, type) {
  const viewer = data?.data?.viewer;
  let edges;
  if (type === "requests" && viewer?.friend_requests?.edges) {
    edges = viewer.friend_requests.edges;
  } else if (type === "suggestions" && viewer?.people_you_may_know?.edges) {
    edges = viewer.people_you_may_know.edges;
  } else if (type === "list" && data?.data?.node?.all_collections?.nodes?.[0]?.style_renderer?.collection?.pageItems?.edges) {
    edges = data.data.node.all_collections.nodes[0].style_renderer.collection.pageItems.edges;
  } else {
    return [];
  }
  return edges.map(edge => {
    const node = edge.node;
    return {
      userID: node.id || node.node?.id,
      name: node.name || node.title?.text,
      profilePicture: node.profile_picture?.uri || node.image?.uri,
      socialContext: node.social_context?.text || node.subtitle_text?.text,
      url: node.url,
      mutualFriendCount: node.mutual_friends?.count || 0
    };
  });
}

module.exports = (defaultFuncs, api, ctx) => {

  async function gqlPost(friendlyName, docID, variables) {
    const form = {
      av: ctx.userID,
      __user: ctx.userID,
      __a: "1",
      fb_dtsg: ctx.fb_dtsg,
      jazoest: ctx.jazoest,
      lsd: ctx.lsd,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: friendlyName,
      variables: JSON.stringify(variables),
      doc_id: docID
    };
    const res = await retryOp(() =>
      defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form, {})
    );
    if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors));
    return res.data;
  }

  const friendModule = {
    requests: async function(useCache = true) {
      const cacheKey = `friend_requests_${ctx.userID}`;
      if (useCache) {
        const cached = FRIEND_CACHE.get(cacheKey);
        if (cached && (Date.now() - cached.ts < CACHE_TTL)) return cached.data;
      }
      const data = await gqlPost("FriendingCometRootContentQuery", "9103543533085580", { scale: 3 });
      const formatted = formatFriends(data, "requests");
      FRIEND_CACHE.set(cacheKey, { data: formatted, ts: Date.now() });
      return formatted;
    },

    accept: async function(identifier) {
      if (!identifier) throw new Error("friend.accept: identifier (userID or name) is required");
      let targetUserID = identifier;
      if (isNaN(identifier)) {
        const requests = await friendModule.requests(false);
        const found = requests.find(req => req.name?.toLowerCase().includes(identifier.toLowerCase()));
        if (!found) throw new Error(`friend.accept: no request matching "${identifier}"`);
        targetUserID = found.userID;
      }
      const data = await gqlPost("FriendingCometFriendRequestConfirmMutation", "24630768433181357", {
        input: {
          friend_requester_id: String(targetUserID),
          friending_channel: "FRIENDS_HOME_MAIN",
          actor_id: ctx.userID,
          client_mutation_id: String(Math.floor(Math.random() * 100))
        },
        scale: 3
      });
      FRIEND_CACHE.delete(`friend_requests_${ctx.userID}`);
      return { success: true, acceptedUserID: targetUserID, response: data?.data };
    },

    decline: async function(identifier) {
      if (!identifier) throw new Error("friend.decline: identifier required");
      let targetUserID = identifier;
      if (isNaN(identifier)) {
        const requests = await friendModule.requests(false);
        const found = requests.find(req => req.name?.toLowerCase().includes(identifier.toLowerCase()));
        if (!found) throw new Error(`friend.decline: no request matching "${identifier}"`);
        targetUserID = found.userID;
      }
      const form = {
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "FriendingCometFriendRequestDeleteMutation",
        doc_id: "5044875148894658",
        variables: JSON.stringify({
          input: {
            friend_requester_id: String(targetUserID),
            actor_id: ctx.userID,
            client_mutation_id: String(Math.floor(Math.random() * 100))
          },
          scale: 3
        })
      };
      await retryOp(() =>
        defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      );
      FRIEND_CACHE.delete(`friend_requests_${ctx.userID}`);
      return { success: true, declinedUserID: targetUserID };
    },

    list: async function(userID, useCache = true) {
      userID = userID || ctx.userID;
      const cacheKey = `friend_list_${userID}`;
      if (useCache) {
        const cached = FRIEND_CACHE.get(cacheKey);
        if (cached && (Date.now() - cached.ts < CACHE_TTL)) return cached.data;
      }
      const sectionToken = Buffer.from(`app_section:${userID}:2356318349`).toString("base64");
      const data = await gqlPost("ProfileCometTopAppSectionQuery", "24492266383698794", {
        collectionToken: null,
        scale: 2,
        sectionToken,
        useDefaultActor: false,
        userID
      });
      const formatted = formatFriends(data, "list");
      FRIEND_CACHE.set(cacheKey, { data: formatted, ts: Date.now() });
      return formatted;
    },

    suggest: {
      list: async function(limit, useCache = true) {
        limit = typeof limit === "number" ? limit : 30;
        const cacheKey = `friend_suggest_${ctx.userID}_${limit}`;
        if (useCache) {
          const cached = FRIEND_CACHE.get(cacheKey);
          if (cached && (Date.now() - cached.ts < CACHE_TTL)) return cached.data;
        }
        const data = await gqlPost("FriendingCometPYMKPanelPaginationQuery", "9917809191634193", {
          count: limit,
          cursor: null,
          scale: 3
        });
        const formatted = formatFriends(data, "suggestions");
        FRIEND_CACHE.set(cacheKey, { data: formatted, ts: Date.now() });
        return formatted;
      },

      request: async function(userID) {
        if (!userID) throw new Error("friend.suggest.request: userID is required");
        const data = await gqlPost("FriendingCometFriendRequestSendMutation", "23982103144788355", {
          input: {
            friend_requestee_ids: [String(userID)],
            friending_channel: "FRIENDS_HOME_MAIN",
            actor_id: ctx.userID,
            client_mutation_id: String(Math.floor(Math.random() * 100))
          },
          scale: 3
        });
        return { success: true, targetUserID: String(userID), response: data?.data };
      }
    },

    clearCache() {
      FRIEND_CACHE.clear();
      return { success: true };
    }
  };

  return friendModule;
};
