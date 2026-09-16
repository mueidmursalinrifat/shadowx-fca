"use strict";
const { parseAndCheckLogin } = require("../../utils/client.js");
const logger = require("../../../func/logger");
const DOC_ID = "24418640587785718";
const FRIENDLY_NAME = "CometHovercardQueryRendererQuery";
const CALLER_CLASS = "RelayModern";

function toJSONMaybe(data) {
  if (!data) return null;
  if (typeof data === "string") {
    const text = data.trim().replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return data;
}

function usernameFromUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^www\.facebook\.com$/i.test(url.hostname)) {
      return null;
    }
    const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (path &&!/^profile\.php$/i.test(path) &&!path.includes("/")) {
      return path;
    }
  } catch {}
  return null;
}

function pickMeta(user) {
  let friendshipStatus = null;
  let gender = null;
  let shortName = user?.short_name || null;
  const primaryActions = Array.isArray(user?.primaryActions)? user.primaryActions : [];
  const secondaryActions = Array.isArray(user?.secondaryActions)? user.secondaryActions : [];
  const friendAction = primaryActions.find(item => item?.profile_action_type === "FRIEND");
  const owner = friendAction?.client_handler?.profile_action?.restrictable_profile_owner;
  if (owner) {
    friendshipStatus = owner.friendship_status || null;
    gender = owner.gender || gender;
    shortName = owner.short_name || shortName;
  }
  if (!gender ||!shortName) {
    const blockAction = secondaryActions.find(item => item?.profile_action_type === "BLOCK");
    const blockOwner = blockAction?.client_handler?.profile_action?.profile_owner;
    if (blockOwner) {
      gender = blockOwner.gender || gender;
      shortName = blockOwner.short_name || shortName;
    }
  }
  return { friendshipStatus, gender, shortName };
}

function normalizeUser(user) {
  if (!user) return null;
  const meta = pickMeta(user);
  const vanity = usernameFromUrl(user.profile_url || user.url) || user.username_for_profile || null;
  return {
    id: user.id || null,
    name: user.name || null,
    firstName: meta.shortName || null,
    vanity,
    thumbSrc: user.profile_picture?.uri || null,
    coverPhoto: user.cover_photo?.source || user.cover_photo?.uri || null,
    profileUrl: user.profile_url || user.url || null,
    gender: meta.gender || null,
    type: user.__typename || "User",
    isFriend: meta.friendshipStatus === "ARE_FRIENDS",
    isBirthday:!!user.is_birthday,
    isVerified:!!user.is_verified,
    isMemorialized:!!user.is_visibly_memorialized,
    isMessengerUser: typeof user.is_messenger_user === "boolean"? user.is_messenger_user : null,
    isMessageBlockedByViewer: typeof user.is_message_blocked_by_viewer === "boolean"? user.is_message_blocked_by_viewer : false,
    workInfo: user.work_info || null,
    messengerStatus: user.messenger_account_status_category || null
  };
}

function createDefaultUser(id) {
  return {
    id: String(id),
    name: "Facebook User",
    firstName: "Facebook",
    lastName: null,
    vanity: String(id),
    thumbSrc: `https://graph.facebook.com/${id}/picture?width=720&height=720`,
    profilePicUrl: `https://graph.facebook.com/${id}/picture?width=720&height=720`,
    coverPhoto: null, // FIX: default e null
    profileUrl: `https://www.facebook.com/profile.php?id=${id}`,
    gender: "no specific gender",
    type: "User",
    isFriend: false,
    isBirthday: false,
    isVerified: false,
    isMemorialized: false,
    isMessengerUser: null,
    isMessageBlockedByViewer: false,
    workInfo: null,
    messengerStatus: null
  };
}

function formatUser(user, id) {
  if (!user) {
    return createDefaultUser(id);
  }
  const nameParts = user.name? String(user.name).trim().split(/\s+/) : [];
  return {
    id: user.id || String(id),
    name: user.name || null,
    firstName: user.firstName || nameParts[0] || "Facebook",
    lastName: nameParts.length > 1? nameParts.slice(1).join(" ") : null,
    vanity: user.vanity || String(id),
    profilePicUrl: user.thumbSrc || `https://graph.facebook.com/${id}/picture?width=720&height=720`,
    coverPhoto: user.coverPhoto || null, // FIX: cover photo pass
    profileUrl: user.profileUrl || `https://www.facebook.com/profile.php?id=${id}`,
    gender: user.gender || "no specific gender",
    type: user.type || "User",
    isFriend: typeof user.isFriend === "boolean"? user.isFriend : false,
    isBirthday:!!user.isBirthday,
    isVerified:!!user.isVerified,
    isMemorialized:!!user.isMemorialized,
    isMessengerUser: typeof user.isMessengerUser === "boolean"? user.isMessengerUser : null,
    isMessageBlockedByViewer: typeof user.isMessageBlockedByViewer === "boolean"? user.isMessageBlockedByViewer : false,
    workInfo: user.workInfo || null,
    messengerStatus: user.messengerStatus || null
  };
}

module.exports = function (defaultFuncs, api, ctx) {
  async function fetchOne(userID) {
    const id = String(userID);
    const variables = {
      actionBarRenderLocation: "WWW_COMET_HOVERCARD",
      context: "DEFAULT",
      entityID: id,
      scale: 1,
      __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false
    };
    const form = {
      av: String(ctx?.userID || ""),
      fb_api_caller_class: CALLER_CLASS,
      fb_api_req_friendly_name: FRIENDLY_NAME,
      server_timestamps: true,
      doc_id: DOC_ID,
      variables: JSON.stringify(variables)
    };
    const response = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form).then(parseAndCheckLogin(ctx, defaultFuncs));
    const parsed = toJSONMaybe(response) || response;
    const root = Array.isArray(parsed)? parsed[0] : parsed;
    const user = root?.data?.node?.comet_hovercard_renderer?.user || null;
    return normalizeUser(user);
  }

  async function fetchLegacy(userIDs) {
    const form = {};
    userIDs.forEach((id, index) => {
      form[`ids[${index}]`] = String(id);
    });
    const response = await defaultFuncs.post("https://www.facebook.com/chat/user_info/", ctx.jar, form).then(parseAndCheckLogin(ctx, defaultFuncs));
    if (response?.error) {
      return {};
    }
    const profiles = response?.payload?.profiles || {};
    const result = {};
    for (const id of Object.keys(profiles)) {
      const profile = profiles[id];
      if (!profile) continue;
      const nameParts = profile.name? String(profile.name).trim().split(/\s+/) : [];
      result[id] = {
        id,
        name: profile.name || null,
        firstName: profile.firstName || nameParts[0] || null,
        lastName: nameParts.length > 1? nameParts.slice(1).join(" ") : null,
        vanity: profile.vanity || null,
        thumbSrc: null,
        coverPhoto: profile.cover_photo || null, // FIX: legacy teo add
        profileUrl: profile.uri || `https://www.facebook.com/profile.php?id=${id}`,
        gender: profile.gender === 1? "male" : profile.gender === 2? "female" : "no specific gender",
        type: profile.type || "User",
        isFriend:!!profile.is_friend,
        isBirthday:!!profile.is_birthday,
        isVerified: false,
        isMessengerUser: null,
        isMessageBlockedByViewer: false,
        workInfo: null,
        messengerStatus: null
      };
    }
    return result;
  }

  return function getUserInfoV2(idOrList, callback) {
    let resolveFunc;
    let rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    if (typeof callback!== "function") {
      callback = (error, data) => {
        if (error) {
          rejectFunc(error);
          return;
        }
        resolveFunc(data);
      };
    }
    const originalIsArray = Array.isArray(idOrList);
    const ids = (originalIsArray? idOrList : [idOrList]).map(id => String(id)).filter(Boolean);
    if (!ids.length) {
      const error = new Error("Invalid user ID(s)");
      callback(error);
      returnPromise;
    }
    (async () => {
      try {
        const retObj = {};
        const results = await Promise.allSettled(ids.map(fetchOne));
        const needFallback = [];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (results[i].status === "fulfilled" && results[i].value?.id) {
            retObj[id] = formatUser(results[i].value, id);
          } else {
            needFallback.push(id);
          }
        }
        if (needFallback.length) {
          try {
            const legacy = await fetchLegacy(needFallback);
            for (const id of needFallback) {
              if (legacy[id]) {
                retObj[id] = formatUser(legacy[id], id);
              }
            }
          } catch (error) {
            logger(`getUserInfoV2 legacy fallback: ${error.message || error}`, "warn");
          }
        }
        for (const id of ids) {
          if (!retObj[id]) {
            retObj[id] = createDefaultUser(id);
          }
          if (ctx?.cache?.set) {
            ctx.cache.set(`user_${id}`, retObj[id]);
          }
        }
        return callback(null, retObj);
      } catch (error) {
        logger(`getUserInfoV2: ${error.message || error}`, "error");
        const retObj = {};
        for (const id of ids) {
          retObj[id] = createDefaultUser(id);
          if (ctx?.cache?.set) {
            ctx.cache.set(`user_${id}`, retObj[id]);
          }
        }
        return callback(null, retObj);
      }
    })();
    returnPromise;
  };
};
