"use strict";

/**
 * E2EE Device/Session Store
 * Persists key material to a JSON file (encrypted with a device secret).
 * Each E2EE session (thread) is stored separately.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class E2EEStore {
    constructor(storePath, userID) {
        this.storePath = storePath;
        this.userID = userID;
        this.data = {
            identityKey: null,
            signedPreKey: null,
            oneTimePreKeys: [],
            sessions: {},      // threadID -> serialized DoubleRatchetSession
            deviceSecret: null // 32-byte random secret for local encryption
        };
        this._loaded = false;
    }

    _storeFile() {
        return path.join(this.storePath, `fcanx_e2ee_${this.userID}.json`);
    }

    _salt() {
        return Buffer.from(this.userID.padEnd(16, "0").slice(0, 16), "utf8");
    }

    _localEncrypt(data) {
        if (!this.data.deviceSecret) return data;
        const key = Buffer.from(this.data.deviceSecret, "base64");
        if (key.length !== 32) return data;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const enc = Buffer.concat([cipher.update(Buffer.from(data, "utf8")), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, enc]).toString("base64");
    }

    _localDecrypt(data) {
        if (!this.data.deviceSecret) return data;
        try {
            const key = Buffer.from(this.data.deviceSecret, "base64");
            if (key.length !== 32) return data;
            const buf = Buffer.from(data, "base64");
            const iv = buf.slice(0, 12);
            const tag = buf.slice(12, 28);
            const enc = buf.slice(28);
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
        } catch (_) {
            return data;
        }
    }

    load() {
        const file = this._storeFile();
        if (!fs.existsSync(file)) return false;
        try {
            const raw = fs.readFileSync(file, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.deviceSecret) this.data.deviceSecret = parsed.deviceSecret;
            const decrypted = this._localDecrypt(parsed.payload || "{}");
            const payload = JSON.parse(decrypted);
            this.data.identityKey = payload.identityKey || null;
            this.data.signedPreKey = payload.signedPreKey || null;
            this.data.oneTimePreKeys = payload.oneTimePreKeys || [];
            this.data.sessions = payload.sessions || {};
            this._loaded = true;
            return true;
        } catch (_) {
            return false;
        }
    }

    save() {
        if (!fs.existsSync(this.storePath)) {
            fs.mkdirSync(this.storePath, { recursive: true });
        }
        if (!this.data.deviceSecret) {
            this.data.deviceSecret = crypto.randomBytes(32).toString("base64");
        }
        const payload = JSON.stringify({
            identityKey: this.data.identityKey,
            signedPreKey: this.data.signedPreKey,
            oneTimePreKeys: this.data.oneTimePreKeys,
            sessions: this.data.sessions
        });
        const encrypted = this._localEncrypt(payload);
        fs.writeFileSync(this._storeFile(), JSON.stringify({ deviceSecret: this.data.deviceSecret, payload: encrypted }, null, 2), "utf8");
    }

    hasIdentityKey() { return !!this.data.identityKey; }

    getIdentityKey() {
        const ik = this.data.identityKey;
        if (!ik) return null;
        return {
            privateKey: Buffer.from(ik.privateKey, "base64"),
            publicKey: Buffer.from(ik.publicKey, "base64"),
            publicKeyRaw: Buffer.from(ik.publicKeyRaw, "base64")
        };
    }

    setIdentityKey(keyPair) {
        this.data.identityKey = {
            privateKey: keyPair.privateKey.toString("base64"),
            publicKey: keyPair.publicKey.toString("base64"),
            publicKeyRaw: keyPair.publicKeyRaw.toString("base64")
        };
    }

    getSignedPreKey() {
        const spk = this.data.signedPreKey;
        if (!spk) return null;
        return {
            privateKey: Buffer.from(spk.privateKey, "base64"),
            publicKey: Buffer.from(spk.publicKey, "base64"),
            publicKeyRaw: Buffer.from(spk.publicKeyRaw, "base64"),
            signature: Buffer.from(spk.signature, "base64"),
            keyId: spk.keyId
        };
    }

    setSignedPreKey(keyPair) {
        this.data.signedPreKey = {
            privateKey: keyPair.privateKey.toString("base64"),
            publicKey: keyPair.publicKey.toString("base64"),
            publicKeyRaw: keyPair.publicKeyRaw.toString("base64"),
            signature: keyPair.signature ? keyPair.signature.toString("base64") : "",
            keyId: keyPair.keyId || 1
        };
    }

    getOneTimePreKeys() {
        return (this.data.oneTimePreKeys || []).map(k => ({
            privateKey: Buffer.from(k.privateKey, "base64"),
            publicKey: Buffer.from(k.publicKey, "base64"),
            publicKeyRaw: Buffer.from(k.publicKeyRaw, "base64"),
            keyId: k.keyId
        }));
    }

    addOneTimePreKey(keyPair) {
        this.data.oneTimePreKeys = this.data.oneTimePreKeys || [];
        this.data.oneTimePreKeys.push({
            privateKey: keyPair.privateKey.toString("base64"),
            publicKey: keyPair.publicKey.toString("base64"),
            publicKeyRaw: keyPair.publicKeyRaw.toString("base64"),
            keyId: keyPair.keyId
        });
    }

    consumeOneTimePreKey(keyId) {
        const idx = (this.data.oneTimePreKeys || []).findIndex(k => k.keyId === keyId);
        if (idx < 0) return null;
        const k = this.data.oneTimePreKeys.splice(idx, 1)[0];
        return {
            privateKey: Buffer.from(k.privateKey, "base64"),
            publicKey: Buffer.from(k.publicKey, "base64"),
            publicKeyRaw: Buffer.from(k.publicKeyRaw, "base64"),
            keyId: k.keyId
        };
    }

    hasSession(threadID) { return !!this.data.sessions[threadID]; }

    getSession(threadID) { return this.data.sessions[threadID] || null; }

    setSession(threadID, serializedSession) { this.data.sessions[threadID] = serializedSession; }

    deleteSession(threadID) { delete this.data.sessions[threadID]; }
}

module.exports = { E2EEStore };
