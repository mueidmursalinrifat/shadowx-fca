"use strict";

const utils = require("../../utils/sifuShim");

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRIES     = 2;
const DEFAULT_DELAY_MS    = 1000;
const BASE_MS             = 400;

async function sendToThread(api, msg, threadID, options, retries) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await api.sendMessage(msg, threadID, options.replyToMessage);
      return { success: true, threadID: String(threadID), messageID: result?.messageID, timestamp: Date.now() };
    } catch (err) {
      lastErr = err;
      const isFatal = /auth|checkpoint|suspended|fatal/i.test(err.message || "");
      if (attempt >= retries || isFatal) throw err;
      const wait = BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 300;
      utils.warn("broadcastMessage", `Retry ${attempt}/${retries} → thread ${threadID} in ${Math.round(wait)}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = (defaultFuncs, api, ctx) => {

  

  return async function broadcastMessage(msg, threadIDs, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => { resolveFunc = resolve; rejectFunc = reject; });

    function done(err, result) {
      if (callback) return err ? callback(err) : callback(null, result);
      if (err) rejectFunc(err); else resolveFunc(result);
    }

    if (!msg) {
      done(new Error("broadcastMessage: msg is required"));
      return returnPromise;
    }

    const ids = Array.isArray(threadIDs) ? threadIDs.filter(Boolean) : [];
    if (!ids.length) {
      done(new Error("broadcastMessage: threadIDs must be a non-empty array"));
      return returnPromise;
    }

    const concurrency   = options.concurrency   || DEFAULT_CONCURRENCY;
    const retries       = options.retries       || DEFAULT_RETRIES;
    const delayMs       = options.delayMs       ?? DEFAULT_DELAY_MS;
    const dryRun        = !!options.dryRun;
    const stopOnError   = !!options.stopOnError;

    if (dryRun) {
      const preview = {
        success:     true,
        dryRun:      true,
        total:       ids.length,
        concurrency,
        retries,
        delayMs,
        threadIDs:   ids.map(String),
        msg:         typeof msg === 'string' ? msg : '[object message]',
        estimatedMs: Math.ceil(ids.length / concurrency) * delayMs,
      };
      utils.log("broadcastMessage", `[DRY-RUN] Would send to ${ids.length} threads`);
      done(null, preview);
      return returnPromise;
    }

    const results = [];
    let errorOccurred = false;

    try {
      for (let i = 0; i < ids.length; i += concurrency) {
        if (stopOnError && errorOccurred) break;

        const batch   = ids.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
          batch.map(tid => sendToThread(api, msg, tid, options, retries))
        );

        for (let bi = 0; bi < settled.length; bi++) {
          const r = settled[bi];
          if (r.status === 'fulfilled') {
            results.push(r.value);
          } else {
            errorOccurred = true;
            results.push({ success: false, threadID: String(batch[bi]), error: r.reason?.message, timestamp: Date.now() });
          }
        }

        if (delayMs > 0 && i + concurrency < ids.length) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }

      const sent   = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      const report = {
        success: failed === 0,
        total:   ids.length,
        sent,
        failed,
        results,
      };

      utils.log("broadcastMessage", `Broadcast complete: ${sent}/${ids.length} sent, ${failed} failed`);
      done(null, report);
    } catch (err) {
      utils.error("broadcastMessage", err.message || err);
      done(err);
    }

    return returnPromise;
  };
};
