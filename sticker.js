// sticker.js — WhatsApp 512x512 WebP sticker pipeline with size-stepping & EXIF metadata
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webp from 'node-webpmux';
import {
  assertSafePublicUrl,
  downloadVideo,
  isPinterestUrl,
  resolvePinterestMedia,
  run,
  TEMP_ROOT,
} from './downloader.js';

const MAX_FETCH_BYTES = 15 * 1024 * 1024; // 15 MB download ceiling
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const STATIC_MAX_BYTES = 98 * 1024; // < 100 KB target for static stickers
const ANIMATED_MAX_BYTES = 485 * 1024; // < 500 KB target (with EXIF headroom) for animated stickers
export const MAX_STICKER_CONVERT_BYTES = 2 * 1024 * 1024; // 2 MB max input sticker size for .cimg/.cvid/.cgif
const MAX_ANIMATED_FRAMES = 150;
const MAX_OUTPUT_DURATION_SEC = 10;

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

  if (isPinterestUrl(currentUrl) && !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(currentUrl)) {
    const pinMeta = await resolvePinterestMedia(currentUrl);
    if (pinMeta?.kind === 'video') {
      const vidMedia = await downloadVideo(pinMeta.canonicalUrl || currentUrl);
      try {
        const srcVid = vidMedia.filePath || vidMedia.slides?.[0];
        if (!srcVid) {
          throw new Error('Could not extract video stream from Pinterest Pin');
        }
        const inputPath = path.join(jobDir, `source${path.extname(srcVid) || '.mp4'}`);
        await fs.promises.copyFile(srcVid, inputPath);
        const isAnimated = await isAnimatedMedia(inputPath, 'video/mp4');
        return { inputPath, isAnimated };
      } finally {
        await vidMedia.cleanup?.();
      }
    }
    if (pinMeta?.images?.length > 0) {
      currentUrl = pinMeta.images[0];
    }
  }

  let parsed;
  let res;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    parsed = await assertSafePublicUrl(currentUrl);
    res = await fetch(currentUrl, {
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      res.body?.cancel?.().catch(() => {});
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
    if (contentType === 'text/html') {
      res.body?.cancel?.().catch(() => {});
      const pageMeta = await resolvePinterestMedia(currentUrl);
      if (pageMeta?.kind === 'video') {
        const vidMedia = await downloadVideo(pageMeta.canonicalUrl || currentUrl);
        try {
          const srcVid = vidMedia.filePath || vidMedia.slides?.[0];
          if (!srcVid) {
            throw new Error('Could not extract video stream from page');
          }
          const inputPath = path.join(jobDir, `source${path.extname(srcVid) || '.mp4'}`);
          await fs.promises.copyFile(srcVid, inputPath);
          const isAnimated = await isAnimatedMedia(inputPath, 'video/mp4');
          return { inputPath, isAnimated };
        } finally {
          await vidMedia.cleanup?.();
        }
      }
      if (pageMeta?.images?.length > 0 && pageMeta.images[0] !== currentUrl) {
        return fetchImageFromUrl(pageMeta.images[0], jobDir);
      }
    }
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

/**
 * Convert a WhatsApp WebP sticker buffer into a static PNG ('img'), H.264 MP4 ('vid'),
 * or looping MP4 GIF ('gif') using node-webpmux to unpack ANIM/ANMF chunks safely.
 * @param {Buffer} stickerBuffer
 * @param {'img' | 'vid' | 'gif'} targetFormat
 * @returns {Promise<{ filePath: string, mimetype: string, isGifPlayback: boolean, cleanup: () => Promise<void> }>}
 */
export async function convertStickerToMedia(stickerBuffer, targetFormat) {
  if (!Buffer.isBuffer(stickerBuffer) || stickerBuffer.length === 0) {
    throw new Error('Empty or invalid sticker buffer');
  }
  if (stickerBuffer.length > MAX_STICKER_CONVERT_BYTES) {
    throw new Error('Sticker exceeds the 2 MB conversion size limit');
  }
  if (targetFormat !== 'img' && targetFormat !== 'vid' && targetFormat !== 'gif') {
    throw new Error(`Unsupported target format: ${targetFormat}`);
  }

  const jobDir = path.join(TEMP_ROOT, `st2media_${crypto.randomUUID()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const cleanup = () =>
    fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

  try {
    const img = new webp.Image();
    await img.load(stickerBuffer);

    if (img.width > 2048 || img.height > 2048) {
      throw new Error('Sticker dimensions exceed 2048x2048 safety cap');
    }

    if (targetFormat === 'img') {
      const singleFrameWebp = path.join(jobDir, 'frame_000.webp');
      if (img.hasAnim && img.anim?.frames?.length > 0) {
        await img._demuxFrame(singleFrameWebp, img.anim.frames[0]);
      } else {
        await fs.promises.writeFile(singleFrameWebp, stickerBuffer);
      }

      const outputPng = path.join(jobDir, 'output.png');
      await run('ffmpeg', [
        '-y',
        '-i', singleFrameWebp,
        '-frames:v', '1',
        '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
        outputPng,
      ]);

      return {
        filePath: outputPng,
        mimetype: 'image/png',
        isGifPlayback: false,
        cleanup,
      };
    }

    if (!img.hasAnim || !img.anim?.frames?.length) {
      throw new Error('This is a static sticker. Use .cimg to convert it to an image.');
    }

    const rawFrames = img.anim.frames.slice(0, MAX_ANIMATED_FRAMES);
    const extracted = [];
    let cycleDuration = 0;

    for (let i = 0; i < rawFrames.length; i++) {
      if (cycleDuration >= MAX_OUTPUT_DURATION_SEC && extracted.length > 0) break;
      const frame = rawFrames[i];
      const delayMs = Math.min(1000, Math.max(20, Number(frame.delay) || 66));
      const delaySec = Number((delayMs / 1000).toFixed(3));
      const baseName = `frame_${String(i).padStart(3, '0')}`;
      const webpFile = `${baseName}.webp`;
      await img._demuxFrame(path.join(jobDir, webpFile), frame);
      extracted.push({ baseName, webpFile, delaySec });
      cycleDuration += delaySec;
    }

    if (extracted.length === 0) {
      throw new Error('Failed to extract frames from animated sticker');
    }

    const loops =
      cycleDuration > 0 && cycleDuration < 3
        ? Math.min(3, Math.max(2, Math.ceil(3 / cycleDuration)))
        : 1;

    const buildConcatManifest = (ext) => {
      const lines = ['ffconcat version 1.0'];
      let totalDur = 0;
      let lastFile = `${extracted[0].baseName}.${ext}`;
      for (let l = 0; l < loops; l++) {
        for (const item of extracted) {
          if (totalDur >= MAX_OUTPUT_DURATION_SEC && lines.length > 1) break;
          lastFile = `${item.baseName}.${ext}`;
          lines.push(`file '${lastFile}'`);
          lines.push(`duration ${item.delaySec}`);
          totalDur += item.delaySec;
        }
      }
      lines.push(`file '${lastFile}'`);
      return `${lines.join('\n')}\n`;
    };

    const framesTxtPath = path.join(jobDir, 'frames.txt');
    const outputMp4 = path.join(jobDir, 'output.mp4');
    const encodeArgs = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', framesTxtPath,
      '-t', String(MAX_OUTPUT_DURATION_SEC),
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p',
      '-r', '30',
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-preset', 'fast',
      '-crf', '20',
      '-an',
      '-movflags', '+faststart',
      outputMp4,
    ];

    await fs.promises.writeFile(framesTxtPath, buildConcatManifest('webp'));
    try {
      await run('ffmpeg', encodeArgs);
    } catch {
      // Fallback: decode single-frame WebPs to PNG if mixed VP8/VP8L chunks fail in concat demuxer
      for (const item of extracted) {
        await run('ffmpeg', [
          '-y',
          '-i', path.join(jobDir, item.webpFile),
          '-frames:v', '1',
          path.join(jobDir, `${item.baseName}.png`),
        ]);
      }
      await fs.promises.writeFile(framesTxtPath, buildConcatManifest('png'));
      await run('ffmpeg', encodeArgs);
    }

    return {
      filePath: outputMp4,
      mimetype: 'video/mp4',
      isGifPlayback: targetFormat === 'gif',
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
