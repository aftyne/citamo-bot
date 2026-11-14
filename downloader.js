// downloader.js — isolated yt-dlp / ffmpeg pipeline (see .agents/skills/ytdlp-whatsapp-media)
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const TEMP_ROOT = path.join(process.cwd(), 'temp');
const TIMEOUT_MS = 180_000; // 180s hard limit per external process
const PROBE_INFO_TIMEOUT_MS = 12_000; // 12s fast metadata probe timeout

// Startup sweep: clear orphans from previous crashes, then ensure ./temp exists.
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const FORMAT =
  'bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc]/best[ext=mp4]/best';

const STATUS_SCALE_FILTER =
  "scale='if(gt(iw,ih),min(1920,iw),min(1080,iw))':'if(gt(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";

const NSFW_TLD_REGEX = /\.(xxx|porn|sex|adult|cam)$/i;
const NSFW_PATH_REGEX = /(?:\/nsfw\/|\br\/nsfw\b|\b(?:hentai|rule34|xvideos|pornhub)\b)/i;
const NSFW_TITLE_REGEX = /\b(nsfw|18\+|porn|hentai|xxx|sex tape|onlyfans leak|nude|nudes)\b/i;
const NSFW_BLOCK_MSG = 'This media is blocked (NSFW or age-restricted content is not allowed).';

const BLOCKED_NSFW_HOSTS = new Set([
  'pornhub', 'xvideos', 'xnxx', 'xhamster', 'redtube', 'youporn', 'spankbang',
  'eporner', 'hqporner', 'beeg', 'motherless', 'rule34', 'nhentai', 'hanime',
  'hentaihaven', 'e-hentai', 'exhentai', 'gelbooru', 'danbooru', 'sankakucomplex',
  'chaturbate', 'stripchat', 'livejasmin', 'bongacams', 'camsoda', 'onlyfans',
  'fansly', 'manyvids', 'brazzers', 'bangbros', 'realitykings', 'javhd',
  'missav', 'jable', 'supjav', 'tokyomotion', 'erome', 'coomer', 'kemono',
]);

const BLOCKED_GRABBER_DOMAINS = [
  'iplogger.org', 'iplogger.com', '2no.co', 'yip.su', 'grabify.link', 'blasze.tk',
  'ps3cfw.com', 'bmwforum.co', 'leancoding.co', 'spottyfly.com', 'stopify.co',
  'webhook.site', 'requestbin.com', 'pipedream.net', 'canarytokens.com',
  'canarytokens.org', 'interact.sh', 'oastify.com', 'burpcollaborator.net',
  'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'localtunnel.me', 'serveo.net',
];

export const ALLOWED_MEDIA_DOMAINS = [
  'youtube.com', 'youtu.be', 'music.youtube.com', 'tiktok.com', 'vm.tiktok.com',
  'vt.tiktok.com', 'instagram.com', 'ddinstagram.com', 'cdninstagram.com',
  'facebook.com', 'fb.watch', 'fb.com', 'fbcdn.net', 'twitter.com', 'x.com',
  't.co', 'twimg.com', 'fxtwitter.com', 'vxtwitter.com', 'reddit.com', 'redd.it',
  'v.redd.it', 'i.redd.it', 'soundcloud.com', 'on.soundcloud.com', 'pinterest.com',
  'pin.it', 'pinimg.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
  'clips.twitch.tv', 'bilibili.com', 'bilibili.tv', 'threads.net', 'streamable.com',
  'imgur.com', 'i.imgur.com', 'giphy.com', 'media.giphy.com', 'tenor.com',
  'media.tenor.com', 'wikimedia.org', 'discordapp.com', 'discordapp.net',
];

function getYtDlpSecurityArgs(includeMatchFilter = true) {
  const args = ['--age-limit', '17'];
  if (includeMatchFilter) {
    args.push('--match-filter', 'age_limit <? 18');
  }
  if (process.env.YTDLP_PROXY) {
    args.push('--proxy', process.env.YTDLP_PROXY);
  }
  return args;
}

export function assertSafeContentMetadata(title = '', ageLimit = 0) {
  if (
    (typeof ageLimit === 'number' && ageLimit >= 18) ||
    NSFW_TITLE_REGEX.test(String(title || ''))
  ) {
    const err = new Error(NSFW_BLOCK_MSG);
    err.isContentBlock = true;
    throw err;
  }
}

/**
 * Strip local filesystem paths from a single-line stderr message so internal
 * temp directories are never leaked to WhatsApp chats.
 */
function sanitizeStderr(stderr) {
  const lastLine = (stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (!lastLine) return '';
  const cleaned = lastLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/tmp\/[^\s"']+/g, '<path>');
  return cleaned.slice(0, 180);
}

/**
 * Sanitize a media title for safe use as a filename (max 60 chars).
 */
export function sanitizeFileName(rawTitle) {
  const cleaned = String(rawTitle || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 60);
  return cleaned || 'audio';
}

/**
 * Run a binary with array args (no shell), enforcing a single unified timeout
 * that kills the entire process tree and sanitizes user-facing errors.
 */
export function run(cmd, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timedOut = false;

    const child = execFile(
      cmd,
      args,
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) {
          console.error(`[downloader] ${cmd} timed out after ${timeoutMs / 1000}s`);
          return reject(new Error(`Download or processing timed out after ${timeoutMs / 1000}s`));
        }
        if (err) {
          console.error(`[downloader] ${cmd} error:`, stderr || err.message);
          if (/Sign in to confirm your age|age-restricted|inappropriate for some users|does not pass filter/i.test(`${stderr}\n${stdout}`)) {
            return reject(new Error(NSFW_BLOCK_MSG));
          }
          const safeDetail = sanitizeStderr(stderr);
          return reject(
            new Error(safeDetail ? `${cmd} failed: ${safeDetail}` : 'Failed to process media stream'),
          );
        }
        resolve(stdout);
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
  });
}

/**
 * Returns { video, audio, rFrameRate, duration } using ffprobe.
 */
export async function probeCodecs(filePath) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,r_frame_rate:format=duration',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(out);
  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? 0);
  return {
    video: videoStream?.codec_name ?? null,
    audio: audioStream?.codec_name ?? null,
    rFrameRate: videoStream?.r_frame_rate ?? null,
    duration: Number.isFinite(duration) ? duration : 0,
  };
}

function isPrivateOrReservedIp(rawIp, allowLoopback = false) {
  let ip = rawIp.split('%')[0].toLowerCase();

  if (ip.startsWith('::ffff:')) {
    const rest = ip.slice(7);
    const hexMatch = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      ip = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    } else {
      ip = rest;
    }
  }

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return !allowLoopback;
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return !allowLoopback;
  return (
    ip === '::' ||
    ip === '0:0:0:0:0:0:0:0' ||
    /^f[cd][0-9a-f]{2}:/.test(ip) ||
    /^fe[89ab][0-9a-f]:/.test(ip)
  );
}

// shortcut: pre-flight DNS lookup does not pin the IP inside yt-dlp; upgrade to an egress proxy if DNS rebinding is in threat model
export async function assertSafePublicUrl(rawUrl, { allowLoopbackForTests = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://');
  }

  const allowLoopback = allowLoopbackForTests || process.env.ALLOW_LOOPBACK_TESTS === '1';
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const host = rawHost.replace(/^www\./, '');

  if (!allowLoopback && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new Error('Blocked private or local URL');
  }

  if (net.isIP(rawHost)) {
    if (isPrivateOrReservedIp(rawHost, allowLoopback)) {
      throw new Error('Blocked private or local URL');
    }
    if (!allowLoopback) {
      throw new Error('Raw IP URLs are blocked to prevent IP leaks.');
    }
    return parsed;
  }

  // Layer 1: Zero-latency NSFW TLD, domain label, and URL path check (before DNS lookup)
  const labels = host.split('.');
  if (
    NSFW_TLD_REGEX.test(host) ||
    labels.some((label) => BLOCKED_NSFW_HOSTS.has(label)) ||
    NSFW_PATH_REGEX.test(`${parsed.pathname}${parsed.search}`)
  ) {
    const err = new Error(NSFW_BLOCK_MSG);
    err.isContentBlock = true;
    throw err;
  }

  // Layer 2: Block known IP-grabber, webhook, and canary domains (before DNS lookup)
  if (BLOCKED_GRABBER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new Error('Blocked IP grabber or untrusted tracking domain.');
  }

  // Layer 3: Strict verified media domain allowlist (prevents DNS-level IP leaks to unknown servers)
  const isLoopbackHost = allowLoopback && (host === 'localhost' || host.endsWith('.localhost'));
  if (
    !isLoopbackHost &&
    process.env.ALLOW_ALL_DOMAINS !== '1' &&
    !ALLOWED_MEDIA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  ) {
    throw new Error(
      'Unsupported or untrusted domain. Only verified media platforms (YouTube, TikTok, Instagram, Facebook, X, Reddit, etc.) are allowed.',
    );
  }

  const records = await dns.promises.lookup(rawHost, { all: true, verbatim: true });

  if (!records.length || records.some((r) => isPrivateOrReservedIp(r.address, allowLoopback))) {
    throw new Error('Blocked private or local URL');
  }

  return parsed;
}

async function withJobDir(prefix, fn) {
  const dirName = prefix ? `${prefix}_${crypto.randomUUID()}` : crypto.randomUUID();
  const jobDir = path.join(TEMP_ROOT, dirName);
  fs.mkdirSync(jobDir, { recursive: true });
  const cleanup = () =>
    fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    return await fn(jobDir, cleanup);
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }
}

/**
 * Fast 12s metadata probe for `.cdl <url>` interactive menu.
 * Falls back gracefully to `{ title: 'Media Link', duration: null, safeTitle: 'audio' }`
 * on timeout or extractor rate-limits so the menu is never blocked.
 */
export async function probeMediaInfo(url) {
  await assertSafePublicUrl(url);
  try {
    const out = await run(
      'yt-dlp',
      [
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        ...getYtDlpSecurityArgs(false),
        '--',
        url,
      ],
      PROBE_INFO_TIMEOUT_MS,
    );
    const info = JSON.parse(out);
    const rawTitle = (info?.title || info?.fulltitle || 'Media Link').trim();
    assertSafeContentMetadata(rawTitle, info?.age_limit);
    const duration =
      typeof info?.duration === 'number' && Number.isFinite(info.duration) ? info.duration : null;
    return {
      title: rawTitle.slice(0, 100) || 'Media Link',
      duration,
      safeTitle: sanitizeFileName(rawTitle),
    };
  } catch (err) {
    if (err?.isContentBlock || /NSFW or age-restricted/i.test(err?.message)) {
      throw err;
    }
    return {
      title: 'Media Link',
      duration: null,
      safeTitle: 'audio',
    };
  }
}

async function downloadRawToJobDir(url, jobDir) {
  const rawPath = path.join(jobDir, 'video.mp4');
  const out = await run('yt-dlp', [
    '--no-playlist',
    '--max-filesize', '500M',
    '--no-progress',
    ...getYtDlpSecurityArgs(true),
    '-f', FORMAT,
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    '--print', 'after_move:title',
    '-o', rawPath,
    '--', url,
  ]);

  if (/does not pass filter/i.test(out || '')) {
    throw new Error(NSFW_BLOCK_MSG);
  }
  const printedTitle = (out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  assertSafeContentMetadata(printedTitle);

  if (!fs.existsSync(rawPath)) {
    throw new Error('No file produced (video may exceed 500 MB or be unavailable)');
  }
  return rawPath;
}

/**
 * Validate video stream presence and ensure H.264 video + AAC audio.
 * Immediately unlinks the pre-transcode file when conversion occurs.
 */
export async function ensureWhatsAppCodecs(filePath, jobDir) {
  const { video, audio } = await probeCodecs(filePath);
  if (!video) {
    throw new Error('No video stream found in URL');
  }

  const needsVideoTranscode = video !== 'h264';
  const needsAudioTranscode = Boolean(audio && audio !== 'aac');

  if (!needsVideoTranscode && !needsAudioTranscode) {
    return filePath;
  }

  const transcoded = path.join(jobDir, 'video_h264.mp4');
  const ffmpegArgs = needsVideoTranscode
    ? [
        '-y', '-i', filePath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        transcoded,
      ]
    : [
        '-y', '-i', filePath,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        transcoded,
      ];

  await run('ffmpeg', ffmpegArgs);
  await fs.promises.unlink(filePath);
  return transcoded;
}

/**
 * Validate audio stream presence and ensure MP3 codec (`libmp3lame`).
 * Immediately unlinks the pre-transcode file when conversion occurs.
 */
export async function ensureMp3Audio(filePath, jobDir) {
  const { audio } = await probeCodecs(filePath);
  if (!audio) {
    throw new Error('No audio track found in this link');
  }

  if (audio === 'mp3' && path.extname(filePath).toLowerCase() === '.mp3') {
    return filePath;
  }

  const mp3Path = path.join(jobDir, 'audio_final.mp3');
  await run('ffmpeg', [
    '-y', '-i', filePath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-q:a', '2',
    mp3Path,
  ]);
  await fs.promises.unlink(filePath);
  return mp3Path;
}

/**
 * Download high-quality MP3 audio for `.cdl` (`2` / `mp3`).
 * @returns {Promise<{ filePath: string, sizeInMB: number, fileName: string, cleanup: () => Promise<void> }>}
 */
export async function downloadAudioMp3(url, preferredTitle = '') {
  await assertSafePublicUrl(url);
  assertSafeContentMetadata(preferredTitle);

  return withJobDir('audio', async (jobDir, cleanup) => {
    const outputTemplate = path.join(jobDir, 'audio.%(ext)s');
    const out = await run('yt-dlp', [
      '--no-playlist',
      '--max-filesize', '500M',
      '--no-progress',
      ...getYtDlpSecurityArgs(true),
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--print', 'after_move:title',
      '-o', outputTemplate,
      '--', url,
    ]);

    if (/does not pass filter/i.test(out || '')) {
      throw new Error(NSFW_BLOCK_MSG);
    }
    const printedTitle = (out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    assertSafeContentMetadata(printedTitle);
    const files = (await fs.promises.readdir(jobDir)).filter(
      (f) => !f.endsWith('.part') && !f.endsWith('.ytdl'),
    );
    if (files.length === 0) {
      throw new Error('No audio file produced (media may exceed 500 MB or be unavailable)');
    }

    const rawFilePath = path.join(jobDir, files[0]);
    const filePath = await ensureMp3Audio(rawFilePath, jobDir);
    const sizeInMB = fs.statSync(filePath).size / (1024 * 1024);
    const safeTitle = sanitizeFileName(preferredTitle || printedTitle || 'audio');

    return {
      filePath,
      sizeInMB,
      fileName: `${safeTitle}.mp3`,
      cleanup,
    };
  });
}

/**
 * Download a WhatsApp-safe (H.264/AAC MP4) video for `.c <url>` or `.cdl` (`1` / `mp4`).
 * @returns {Promise<{ filePath: string, sizeInMB: number, cleanup: () => Promise<void> }>}
 */
export async function downloadVideo(url) {
  await assertSafePublicUrl(url);

  return withJobDir('', async (jobDir, cleanup) => {
    const rawPath = await downloadRawToJobDir(url, jobDir);
    const filePath = await ensureWhatsAppCodecs(rawPath, jobDir);
    const sizeInMB = fs.statSync(filePath).size / (1024 * 1024);
    return { filePath, sizeInMB, cleanup };
  });
}

/**
 * Transcode raw video to WhatsApp Status HD sweet-spot specs (preserving native FPS),
 * immediately unlink raw file, and split into 58s segments if duration > 60s.
 * @returns {Promise<Array<{ filePath: string, partNumber: number, totalParts: number }>>}
 */
export async function optimizeAndSplitForStatus(rawFilePath, jobDir) {
  const { video } = await probeCodecs(rawFilePath);
  if (!video) {
    throw new Error('No video stream found in URL');
  }

  const optimizedFilePath = path.join(jobDir, 'status_opt.mp4');
  await run('ffmpeg', [
    '-y', '-i', rawFilePath,
    '-vf', STATUS_SCALE_FILTER,
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.2', '-preset', 'medium', '-crf', '21',
    '-maxrate', '4000k', '-bufsize', '8000k', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    optimizedFilePath,
  ]);

  // Fix #8: immediately remove raw source file so two copies never sit on disk
  await fs.promises.unlink(rawFilePath);

  const { duration } = await probeCodecs(optimizedFilePath);
  if (duration <= 60) {
    return [{ filePath: optimizedFilePath, partNumber: 1, totalParts: 1 }];
  }

  const segmentPattern = path.join(jobDir, 'status_part_%03d.mp4');
  await run('ffmpeg', [
    '-y', '-i', optimizedFilePath,
    '-c', 'copy',
    '-map', '0',
    '-segment_time', '58',
    '-f', 'segment',
    '-reset_timestamps', '1',
    segmentPattern,
  ]);

  // Fix #8: immediately remove unsplit optimized file after segmentation
  await fs.promises.unlink(optimizedFilePath);

  const segmentFiles = (await fs.promises.readdir(jobDir))
    .filter((name) => /^status_part_\d+\.mp4$/.test(name))
    .sort();

  if (segmentFiles.length === 0) {
    throw new Error('Failed to split Status video into segments');
  }

  const totalParts = segmentFiles.length;
  return segmentFiles.map((name, idx) => ({
    filePath: path.join(jobDir, name),
    partNumber: idx + 1,
    totalParts,
  }));
}

/**
 * Download, optimize for WhatsApp Status HD (preserving native FPS), and auto-split if > 60s.
 * @returns {Promise<{ parts: Array<{ filePath: string, partNumber: number, totalParts: number }>, cleanup: () => Promise<void> }>}
 */
export async function downloadAndOptimizeForStatus(url) {
  await assertSafePublicUrl(url);

  return withJobDir('', async (jobDir, cleanup) => {
    const rawFilePath = await downloadRawToJobDir(url, jobDir);
    const parts = await optimizeAndSplitForStatus(rawFilePath, jobDir);
    return { parts, cleanup };
  });
}
