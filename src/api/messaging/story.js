"use strict";

const utils = require("../../utils/sifuShim");
const { URL } = require('url');
const { globalShield } = require("../../utils/sifuShim");

const STORY_CACHE = new Map();
const STORY_CACHE_TTL = 5 * 60 * 1000;
const STORY_HISTORY = [];
const MAX_HISTORY = 300;

const ALLOWED_REACTIONS = new Set(['❤️', '👍', '🤗', '😆', '😡', '😢', '😮']);

const FONT_MAP = {
  headline: '1919119914775364',
  classic: '516266749248495',
  casual: '516266749248495',
  fancy: '1790435664339626',
  bold: '1919119914775364'
};

const BG_MAP = {
  orange: '2163607613910521',
  blue: '401372137331149',
  green: '367314917184744',
  modern: '554617635055752',
  dark: '2163607613910521',
  light: '401372137331149'
};

async function retryOp(fn, retries = 4, base = 600) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const transient = /network|timeout|ECONNRESET|ETIMEDOUT|5\d\d|429/i.test(String(err?.message || err));
      if (!transient) throw err;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i) + Math.random() * 300));
    }
  }
}

function extractStoryIDFromURL(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const idx = parts.indexOf('stories');
    if (idx !== -1 && parts.length > idx + 2) return parts[idx + 2];
    const storyParam = u.searchParams.get('story_fbid');
    if (storyParam) return storyParam;
    return null;
  } catch {
    return null;
  }
}

function resolveStoryID(storyIdOrUrl) {
  if (!storyIdOrUrl) throw new Error('story: storyID or URL is required');
  const extracted = extractStoryIDFromURL(storyIdOrUrl);
  return extracted || storyIdOrUrl;
}

function recordHistory(op) {
  STORY_HISTORY.unshift({ ...op, ts: Date.now() });
  if (STORY_HISTORY.length > MAX_HISTORY) STORY_HISTORY.length = MAX_HISTORY;
}

module.exports = function (defaultFuncs, api, ctx) {

  async function sendStoryReply(storyIdOrUrl, message, isReaction, options = {}) {
    const storyID = resolveStoryID(storyIdOrUrl);
    const { retry = true, timeout = 15000 } = options;

    if (!message) throw new Error('story: message or reaction is required');

    if (isReaction && !ALLOWED_REACTIONS.has(message)) {
      throw new Error(`story: invalid reaction "${message}". Allowed: ${Array.from(ALLOWED_REACTIONS).join(' ')}`);
    }

    const variables = {
      input: {
        attribution_id_v2: 'StoriesCometSuspenseRoot.react,comet.stories.viewer,via_cold_start',
        message,
        story_id: storyID,
        story_reply_type: isReaction ? 'LIGHT_WEIGHT' : 'TEXT',
        actor_id: ctx.userID,
        client_mutation_id: String(Math.floor(Math.random() * 10 + 1))
      }
    };

    if (isReaction) {
      variables.input.lightweight_reaction_actions = { offsets: [0], reaction: message };
    }

    const form = {
      av: ctx.userID,
      __user: ctx.userID,
      __a: '1',
      fb_dtsg: ctx.fb_dtsg,
      jazoest: ctx.jazoest,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'useStoriesSendReplyMutation',
      variables: JSON.stringify(variables),
      doc_id: '9697491553691692'
    };

    await globalShield.addSmartDelay();

    const exec = () => defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form, {});
    const res = retry ? await retryOp(exec) : await exec();

    if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors));

    const storyReplyData = res.data?.data?.direct_message_reply;
    if (!storyReplyData) throw new Error('story: "direct_message_reply" not found in response');

    recordHistory({ action: isReaction ? 'react' : 'reply', storyID, message });
    return { success: true, storyID, [isReaction ? 'reaction' : 'message']: message, result: storyReplyData, timestamp: Date.now() };
  }

  async function create(message, fontName = 'classic', backgroundName = 'blue', options = {}) {
    const { retry = true } = options;
    if (!message || typeof message !== 'string') throw new Error('story.create: message must be a non-empty string');

    const fontId = FONT_MAP[fontName.toLowerCase()] || FONT_MAP.classic;
    const bgId = BG_MAP[backgroundName.toLowerCase()] || BG_MAP.blue;

    const variables = {
      input: {
        audiences: [{ stories: { self: { target_id: ctx.userID } } }],
        audiences_is_complete: true,
        logging: { composer_session_id: `createStoriesText-${Date.now()}` },
        navigation_data: { attribution_id_v2: 'StoriesCreateRoot.react,comet.stories.create' },
        source: 'WWW',
        message: { ranges: [], text: message },
        text_format_metadata: { inspirations_custom_font_id: fontId },
        text_format_preset_id: bgId,
        tracking: [null],
        actor_id: ctx.userID,
        client_mutation_id: String(Math.floor(Math.random() * 9999))
      }
    };

    const form = {
      __a: '1',
      fb_dtsg: ctx.fb_dtsg,
      jazoest: ctx.jazoest,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'StoriesCreateMutation',
      variables: JSON.stringify(variables),
      doc_id: '24226878183562473'
    };

    await globalShield.addSmartDelay();

    const exec = () => defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form, {});
    const res = retry ? await retryOp(exec) : await exec();

    if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors));

    const storyNode = res.data?.data?.story_create?.viewer?.actor?.story_bucket?.nodes?.[0]?.first_story_to_show;
    if (!storyNode?.id) throw new Error('story.create: storyID not found in response');

    recordHistory({ action: 'create', message: message.slice(0, 80), font: fontName, bg: backgroundName, storyID: storyNode.id });
    utils.log('story.create', `Story created: ${storyNode.id}`);

    return { success: true, storyID: storyNode.id, font: fontName, background: backgroundName, timestamp: Date.now() };
  }

  async function getStory(storyIdOrUrl, options = {}) {
    const storyID = resolveStoryID(storyIdOrUrl);
    const { skipCache = false } = options;
    const cacheKey = `story_${storyID}`;

    if (!skipCache) {
      const cached = STORY_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.ts < STORY_CACHE_TTL) return { ...cached.result, fromCache: true };
    }

    const form = {
      av: ctx.userID,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'StoriesRootQuery',
      variables: JSON.stringify({ story_bucket_id: storyID }),
      doc_id: '9781019695323982'
    };

    const res = await retryOp(() => defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form, {}));
    if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors));

    const result = { success: true, storyID, data: res.data, timestamp: Date.now() };
    STORY_CACHE.set(cacheKey, { result, ts: Date.now() });
    return result;
  }

  async function deleteStory(storyID, options = {}) {
    if (!storyID) throw new Error('story.delete: storyID is required');
    const { retry = true } = options;

    const form = {
      av: ctx.userID,
      __user: ctx.userID,
      fb_dtsg: ctx.fb_dtsg,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'StoriesDeleteMutation',
      variables: JSON.stringify({
        input: {
          story_id: String(storyID),
          actor_id: ctx.userID,
          client_mutation_id: String(Math.floor(Math.random() * 9999))
        }
      }),
      doc_id: '5697804170303568'
    };

    await globalShield.addSmartDelay();

    const exec = () => defaultFuncs.post('https://www.facebook.com/api/graphql/', ctx.jar, form, {});
    const res = retry ? await retryOp(exec) : await exec();
    if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors));

    STORY_CACHE.delete(`story_${storyID}`);
    recordHistory({ action: 'delete', storyID });
    return { success: true, storyID, timestamp: Date.now() };
  }

  return {
    create,
    react: (storyIdOrUrl, reaction, options) => sendStoryReply(storyIdOrUrl, reaction, true, options),
    msg: (storyIdOrUrl, message, options) => sendStoryReply(storyIdOrUrl, message, false, options),
    reply: (storyIdOrUrl, message, options) => sendStoryReply(storyIdOrUrl, message, false, options),
    get: getStory,
    delete: deleteStory,
    extractID: extractStoryIDFromURL,
    getHistory: (limit = 50) => STORY_HISTORY.slice(0, limit),
    clearCache: () => { STORY_CACHE.clear(); return { success: true }; },
    allowedReactions: Array.from(ALLOWED_REACTIONS),
    fonts: Object.keys(FONT_MAP),
    backgrounds: Object.keys(BG_MAP)
  };
};
