"use strict";

/**
 * SHADOWX E2EE Crypto — All primitives using Node.js built-in crypto only.
 * Implements: X25519 DH, HKDF-SHA256, AES-256-GCM, HMAC-SHA256
 * Node.js >= 15 required (crypto.hkdfSync, crypto.generateKeyPairSync x25519).
 */

const crypto = require("crypto");

// ─────────────────────────────────────────────────────────
// X25519 Key Management
// ─────────────────────────────────────────────────────────

function generateKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519", {
        privateKeyEncoding: { type: "pkcs8", format: "der" },
        publicKeyEncoding: { type: "spki", format: "der" }
    });
    return {
        privateKey,
        publicKey,
        publicKeyRaw: exportRawPublicKey(publicKey)
    };
}

function exportRawPublicKey(spkiDer) {
    // X25519 SPKI DER: 12 bytes header + 32 bytes key
    return Buffer.from(spkiDer).slice(-32);
}

function importPublicKey(raw32bytes) {
    if (raw32bytes.length !== 32) throw new Error("X25519 public key must be 32 bytes");
    // Build minimal SPKI wrapper for X25519
    const header = Buffer.from("302a300506032b656e032100", "hex");
    return Buffer.concat([header, raw32bytes]);
}

function dh(privateKeyPkcs8Der, peerPublicRaw32) {
    const privKey = crypto.createPrivateKey({ key: Buffer.from(privateKeyPkcs8Der), format: "der", type: "pkcs8" });
    const pubKeyDer = importPublicKey(Buffer.from(peerPublicRaw32));
    const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: "der", type: "spki" });
    return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}

// ─────────────────────────────────────────────────────────
// HKDF-SHA256
// ─────────────────────────────────────────────────────────

function hkdf(ikm, length, salt, info) {
    if (!salt) salt = Buffer.alloc(32, 0);
    if (!info) info = Buffer.alloc(0);
    if (typeof info === "string") info = Buffer.from(info, "utf8");
    return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

function hkdfExtract(salt, ikm) {
    return crypto.createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk, info, length) {
    const results = [];
    let t = Buffer.alloc(0);
    let i = 0;
    while (results.reduce((s, b) => s + b.length, 0) < length) {
        i++;
        const hmac = crypto.createHmac("sha256", prk);
        hmac.update(t);
        if (info) hmac.update(info);
        hmac.update(Buffer.from([i]));
        t = hmac.digest();
        results.push(t);
    }
    return Buffer.concat(results).slice(0, length);
}

// ─────────────────────────────────────────────────────────
// AES-256-GCM
// ─────────────────────────────────────────────────────────

function encrypt(key32, plaintext, aad) {
    if (key32.length !== 32) throw new Error("AES-GCM key must be 32 bytes");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key32, iv);
    if (aad) cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(key32, ciphertext, aad) {
    if (key32.length !== 32) throw new Error("AES-GCM key must be 32 bytes");
    if (ciphertext.length < 28) throw new Error("Ciphertext too short");
    const iv = ciphertext.slice(0, 12);
    const authTag = ciphertext.slice(12, 28);
    const data = ciphertext.slice(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key32, iv);
    decipher.setAuthTag(authTag);
    if (aad) decipher.setAAD(aad);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ─────────────────────────────────────────────────────────
// HMAC-SHA256
// ─────────────────────────────────────────────────────────

function hmacSha256(key, data) {
    return crypto.createHmac("sha256", key).update(data).digest();
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────
// X3DH Key Agreement (Extended Triple Diffie-Hellman)
// ─────────────────────────────────────────────────────────

/**
 * Sender side of X3DH.
 * @param {object} senderIdKey    - { privateKey, publicKey, publicKeyRaw } of sender identity key
 * @param {object} ephemeralKey   - { privateKey, publicKey, publicKeyRaw } of ephemeral key
 * @param {Buffer} recipientIdPub - recipient's identity public key (raw 32 bytes)
 * @param {Buffer} recipientSpkPub - recipient's signed pre-key (raw 32 bytes)
 * @param {Buffer} [recipientOpkPub] - recipient's one-time pre-key (raw 32 bytes), optional
 * @returns {Buffer} 32-byte shared master secret
 */
function x3dhSend(senderIdKey, ephemeralKey, recipientIdPub, recipientSpkPub, recipientOpkPub) {
    const dh1 = dh(senderIdKey.privateKey, recipientSpkPub);
    const dh2 = dh(ephemeralKey.privateKey, recipientIdPub);
    const dh3 = dh(ephemeralKey.privateKey, recipientSpkPub);
    const parts = recipientOpkPub
        ? [dh1, dh2, dh3, dh(ephemeralKey.privateKey, recipientOpkPub)]
        : [dh1, dh2, dh3];
    const ikm = Buffer.concat(parts);
    const F = Buffer.alloc(32, 0xFF);
    const salt = Buffer.alloc(32, 0);
    return hkdf(Buffer.concat([F, ikm]), 32, salt, Buffer.from("WhisperText", "utf8"));
}

/**
 * Receiver side of X3DH.
 */
function x3dhReceive(recipientIdKey, recipientSpkKey, recipientOpkKey, senderIdPub, senderEphemeralPub) {
    const dh1 = dh(recipientSpkKey.privateKey, senderIdPub);
    const dh2 = dh(recipientIdKey.privateKey, senderEphemeralPub);
    const dh3 = dh(recipientSpkKey.privateKey, senderEphemeralPub);
    const parts = recipientOpkKey
        ? [dh1, dh2, dh3, dh(recipientOpkKey.privateKey, senderEphemeralPub)]
        : [dh1, dh2, dh3];
    const ikm = Buffer.concat(parts);
    const F = Buffer.alloc(32, 0xFF);
    const salt = Buffer.alloc(32, 0);
    return hkdf(Buffer.concat([F, ikm]), 32, salt, Buffer.from("WhisperText", "utf8"));
}

module.exports = {
    generateKeyPair,
    exportRawPublicKey,
    importPublicKey,
    dh,
    hkdf,
    hkdfExtract,
    hkdfExpand,
    encrypt,
    decrypt,
    hmacSha256,
    constantTimeEqual,
    x3dhSend,
    x3dhReceive,
    randomBytes: crypto.randomBytes.bind(crypto)
};
