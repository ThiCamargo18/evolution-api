import axios from 'axios';
import { prepareWAMessageMedia, WAMediaUploadFunction, WAUrlInfo } from 'baileys';
import { isURL } from 'class-validator';
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

// WhatsApp only renders the big image card when the title is non-empty, so
// this stands in for a real title: it keeps the card to just the image and
// the shared link's own domain (e.g. "mercadolivre.com"), no page title/
// description text.
function linkPreviewDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).host.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

export interface CustomLinkPreview {
  title?: string;
  // Image URL or base64 to use as the preview thumbnail instead of scraping the page.
  thumbnailUrl?: string;
}

async function loadImageBuffer(source: string): Promise<Buffer> {
  if (isURL(source)) {
    const response = await axios.get<ArrayBuffer>(source, {
      headers: REQUEST_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 10,
      maxContentLength: MAX_IMAGE_BYTES,
      responseType: 'arraybuffer',
    });

    return Buffer.from(response.data);
  }

  return Buffer.from(source, 'base64');
}

// WhatsApp's media pipeline expects JPEG for image/thumbnail-link media —
// WEBP/PNG/AVIF sources (common on e-commerce CDNs) get silently dropped by
// the client, which then falls back to the small embedded jpegThumbnail
// only, looking blurry. Re-encoding here guarantees the HD upload always
// decodes.
async function toJpegBuffer(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Builds a WAUrlInfo using a caller-supplied image instead of scraping the
 * page. The real URL from `text` is kept as matched-text/canonical-url so it
 * stays clickable and unchanged; only the card's image/title/description are
 * overridden. Lets affiliate links (Mercado Livre, Shopee, etc.) use a
 * controlled, always-crisp image instead of whatever og:image the store
 * happens to serve.
 */
async function generateCustomLinkPreview(
  matchedText: string,
  customPreview: CustomLinkPreview,
  uploadImage?: WAMediaUploadFunction,
): Promise<WAUrlInfo | undefined> {
  try {
    const urlInfo: WAUrlInfo = {
      'canonical-url': matchedText,
      'matched-text': matchedText,
      title: customPreview.title || linkPreviewDomain(matchedText),
      description: '',
    };

    const imageBuffer = await toJpegBuffer(await loadImageBuffer(customPreview.thumbnailUrl));

    urlInfo.jpegThumbnail = await sharp(imageBuffer).resize({ width: THUMBNAIL_WIDTH_PX }).jpeg().toBuffer();

    if (uploadImage) {
      const { imageMessage } = await prepareWAMessageMedia(
        { image: imageBuffer },
        { upload: uploadImage, mediaTypeOverride: 'thumbnail-link' },
      );

      if (imageMessage) {
        urlInfo.highQualityThumbnail = imageMessage as WAUrlInfo['highQualityThumbnail'];
      }
    }

    return urlInfo;
  } catch {
    return undefined;
  }
}

/**
 * Fetches Open Graph data for the first URL found in `text` using a
 * WhatsApp-spoofed User-Agent and normal (cross-domain) redirect following.
 *
 * Baileys' built-in link preview (link-preview-js) uses a generic UA and
 * refuses to follow redirects across hostnames, which is exactly the shape
 * of affiliate short links (e.g. Mercado Livre/Shopee) and why those never
 * get an image. This bypasses both limitations.
 *
 * When `customPreview.thumbnailUrl` is provided, the page is never scraped —
 * the supplied image/title/description are used directly.
 */
export const generateUrlLinkPreview = async (
  text: string,
  uploadImage?: WAMediaUploadFunction,
  customPreview?: CustomLinkPreview,
): Promise<WAUrlInfo | undefined> => {
  const matchedText = text?.match(URL_REGEX)?.[0];
  if (!matchedText) return undefined;

  if (customPreview?.thumbnailUrl) {
    const customUrlInfo = await generateCustomLinkPreview(matchedText, customPreview, uploadImage);
    if (customUrlInfo) return customUrlInfo;
  }

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

    let imageUrl = extractMetaContent(html, ['og:image', 'twitter:image']);

    if (!imageUrl) return undefined;

    const urlInfo: WAUrlInfo = {
      'canonical-url': finalUrl,
      'matched-text': matchedText,
      title: linkPreviewDomain(matchedText),
      description: '',
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

        const imageBuffer = await toJpegBuffer(Buffer.from(imageResponse.data));

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
