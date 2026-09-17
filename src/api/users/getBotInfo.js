"use strict";

const utils = require("../../utils/sifuShim");

const BOT_INFO_CACHE = new Map();

module.exports = (defaultFuncs, api, ctx) => {
  return function getBotInfo(netData) {
    if (!netData || !Array.isArray(netData)) {
      utils.error("getBotInfo", "netData must be a valid array");
      return null;
    }

    const cacheKey = `botinfo_${ctx.userID}`;
    const cached = BOT_INFO_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.ts < 10 * 60 * 1000)) return cached.info;

    const findConfig = (key) => {
      for (const scriptData of netData) {
        if (!scriptData.require) continue;
        for (const req of scriptData.require) {
          if (Array.isArray(req)) {
            if (req[0] === key && req[2]) return req[2];
            if (req[3] && req[3][0]?.__bbox?.define) {
              for (const def of req[3][0].__bbox.define) {
                if (Array.isArray(def) && def[0]?.endsWith(key) && def[2]) return def[2];
              }
            }
          }
        }
      }
      return null;
    };

    const findMultiConfig = (...keys) => {
      for (const key of keys) {
        const result = findConfig(key);
        if (result) return result;
      }
      return null;
    };

    const currentUserData = findConfig("CurrentUserInitialData");
    const dtsgInitialData = findMultiConfig("DTSGInitialData", "DTSGInitData");
    const lsdData = findConfig("LSD");
    const mqttData = findConfig("MqttWebDeviceID");
    const siteData = findConfig("SiteData");
    const cryptoData = findConfig("CryptoConfig");

    if (!currentUserData || !dtsgInitialData) {
      utils.error("getBotInfo", "Critical data missing (CurrentUserInitialData or DTSGInitialData)");
      return null;
    }

    const botInfo = {
      name: currentUserData.NAME,
      firstName: currentUserData.SHORT_NAME,
      uid: currentUserData.USER_ID,
      appID: currentUserData.APP_ID,
      isBusiness: !!currentUserData.IS_BUSINESS_PERSON_ACCOUNT,
      isPageAdmin: !!currentUserData.IS_PAGES_CREATOR,
      locale: currentUserData.LOCALE || "en_US",
      dtsgToken: dtsgInitialData.token,
      dtsgAsyncToken: dtsgInitialData.async_get_token,
      lsdToken: lsdData?.token,
      mqttDeviceID: mqttData?.clientID,
      siteRevision: siteData?.client_revision,
      spinT: siteData?.spin_t,
      cryptoKey: cryptoData?.key,
      timestamp: Date.now(),

      getCtx: (key) => ctx[key],
      getOptions: (key) => ctx.globalOptions?.[key],
      getRegion: () => ctx.region,
      getRaw: (key) => findConfig(key)
    };

    BOT_INFO_CACHE.set(cacheKey, { info: botInfo, ts: Date.now() });
    return botInfo;
  };
};
