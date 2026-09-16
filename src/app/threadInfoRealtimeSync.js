"use strict";

function parseRowData(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const o = JSON.parse(raw);
      return typeof o === "object" && o !== null ? o : null;
    } catch { return null; }
  }
  return null;
}

function normalizeParticipantId(v) {
  if (v == null) return "";
  if (typeof v === "object" && v && "id" in v) return String(v.id);
  return String(v);
}

function normalizeAddedParticipants(raw) {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map(normalizeParticipantId).filter(Boolean);
}

function mergedEventData(ev) {
  const a = ev.logMessageData || {};
  const b = ev.eventData || {};
  return { ...b, ...a };
}

async function invalidateThreadCacheRow(Thread, threadID) {
  await Thread.update({ data: null }, { where: { threadID } });
}

function toThreadParticipant(entry, idFallback) {
  const id = String(entry?.id ?? idFallback ?? "");
  return {
    id,
    name: entry?.name ?? null,
    firstName: entry?.firstName ?? null,
    vanity: entry?.vanity ?? null,
    url: entry?.profileUrl ?? entry?.url ?? null,
    thumbSrc: entry?.thumbSrc ?? null,
    profileUrl: entry?.profileUrl ?? null,
    gender: entry?.gender ?? null,
    type: entry?.type ?? null,
    isFriend: Boolean(entry?.isFriend),
    isBirthday: Boolean(entry?.isBirthday)
  };
}

function minimalParticipant(id) {
  return { id, name: null, firstName: null, vanity: null, url: null, thumbSrc: null, profileUrl: null, gender: null, type: null, isFriend: false, isBirthday: false };
}

async function fetchAndMergeParticipants(api, info, idsToFetch, log) {
  const uniq = [...new Set(idsToFetch.map(String).filter(Boolean))];
  if (!uniq.length || !api || typeof api.getUserInfo !== "function") return false;
  try {
    const map = await api.getUserInfo(uniq);
    if (!map || typeof map !== "object") return false;
    const prev = new Map();
    for (const u of Array.isArray(info.userInfo) ? info.userInfo : []) {
      if (u?.id != null) prev.set(String(u.id), u);
    }
    for (const id of uniq) {
      const entry = map[id];
      if (entry && typeof entry === "object") prev.set(id, toThreadParticipant(entry, id));
    }
    const pids = (info.participantIDs || []).map(String);
    info.userInfo = pids.map(pid => {
      const fresh = map[pid];
      if (fresh && typeof fresh === "object") return toThreadParticipant(fresh, pid);
      const old = prev.get(pid);
      if (old) return old;
      return minimalParticipant(pid);
    });
    return true;
  } catch (e) {
    log?.(`thread-info-realtime-sync getUserInfo: ${e?.message || e}`, "warn");
    return false;
  }
}

function syncParticipantListFromEvent(ev, info) {
  const p = ev.participantIDs;
  if (!Array.isArray(p) || !p.length) return false;
  const next = p.map(String).filter(Boolean);
  if (!next.length) return false;
  const prev = JSON.stringify((info.participantIDs || []).map(String).sort());
  if (prev === JSON.stringify([...next].sort())) return false;
  info.participantIDs = next;
  if (Array.isArray(info.userInfo)) {
    const set = new Set(next);
    info.userInfo = info.userInfo.filter(u => set.has(String(u?.id)));
  }
  return true;
}

function tryPatchThemeFromUntyped(data, info) {
  if (!data || typeof data !== "object") return false;
  let mutated = false;
  const stack = [{ obj: data, depth: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    if (depth > 10) continue;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const kl = k.toLowerCase();
      if (typeof v === "string") {
        if (kl.includes("emoji") && !kl.includes("unicode")) { info.emoji = v; mutated = true; }
        if (kl.includes("bubble_color") || kl.includes("theme_color") || kl.includes("outgoing_bubble") || kl === "gradient_color" || kl === "accessory_color") {
          const hex = v.replace(/^#/, "").trim();
          if (/^[0-9a-f]{6,12}$/i.test(hex)) { info.color = hex.length >= 8 ? hex.slice(0, 8) : hex; mutated = true; }
        }
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        stack.push({ obj: v, depth: depth + 1 });
      }
    }
  }
  return mutated;
}

function tryPatchAdminsFromUntyped(data, info) {
  if (!data || typeof data !== "object") return false;
  const tryArray = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return false;
    const ids = arr.map(normalizeParticipantId).filter(Boolean);
    if (!ids.length) return false;
    info.adminIDs = ids;
    return true;
  };
  const o = data;
  for (const key of Object.keys(o)) {
    if (key.toLowerCase().includes("admin") && Array.isArray(o[key])) {
      if (tryArray(o[key])) return true;
    }
  }
  let mutated = false;
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      if (node.length && node.every(x => typeof x === "string" || typeof x === "number")) {
        if (tryArray(node)) mutated = true;
      }
      node.forEach(x => walk(x, depth + 1));
      return;
    }
    for (const k of Object.keys(node)) {
      const kl = k.toLowerCase();
      const v = node[k];
      if (kl.includes("thread_admin") || kl === "admin_ids" || kl === "admins") {
        if (tryArray(v)) mutated = true;
      }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return mutated;
}

function tryPatchNickname(data, info) {
  if (!data || typeof data !== "object") return false;
  const o = data;
  const pid = o.participant_id ?? o.participantId ?? o.user_id ?? o.actor_id ?? o.target_id;
  const nn = o.nickname ?? o.new_nickname ?? o.name;
  if (pid == null || nn == null || typeof nn !== "string" || !nn.trim()) return false;
  if (!info.nicknames || typeof info.nicknames !== "object") info.nicknames = {};
  info.nicknames[String(pid)] = nn.trim();
  return true;
}

function tryPatchApprovalMode(data, info) {
  if (!data || typeof data !== "object") return false;
  for (const k of ["approval_mode", "approvalMode", "is_approval_mode_enabled"]) {
    if (typeof data[k] === "boolean") { info.approvalMode = data[k]; return true; }
    if (data[k] === "1" || data[k] === "0" || data[k] === 1 || data[k] === 0) { info.approvalMode = Boolean(Number(data[k])); return true; }
  }
  return false;
}

function tryPatchInviteLink(data, info) {
  if (!data || typeof data !== "object") return false;
  const jm = data.joinable_mode ?? data.joinableMode;
  if (!jm || typeof jm !== "object") return false;
  if (!info.inviteLink || typeof info.inviteLink !== "object") info.inviteLink = {};
  if (jm.mode !== undefined) info.inviteLink.enable = jm.mode === 1 || jm.mode === true;
  if (typeof jm.link === "string") info.inviteLink.link = jm.link;
  return true;
}

async function applyThreadInfoRealtimeEvent(Thread, threadID, ev, log, api) {
  if (!Thread || !threadID || !ev || ev.type !== "event") return;
  const logType = ev.logMessageType != null ? String(ev.logMessageType) : "";
  const data = mergedEventData(ev);
  try {
    const row = await Thread.findOne({ where: { threadID } });
    const rawData = row && typeof row.get === "function" ? row.get("data") : row?.data;
    let info = parseRowData(rawData);
    if (!row || !info) { await invalidateThreadCacheRow(Thread, threadID); return; }
    let mutated = false;
    if (syncParticipantListFromEvent(ev, info)) mutated = true;
    switch (logType) {
      case "log:thread-name": {
        const name = data.name != null ? String(data.name) : "";
        if (name) { info.threadName = name; info.name = name; mutated = true; }
        break;
      }
      case "log:unsubscribe": {
        const left = normalizeParticipantId(data.leftParticipantFbId);
        if (left) {
          if (Array.isArray(info.participantIDs)) { info.participantIDs = info.participantIDs.map(String).filter(id => id !== left); mutated = true; }
          if (Array.isArray(info.userInfo)) { info.userInfo = info.userInfo.filter(u => String(u?.id) !== left); mutated = true; }
        }
        if (mutated && Array.isArray(info.participantIDs) && info.participantIDs.length) {
          if (await fetchAndMergeParticipants(api, info, info.participantIDs.map(String), log)) mutated = true;
        }
        break;
      }
      case "log:subscribe": {
        const added = normalizeAddedParticipants(data.addedParticipants);
        if (added.length) {
          if (!Array.isArray(info.participantIDs)) info.participantIDs = [];
          const set = new Set(info.participantIDs.map(String));
          for (const id of added) { if (!set.has(id)) { info.participantIDs.push(id); set.add(id); mutated = true; } }
          if (await fetchAndMergeParticipants(api, info, added, log)) mutated = true;
        }
        break;
      }
      case "log:thread-icon":
      case "log:thread-image": {
        const img = data.image;
        const url = img && (img.url || img.uri);
        if (url) { info.imageSrc = String(url); mutated = true; }
        break;
      }
      case "log:thread-color": if (tryPatchThemeFromUntyped(data, info)) mutated = true; break;
      case "log:thread-admins": if (tryPatchAdminsFromUntyped(data, info)) mutated = true; break;
      case "log:user-nickname": if (tryPatchNickname(data, info)) mutated = true; break;
      case "log:thread-approval-mode": if (tryPatchApprovalMode(data, info)) mutated = true; break;
      case "log:link-status": if (tryPatchInviteLink(data, info)) mutated = true; break;
      case "log:approval-queue": {
        const q = data.approvalQueue;
        if (q && typeof q === "object") { info.approvalQueue = [...(Array.isArray(info.approvalQueue) ? info.approvalQueue : []), q]; mutated = true; }
        break;
      }
      case "log:magic-words":
      case "log:thread-poll":
      case "log:thread-pinned":
      case "log:unpin-message":
      case "log:thread-call":
      case "log:user-location":
        break;
      default:
        if (tryPatchThemeFromUntyped(data, info)) mutated = true;
        if (tryPatchAdminsFromUntyped(data, info)) mutated = true;
        if (tryPatchNickname(data, info)) mutated = true;
        if (tryPatchApprovalMode(data, info)) mutated = true;
        if (tryPatchInviteLink(data, info)) mutated = true;
        break;
    }
    if (mutated && typeof row.update === "function") await row.update({ data: info });
    else await invalidateThreadCacheRow(Thread, threadID);
  } catch (e) {
    log?.(`thread-info-realtime-sync: ${e?.message || e}`, "warn");
  }
}

function attachThreadInfoRealtimeSync(ctx, models, logger, api) {
  const Thread = models?.Thread;
  if (!Thread || typeof Thread.findOne !== "function") return false;
  const resolveApi = () => api || ctx.api;
  ctx._syncThreadInfoFromEvent = (ev) => {
    if (!ev || ev.type !== "event" || ev.threadID == null) return;
    applyThreadInfoRealtimeEvent(Thread, String(ev.threadID), ev, logger, resolveApi());
  };
  return true;
}

module.exports = { attachThreadInfoRealtimeSync, applyThreadInfoRealtimeEvent };
