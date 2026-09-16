"use strict";

function bindOptionalMethod(api, key) {
  const candidate = api[key];
  return typeof candidate === "function" ? candidate.bind(api) : undefined;
}

function readOptionalMember(api, key) {
  return typeof api[key] === "undefined" ? undefined : api[key];
}

function bindLiveMethod(api, key) {
  return (...args) => {
    const candidate = api[key];
    if (typeof candidate !== "function") {
      throw new Error(`API method "${key}" is not available`);
    }
    return candidate.apply(api, args);
  };
}

function compactNamespace(namespace) {
  return Object.fromEntries(
    Object.entries(namespace).filter(([, value]) => value !== undefined)
  );
}

function readNamespace(api, key) {
  const value = api[key];
  return value && typeof value === "object" ? value : undefined;
}

function createFallbackNamespaces(api) {
  return {
    messages: compactNamespace({
      send: bindOptionalMethod(api, "sendMessage"),
      edit: bindOptionalMethod(api, "editMessage"),
      delete: bindOptionalMethod(api, "deleteMessage"),
      unsend: bindOptionalMethod(api, "unsendMessage"),
      get: bindOptionalMethod(api, "getMessage"),
      markRead: bindOptionalMethod(api, "markAsRead"),
      markReadAll: bindOptionalMethod(api, "markAsReadAll"),
      markSeen: bindOptionalMethod(api, "markAsSeen"),
      markDelivered: bindOptionalMethod(api, "markAsDelivered"),
      typing: bindOptionalMethod(api, "sendTypingIndicator"),
      react: bindOptionalMethod(api, "setMessageReaction"),
      shareContact: bindOptionalMethod(api, "shareContact"),
      getEmojiUrl: bindOptionalMethod(api, "getEmojiUrl"),
      resolvePhotoUrl: bindOptionalMethod(api, "resolvePhotoUrl"),
      uploadAttachment: bindOptionalMethod(api, "uploadAttachment"),
      forwardAttachment: bindOptionalMethod(api, "forwardAttachment")
    }),
    threads: compactNamespace({
      createGroup: bindOptionalMethod(api, "createNewGroup"),
      getInfo: bindOptionalMethod(api, "getThreadInfo"),
      getList: bindOptionalMethod(api, "getThreadList"),
      getHistory: bindOptionalMethod(api, "getThreadHistory"),
      getPictures: bindOptionalMethod(api, "getThreadPictures"),
      addUsers: bindOptionalMethod(api, "addUserToGroup"),
      archive: bindOptionalMethod(api, "changeArchivedStatus"),
      removeUser: bindOptionalMethod(api, "removeUserFromGroup"),
      setAdmin: bindOptionalMethod(api, "changeAdminStatus"),
      setImage: bindOptionalMethod(api, "changeGroupImage"),
      setColor: bindOptionalMethod(api, "changeThreadColor"),
      setEmoji: bindOptionalMethod(api, "changeThreadEmoji"),
      setNickname: bindOptionalMethod(api, "changeNickname"),
      createPoll: bindOptionalMethod(api, "createPoll"),
      createThemeAI: bindOptionalMethod(api, "createThemeAI"),
      getThemePictures: bindOptionalMethod(api, "getThemePictures"),
      delete: bindOptionalMethod(api, "deleteThread"),
      colors: readOptionalMember(api, "threadColors"),
      handleMessageRequest: bindOptionalMethod(api, "handleMessageRequest"),
      mute: bindOptionalMethod(api, "muteThread"),
      setTitle: bindOptionalMethod(api, "setTitle"),
      search: bindOptionalMethod(api, "searchForThread")
    }),
    users: compactNamespace({
      getID: bindOptionalMethod(api, "getUserID"),
      getInfo: bindOptionalMethod(api, "getUserInfo"),
      getInfoV2: bindOptionalMethod(api, "getUserInfoV2"),
      getFriends: bindOptionalMethod(api, "getFriendsList")
    }),
    account: compactNamespace({
      addExternalModule: bindOptionalMethod(api, "addExternalModule"),
      addFriend: bindOptionalMethod(api, "addFriend"),
      changeAvatar: bindOptionalMethod(api, "changeAvatar"),
      changeCover: bindOptionalMethod(api, "changeCover"),
      changeBio: bindOptionalMethod(api, "changeBio"),
      enableAutoSaveAppState: bindOptionalMethod(api, "enableAutoSaveAppState"),
      getCurrentUserID: bindOptionalMethod(api, "getCurrentUserID"),
      handleFriendRequest: bindOptionalMethod(api, "handleFriendRequest"),
      logout: bindOptionalMethod(api, "logout"),
      refreshDtsg: bindOptionalMethod(api, "refreshFb_dtsg"),
      changeBlockedStatus: bindOptionalMethod(api, "changeBlockedStatus"),
      setOptions: bindOptionalMethod(api, "setOptions"),
      setPostReaction: bindOptionalMethod(api, "setPostReaction"),
      unfriend: bindOptionalMethod(api, "unfriend"),
      getAppState: bindOptionalMethod(api, "getAppState"),
      getCookies: bindOptionalMethod(api, "getCookies")
    }),
    realtime: compactNamespace({
      listen: bindLiveMethod(api, "listenMqtt"),
      stop: bindLiveMethod(api, "stopListening"),
      stopAsync: bindLiveMethod(api, "stopListeningAsync"),
      useMiddleware: bindLiveMethod(api, "useMiddleware"),
      removeMiddleware: bindLiveMethod(api, "removeMiddleware"),
      clearMiddleware: bindLiveMethod(api, "clearMiddleware"),
      listMiddleware: bindLiveMethod(api, "listMiddleware"),
      setMiddlewareEnabled: bindLiveMethod(api, "setMiddlewareEnabled")
    }),
    http: compactNamespace({
      get: bindOptionalMethod(api, "httpGet"),
      post: bindOptionalMethod(api, "httpPost"),
      postFormData: bindOptionalMethod(api, "postFormData")
    }),
    scheduler: compactNamespace(readOptionalMember(api, "scheduler") || {})
  };
}

function mergeNamespace(fallback, existing) {
  return compactNamespace({ ...fallback, ...(existing || {}) });
}

function createFcaClient(api) {
  const fallback = createFallbackNamespaces(api);
  return {
    raw: api,
    messages: mergeNamespace(fallback.messages, readNamespace(api, "messages")),
    threads: mergeNamespace(fallback.threads, readNamespace(api, "threads")),
    users: mergeNamespace(fallback.users, readNamespace(api, "users")),
    account: mergeNamespace(fallback.account, readNamespace(api, "account")),
    realtime: mergeNamespace(fallback.realtime, readNamespace(api, "realtime")),
    http: mergeNamespace(fallback.http, readNamespace(api, "http")),
    scheduler: mergeNamespace(fallback.scheduler, readNamespace(api, "scheduler"))
  };
}

module.exports = { createFcaClient };
