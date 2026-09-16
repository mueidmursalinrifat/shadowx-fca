"use strict";

var url = require("url");
const querystring = require("querystring");

function _formatAttachment(attachment1, attachment2) {
  attachment2 = attachment2 || { id: "", image_data: {} };
  attachment1 = attachment1.mercury ? attachment1.mercury : attachment1;
  var blob = attachment1.blob_attachment;
  var type =
    blob && blob.__typename ? blob.__typename : attachment1.attach_type;
  if (!type && attachment1.sticker_attachment) {
    type = "StickerAttachment";
    blob = attachment1.sticker_attachment;
  } else if (!type && attachment1.extensible_attachment) {
    if (
      attachment1.extensible_attachment.story_attachment &&
      attachment1.extensible_attachment.story_attachment.target &&
      attachment1.extensible_attachment.story_attachment.target.__typename &&
      attachment1.extensible_attachment.story_attachment.target.__typename ===
        "MessageLocation"
    )
      type = "MessageLocation";
    else type = "ExtensibleAttachment";

    blob = attachment1.extensible_attachment;
  }

  if (blob && blob.real_metadata) {
    const realMetadata = blob.real_metadata;
    if (realMetadata.Src) {
      attachment2.src = realMetadata.Src;
    }
    if (realMetadata.ThumbnailSrc) {
      attachment2.thumbnailSrc = realMetadata.ThumbnailSrc;
    }
  }

  switch (type) {
    case "sticker":
      return {
        type: "sticker",
        ID: attachment1.metadata.stickerID.toString(),
        url: attachment1.url,
        packID: attachment1.metadata.packID.toString(),
        spriteUrl: attachment1.metadata.spriteURI,
        spriteUrl2x: attachment1.metadata.spriteURI2x,
        width: attachment1.metadata.width,
        height: attachment1.metadata.height,
        caption: attachment2.caption,
        description: attachment2.description,
        frameCount: attachment1.metadata.frameCount,
        frameRate: attachment1.metadata.frameRate,
        framesPerRow: attachment1.metadata.framesPerRow,
        framesPerCol: attachment1.metadata.framesPerCol,
        stickerID: attachment1.metadata.stickerID.toString(),
        spriteURI: attachment1.metadata.spriteURI,
        spriteURI2x: attachment1.metadata.spriteURI2x,
      };
    case "file":
      return {
        type: "file",
        filename: attachment1.name,
        ID: attachment2.id.toString(),
        url: attachment1.url,
        isMalicious: attachment2.is_malicious,
        contentType: attachment2.mime_type,
        name: attachment1.name,
        mimeType: attachment2.mime_type,
        fileSize: attachment2.file_size,
      };
    case "photo":
      return {
        type: "photo",
        ID: attachment1.metadata.fbid.toString(),
        filename: attachment1.fileName,
        thumbnailUrl: attachment1.thumbnail_url,
        previewUrl: attachment1.preview_url,
        previewWidth: attachment1.preview_width,
        previewHeight: attachment1.preview_height,
        largePreviewUrl: attachment1.large_preview_url,
        largePreviewWidth: attachment1.large_preview_width,
        largePreviewHeight: attachment1.large_preview_height,
        url: attachment1.metadata.url,
        width: attachment1.metadata.dimensions.split(",")[0],
        height: attachment1.metadata.dimensions.split(",")[1],
        name: attachment1.fileName,
      };
    case "animated_image":
      return {
        type: "animated_image",
        ID: attachment2.id.toString(),
        filename: attachment2.filename,
        previewUrl: attachment1.preview_url,
        previewWidth: attachment1.preview_width,
        previewHeight: attachment1.preview_height,
        url: attachment2.image_data.url,
        width: attachment2.image_data.width,
        height: attachment2.image_data.height,
        name: attachment1.name,
        facebookUrl: attachment1.url,
        thumbnailUrl: attachment1.thumbnail_url,
        mimeType: attachment2.mime_type,
        rawGifImage: attachment2.image_data.raw_gif_image,
        rawWebpImage: attachment2.image_data.raw_webp_image,
        animatedGifUrl: attachment2.image_data.animated_gif_url,
        animatedGifPreviewUrl: attachment2.image_data.animated_gif_preview_url,
        animatedWebpUrl: attachment2.image_data.animated_webp_url,
        animatedWebpPreviewUrl:
          attachment2.image_data.animated_webp_preview_url,
      };
    case "share":
      return {
        type: "share",
        ID: attachment1.share.share_id.toString(),
        url: attachment2.href,
        title: attachment1.share.title,
        description: attachment1.share.description,
        source: attachment1.share.source,
        image: attachment1.share.media.image,
        width: attachment1.share.media.image_size.width,
        height: attachment1.share.media.image_size.height,
        playable: attachment1.share.media.playable,
        duration: attachment1.share.media.duration,
        subattachments: attachment1.share.subattachments,
        properties: {},
        animatedImageSize: attachment1.share.media.animated_image_size,
        facebookUrl: attachment1.share.uri,
        target: attachment1.share.target,
        styleList: attachment1.share.style_list,
      };
    case "video":
      return {
        type: "video",
        ID: attachment1.metadata.fbid.toString(),
        filename: attachment1.name,
        previewUrl: attachment1.preview_url,
        previewWidth: attachment1.preview_width,
        previewHeight: attachment1.preview_height,
        url: attachment1.url,
        width: attachment1.metadata.dimensions.width,
        height: attachment1.metadata.dimensions.height,
        duration: attachment1.metadata.duration,
        videoType: "unknown",
        thumbnailUrl: attachment1.thumbnail_url,
      };
    case "error":
      return {
        type: "error",
        attachment1: attachment1,
        attachment2: attachment2,
      };
    case "MessageImage":
      return {
        type: "photo",
        ID: blob.legacy_attachment_id,
        filename: blob.filename,
        thumbnailUrl: blob.thumbnail.uri,
        previewUrl: blob.preview.uri,
        previewWidth: blob.preview.width,
        previewHeight: blob.preview.height,
        largePreviewUrl: blob.large_preview.uri,
        largePreviewWidth: blob.large_preview.width,
        largePreviewHeight: blob.large_preview.height,
        url: blob.large_preview.uri,
        width: blob.original_dimensions.x,
        height: blob.original_dimensions.y,
        name: blob.filename,
      };
    case "MessageAnimatedImage":
      return {
        type: "animated_image",
        ID: blob.legacy_attachment_id,
        filename: blob.filename,
        previewUrl: blob.preview_image.uri,
        previewWidth: blob.preview_image.width,
        previewHeight: blob.preview_image.height,
        url: blob.animated_image.uri,
        width: blob.animated_image.width,
        height: blob.animated_image.height,
        thumbnailUrl: blob.preview_image.uri,
        name: blob.filename,
        facebookUrl: blob.animated_image.uri,
        rawGifImage: blob.animated_image.uri,
        animatedGifUrl: blob.animated_image.uri,
        animatedGifPreviewUrl: blob.preview_image.uri,
        animatedWebpUrl: blob.animated_image.uri,
        animatedWebpPreviewUrl: blob.preview_image.uri,
      };
    case "MessageVideo":
      return {
        type: "video",
        filename: blob.filename,
        ID: blob.legacy_attachment_id,
        previewUrl: blob.large_image.uri,
        previewWidth: blob.large_image.width,
        previewHeight: blob.large_image.height,
        url: blob.playable_url,
        width: blob.original_dimensions.x,
        height: blob.original_dimensions.y,
        duration: blob.playable_duration_in_ms,
        videoType: blob.video_type.toLowerCase(),
        thumbnailUrl: blob.large_image.uri,
      };
    case "MessageAudio":
      return {
        type: "audio",
        filename: blob.filename,
        ID: blob.url_shimhash,
        audioType: blob.audio_type,
        duration: blob.playable_duration_in_ms,
        url: blob.playable_url,
        isVoiceMail: blob.is_voicemail,
      };
    case "StickerAttachment":
      return {
        type: "sticker",
        ID: blob.id,
        url: blob.url,
        packID: blob.pack ? blob.pack.id : null,
        spriteUrl: blob.sprite_image,
        spriteUrl2x: blob.sprite_image_2x,
        width: blob.width,
        height: blob.height,
        caption: blob.label,
        description: blob.label,
        frameCount: blob.frame_count,
        frameRate: blob.frame_rate,
        framesPerRow: blob.frames_per_row,
        framesPerCol: blob.frames_per_column,
        stickerID: blob.id,
        spriteURI: blob.sprite_image,
        spriteURI2x: blob.sprite_image_2x,
      };
    case "MessageLocation": {
      var urlAttach = blob.story_attachment.url;
      var mediaAttach = blob.story_attachment.media;
      var u = querystring.parse(url.parse(urlAttach).query).u;
      var where1 = querystring.parse(url.parse(u).query).where1;
      var address = where1.split(", ");
      var latitude;
      var longitude;
      try {
        latitude = Number.parseFloat(address[0]);
        longitude = Number.parseFloat(address[1]);
      } catch (err) {}
      var imageUrl;
      var width;
      var height;
      if (mediaAttach && mediaAttach.image) {
        imageUrl = mediaAttach.image.uri;
        width = mediaAttach.image.width;
        height = mediaAttach.image.height;
      }
      return {
        type: "location",
        ID: blob.legacy_attachment_id,
        latitude: latitude,
        longitude: longitude,
        image: imageUrl,
        width: width,
        height: height,
        url: u || urlAttach,
        address: where1,
        facebookUrl: blob.story_attachment.url,
        target: blob.story_attachment.target,
        styleList: blob.story_attachment.style_list,
      };
    }
    case "ExtensibleAttachment":
      return {
        type: "share",
        ID: blob.legacy_attachment_id,
        url: blob.story_attachment.url,
        title: blob.story_attachment.title_with_entities.text,
        description:
          blob.story_attachment.description &&
          blob.story_attachment.description.text,
        source: blob.story_attachment.source
          ? blob.story_attachment.source.text
          : null,
        image:
          blob.story_attachment.media &&
          blob.story_attachment.media.image &&
          blob.story_attachment.media.image.uri,
        width:
          blob.story_attachment.media &&
          blob.story_attachment.media.image &&
          blob.story_attachment.media.image.width,
        height:
          blob.story_attachment.media &&
          blob.story_attachment.media.image &&
          blob.story_attachment.media.image.height,
        playable:
          blob.story_attachment.media &&
          blob.story_attachment.media.is_playable,
        duration:
          blob.story_attachment.media &&
          blob.story_attachment.media.playable_duration_in_ms,
        playableUrl:
          blob.story_attachment.media == null
            ? null
            : blob.story_attachment.media.playable_url,
        subattachments: blob.story_attachment.subattachments,
        properties: blob.story_attachment.properties.reduce(function (obj, cur) {
          obj[cur.key] = cur.value.text;
          return obj;
        }, {}),
        facebookUrl: blob.story_attachment.url,
        target: blob.story_attachment.target,
        styleList: blob.story_attachment.style_list,
      };
    case "MessageFile":
      return {
        type: "file",
        filename: blob.filename,
        ID: blob.message_file_fbid,
        url: blob.url,
        isMalicious: blob.is_malicious,
        contentType: blob.content_type,
        name: blob.filename,
        mimeType: "",
        fileSize: -1,
      };
    default:
      throw new Error(
        "unrecognized attach_file of type " +
          type +
          "`" +
          JSON.stringify(attachment1, null, 4) +
          " attachment2: " +
          JSON.stringify(attachment2, null, 4) +
          "`",
      );
  }
}

function formatAttachment(attachments, attachmentIds, attachmentMap, shareMap) {
  attachmentMap = shareMap || attachmentMap;
  return attachments
    ? attachments.map(function (att, idx) {
        if (
          !attachmentMap ||
          !attachmentIds ||
          !attachmentMap[attachmentIds[idx]]
        ) {
          return _formatAttachment(att);
        }
        return _formatAttachment(att, attachmentMap[attachmentIds[idx]]);
      })
    : [];
}

module.exports = {
  _formatAttachment,
  formatAttachment,
};
