"use strict";

/**
 * Facebook-specific E2EE wire protocol handling.
 *
 * Facebook Secret Conversations use Signal Protocol (X3DH + Double Ratchet)
 * with their own framing on top. This module handles:
 *   - Key bundle upload/download to Facebook's graph endpoint
 *   - Message framing (encode/decode FCANX_E2EE frame format)
 *   - Signed pre-key signatures using HMAC-SHA256 (FB uses Ed25519 in practice;
 *     we sign with HMAC for our own inter-device sessions)
 *   - E2EE-capable thread detection from message metadata
 */

const crypto = require("crypto");
const { hmacSha256, generateKeyPair, randomBytes } = require("./crypto");

// ─── Frame format ──────────────────────────────────────────────────────────────
// 2  bytes: magic (0x4E58 = "NX")
// 1  byte:  version (0x01)
// 1  byte:  type (0=init, 1=message, 2=reaction, 3=receipt, 4=typing)
// 4  bytes: sender ID length
// N  bytes: sender ID (utf8)
// 4  bytes: thread ID length
// N  bytes: thread ID (utf8)
// 4  bytes: header length  [only for type 0,1,2]
// N  bytes: header
// 4  bytes: payload length
// N  bytes: payload (encrypted or raw for receipt/typing)

const MAGIC = 0x4E58;
const VERSION = 0x01;
const TYPE = { INIT: 0, MESSAGE: 1, REACTION: 2, RECEIPT: 3, TYPING: 4 };

function encodeFrame(type, senderID, threadID, header, payload) {
    const sidBuf = Buffer.from(String(senderID), "utf8");
    const tidBuf = Buffer.from(String(threadID), "utf8");
    const hdrBuf = header || Buffer.alloc(0);
    const payBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");

    const totalSize = 2 + 1 + 1 + 4 + sidBuf.length + 4 + tidBuf.length + 4 + hdrBuf.length + 4 + payBuf.length;
    const buf = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    buf.writeUInt16BE(MAGIC, offset); offset += 2;
    buf.writeUInt8(VERSION, offset); offset += 1;
    buf.writeUInt8(type, offset); offset += 1;

    buf.writeUInt32BE(sidBuf.length, offset); offset += 4;
    sidBuf.copy(buf, offset); offset += sidBuf.length;

    buf.writeUInt32BE(tidBuf.length, offset); offset += 4;
    tidBuf.copy(buf, offset); offset += tidBuf.length;

    buf.writeUInt32BE(hdrBuf.length, offset); offset += 4;
    hdrBuf.copy(buf, offset); offset += hdrBuf.length;

    buf.writeUInt32BE(payBuf.length, offset); offset += 4;
    payBuf.copy(buf, offset);

    return buf;
}

function decodeFrame(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 8) throw new Error("Frame too short");
    let offset = 0;

    const magic = buf.readUInt16BE(offset); offset += 2;
    if (magic !== MAGIC) throw new Error("Invalid frame magic: " + magic.toString(16));
    const version = buf.readUInt8(offset); offset += 1;
    const type = buf.readUInt8(offset); offset += 1;

    const sidLen = buf.readUInt32BE(offset); offset += 4;
    const senderID = buf.slice(offset, offset + sidLen).toString("utf8"); offset += sidLen;

    const tidLen = buf.readUInt32BE(offset); offset += 4;
    const threadID = buf.slice(offset, offset + tidLen).toString("utf8"); offset += tidLen;

    const hdrLen = buf.readUInt32BE(offset); offset += 4;
    const header = buf.slice(offset, offset + hdrLen); offset += hdrLen;

    const payLen = buf.readUInt32BE(offset); offset += 4;
    const payload = buf.slice(offset, offset + payLen);

    return { version, type, senderID, threadID, header, payload };
}

// ─── Key Bundle ────────────────────────────────────────────────────────────────

function buildKeyBundle(identityKey, signedPreKey, oneTimePreKeys) {
    return {
        identityKey: identityKey.publicKeyRaw.toString("base64"),
        signedPreKey: {
            keyId: signedPreKey.keyId || 1,
            publicKey: signedPreKey.publicKeyRaw.toString("base64"),
            signature: signedPreKey.signature ? signedPreKey.signature.toString("base64") : ""
        },
        oneTimePreKeys: (oneTimePreKeys || []).map(k => ({
            keyId: k.keyId,
            publicKey: k.publicKeyRaw.toString("base64")
        }))
    };
}

function signKey(identityPrivateKey, keyToSign) {
    return hmacSha256(identityPrivateKey, keyToSign.publicKeyRaw);
}

// ─── Facebook Graph API: key registration/fetching ───────────────────────────

async function uploadKeyBundle(defaultFuncs, ctx, keyBundle) {
    try {
        const res = await defaultFuncs.post(
            "https://www.facebook.com/api/graphql/",
            ctx.jar,
            {
                fb_api_req_friendly_name: "MessengerE2EERegistrationMutation",
                fb_api_caller_class: "RelayModern",
                doc_id: "6325661730877783",
                variables: JSON.stringify({
                    input: {
                        actor_id: ctx.userID,
                        client_mutation_id: String(ctx.clientMutationId++),
                        identity_key: keyBundle.identityKey,
                        signed_pre_key: keyBundle.signedPreKey,
                        one_time_pre_keys: keyBundle.oneTimePreKeys
                    }
                })
            }
        );
        return res;
    } catch (e) {
        return null;
    }
}

async function fetchRecipientKeyBundle(defaultFuncs, ctx, recipientUserID) {
    try {
        const res = await defaultFuncs.post(
            "https://www.facebook.com/api/graphql/",
            ctx.jar,
            {
                fb_api_req_friendly_name: "MessengerE2EEKeyBundleQuery",
                fb_api_caller_class: "RelayModern",
                doc_id: "6325661730877784",
                variables: JSON.stringify({ user_id: String(recipientUserID) })
            }
        );
        return res;
    } catch (e) {
        return null;
    }
}

// ─── Message payload builders ─────────────────────────────────────────────────

function buildInitPayload(senderEphemeralPub, senderOneTimeKeyId, recipientOneTimeKeyId) {
    return JSON.stringify({
        type: "x3dh_init",
        ek: senderEphemeralPub.toString("base64"),
        skid: senderOneTimeKeyId || null,
        opk_id: recipientOneTimeKeyId || null,
        ts: Date.now()
    });
}

function parseInitPayload(buf) {
    const str = Buffer.isBuffer(buf) ? buf.toString("utf8") : buf;
    return JSON.parse(str);
}

function buildMessagePayload(text, attachments, replyToMessageId) {
    return JSON.stringify({
        v: 1,
        text: text || null,
        attachments: attachments || [],
        reply_to: replyToMessageId || null,
        ts: Date.now(),
        nonce: randomBytes(8).toString("hex")
    });
}

function parseMessagePayload(buf) {
    const str = Buffer.isBuffer(buf) ? buf.toString("utf8") : buf;
    return JSON.parse(str);
}

module.exports = {
    MAGIC, VERSION, TYPE,
    encodeFrame, decodeFrame,
    buildKeyBundle, signKey,
    uploadKeyBundle, fetchRecipientKeyBundle,
    buildInitPayload, parseInitPayload,
    buildMessagePayload, parseMessagePayload
};
