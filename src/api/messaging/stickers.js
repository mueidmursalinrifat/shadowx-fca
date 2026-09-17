"use strict";

const utils = require("../../utils/sifuShim");

const _cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { _cache.set(key, { data, ts: Date.now() }); return data; });
}

function normalizeSticker(node) {
  if (!node) return null;
  return {
    type:        'sticker',
    ID:          node.id,
    stickerID:   node.id,
    url:         node.image?.uri         || node.url         || null,
    animatedUrl: node.animated_image?.uri || node.animatedUrl || null,
    spriteUrl:   node.sprite_image?.uri  || null,
    packID:      node.pack?.id           || node.packID      || null,
    packName:    node.pack?.name         || null,
    label:       node.label || node.accessibility_label || null,
    width:       node.image?.width       || null,
    height:      node.image?.height      || null,
    isAnimated:  !!(node.animated_image?.uri),
  };
}

function normalizePack(node) {
  if (!node) return null;
  return {
    id:        node.id,
    name:      node.name,
    thumbnail: node.thumbnail_image?.uri || null,
    stickerCount: node.sticker_count || null,
    isOwned:   node.is_owned !== undefined ? node.is_owned : null,
    isNew:     node.is_new   || false,
  };
}

function formatPackList(data) {
  const trayPacks  = data?.data?.picker_plugins?.sticker_picker?.sticker_store?.tray_packs;
  const storePacks = data?.data?.viewer?.sticker_store?.available_packs;
  const packData   = storePacks || trayPacks;

  if (!packData) return { packs: [], page_info: { has_next_page: false }, store_id: null };

  const edges = Array.isArray(packData) ? packData : packData.edges || [];
  return {
    packs:      edges.map(e => normalizePack(e.node || e)).filter(Boolean),
    page_info:  packData.page_info || { has_next_page: false },
    store_id:   data?.data?.viewer?.sticker_store?.id || null,
  };
}

function formatStickerSearchResults(data) {
  const edges = data?.data?.sticker_search?.sticker_results?.edges || [];
  return edges.map(e => normalizeSticker(e.node)).filter(Boolean);
}

function formatStickerPackResults(data) {
  const edges = data?.data?.sticker_pack?.stickers?.edges || [];
  return edges.map(e => normalizeSticker(e.node)).filter(Boolean);
}

function formatAiStickers(data) {
  const nodes = data?.data?.xfb_trending_generated_ai_stickers?.nodes || [];
  return nodes.map(n => normalizeSticker(n)).filter(Boolean);
}

function formatRecentStickers(data) {
  const edges = data?.data?.viewer?.recent_stickers?.edges || [];
  return edges.map(e => normalizeSticker(e.node)).filter(Boolean);
}

function formatTrayStickers(data) {
  const plugins = data?.data?.picker_plugins?.sticker_picker?.recent_stickers;
  if (!plugins) return [];
  const stickers = Array.isArray(plugins) ? plugins : plugins.edges?.map(e => e.node) || [];
  return stickers.map(normalizeSticker).filter(Boolean);
}

module.exports = function (defaultFuncs, api, ctx) {

  
  async function makeRequest(form, retries = 3, baseMs = 500) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resData = await defaultFuncs
          .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs));

        if (!resData) throw new Error("GraphQL returned no data");
        if (resData.errors) {
          const msg = resData.errors[0]?.message || JSON.stringify(resData.errors);
          throw Object.assign(new Error(msg), { isFatal: /auth|permission|checkpoint/i.test(msg) });
        }
        return resData;
      } catch (err) {
        lastErr = err;
        if (err.isFatal || attempt >= retries) throw err;
        const wait = baseMs * Math.pow(2, attempt - 1) + Math.random() * 200;
        utils.warn("StickerAPI", `Retry ${attempt}/${retries} in ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  return {

    

    search: async function (query, options = {}) {
      if (!query) throw new Error("stickers.search: query is required");
      const w = options.width  || 128;
      const h = options.height || 128;
      const form = {
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'CometStickerPickerSearchResultsRootQuery',
        variables: JSON.stringify({
          scale:            3,
          search_query:     query.trim(),
          sticker_height:   h,
          sticker_width:    w,
          stickerInterface: "MESSAGES",
        }),
        doc_id: '24004987559125954',
      };
      const res = await makeRequest(form);
      let stickers = formatStickerSearchResults(res);
      if (options.limit) stickers = stickers.slice(0, options.limit);
      return stickers;
    },

    

    listPacks: async function () {
      return cached('listPacks', async () => {
        const form = {
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'CometStickerPickerCardQuery',
          variables: JSON.stringify({ scale: 3, stickerInterface: "MESSAGES" }),
          doc_id:   '10095807770482952',
        };
        const res = await makeRequest(form);
        return formatPackList(res).packs;
      });
    },

    

    getStorePacks: async function (options = {}) {
      const maxPages = options.maxPages || 50;
      utils.log("StickerAPI", "Fetching all store packs (auto-paginated)...");
      let allPacks = [], page = 0;

      const firstForm = {
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'CometStickersStoreDialogQuery',
        variables: JSON.stringify({}),
        doc_id:   '29237828849196584',
      };
      let res = await makeRequest(firstForm);
      let { packs, page_info, store_id } = formatPackList(res);
      allPacks.push(...packs);
      page++;

      while (page_info?.has_next_page && page < maxPages) {
        const nextForm = {
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'CometStickersStorePackListPaginationQuery',
          variables: JSON.stringify({ count: 20, cursor: page_info.end_cursor, id: store_id }),
          doc_id:   '9898634630218439',
        };
        res = await makeRequest(nextForm);
        const next = formatPackList(res);
        allPacks.push(...next.packs);
        page_info = next.page_info;
        page++;
      }

      utils.log("StickerAPI", `Fetched ${allPacks.length} store packs in ${page} pages`);
      return allPacks;
    },

    

    listAllPacks: async function () {
      const [myPacks, storePacks] = await Promise.all([this.listPacks(), this.getStorePacks()]);
      const map = new Map();
      [...myPacks, ...storePacks].forEach(p => map.set(p.id, p));
      return Array.from(map.values());
    },

    

    addPack: async function (packID) {
      if (!packID) throw new Error("stickers.addPack: packID is required");
      const form = {
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'CometStickersStorePackMutationAddMutation',
        variables: JSON.stringify({
          input: {
            pack_id:             packID,
            actor_id:            ctx.userID,
            client_mutation_id:  String(Date.now() % 1e9),
          }
        }),
        doc_id: '9877489362345320',
      };
      const res = await makeRequest(form);
      return normalizePack(res.data?.sticker_pack_add?.sticker_pack) || res.data;
    },

    

    removePack: async function (packID) {
      if (!packID) throw new Error("stickers.removePack: packID is required");
      const form = {
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'CometStickersStorePackMutationRemoveMutation',
        variables: JSON.stringify({
          input: {
            pack_id:             packID,
            actor_id:            ctx.userID,
            client_mutation_id:  String(Date.now() % 1e9),
          }
        }),
        doc_id: '25244534060527988',
      };
      const res = await makeRequest(form);
      return res.data;
    },

    

    getStickersInPack: async function (packID, options = {}) {
      if (!packID) throw new Error("stickers.getStickersInPack: packID is required");
      return cached(`pack::${packID}`, async () => {
        const form = {
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'CometStickerPickerPackContentRootQuery',
          variables: JSON.stringify({
            packID,
            stickerWidth:  options.width  || 128,
            stickerHeight: options.height || 128,
            scale:         3,
          }),
          doc_id: '23982341384707469',
        };
        const res = await makeRequest(form);
        return formatStickerPackResults(res);
      });
    },

    

    getAiStickers: async function ({ limit = 20 } = {}) {
      return cached(`ai_stickers::${limit}`, async () => {
        const form = {
          fb_api_caller_class:      'RelayModern',
          fb_api_req_friendly_name: 'CometStickerPickerStickerGeneratedCardQuery',
          variables: JSON.stringify({ limit }),
          doc_id:   '24151467751156443',
        };
        const res = await makeRequest(form);
        return formatAiStickers(res);
      });
    },

    

    getRecentStickers: async function ({ limit = 30 } = {}) {
      const form = {
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'CometStickerPickerRecentStickersQuery',
        variables: JSON.stringify({ scale: 3, stickerInterface: "MESSAGES" }),
        doc_id:   '10095807770482952',
      };
      const res = await makeRequest(form);
      const tray = formatTrayStickers(res);
      return tray.slice(0, limit);
    },

    

    resolveSticker: async function (stickerIDs) {
      const ids  = Array.isArray(stickerIDs) ? stickerIDs : [stickerIDs];
      const form = {
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'CometStickerPickerStickerQuery',
        variables: JSON.stringify({ stickerIDs: ids, scale: 3 }),
        doc_id:   '9580756598638278',
      };
      try {
        const res = await makeRequest(form);
        const nodes = (res?.data?.stickers || ids.map(() => null));
        const resolved = (Array.isArray(nodes) ? nodes : Object.values(nodes))
          .map(n => normalizeSticker(n)).filter(Boolean);
        return ids.length === 1 ? (resolved[0] || null) : resolved;
      } catch {
        
        const fallback = ids.map(id => ({ type: 'sticker', ID: id, stickerID: id }));
        return ids.length === 1 ? fallback[0] : fallback;
      }
    },

    

    generateAiSticker: async function (prompt, { numResults = 4 } = {}) {
      if (!prompt) throw new Error("stickers.generateAiSticker: prompt is required");
      const form = {
        av:                       ctx.userID,
        __user:                   ctx.userID,
        fb_dtsg:                  ctx.fb_dtsg,
        fb_api_caller_class:      'RelayModern',
        fb_api_req_friendly_name: 'useGenerateAIStickerMutation',
        variables: JSON.stringify({
          input: {
            client_mutation_id: String(Date.now() % 1e9),
            actor_id:           ctx.userID,
            num_results:        Math.min(numResults, 8),
            prompt:             prompt.trim(),
          }
        }),
        server_timestamps: true,
        doc_id:            '6774614342659830',
      };
      const res     = await makeRequest(form);
      const stickers = res?.data?.xfb_generate_ai_sticker?.stickers || [];
      return stickers.map(normalizeSticker).filter(Boolean);
    },

  };
};
