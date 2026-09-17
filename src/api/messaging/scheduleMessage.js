"use strict";

const utils = require("../../utils/sifuShim");

const SCHEDULE_MAP = new Map();
let _scheduleCounter = 0;

function genScheduleID() {
  _scheduleCounter++;
  return `sched_${Date.now()}_${_scheduleCounter}`;
}

module.exports = (defaultFuncs, api, ctx) => {

  const scheduleMessage = {

    

    send(msg, threadID, when, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      options = options || {};

      if (!msg)      throw new Error("scheduleMessage.send: msg is required");
      if (!threadID) throw new Error("scheduleMessage.send: threadID is required");
      if (when === undefined || when === null) throw new Error("scheduleMessage.send: 'when' (delay ms or Date) is required");

      let delayMs;
      if (when instanceof Date) {
        delayMs = when.getTime() - Date.now();
      } else if (typeof when === 'number') {
        delayMs = when > 1e12 ? when - Date.now() : when;
      } else {
        throw new Error("scheduleMessage.send: 'when' must be a number (ms) or Date");
      }

      if (delayMs < 0) throw new Error("scheduleMessage.send: 'when' is in the past");

      const scheduleID = genScheduleID();
      const firesAt    = Date.now() + delayMs;

      const timer = setTimeout(async () => {
        SCHEDULE_MAP.delete(scheduleID);
        try {
          const result = await api.sendMessage(msg, threadID, options.replyToMessage);
          utils.log("scheduleMessage", `Fired schedule ${scheduleID} → thread ${threadID}`);
          if (callback) callback(null, { ...result, scheduleID });
        } catch (err) {
          utils.error("scheduleMessage", `Schedule ${scheduleID} failed: ${err.message}`);
          if (callback) callback(err);
        }
      }, delayMs);

      SCHEDULE_MAP.set(scheduleID, {
        scheduleID,
        threadID: String(threadID),
        msg:      typeof msg === 'string' ? msg : '[object]',
        firesAt,
        timer,
      });

      utils.log("scheduleMessage", `Scheduled ${scheduleID} — fires in ${Math.round(delayMs / 1000)}s`);

      return {
        scheduleID,
        firesAt: new Date(firesAt).toISOString(),
        cancel: () => scheduleMessage.cancel(scheduleID),
      };
    },

    

    cancel(scheduleID) {
      const job = SCHEDULE_MAP.get(scheduleID);
      if (!job) return { success: false, scheduleID, reason: "Not found or already fired" };

      clearTimeout(job.timer);
      SCHEDULE_MAP.delete(scheduleID);
      utils.log("scheduleMessage", `Cancelled schedule ${scheduleID}`);
      return { success: true, scheduleID };
    },

    

    list() {
      return Array.from(SCHEDULE_MAP.values()).map(j => ({
        scheduleID: j.scheduleID,
        threadID:   j.threadID,
        msg:        j.msg,
        firesAt:    new Date(j.firesAt).toISOString(),
        remainingMs: Math.max(0, j.firesAt - Date.now()),
      }));
    },

    

    cancelAll() {
      const ids = Array.from(SCHEDULE_MAP.keys());
      for (const id of ids) {
        clearTimeout(SCHEDULE_MAP.get(id).timer);
        SCHEDULE_MAP.delete(id);
      }
      utils.log("scheduleMessage", `Cancelled ${ids.length} scheduled message(s)`);
      return { success: true, cancelled: ids.length };
    },
  };

  return scheduleMessage;
};
