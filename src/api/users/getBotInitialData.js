"use strict";

const utils = require("../../utils/sifuShim");

const INIT_DATA_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function retryOp(fn, retries = 3, base = 700) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 300));
    }
  }
}

function parseInitialData(html) {
  const extractors = [
    { regex: /"CurrentUserInitialData",\[\],\{(.*?)\},(.*?)\]/, parse: (m) => JSON.parse(`{${m[1]}}`) },
    { regex: /\"USER_ID\":\"(\d+)\"/, parse: (m) => ({ USER_ID: m[1] }) }
  ];

  for (const { regex, parse } of extractors) {
    const match = html.match(regex);
    if (match) {
      try { return parse(match); } catch {}
    }
  }

  const jsonBlobs = [];
  const jsonRegex = /\{[^{}]*"USER_ID"[^{}]*\}/g;
  let m;
  while ((m = jsonRegex.exec(html)) !== null) {
    try { jsonBlobs.push(JSON.parse(m[0])); } catch {}
  }
  return jsonBlobs[0] || null;
}

module.exports = (defaultFuncs, api, ctx) => {
  return async function getBotInitialData(callback) {
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof callback !== "function") {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    try {
      const cacheKey = `botInitialData_${ctx.userID}`;
      const cached = INIT_DATA_CACHE.get(cacheKey);
      if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
        return callback(null, cached.data);
      }

      utils.log("getBotInitialData: Fetching account info...");

      const urls = [
        `https://www.facebook.com/profile.php?id=${ctx.userID}`,
        `https://www.facebook.com/me`
      ];

      let html = null;
      for (const url of urls) {
        try {
          await new Promise((res, rej) => {
            api.httpGet(url, null, { customUserAgent: utils.windowsUserAgent }, (err, data) => {
              if (err) return rej(err);
              html = data;
              res();
            }, true);
          });
          if (html) break;
        } catch {}
      }

      if (!html) throw new Error("getBotInitialData: failed to fetch profile page");

      const parsed = parseInitialData(html);
      if (!parsed) {
        return callback(null, { error: "Could not parse initial data. Rate-limited or session expired." });
      }

      const result = {
        ...parsed,
        name: parsed.NAME,
        uid: parsed.USER_ID,
        firstName: parsed.SHORT_NAME,
        isBusiness: !!parsed.IS_BUSINESS_PERSON_ACCOUNT,
        locale: parsed.LOCALE,
        fetchedAt: Date.now()
      };
      delete result.NAME;
      delete result.USER_ID;

      INIT_DATA_CACHE.set(cacheKey, { data: result, ts: Date.now() });
      callback(null, result);
    } catch (err) {
      utils.error("getBotInitialData", err);
      callback(err);
    }

    return returnPromise;
  };
};
