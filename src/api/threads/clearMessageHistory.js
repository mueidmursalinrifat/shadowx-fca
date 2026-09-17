"use strict";

const utils = require("../../utils/sifuShim");

const DEFAULT_LIMIT     = 100;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DELAY_MS  = 500;

module.exports = (defaultFuncs, api, ctx) => {

  

  return async function clearMessageHistory(threadID, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => { resolveFunc = resolve; rejectFunc = reject; });

    function done(err, result) {
      if (callback) return err ? callback(err) : callback(null, result);
      if (err) rejectFunc(err); else resolveFunc(result);
    }

    if (!threadID) {
      done(new Error("clearMessageHistory: threadID is required"));
      return returnPromise;
    }

    const limit      = options.limit     || DEFAULT_LIMIT;
    const pageSize   = options.pageSize  || DEFAULT_PAGE_SIZE;
    const delayMs    = options.delayMs   ?? DEFAULT_DELAY_MS;
    const onlyMine   = !!options.onlyMine;
    const dryRun     = !!options.dryRun;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    let deleted  = 0;
    let skipped  = 0;
    let fetched  = 0;
    let timestamp = null;

    try {
      while (fetched < limit) {
        const fetchCount = Math.min(pageSize, limit - fetched);
        let history;

        try {
          history = await api.getThreadHistory(threadID, fetchCount, timestamp);
        } catch (err) {
          utils.warn("clearMessageHistory", `getThreadHistory failed: ${err.message}`);
          break;
        }

        if (!history || !history.length) break;

        const messages = history.filter(m => {
          if (!m.messageID) return false;
          if (onlyMine && m.senderID !== String(ctx.userID)) return false;
          return true;
        });

        const skippedPage = history.length - messages.length;
        skipped  += skippedPage;
        fetched  += history.length;
        timestamp = history[0]?.timestamp || null;

        if (dryRun) {
          deleted += messages.length;
          utils.log("clearMessageHistory", `[DRY-RUN] Would delete ${messages.length} messages from page`);
        } else {
          const ids = messages.map(m => m.messageID);
          if (ids.length) {
            try {
              await api.deleteMessage(ids, { concurrency: 5 });
              deleted += ids.length;
            } catch (err) {
              utils.warn("clearMessageHistory", `Batch delete error: ${err.message}`);
            }
          }
        }

        if (onProgress) {
          try {
            onProgress({ deleted, skipped, fetched, remaining: Math.max(0, limit - fetched) });
          } catch (_) {}
        }

        if (history.length < pageSize) break;
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }

      const result = {
        success:  true,
        threadID: String(threadID),
        deleted,
        skipped,
        fetched,
        dryRun,
        onlyMine,
        timestamp: Date.now(),
      };

      utils.log("clearMessageHistory", `${dryRun ? '[DRY-RUN] ' : ''}Thread ${threadID}: deleted=${deleted}, skipped=${skipped}`);
      done(null, result);
    } catch (err) {
      utils.error("clearMessageHistory", err.message || err);
      done(err);
    }

    return returnPromise;
  };
};
