"use strict";

const e2ee = require("../../utils/sifuShim");

module.exports = function (defaultFuncs, api, ctx) {
  const PEER_CACHE = new Map();

  function getPeerCount() {
    if (!ctx._e2eePeers) return 0;
    return Object.keys(ctx._e2eePeers).length;
  }

  function getStats() {
    return {
      enabled: e2ee.isEnabled(ctx),
      peerCount: getPeerCount(),
      hasPublicKey: !!e2ee.getPublicKey(ctx),
      peerIDs: ctx._e2eePeers ? Object.keys(ctx._e2eePeers) : []
    };
  }

  function exportKeyring() {
    return {
      publicKey: e2ee.getPublicKey(ctx),
      peers: ctx._e2eePeers ? { ...ctx._e2eePeers } : {},
      exportedAt: Date.now()
    };
  }

  function importKeyring(keyring) {
    if (!keyring || typeof keyring !== "object") throw new Error("e2ee.importKeyring: invalid keyring object");
    if (keyring.peers && typeof keyring.peers === "object") {
      for (const [threadID, key] of Object.entries(keyring.peers)) {
        e2ee.setPeerKey(ctx, threadID, key);
      }
    }
    return { success: true, importedPeers: Object.keys(keyring.peers || {}).length };
  }

  function encryptBatch(entries) {
    if (!Array.isArray(entries)) throw new Error("e2ee.encryptBatch: entries must be an array");
    return entries.map(({ threadID, text }) => {
      try {
        return { threadID, encrypted: e2ee.encrypt(ctx, threadID, text), error: null };
      } catch (err) {
        return { threadID, encrypted: null, error: err.message };
      }
    });
  }

  function decryptBatch(entries) {
    if (!Array.isArray(entries)) throw new Error("e2ee.decryptBatch: entries must be an array");
    return entries.map(({ threadID, armored }) => {
      try {
        return { threadID, decrypted: e2ee.decrypt(ctx, threadID, armored), error: null };
      } catch (err) {
        return { threadID, decrypted: null, error: err.message };
      }
    });
  }

  function rotatePeerKey(threadID, newPeerPublicKeyB64) {
    e2ee.clearPeerKey(ctx, threadID);
    e2ee.setPeerKey(ctx, newPeerPublicKeyB64 ? threadID : null, newPeerPublicKeyB64);
    return { success: true, threadID, rotated: !!newPeerPublicKeyB64 };
  }

  return {
    enable() { e2ee.enable(ctx); return { success: true, enabled: true }; },
    disable() { e2ee.disable(ctx); return { success: true, enabled: false }; },
    isEnabled() { return e2ee.isEnabled(ctx); },
    getPublicKey() { return e2ee.getPublicKey(ctx); },
    setPeerKey(threadID, peerPublicKeyB64) {
      if (!threadID) throw new Error("e2ee.setPeerKey: threadID is required");
      if (!peerPublicKeyB64) throw new Error("e2ee.setPeerKey: peerPublicKeyB64 is required");
      e2ee.setPeerKey(ctx, threadID, peerPublicKeyB64);
      PEER_CACHE.set(threadID, { key: peerPublicKeyB64, ts: Date.now() });
      return { success: true, threadID };
    },
    clearPeerKey(threadID) {
      e2ee.clearPeerKey(ctx, threadID);
      PEER_CACHE.delete(threadID);
      return { success: true, threadID };
    },
    hasPeer(threadID) { return e2ee.hasPeer(ctx, threadID); },
    encrypt(threadID, text) { return e2ee.encrypt(ctx, threadID, text); },
    decrypt(threadID, armored) { return e2ee.decrypt(ctx, threadID, armored); },
    getStats,
    exportKeyring,
    importKeyring,
    encryptBatch,
    decryptBatch,
    rotatePeerKey,
    clearAllPeers() {
      const peers = ctx._e2eePeers ? Object.keys(ctx._e2eePeers) : [];
      peers.forEach(id => e2ee.clearPeerKey(ctx, id));
      PEER_CACHE.clear();
      return { success: true, clearedCount: peers.length };
    }
  };
};
