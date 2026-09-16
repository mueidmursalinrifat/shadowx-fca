"use strict";

/**
 * Double Ratchet Algorithm (Signal Protocol)
 * Based on the Signal Protocol specification:
 * https://signal.org/docs/specifications/doubleratchet/
 */

const { generateKeyPair, dh, hkdf, hkdfExtract, hkdfExpand, encrypt, decrypt, hmacSha256 } = require("./crypto");

const MAX_SKIP = 1000;
const INFO_RATCHET = Buffer.from("WhisperRatchet", "utf8");
const INFO_MSG = Buffer.from("WhisperMessageKeys", "utf8");

function kdfCK(ck) {
    const ck2 = hmacSha256(ck, Buffer.from([0x02]));
    const mk = hmacSha256(ck, Buffer.from([0x01]));
    return { ck: ck2, mk };
}

function kdfRK(rk, dh_out) {
    const salt = rk;
    const out = hkdf(dh_out, 64, salt, INFO_RATCHET);
    return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}

function deriveMessageKeys(mk) {
    const out = hkdf(mk, 80, Buffer.alloc(32, 0), INFO_MSG);
    return {
        encKey: out.slice(0, 32),
        authKey: out.slice(32, 64),
        iv: out.slice(64, 80)
    };
}

class DoubleRatchetSession {
    constructor() {
        this.DHs = null;          // Our DH ratchet key pair
        this.DHr = null;          // Their DH ratchet public key (raw 32 bytes)
        this.RK = null;           // Root key (32 bytes)
        this.CKs = null;          // Sending chain key
        this.CKr = null;          // Receiving chain key
        this.Ns = 0;              // Send message number
        this.Nr = 0;              // Receive message number
        this.PN = 0;              // Previous sending chain length
        this.MKSKIPPED = new Map(); // Skipped message keys
    }

    /**
     * Initialize as sender (Alice) after X3DH
     */
    initAsSender(sk, recipientRatchetPublicKey) {
        this.DHs = generateKeyPair();
        this.DHr = Buffer.from(recipientRatchetPublicKey);
        const dhOut = dh(this.DHs.privateKey, this.DHr);
        const { rk, ck } = kdfRK(sk, dhOut);
        this.RK = rk;
        this.CKs = ck;
        this.CKr = null;
        this.Ns = 0; this.Nr = 0; this.PN = 0;
    }

    /**
     * Initialize as receiver (Bob) after X3DH
     */
    initAsReceiver(sk, ourRatchetKeyPair) {
        this.DHs = ourRatchetKeyPair;
        this.DHr = null;
        this.RK = sk;
        this.CKs = null;
        this.CKr = null;
        this.Ns = 0; this.Nr = 0; this.PN = 0;
    }

    /**
     * Encrypt a message
     * Returns { header, ciphertext }
     */
    encrypt(plaintext, aad) {
        const { ck, mk } = kdfCK(this.CKs);
        this.CKs = ck;
        const header = this._buildHeader(this.DHs.publicKeyRaw, this.PN, this.Ns);
        this.Ns++;
        const keys = deriveMessageKeys(mk);
        const aadFull = aad ? Buffer.concat([aad, header]) : header;
        const ciphertext = encrypt(keys.encKey, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8"), aadFull);
        return { header, ciphertext };
    }

    /**
     * Decrypt a message
     * @param {Buffer} header - message header
     * @param {Buffer} ciphertext - encrypted payload
     * @param {Buffer} [aad] - additional auth data
     * @returns {Buffer} decrypted plaintext
     */
    decrypt(header, ciphertext, aad) {
        const { dh_pub, pn, n } = this._parseHeader(header);
        const aadFull = aad ? Buffer.concat([aad, header]) : header;

        // Check skipped keys first
        const skipKey = `${dh_pub.toString("hex")}:${n}`;
        if (this.MKSKIPPED.has(skipKey)) {
            const mk = this.MKSKIPPED.get(skipKey);
            this.MKSKIPPED.delete(skipKey);
            const keys = deriveMessageKeys(mk);
            return decrypt(keys.encKey, ciphertext, aadFull);
        }

        // Check if we need to ratchet
        const needsRatchet = !this.DHr || !dh_pub.equals(this.DHr);
        if (needsRatchet) {
            this._skipMessageKeys(pn);
            this._dhRatchetStep(dh_pub);
        }

        this._skipMessageKeys(n);
        const { ck, mk } = kdfCK(this.CKr);
        this.CKr = ck;
        this.Nr++;

        const keys = deriveMessageKeys(mk);
        return decrypt(keys.encKey, ciphertext, aadFull);
    }

    _skipMessageKeys(until) {
        if (this.Nr + MAX_SKIP < until) throw new Error("Too many skipped messages: " + until);
        if (this.CKr) {
            while (this.Nr < until) {
                const { ck, mk } = kdfCK(this.CKr);
                this.CKr = ck;
                const key = `${this.DHr.toString("hex")}:${this.Nr}`;
                this.MKSKIPPED.set(key, mk);
                this.Nr++;
            }
        }
    }

    _dhRatchetStep(remoteDhPub) {
        this.PN = this.Ns;
        this.Ns = 0;
        this.Nr = 0;
        this.DHr = remoteDhPub;

        // Receive ratchet
        const dhOut1 = dh(this.DHs.privateKey, this.DHr);
        const { rk: rk1, ck: ckr } = kdfRK(this.RK, dhOut1);
        this.RK = rk1;
        this.CKr = ckr;

        // Send ratchet
        this.DHs = generateKeyPair();
        const dhOut2 = dh(this.DHs.privateKey, this.DHr);
        const { rk: rk2, ck: cks } = kdfRK(this.RK, dhOut2);
        this.RK = rk2;
        this.CKs = cks;
    }

    _buildHeader(dhPub, pn, n) {
        const buf = Buffer.allocUnsafe(32 + 4 + 4);
        Buffer.from(dhPub).copy(buf, 0);
        buf.writeUInt32BE(pn, 32);
        buf.writeUInt32BE(n, 36);
        return buf;
    }

    _parseHeader(header) {
        if (header.length < 40) throw new Error("Invalid ratchet header length");
        return {
            dh_pub: header.slice(0, 32),
            pn: header.readUInt32BE(32),
            n: header.readUInt32BE(36)
        };
    }

    /**
     * Serialize session state for persistence
     */
    serialize() {
        return JSON.stringify({
            DHs_priv: this.DHs ? this.DHs.privateKey.toString("base64") : null,
            DHs_pub: this.DHs ? this.DHs.publicKeyRaw.toString("base64") : null,
            DHr: this.DHr ? this.DHr.toString("base64") : null,
            RK: this.RK ? this.RK.toString("base64") : null,
            CKs: this.CKs ? this.CKs.toString("base64") : null,
            CKr: this.CKr ? this.CKr.toString("base64") : null,
            Ns: this.Ns,
            Nr: this.Nr,
            PN: this.PN,
            MKSKIPPED: Array.from(this.MKSKIPPED.entries()).map(([k, v]) => [k, v.toString("base64")])
        });
    }

    /**
     * Restore session state from serialized string
     */
    static deserialize(json) {
        const d = JSON.parse(json);
        const session = new DoubleRatchetSession();
        if (d.DHs_priv) {
            session.DHs = {
                privateKey: Buffer.from(d.DHs_priv, "base64"),
                publicKey: null,
                publicKeyRaw: Buffer.from(d.DHs_pub, "base64")
            };
        }
        session.DHr = d.DHr ? Buffer.from(d.DHr, "base64") : null;
        session.RK = d.RK ? Buffer.from(d.RK, "base64") : null;
        session.CKs = d.CKs ? Buffer.from(d.CKs, "base64") : null;
        session.CKr = d.CKr ? Buffer.from(d.CKr, "base64") : null;
        session.Ns = d.Ns || 0;
        session.Nr = d.Nr || 0;
        session.PN = d.PN || 0;
        session.MKSKIPPED = new Map((d.MKSKIPPED || []).map(([k, v]) => [k, Buffer.from(v, "base64")]));
        return session;
    }
}

module.exports = { DoubleRatchetSession, kdfCK, kdfRK, deriveMessageKeys };
