// sticker.js — WhatsApp 512x512 WebP sticker pipeline with size-stepping & EXIF metadata
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webp from 'node-webpmux';
import { assertSafePublicUrl, run, TEMP_ROOT } from './downloader.js';

const MAX_FETCH_BYTES = 15 * 1024 * 1024; // 15 MB download ceiling
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const STATIC_MAX_BYTES = 98 * 1024; // < 100 KB target for static stickers
const ANIMATED_MAX_BYTES = 485 * 1024; // < 500 KB target (with EXIF headroom) for animated stickers

const ALLOWED_IMAGE_MIMES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const FIT_FILTER =
  'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
const CROP_FILTER =
  'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba';

/**
 * Inspect whether an input file is animated (GIF, multi-frame WebP, or video).
 */
export async function isAnimatedMedia(filePath, mimeHint = '') {
  const lowerMime = (mimeHint || '').toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  if (lowerMime === 'image/gif' || lowerMime.startsWith('video/') || ext === '.gif' || ext === '.mp4' || ext === '.webm') {
    return true;
  }

  // Check WebP RIFF header for ANIM / ANMF chunks before invoking ffprobe
  if (lowerMime === 'image/webp' || ext === '.webp') {
    try {
      const fd = await fs.promises.open(filePath, 'r');
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fd.read(buf, 0, 64, 0);
      await fd.close();
      const headerSlice = buf.subarray(0, bytesRead);
      if (headerSlice.includes(Buffer.from('ANIM')) || headerSlice.includes(Buffer.from('ANMF'))) {
        return true;
      }
    } catch {
      // fall through to ffprobe
    }
  }

  try {
    const out = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-count_frames',
      '-show_entries', 'stream=nb_read_frames,nb_frames:format=duration',
      '-of', 'json',
      filePath,
    ]);
    const parsed = JSON.parse(out);
    const stream = parsed.streams?.[0] || {};
    const frames = Number(stream.nb_read_frames || stream.nb_frames || 1);
    const duration = Number(parsed.format?.duration || 0);
    return frames > 1 || duration > 0.1;
  } catch {
    return false;
  }
}

/**
 * Safely fetch an image/GIF from an http(s) URL with a 15s timeout and 15 MB ceiling.
 * @returns {Promise<{ inputPath: string, isAnimated: boolean }>}
 */
export async function fetchImageFromUrl(url, jobDir) {
  let currentUrl = url;
  let parsed;
  let res;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    parsed = await assertSafePublicUrl(currentUrl);
    res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location || hop === MAX_REDIRECTS) {
        throw new Error('Too many or invalid redirects');
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }
    break;
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch image URL (HTTP ${res.status})`);
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const urlExt = path.extname(parsed.pathname).toLowerCase();

  const extFromMime = ALLOWED_IMAGE_MIMES.get(contentType);
  const hasValidExt = ALLOWED_IMAGE_EXTS.has(urlExt);

  if (!extFromMime && !hasValidExt) {
    throw new Error('URL does not point to a supported image (JPEG, PNG, WebP, or GIF)');
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > MAX_FETCH_BYTES) {
    throw new Error('Image exceeds the 15 MB size limit');
  }

  if (!res.body) {
    throw new Error('Empty response body from image URL');
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of res.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_FETCH_BYTES) {
      throw new Error('Image exceeds the 15 MB size limit');
    }
    chunks.push(Buffer.from(chunk));
  }

  const finalExt = extFromMime || (urlExt === '.jpeg' ? '.jpg' : urlExt) || '.img';
  const inputPath = path.join(jobDir, `source${finalExt}`);
  await fs.promises.writeFile(inputPath, Buffer.concat(chunks));

  const isAnimated = await isAnimatedMedia(inputPath, contentType);
  return { inputPath, isAnimated };
}

/**
 * Convert an image or short clip into a 512x512 WhatsApp WebP sticker,
 * stepping down encoding quality to respect <100 KB (static) or <500 KB (animated).
 */
export async function convertToStickerWebp(
  inputPath,
  outputPath,
  { isAnimated = false, crop = false } = {},
) {
  const baseFilter = crop ? CROP_FILTER : FIT_FILTER;

  if (!isAnimated) {
    const qualities = [80, 55, 35, 15];
    for (const q of qualities) {
      await run('ffmpeg', [
        '-y', '-i', inputPath,
        '-vf', baseFilter,
        '-vframes', '1',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', String(q),
        '-an',
        outputPath,
      ]);
      const { size } = await fs.promises.stat(outputPath);
      if (size <= STATIC_MAX_BYTES) {
        return outputPath;
      }
    }
    return outputPath;
  }

  // Animated pipeline (< 500 KB ceiling, max 6s, 15fps)
  const animatedFilter = `${baseFilter},fps=15`;
  const qualities = [65, 45, 25, 12];
  for (const q of qualities) {
    await run('ffmpeg', [
      '-y', '-t', '6', '-i', inputPath,
      '-vf', animatedFilter,
      '-loop', '0',
      '-c:v', 'libwebp',
      '-lossless', '0',
      '-compression_level', '6',
      '-q:v', String(q),
      '-preset', 'default',
      '-an',
      outputPath,
    ]);
    const { size } = await fs.promises.stat(outputPath);
    if (size <= ANIMATED_MAX_BYTES) {
      return outputPath;
    }
  }

  // Final fallback for dense animations: 10 fps + 384x384 inner detail padded to 512x512
  const fallbackFilter = crop
    ? 'scale=384:384:force_original_aspect_ratio=increase,crop=384:384,scale=512:512,format=rgba,fps=10'
    : 'scale=384:384:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=10';

  await run('ffmpeg', [
    '-y', '-t', '5', '-i', inputPath,
    '-vf', fallbackFilter,
    '-loop', '0',
    '-c:v', 'libwebp',
    '-lossless', '0',
    '-compression_level', '6',
    '-q:v', '10',
    '-preset', 'default',
    '-an',
    outputPath,
  ]);
  return outputPath;
}

/**
 * Inject WhatsApp Sticker Pack EXIF metadata into a WebP buffer via node-webpmux.
 */
export async function addStickerExif(
  webpBuffer,
  {
    packId = 'citamo-bot-pack',
    packName = 'Citamo Bot',
    author = 'citamo-bot',
    emojis = ['✨'],
  } = {},
) {
  const jsonPayload = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': packId,
      'sticker-pack-name': packName,
      'sticker-pack-publisher': author,
      emojis,
    }),
    'utf-8',
  );

  // Standard 22-byte little-endian TIFF header used by WhatsApp for sticker EXIF
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  exifAttr.writeUInt32LE(jsonPayload.length, 14);

  const exifBuffer = Buffer.concat([exifAttr, jsonPayload]);
  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = exifBuffer;
  return img.save(null);
}

/**
 * Full sticker job pipeline with guaranteed `./temp/sticker_<jobId>/` cleanup.
 * Accepts either `{ buffer, mime, ext, isAnimated, crop }` or `{ url, crop }`.
 * @returns {Promise<Buffer>} Final WebP sticker buffer with WhatsApp EXIF
 */
export async function createSticker({
  buffer = null,
  mime = '',
  ext = '',
  isAnimated = null,
  url = null,
  crop = false,
  packName = 'Citamo Bot',
  author = 'citamo-bot',
} = {}) {
  const jobDir = path.join(TEMP_ROOT, `sticker_${crypto.randomUUID()}`);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    let inputPath;
    let animated = isAnimated === true;

    if (buffer) {
      const safeExt = ext || ALLOWED_IMAGE_MIMES.get(mime.toLowerCase()) || (mime.startsWith('video/') ? '.mp4' : '.bin');
      inputPath = path.join(jobDir, `input${safeExt}`);
      await fs.promises.writeFile(inputPath, buffer);
      if (!animated) {
        animated = await isAnimatedMedia(inputPath, mime);
      }
    } else if (url) {
      const fetched = await fetchImageFromUrl(url, jobDir);
      inputPath = fetched.inputPath;
      animated = fetched.isAnimated;
    } else {
      throw new Error('No media buffer or image URL provided');
    }

    const outputPath = path.join(jobDir, 'sticker.webp');
    await convertToStickerWebp(inputPath, outputPath, { isAnimated: animated, crop });

    const rawWebp = await fs.promises.readFile(outputPath);
    const finalBuffer = await addStickerExif(rawWebp, { packName, author });
    const maxBytes = (animated ? 500 : 100) * 1024;
    if (finalBuffer.length > maxBytes) {
      throw new Error('Sticker is too complex to fit under WhatsApp size limit');
    }
    return finalBuffer;
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
