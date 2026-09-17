"use strict";

const utils = require("../../utils/sifuShim");
const { globalShield } = require("../../utils/sifuShim");

const THEME_MQTT_HISTORY = [];
const MAX_HISTORY = 200;
const DEDUP = new Map();
const DEDUP_TTL = 2000;

async function retryOp(fn, retries = 3, base = 400) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const transient = /network|timeout|ECONNRESET|5\d\d|429/i.test(String(err?.message || err));
      if (!transient) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

const TASK_DEFINITIONS = [
  { label: 1013, queue: (tid) => ['ai_generated_theme', String(tid)] },
  { label: 1037, queue: (tid) => ['msgr_custom_thread_theme', String(tid)] },
  { label: 1028, queue: (tid) => ['thread_theme_writer', String(tid)] },
  { label: 43, queue: () => 'thread_theme', extra: { source: null, payload: null } }
];

function buildThemeTask(ctx, threadID, themeFBID, taskDef, baseTaskNumber) {
  const { label, queue, extra = {} } = taskDef;
  const queueName = typeof queue === 'function' ? queue(threadID) : queue;

  return {
    failure_count: null,
    label: String(label),
    payload: JSON.stringify({
      thread_key: threadID,
      theme_fbid: themeFBID,
      sync_group: 1,
      ...extra
    }),
    queue_name: typeof queueName === 'string' ? queueName : JSON.stringify(queueName),
    task_id: baseTaskNumber
  };
}

function buildThemeMessage(ctx, threadID, themeFBID, taskDef) {
  ctx.wsReqNumber = (ctx.wsReqNumber || 0) + 1;
  ctx.wsTaskNumber = (ctx.wsTaskNumber || 0) + 1;
  const task = buildThemeTask(ctx, threadID, themeFBID, taskDef, ctx.wsTaskNumber);

  return {
    app_id: '772021112871879',
    payload: JSON.stringify({
      epoch_id: parseInt(utils.generateOfflineThreadingID()),
      tasks: [task],
      version_id: '24227364673632991'
    }),
    request_id: ctx.wsReqNumber,
    type: 3
  };
}

function publishMessage(ctx, msg) {
  return new Promise((resolve, reject) => {
    ctx.mqttClient.publish(
      '/ls_req',
      JSON.stringify(msg),
      { qos: 1, retain: false },
      (err) => { if (err) reject(err); else resolve({ success: true, request_id: msg.request_id }); }
    );
  });
}

function publishMessageWithAck(ctx, msg) {
  return new Promise((resolve, reject) => {
    const reqID = msg.request_id;
    let handled = false;

    const onResp = (topic, message) => {
      if (topic !== '/ls_resp' || handled) return;
      let j;
      try { j = JSON.parse(message.toString()); j.payload = JSON.parse(j.payload); } catch { return; }
      if (j.request_id !== reqID) return;
      handled = true;
      clearTimeout(timer);
      ctx.mqttClient.removeListener('message', onResp);
      resolve({ success: true, request_id: reqID, acked: true });
    };

    const timer = setTimeout(() => {
      if (!handled) {
        handled = true;
        ctx.mqttClient.removeListener('message', onResp);
        resolve({ success: true, request_id: reqID, acked: false });
      }
    }, 8000);

    ctx.mqttClient.on('message', onResp);
    ctx.mqttClient.publish('/ls_req', JSON.stringify(msg), { qos: 1, retain: false }, (err) => {
      if (err && !handled) {
        handled = true;
        clearTimeout(timer);
        ctx.mqttClient.removeListener('message', onResp);
        reject(err);
      }
    });
  });
}

function recordHistory(op) {
  THEME_MQTT_HISTORY.unshift({ ...op, ts: Date.now() });
  if (THEME_MQTT_HISTORY.length > MAX_HISTORY) THEME_MQTT_HISTORY.length = MAX_HISTORY;
}

module.exports = function (defaultFuncs, api, ctx) {

  const setThreadThemeMqtt = async function setThreadThemeMqtt(threadID, themeFBID, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!options || typeof options !== 'object') options = {};
    const { useAck = false, dedup = true, addDelay = true } = options;

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const done = (err, data) => {
      if (typeof callback === 'function') callback(err, data);
      if (err) rejectFunc(err);
      else resolveFunc(data);
    };

    try {
      if (!ctx.mqttClient) throw new Error('setThreadThemeMqtt: MQTT not connected');
      if (!threadID) throw new Error('setThreadThemeMqtt: threadID is required');
      if (!themeFBID) throw new Error('setThreadThemeMqtt: themeFBID is required');

      const dedupKey = `theme_${threadID}_${themeFBID}`;
      if (dedup) {
        const last = DEDUP.get(dedupKey);
        if (last && Date.now() - last < DEDUP_TTL) {
          return done(null, { success: true, skipped: true, reason: 'dedup', threadID: String(threadID), themeFBID: String(themeFBID) });
        }
        DEDUP.set(dedupKey, Date.now());
      }

      if (addDelay) await globalShield.addSmartDelay();

      const publish = useAck ? publishMessageWithAck : publishMessage;
      const results = [];

      for (const taskDef of TASK_DEFINITIONS) {
        const msg = buildThemeMessage(ctx, threadID, themeFBID, taskDef);
        try {
          const r = await retryOp(() => publish(ctx, msg));
          results.push({ ...r, label: taskDef.label });
        } catch (err) {
          utils.warn('setThreadThemeMqtt', `Task label ${taskDef.label} failed:`, err.message);
          results.push({ success: false, label: taskDef.label, error: err.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const result = {
        success: successCount > 0,
        threadID: String(threadID),
        themeFBID: String(themeFBID),
        tasksPublished: successCount,
        tasksFailed: results.length - successCount,
        results,
        timestamp: Date.now()
      };

      recordHistory({ threadID: String(threadID), themeFBID: String(themeFBID), successCount });
      utils.log('setThreadThemeMqtt', `Set theme ${themeFBID} on thread ${threadID} (${successCount}/${results.length} tasks succeeded)`);

      done(null, result);
    } catch (err) {
      utils.error('setThreadThemeMqtt', err);
      done(err);
    }

    return returnPromise;
  };

  setThreadThemeMqtt.batch = async function batchSetTheme(items, options = {}) {
    const results = [];
    const errors = [];
    for (const { threadID, themeFBID } of items) {
      try {
        const r = await setThreadThemeMqtt(threadID, themeFBID, options);
        results.push(r);
      } catch (err) {
        errors.push({ threadID, themeFBID, error: err.message });
      }
      await new Promise(r => setTimeout(r, 200 + Math.random() * 100));
    }
    return { success: errors.length === 0, results, errors, timestamp: Date.now() };
  };

  setThreadThemeMqtt.getHistory = (limit = 30) => THEME_MQTT_HISTORY.slice(0, limit);
  setThreadThemeMqtt.clearDedup = () => { DEDUP.clear(); return { success: true }; };

  return setThreadThemeMqtt;
};
