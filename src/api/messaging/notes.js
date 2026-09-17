"use strict";

const utils = require("../../utils/sifuShim");

const PRIVACY_VALUES = new Set(['EVERYONE', 'FRIENDS', 'CLOSE_FRIENDS', 'CUSTOM', 'ONLY_ME']);
const DEFAULT_DURATION = 86400; 

function wrapPromise(fn) {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const cb = (err, data) => { if (err) reject(err); else resolve(data); };
  fn(cb);
  return promise;
}

async function gqlPost(defaultFuncs, ctx, form, retries = 3, baseMs = 500) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resData = await defaultFuncs
        .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs));
      if (resData?.errors) {
        const msg = resData.errors[0]?.message || JSON.stringify(resData.errors);
        throw Object.assign(new Error(msg), { isFatal: /auth|permission|checkpoint/i.test(msg) });
      }
      return resData;
    } catch (err) {
      lastErr = err;
      if (err.isFatal || attempt >= retries) throw err;
      const wait = baseMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      utils.warn("notes", `Retry ${attempt}/${retries} in ${Math.round(wait)}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = function (defaultFuncs, api, ctx) {

  

  function checkNote(callback) {
    const form = {
      fb_api_caller_class:      "RelayModern",
      fb_api_req_friendly_name: "MWInboxTrayNoteCreationDialogQuery",
      variables:                JSON.stringify({ scale: 2 }),
      doc_id:                   "30899655739648624",
    };

    const exec = async cb => {
      try {
        const res = await gqlPost(defaultFuncs, ctx, form);
        const note = res?.data?.viewer?.actor?.msgr_user_rich_status || null;
        const out = note ? {
          noteID:       note.id,
          text:         note.text || note.description || null,
          emoji:        note.emoji || null,
          privacyLevel: note.privacy || null,
          createdAt:    note.creation_time || null,
          expiresAt:    note.expiration_time || null,
          isActive:     true,
        } : null;
        cb(null, out);
      } catch (err) {
        utils.error("notes.checkNote", err.message || err);
        cb(err);
      }
    };

    if (callback) { exec(callback); return; }
    return wrapPromise(exec);
  }

  

  function createNote(text, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    const privacy  = PRIVACY_VALUES.has(options.privacy) ? options.privacy : 'EVERYONE';
    const duration = options.duration || DEFAULT_DURATION;

    const input = {
      client_mutation_id: String(Date.now() % 1e9),
      actor_id:           ctx.userID,
      description:        typeof text === 'string' ? text : String(text),
      duration,
      note_type:          "TEXT_NOTE",
      privacy,
      session_id:         utils.getGUID ? utils.getGUID() : String(Math.random()),
    };
    if (options.emoji) input.emoji = options.emoji;

    const form = {
      fb_api_caller_class:      "RelayModern",
      fb_api_req_friendly_name: "MWInboxTrayNoteCreationDialogCreationStepContentMutation",
      variables:                JSON.stringify({ input }),
      doc_id:                   "24060573783603122",
    };

    const exec = async cb => {
      try {
        const res = await gqlPost(defaultFuncs, ctx, form);
        const status = res?.data?.xfb_rich_status_create?.status;
        if (!status) throw new Error("No note status in response — creation may have failed");
        cb(null, {
          noteID:       status.id,
          text:         status.text || text,
          emoji:        status.emoji || options.emoji || null,
          privacyLevel: privacy,
          duration,
          expiresAt:    status.expiration_time || (Date.now() + duration * 1000),
          createdAt:    Date.now(),
        });
      } catch (err) {
        utils.error("notes.createNote", err.message || err);
        cb(err);
      }
    };

    if (callback) { exec(callback); return; }
    return wrapPromise(exec);
  }

  

  function deleteNote(noteID, callback) {
    const ids = Array.isArray(noteID) ? noteID : [noteID];

    const deleteOne = async id => {
      const form = {
        fb_api_caller_class:      "RelayModern",
        fb_api_req_friendly_name: "useMWInboxTrayDeleteNoteMutation",
        variables:                JSON.stringify({
          input: {
            client_mutation_id: String(Date.now() % 1e9),
            actor_id:           ctx.userID,
            rich_status_id:     id,
          }
        }),
        doc_id: "9532619970198958",
      };
      const res = await gqlPost(defaultFuncs, ctx, form);
      if (!res?.data?.xfb_rich_status_delete) throw new Error(`Delete note ${id}: no confirmation in response`);
      return { success: true, noteID: id };
    };

    const exec = async cb => {
      try {
        const results = await Promise.all(ids.map(deleteOne));
        cb(null, ids.length === 1 ? results[0] : results);
      } catch (err) {
        utils.error("notes.deleteNote", err.message || err);
        cb(err);
      }
    };

    if (callback) { exec(callback); return; }
    return wrapPromise(exec);
  }

  

  function recreateNote(oldNoteID, newText, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    const exec = async cb => {
      try {
        const deleted = await new Promise((res, rej) => deleteNote(oldNoteID, (err, d) => err ? rej(err) : res(d)));
        const created = await new Promise((res, rej) => createNote(newText, options, (err, c) => err ? rej(err) : res(c)));
        cb(null, { deleted, created });
      } catch (err) {
        utils.error("notes.recreateNote", err.message || err);
        cb(err);
      }
    };

    if (callback) { exec(callback); return; }
    return wrapPromise(exec);
  }

  

  function updateNote(oldNoteID, newText, options, callback) {
    return recreateNote(oldNoteID, newText, options, callback);
  }

  

  async function replaceActiveNote(newText, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};

    const exec = async cb => {
      try {
        const current = await new Promise((res, rej) => checkNote((err, n) => err ? rej(err) : res(n)));
        let deleted = null;
        if (current?.noteID) {
          deleted = await new Promise((res, rej) => deleteNote(current.noteID, (err, d) => err ? rej(err) : res(d)));
        }
        if (!newText) return cb(null, { deleted, created: null });
        const created = await new Promise((res, rej) => createNote(newText, options, (err, c) => err ? rej(err) : res(c)));
        cb(null, { deleted, created });
      } catch (err) {
        utils.error("notes.replaceActiveNote", err.message || err);
        cb(err);
      }
    };

    if (callback) { exec(callback); return; }
    return wrapPromise(exec);
  }

  return {
    create:             createNote,
    delete:             deleteNote,
    recreate:           recreateNote,
    update:             updateNote,
    check:              checkNote,
    replaceActive:      replaceActiveNote,
  };
};
