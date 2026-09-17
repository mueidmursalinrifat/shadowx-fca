"use strict";

const utils = require("../../utils/sifuShim");

async function retryOp(fn, retries = 3, base = 800) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      if (err && err.continue) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 300));
    }
  }
}

module.exports = function (defaultFuncs, api, ctx) {
  return function getAccess(authCode, callback) {
    const BASE_URL = "https://business.facebook.com/";
    const REFERER = BASE_URL + "security/twofactor/reauth/?twofac_next=" + encodeURIComponent(BASE_URL + "content_management") + "&type=avoid_bypass&app_id=0&save_device=0";

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof authCode === "function") { callback = authCode; authCode = ""; }

    const cb = (err, token) => {
      if (typeof callback === "function") callback(err, token);
      if (err) rejectFunc(err); else resolveFunc(token);
    };

    if (ctx.access_token) {
      cb(null, ctx.access_token);
      return returnPromise;
    }

    (async () => {
      try {
        const pageRes = await retryOp(() =>
          utils.get(BASE_URL + "content_management", ctx.jar, null, ctx.globalOptions, null, {
            noRef: true,
            Origin: BASE_URL
          })
        );

        const html = pageRes.body;
        const lsd = utils.getFrom(html, '[\"LSD\",[],{\"token\":\"', '\"}');
        if (!lsd) throw new Error("getAccess: could not extract LSD token");

        function submitCode(code) {
          let pResolve, pReject;
          const p = new Promise((res, rej) => { pResolve = res; pReject = rej; });

          if (typeof code !== "string" || code.length !== 6 || isNaN(code)) {
            const contErr = { error: "submitCode", lerror: "code must be a 6-digit string", continue: submitCode };
            pReject(contErr);
            cb(contErr);
            return p;
          }

          defaultFuncs.post(
            BASE_URL + "security/twofactor/reauth/enter/",
            ctx.jar,
            { approvals_code: code, save_device: true, lsd },
            ctx.globalOptions, null,
            { Referer: REFERER, Origin: BASE_URL }
          ).then(res => {
            const body = res.body || "";
            let payload;
            try { payload = JSON.parse(body.split(";").pop() || "{}").payload; } catch {}
            if (payload && !payload.codeConfirmed) {
              throw { error: "submitCode", lerror: payload.message, continue: submitCode };
            }
          }).then(() =>
            retryOp(() => utils.get(BASE_URL + "content_management", ctx.jar, null, ctx.globalOptions, null, { noRef: true }))
          ).then(res => {
            const pageHtml = res.body;
            const tokenMatch = /"accessToken":"(\S+)","clientID":/g.exec(pageHtml);
            if (!tokenMatch) throw { error: "token-undefined", htmlData: pageHtml.substring(0, 500) };
            ctx.access_token = tokenMatch[1];
            pResolve(tokenMatch[1]);
            cb(null, tokenMatch[1]);
          }).catch(err => {
            utils.error("getAccess.submitCode", err.error || err);
            pReject(err);
            cb(err);
          });

          return p;
        }

        const code = String(authCode || "");
        if (code.length === 6 && !isNaN(code)) {
          await submitCode(code);
        } else if (typeof callback === "function") {
          cb({ error: "submitCode", continue: submitCode });
        } else {
          throw { error: "getAccess: provide a 6-digit auth code or a callback for interactive entry" };
        }
      } catch (err) {
        utils.error("getAccess", typeof callback === "function" ? (err.error || err) : err);
        cb(err);
      }
    })();

    return returnPromise;
  };
};
