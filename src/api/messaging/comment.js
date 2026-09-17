"use strict";

const utils = require("../../utils/sifuShim");

async function retryOp(fn, retries = 3, base = 600) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

async function handleUpload(defaultFuncs, ctx, msg, form) {
  if (!msg.attachments || !msg.attachments.length) return;
  const uploads = msg.attachments.map(item => {
    if (!utils.isReadableStream(item)) throw new Error("comment: attachments must be readable streams");
    return defaultFuncs.postFormData("https://www.facebook.com/ajax/ufi/upload/", ctx.jar, {
      profile_id: ctx.userID,
      source: 19,
      target_id: ctx.userID,
      file: item
    }).then(utils.parseAndCheckLogin(ctx, defaultFuncs)).then(res => {
      if (res.error || !res.payload?.fbid) throw res;
      return { media: { id: res.payload.fbid } };
    });
  });
  const results = await Promise.all(uploads);
  form.input.attachments.push(...results);
}

function handleURL(msg, form) {
  if (typeof msg.url === "string") {
    form.input.attachments.push({ link: { external: { url: msg.url } } });
  }
}

function handleMentions(msg, form) {
  if (!msg.mentions) return;
  for (const { tag, id, fromIndex } of msg.mentions) {
    if (typeof tag !== "string" || !id) {
      utils.warn("comment", `Mention skipped — tag must be string and id must be provided`);
      continue;
    }
    const offset = msg.body.indexOf(tag, fromIndex || 0);
    if (offset < 0) { utils.warn("comment", `Mention "${tag}" not found in body`); continue; }
    form.input.message.ranges.push({ entity: { id }, length: tag.length, offset });
  }
}

function handleSticker(msg, form) {
  if (msg.sticker) form.input.attachments.push({ media: { id: String(msg.sticker) } });
}

async function submitComment(defaultFuncs, ctx, form) {
  const res = await defaultFuncs.post("https://www.facebook.com/api/graphql/", ctx.jar, {
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "useCometUFICreateCommentMutation",
    variables: JSON.stringify(form),
    server_timestamps: true,
    doc_id: 6993516810709754
  }).then(utils.parseAndCheckLogin(ctx, defaultFuncs));

  if (res.errors) throw res;
  const edge = res.data?.comment_create?.feedback_comment_edge;
  if (!edge) throw new Error("comment: no feedback_comment_edge in response");

  return {
    id:        edge.node.id,
    url:       edge.node.feedback?.url || null,
    count:     res.data.comment_create.feedback?.total_comment_count || 0,
    text:      edge.node.body?.text || "",
    timestamp: Date.now()
  };
}

module.exports = (defaultFuncs, api, ctx) => {
  return async function createCommentPost(msg, postID, replyCommentID, callback) {
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof replyCommentID === "function") { callback = replyCommentID; replyCommentID = null; }
    if (typeof callback !== "function") {
      callback = (err, data) => { if (err) return rejectFunc(err); resolveFunc(data); };
    }

    try {
      if (typeof msg !== "string" && typeof msg !== "object")
        throw new Error("comment: msg must be a string or object");
      if (!postID || typeof postID !== "string")
        throw new Error("comment: postID must be a non-empty string");

      const msgObj = typeof msg === "string" ? { body: msg } : { ...msg };
      msgObj.mentions    = msgObj.mentions    || [];
      msgObj.attachments = msgObj.attachments || [];

      const form = {
        feedLocation:    "NEWSFEED",
        feedbackSource:  1,
        groupID:         null,
        input: {
          client_mutation_id:       String(Math.round(Math.random() * 19)),
          actor_id:                 ctx.userID,
          attachments:              [],
          feedback_id:              Buffer.from("feedback:" + postID).toString("base64"),
          message:                  { ranges: [], text: msgObj.body || "" },
          reply_comment_parent_fbid: replyCommentID || null,
          is_tracking_encrypted:    true,
          tracking:                 [],
          feedback_source:          "NEWS_FEED",
          idempotence_token:        "client:" + utils.getGUID(),
          session_id:               utils.getGUID()
        },
        scale:           1,
        useDefaultActor: false
      };

      await handleUpload(defaultFuncs, ctx, msgObj, form);
      handleURL(msgObj, form);
      handleMentions(msgObj, form);
      handleSticker(msgObj, form);

      const result = await retryOp(() => submitComment(defaultFuncs, ctx, form));
      callback(null, result);
    } catch (err) {
      utils.error("comment", err);
      callback(err);
    }

    return returnPromise;
  };
};
