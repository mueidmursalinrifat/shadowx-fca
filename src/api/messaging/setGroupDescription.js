"use strict";

const utils = require("../../utils/sifuShim");

const MAX_RETRIES = 3;
const BASE_MS     = 500;
const MAX_DESC_LEN = 500;

async function setDescriptionGraphQL(defaultFuncs, ctx, threadID, description) {
  const form = {
    av:                       ctx.userID,
    __user:                   ctx.userID,
    __a:                      1,
    fb_dtsg:                  ctx.fb_dtsg,
    lsd:                      ctx.lsd || ctx.fb_dtsg,
    fb_api_caller_class:      "RelayModern",
    fb_api_req_friendly_name: "ThreadSubtitleMutation",
    variables: JSON.stringify({
      input: {
        client_mutation_id: String(Date.now() % 1e9),
        actor_id:           ctx.userID,
        thread_id:          String(threadID),
        subtitle:           description,
      }
    }),
    server_timestamps: true,
    doc_id:            "5561788507228235",
  };

  const res     = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, form);
  const checked = await utils.parseAndCheckLogin(ctx, defaultFuncs)(res);
  if (checked?.errors) throw Object.assign(
    new Error(checked.errors[0]?.message || JSON.stringify(checked.errors)),
    { isFatal: true }
  );
  return checked;
}

module.exports = (defaultFuncs, api, ctx) => {

  

  return async function setGroupDescription(threadID, description, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => { resolveFunc = resolve; rejectFunc = reject; });

    function done(err, result) {
      if (callback) return err ? callback(err) : callback(null, result);
      if (err) rejectFunc(err); else resolveFunc(result);
    }

    if (!threadID) {
      done(new Error("setGroupDescription: threadID is required"));
      return returnPromise;
    }
    if (typeof description !== 'string') {
      done(new Error("setGroupDescription: description must be a string (use '' to clear)"));
      return returnPromise;
    }
    if (description.length > MAX_DESC_LEN) {
      done(new Error(`setGroupDescription: description exceeds max length of ${MAX_DESC_LEN} characters`));
      return returnPromise;
    }

    const retries = options.retries || MAX_RETRIES;
    let lastErr;

    try {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const raw = await setDescriptionGraphQL(defaultFuncs, ctx, threadID, description);
          const result = {
            success:     true,
            threadID:    String(threadID),
            description: description,
            cleared:     description === "",
            updatedAt:   Date.now(),
            raw,
          };
          utils.log("setGroupDescription", `Thread ${threadID} description updated`);
          done(null, result);
          return returnPromise;
        } catch (err) {
          lastErr = err;
          if (attempt >= retries || err.isFatal) throw err;
          const wait = BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
          utils.warn("setGroupDescription", `Retry ${attempt}/${retries} in ${Math.round(wait)}ms`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    } catch (err) {
      utils.error("setGroupDescription", err.message || err);
      done(err);
    }

    return returnPromise;
  };
};
