import axios from 'axios';
import { prepareWAMessageMedia, WAMediaUploadFunction, WAUrlInfo } from 'baileys';
import sharp from 'sharp';

// Marketplaces like Mercado Livre and Shopee return 403 to a generic
// Node/axios User-Agent (bot protection), but allow WhatsApp's own preview
// fetcher since they want their links previewed inside chats. Spoofing it
// here lets us reach the real product page instead of an empty/blocked one.
const WA_USER_AGENT = 'WhatsApp/2.23.20.0';

const REQUEST_HEADERS = {
  'User-Agent': WA_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};

const REQUEST_TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_WIDTH_PX = 192;

const URL_REGEX = /https?:\/\/[^\s]+/i;

function extractMetaContent(html: string, properties: string[]): string | undefined {
  for (const property of properties) {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${property}["']`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1];
    }
  }

  return undefined;
}

/**
 * Fetches Open Graph data for the first URL found in `text` using a
 * WhatsApp-spoofed User-Agent and normal (cross-domain) redirect following.
 *
 * Baileys' built-in link preview (link-preview-js) uses a generic UA and
 * refuses to follow redirects across hostnames, which is exactly the shape
 * of affiliate short links (e.g. Mercado Livre/Shopee) and why those never
 * get an image. This bypasses both limitations.
 */
export const generateUrlLinkPreview = async (
  text: string,
  uploadImage?: WAMediaUploadFunction,
): Promise<WAUrlInfo | undefined> => {
  const matchedText = text?.match(URL_REGEX)?.[0];
  if (!matchedText) return undefined;

  try {
    const pageResponse = await axios.get<string>(matchedText, {
      headers: REQUEST_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 10,
      maxContentLength: MAX_PAGE_BYTES,
      responseType: 'text',
      transitional: { clarifyTimeoutError: true },
    });

    const html = pageResponse.data;
    const finalUrl = pageResponse.request?.res?.responseUrl || matchedText;

    const title = extractMetaContent(html, ['og:title']) || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    const description = extractMetaContent(html, ['og:description', 'description']);
    let imageUrl = extractMetaContent(html, ['og:image', 'twitter:image']);

    if (!title && !imageUrl) return undefined;

    const urlInfo: WAUrlInfo = {
      'canonical-url': finalUrl,
      'matched-text': matchedText,
      title: title || '',
      description: description || '',
    };

    if (imageUrl && uploadImage) {
      try {
        imageUrl = new URL(imageUrl, finalUrl).toString();

        const imageResponse = await axios.get<ArrayBuffer>(imageUrl, {
          headers: REQUEST_HEADERS,
          timeout: REQUEST_TIMEOUT_MS,
          maxRedirects: 10,
          maxContentLength: MAX_IMAGE_BYTES,
          responseType: 'arraybuffer',
        });

        const imageBuffer = Buffer.from(imageResponse.data);

        urlInfo.jpegThumbnail = await sharp(imageBuffer).resize({ width: THUMBNAIL_WIDTH_PX }).jpeg().toBuffer();

        const { imageMessage } = await prepareWAMessageMedia(
          { image: imageBuffer },
          { upload: uploadImage, mediaTypeOverride: 'thumbnail-link' },
        );

        if (imageMessage) {
          urlInfo.highQualityThumbnail = imageMessage as WAUrlInfo['highQualityThumbnail'];
          urlInfo.originalThumbnailUrl = imageUrl;
        }
      } catch {
        // Preview still works with just title/description if the image fails.
      }
    }

    return urlInfo;
  } catch {
    return undefined;
  }
};
