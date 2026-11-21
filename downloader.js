// downloader.js — isolated yt-dlp / ffmpeg pipeline (see .agents/skills/ytdlp-whatsapp-media)
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile?.(envPath);
  } catch (err) {
    console.warn("[downloader] Failed to load .env:", err.message);
  }
}

export const TEMP_ROOT = path.join(process.cwd(), "temp");
const TIMEOUT_MS = 180_000; // 180s hard limit per external process
const PROBE_INFO_TIMEOUT_MS = 12_000; // 12s fast metadata probe timeout
const MAX_CAROUSEL_SLIDES = 10;
const MAX_SLIDE_BYTES = 10 * 1024 * 1024; // 10 MB per slide image
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB max carousel audio
const MAX_HTML_BYTES = 512 * 1024; // 512 KB cap for HTML metadata scraping
const CAROUSEL_FETCH_TIMEOUT_MS = 15_000;
const CAROUSEL_MAX_REDIRECTS = 5;
const CAROUSEL_CONCURRENCY = 3;

// Startup sweep: clear orphans from previous crashes, then ensure ./temp exists.
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const FORMAT =
  "bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/bestvideo[ext=mp4][vcodec^=avc]+bestaudio/bestvideo+bestaudio/best[ext=mp4][vcodec^=avc]/best[ext=mp4]/best";

const STATUS_SCALE_FILTER =
  "scale='if(gt(iw,ih),min(1920,iw),min(1080,iw))':'if(gt(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";

const NSFW_TLD_REGEX = /\.(xxx|porn|sex|adult|cam)$/i;
const NSFW_PATH_REGEX = /(?:\/nsfw\/|\br\/nsfw\b|\b(?:hentai|rule34|xvideos|pornhub)\b)/i;
const NSFW_TITLE_REGEX = /\b(nsfw|18\+|porn|hentai|xxx|sex tape|onlyfans|nude|nudes)\b/i;
const NSFW_BLOCK_MSG = "This media is blocked (NSFW or age-restricted content is not allowed).";

const BLOCKED_NSFW_HOSTS = new Set([
  "pornhub",
  "xvideos",
  "xnxx",
  "xhamster",
  "redtube",
  "youporn",
  "spankbang",
  "eporner",
  "hqporner",
  "beeg",
  "motherless",
  "rule34",
  "nhentai",
  "hanime",
  "hentaihaven",
  "e-hentai",
  "exhentai",
  "gelbooru",
  "danbooru",
  "sankakucomplex",
  "chaturbate",
  "stripchat",
  "livejasmin",
  "bongacams",
  "camsoda",
  "onlyfans",
  "fansly",
  "manyvids",
  "brazzers",
  "bangbros",
  "realitykings",
  "javhd",
  "missav",
  "jable",
  "supjav",
  "tokyomotion",
  "erome",
  "coomer",
  "kemono",
]);

const BLOCKED_GRABBER_DOMAINS = [
  "iplogger.org",
  "iplogger.com",
  "2no.co",
  "yip.su",
  "grabify.link",
  "blasze.tk",
  "ps3cfw.com",
  "bmwforum.co",
  "leancoding.co",
  "spottyfly.com",
  "stopify.co",
  "webhook.site",
  "requestbin.com",
  "pipedream.net",
  "canarytokens.com",
  "canarytokens.org",
  "interact.sh",
  "oastify.com",
  "burpcollaborator.net",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
  "localtunnel.me",
  "serveo.net",
];

export const ALLOWED_MEDIA_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "music.youtube.com",
  "tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokv.com",
  "tikwm.com",
  "musical.ly",
  "ibytedtos.com",
  "byteoversea.com",
  "muscdn.com",
  "instagram.com",
  "ddinstagram.com",
  "cdninstagram.com",
  "scontent.cdninstagram.com",
  "facebook.com",
  "fb.watch",
  "fb.com",
  "fbcdn.net",
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "reddit.com",
  "redd.it",
  "v.redd.it",
  "i.redd.it",
  "soundcloud.com",
  "on.soundcloud.com",
  "pinterest.com",
  "pinterest.co.uk",
  "pinterest.ca",
  "pinterest.de",
  "pinterest.fr",
  "pinterest.jp",
  "pinterest.es",
  "pinterest.it",
  "pinterest.com.au",
  "pinterest.com.mx",
  "pinterest.co.kr",
  "pinterest.ph",
  "pin.it",
  "pinimg.com",
  "vimeo.com",
  "dailymotion.com",
  "twitch.tv",
  "clips.twitch.tv",
  "bilibili.com",
  "bilibili.tv",
  "threads.net",
  "streamable.com",
  "imgur.com",
  "i.imgur.com",
  "giphy.com",
  "media.giphy.com",
  "tenor.com",
  "media.tenor.com",
  "wikimedia.org",
  "discordapp.com",
  "discordapp.net",
];

const AUTH_REQUIRED_MSG =
  "This post requires login or is private/unavailable. Set YTDLP_COOKIES_FILE (or YTDLP_COOKIES_FROM_BROWSER) to access login-walled Instagram posts.";
const COOKIES_BROWSER_REGEX = /^[a-z0-9_-]+(?::[a-z0-9_ .+-]+)?$/i;
let warnedMissingCookies = false;

export function getYtDlpCookieArgs() {
  const cookiesFile = (process.env.YTDLP_COOKIES_FILE || "").trim();
  if (cookiesFile) {
    const resolvedPath = path.resolve(cookiesFile);
    try {
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        return ["--cookies", resolvedPath];
      }
    } catch {
      // fall through to warning
    }
    if (!warnedMissingCookies) {
      warnedMissingCookies = true;
      console.warn(
        `[downloader] YTDLP_COOKIES_FILE not found or not a file (${cookiesFile}); continuing without cookies.`,
      );
    }
    return [];
  }

  const browser = (process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
  if (browser) {
    if (COOKIES_BROWSER_REGEX.test(browser) && !browser.startsWith("-")) {
      return ["--cookies-from-browser", browser];
    }
    if (!warnedMissingCookies) {
      warnedMissingCookies = true;
      console.warn(
        "[downloader] Ignoring invalid YTDLP_COOKIES_FROM_BROWSER value.",
      );
    }
  }
  return [];
}

function getYtDlpSecurityArgs(includeMatchFilter = true) {
  const args = ["--age-limit", "17"];
  if (includeMatchFilter) {
    args.push("--match-filter", "age_limit <? 18");
  }
  if (process.env.YTDLP_PROXY) {
    args.push("--proxy", process.env.YTDLP_PROXY);
  }
  args.push(...getYtDlpCookieArgs());
  return args;
}

export function assertSafeContentMetadata(title = "", ageLimit = 0) {
  if (
    (typeof ageLimit === "number" && ageLimit >= 18) ||
    NSFW_TITLE_REGEX.test(String(title || ""))
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
  const lastLine = (stderr || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  if (!lastLine) return "";
  const cleaned = lastLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/tmp\/[^\s"']+/g, "<path>");
  return cleaned.slice(0, 180);
}

/**
 * Sanitize a media title for safe use as a filename (max 60 chars).
 */
export function sanitizeFileName(rawTitle) {
  const cleaned = String(rawTitle || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60);
  return cleaned || "audio";
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
          if (
            /Sign in to confirm your age|age-restricted|inappropriate for some users|does not pass filter/i.test(
              `${stderr}\n${stdout}`,
            )
          ) {
            return reject(new Error(NSFW_BLOCK_MSG));
          }
          if (
            /Instagram sent an empty media response|login required|rate-limit reached|not available.*logged-in|requested content is not available/i.test(
              stderr || "",
            )
          ) {
            const authErr = new Error(AUTH_REQUIRED_MSG);
            authErr.isAuthRequired = true;
            return reject(authErr);
          }
          const safeDetail = sanitizeStderr(stderr);
          return reject(
            new Error(
              safeDetail ? `${cmd} failed: ${safeDetail}` : "Failed to process media stream",
            ),
          );
        }
        resolve(stdout);
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
  });
}

/**
 * Returns { video, audio, rFrameRate, duration } using ffprobe.
 */
export async function probeCodecs(filePath) {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,r_frame_rate:format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(out);
  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? 0);
  return {
    video: videoStream?.codec_name ?? null,
    audio: audioStream?.codec_name ?? null,
    rFrameRate: videoStream?.r_frame_rate ?? null,
    duration: Number.isFinite(duration) ? duration : 0,
  };
}

function isPrivateOrReservedIp(rawIp, allowLoopback = false) {
  let ip = rawIp.split("%")[0].toLowerCase();

  if (ip.startsWith("::ffff:")) {
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
    const [a, b] = ip.split(".").map(Number);
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

  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return !allowLoopback;
  return (
    ip === "::" ||
    ip === "0:0:0:0:0:0:0:0" ||
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
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://");
  }

  const allowLoopback = allowLoopbackForTests || process.env.ALLOW_LOOPBACK_TESTS === "1";
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const host = rawHost.replace(/^www\./, "");

  if (!allowLoopback && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new Error("Blocked private or local URL");
  }

  if (net.isIP(rawHost)) {
    if (isPrivateOrReservedIp(rawHost, allowLoopback)) {
      throw new Error("Blocked private or local URL");
    }
    if (!allowLoopback) {
      throw new Error("Raw IP URLs are blocked to prevent IP leaks.");
    }
    return parsed;
  }

  // Layer 1: Zero-latency NSFW TLD, domain label, and URL path check (before DNS lookup)
  const labels = host.split(".");
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
    throw new Error("Blocked IP grabber or untrusted tracking domain.");
  }

  // Layer 3: Strict verified media domain allowlist (prevents DNS-level IP leaks to unknown servers)
  const isLoopbackHost = allowLoopback && (host === "localhost" || host.endsWith(".localhost"));
  if (
    !isLoopbackHost &&
    process.env.ALLOW_ALL_DOMAINS !== "1" &&
    !ALLOWED_MEDIA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  ) {
    throw new Error(
      "Unsupported domain. Only verified platforms (YouTube, TikTok, Instagram, Facebook, X, Reddit, etc.) are allowed.",
    );
  }

  const records = await dns.promises.lookup(rawHost, { all: true, verbatim: true });

  if (!records.length || records.some((r) => isPrivateOrReservedIp(r.address, allowLoopback))) {
    throw new Error("Blocked private or local URL");
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

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function matchTikTokPhotoId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(/\/photo\/(\d+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Safely resolve TikTok shortlinks (vt.tiktok.com, vm.tiktok.com, etc.) with
 * manual redirect hops validated by assertSafePublicUrl, and detect /photo/<id> mode.
 * @returns {Promise<{ canonicalUrl: string, isPhotoMode: boolean, photoId: string | null }>}
 */
export async function resolveTikTokUrl(url) {
  let currentParsed = await assertSafePublicUrl(url);
  const host = currentParsed.hostname.toLowerCase().replace(/^www\./, "");
  const isTikTok = host === "tiktok.com" || host.endsWith(".tiktok.com");

  const initialPhotoId = matchTikTokPhotoId(url);
  if (initialPhotoId) {
    return { canonicalUrl: url, isPhotoMode: true, photoId: initialPhotoId };
  }
  if (!isTikTok) {
    return { canonicalUrl: url, isPhotoMode: false, photoId: null };
  }

  let currentUrl = url;
  try {
    for (let hop = 0; hop <= CAROUSEL_MAX_REDIRECTS; hop++) {
      if (hop > 0) {
        currentParsed = await assertSafePublicUrl(currentUrl);
      }
      const hopPhotoId = matchTikTokPhotoId(currentUrl);
      if (hopPhotoId) {
        return { canonicalUrl: currentUrl, isPhotoMode: true, photoId: hopPhotoId };
      }

      const res = await fetch(currentUrl, {
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        res.body?.cancel?.().catch(() => {});
        if (!location || hop === CAROUSEL_MAX_REDIRECTS) break;
        currentUrl = new URL(location, currentParsed).toString();
        continue;
      }

      res.body?.cancel?.().catch(() => {});
      break;
    }
  } catch (err) {
    if (err?.isContentBlock || /Blocked|Unsupported|Raw IP/i.test(err?.message)) {
      throw err;
    }
  }

  const finalPhotoId = matchTikTokPhotoId(currentUrl);
  return {
    canonicalUrl: currentUrl,
    isPhotoMode: Boolean(finalPhotoId),
    photoId: finalPhotoId,
  };
}

/**
 * Two-tier TikTok Photo Mode (/photo/<id>) extractor that never invokes yt-dlp on /photo/ URLs:
 *   Tier 1: Direct HTML __UNIVERSAL_DATA_FOR_REHYDRATION__ scrape
 *   Tier 2: Automatic JSON API fallback via tikwm.com
 * @returns {Promise<{ slideUrls: string[], audioUrl: string | null, title: string, canonicalUrl: string } | null>}
 */
export async function extractTikTokPhotoCarousel(url) {
  const { canonicalUrl } = await resolveTikTokUrl(url);

  // Tier 1: Direct HTML Hydration Scrape (__UNIVERSAL_DATA_FOR_REHYDRATION__)
  try {
    let currentUrl = canonicalUrl;
    let parsed;
    let res;
    for (let hop = 0; hop <= CAROUSEL_MAX_REDIRECTS; hop++) {
      parsed = await assertSafePublicUrl(currentUrl);
      res = await fetch(currentUrl, {
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(CAROUSEL_FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        res.body?.cancel?.().catch(() => {});
        if (!location || hop === CAROUSEL_MAX_REDIRECTS) break;
        currentUrl = new URL(location, parsed).toString();
        continue;
      }
      break;
    }

    if (res?.ok) {
      const html = await res.text();
      const match = html.match(
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
      );
      if (match?.[1]) {
        const data = JSON.parse(match[1]);
        const detail =
          data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
          data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;
        if (detail) {
          if (detail.isContentClassified) {
            assertSafeContentMetadata("", 18);
          }
          const rawTitle = String(
            detail.desc || detail.imagePost?.title || "TikTok Photo Carousel",
          ).trim();
          assertSafeContentMetadata(rawTitle, 0);

          const images = detail.imagePost?.images;
          if (Array.isArray(images) && images.length > 0) {
            const slideUrls = images
              .map((img) => img?.imageURL?.urlList?.find((u) => /^https?:\/\//i.test(u)))
              .filter(Boolean);
            const audioUrl =
              detail.music?.playUrl && /^https?:\/\//i.test(detail.music.playUrl)
                ? detail.music.playUrl
                : null;
            if (slideUrls.length > 0) {
              return {
                slideUrls,
                audioUrl,
                title: rawTitle || "TikTok Photo Carousel",
                canonicalUrl,
              };
            }
          }
        }
      }
    }
  } catch (err) {
    if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
      throw err;
    }
  }

  // Tier 2: Automatic JSON API Fallback (tikwm.com)
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(canonicalUrl)}`;
    await assertSafePublicUrl(apiUrl);
    const res = await fetch(apiUrl, {
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (res.ok) {
      const json = await res.json();
      const images = json?.data?.images;
      if (Array.isArray(images) && images.length > 0) {
        const rawTitle = String(json.data.title || "TikTok Photo Carousel").trim();
        assertSafeContentMetadata(rawTitle, 0);
        const slideUrls = images.filter(
          (u) => typeof u === "string" && /^https?:\/\//i.test(u),
        );
        const audioUrl =
          [json.data.music, json.data.music_info?.play, json.data.play].find(
            (u) => typeof u === "string" && /^https?:\/\//i.test(u),
          ) || null;
        if (slideUrls.length > 0) {
          return {
            slideUrls,
            audioUrl,
            title: rawTitle || "TikTok Photo Carousel",
            canonicalUrl,
          };
        }
      }
    }
  } catch (err) {
    if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
      throw err;
    }
  }

  return null;
}

const PINTEREST_HOST_REGEX =
  /^(?:[a-z0-9-]+\.)?(?:pinterest\.(?:com|co\.uk|ca|de|fr|jp|es|it|com\.au|com\.mx|co\.kr|ph)|pin\.it|pinimg\.com)$/i;

export function isPinterestUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return PINTEREST_HOST_REGEX.test(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function readBoundedHtml(res, maxBytes = MAX_HTML_BYTES) {
  if (!res?.body) return "";
  const chunks = [];
  let totalBytes = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      if (totalBytes + buf.byteLength > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - totalBytes));
        await res.body.cancel?.().catch(() => {});
        break;
      }
      chunks.push(buf);
      totalBytes += buf.byteLength;
    }
  } catch {
    // Return partial HTML collected up to error/cancel
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function decodeHtmlAttr(str) {
  return String(str || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

async function upgradePinimgUrl(rawUrl) {
  await assertSafePublicUrl(rawUrl);
  const upgraded = rawUrl.replace(
    /(\/\/i\.pinimg\.com\/)(?:236x|474x|564x|736x|600x315|136x136|60x60)\//i,
    "$1originals/",
  );
  if (upgraded === rawUrl) return rawUrl;
  try {
    await assertSafePublicUrl(upgraded);
    const res = await fetch(upgraded, {
      method: "HEAD",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5_000),
      headers: { "User-Agent": BROWSER_USER_AGENT },
    });
    res.body?.cancel?.().catch(() => {});
    if (res.ok) return upgraded;
  } catch {
    // Fall back to original thumbnail URL if /originals/ returns 403/404 or times out
  }
  return rawUrl;
}

/**
 * Safely resolve Pinterest (pin.it, pinterest.com, pinimg.com) links or HTML Pin pages:
 *   Step A: Follow manual redirects with assertSafePublicUrl and canonicalize /pin/<id>/
 *   Step B: Tier 1 yt-dlp --ignore-no-formats-error --dump-single-json inspection
 *   Step C: Tier 2 bounded (512 KB) HTML og:image / i.pinimg.com/originals/ fallback
 * @returns {Promise<{ kind: 'video' | 'image' | 'carousel', images: string[], title: string, duration: number | null, canonicalUrl: string } | null>}
 */
export async function resolvePinterestMedia(url) {
  const initialParsed = await assertSafePublicUrl(url);
  const initialHost = initialParsed.hostname.toLowerCase();

  // Direct i.pinimg.com image/GIF asset URL
  if (
    (initialHost === "i.pinimg.com" || initialHost.endsWith(".pinimg.com")) &&
    /\.(jpe?g|png|webp|gif)(\?|$)/i.test(initialParsed.pathname)
  ) {
    const bestUrl = await upgradePinimgUrl(url);
    return {
      kind: "image",
      images: [bestUrl],
      title: "Pinterest Image",
      duration: null,
      canonicalUrl: bestUrl,
    };
  }

  // Step A: Follow manual redirects safely
  let currentUrl = url;
  let currentParsed = initialParsed;
  let finalResponse = null;

  try {
    for (let hop = 0; hop <= CAROUSEL_MAX_REDIRECTS; hop++) {
      if (hop > 0) {
        currentParsed = await assertSafePublicUrl(currentUrl);
      }
      const res = await fetch(currentUrl, {
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        res.body?.cancel?.().catch(() => {});
        if (!location || hop === CAROUSEL_MAX_REDIRECTS) break;
        currentUrl = new URL(location, currentParsed).toString();
        continue;
      }

      finalResponse = res;
      break;
    }
  } catch (err) {
    if (err?.isContentBlock || /Blocked|Unsupported|Raw IP/i.test(err?.message)) {
      throw err;
    }
  }

  let canonicalUrl = currentUrl;
  try {
    const parsedCanon = new URL(currentUrl);
    const pinMatch = parsedCanon.pathname.match(/\/pin\/(?:[^/]*--)?(\d+)/i);
    if (pinMatch && PINTEREST_HOST_REGEX.test(parsedCanon.hostname.toLowerCase())) {
      canonicalUrl = `https://www.pinterest.com/pin/${pinMatch[1]}/`;
      await assertSafePublicUrl(canonicalUrl);
    }
  } catch (err) {
    if (err?.isContentBlock || /Blocked|Unsupported|Raw IP/i.test(err?.message)) {
      throw err;
    }
  }

  const isPinterest = isPinterestUrl(url) || isPinterestUrl(canonicalUrl);

  // Step B: Tier 1 Extraction via yt-dlp --ignore-no-formats-error --dump-single-json
  if (isPinterest) {
    try {
      const out = await run(
        "yt-dlp",
        [
          "--ignore-no-formats-error",
          "--dump-single-json",
          "--no-playlist",
          "--no-warnings",
          ...getYtDlpSecurityArgs(false),
          "--",
          canonicalUrl,
        ],
        15_000,
      );
      const info = JSON.parse(out);
      const rawTitle = String(
        info?.title || info?.fulltitle || info?.description || "Pinterest Pin",
      ).trim();
      assertSafeContentMetadata(rawTitle, info?.age_limit);
      if (info?.description) {
        assertSafeContentMetadata(String(info.description), info?.age_limit);
      }

      const formats = Array.isArray(info?.formats) ? info.formats : [];
      const hasVideoStream = formats.some(
        (f) =>
          (f?.vcodec &&
            f.vcodec !== "none" &&
            !/^(jpg|jpeg|png|webp|gif)$/i.test(f.ext || "")) ||
          (typeof f?.url === "string" &&
            (/\.(mp4|m3u8)(\?|$)/i.test(f.url) || /\/\/v\d*\.pinimg\.com\//i.test(f.url)) &&
            f?.vcodec !== "none"),
      );

      const duration =
        typeof info?.duration === "number" && Number.isFinite(info.duration)
          ? info.duration
          : null;

      if (hasVideoStream) {
        finalResponse?.body?.cancel?.().catch(() => {});
        return {
          kind: "video",
          images: [],
          title: rawTitle || "Pinterest Video",
          duration,
          canonicalUrl,
        };
      }

      const candidateUrls = [];
      const pickBestThumb = (thumbs) => {
        if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
        const orig = thumbs.find(
          (t) => typeof t?.url === "string" && /\/originals\//i.test(t.url),
        );
        if (orig?.url) return orig.url;
        const sorted = [...thumbs]
          .filter((t) => typeof t?.url === "string" && /^https?:\/\//i.test(t.url))
          .sort((a, b) => (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0));
        return sorted[0]?.url || thumbs[thumbs.length - 1]?.url || null;
      };

      if (Array.isArray(info?.entries) && info.entries.length > 0) {
        for (const entry of info.entries) {
          if (!entry) continue;
          assertSafeContentMetadata(entry.title || "", entry.age_limit);
          const entryHasVideo =
            entry.vcodec &&
            entry.vcodec !== "none" &&
            !/^(jpg|jpeg|png|webp|gif)$/i.test(entry.ext || "");
          if (entryHasVideo) {
            finalResponse?.body?.cancel?.().catch(() => {});
            return {
              kind: "video",
              images: [],
              title: rawTitle || "Pinterest Video",
              duration,
              canonicalUrl,
            };
          }
          const bestEntryImg =
            pickBestThumb(entry.thumbnails) ||
            (typeof entry.thumbnail === "string" ? entry.thumbnail : null) ||
            (typeof entry.url === "string" && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(entry.url)
              ? entry.url
              : null);
          if (bestEntryImg) candidateUrls.push(bestEntryImg);
        }
      } else {
        const bestSingleImg =
          pickBestThumb(info?.thumbnails) ||
          (typeof info?.thumbnail === "string" ? info.thumbnail : null) ||
          (typeof info?.url === "string" && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(info.url)
            ? info.url
            : null);
        if (bestSingleImg) candidateUrls.push(bestSingleImg);
      }

      const validImages = [];
      for (const rawImgUrl of [...new Set(candidateUrls)].slice(0, MAX_CAROUSEL_SLIDES)) {
        try {
          const upgraded = await upgradePinimgUrl(rawImgUrl);
          validImages.push(upgraded);
        } catch (err) {
          if (err?.isContentBlock || /Blocked|Unsupported|Raw IP/i.test(err?.message)) {
            throw err;
          }
        }
      }

      if (validImages.length > 0) {
        finalResponse?.body?.cancel?.().catch(() => {});
        return {
          kind: validImages.length > 1 ? "carousel" : "image",
          images: validImages,
          title: rawTitle || "Pinterest Image",
          duration: null,
          canonicalUrl,
        };
      }
    } catch (err) {
      if (err?.isContentBlock || /NSFW or age-restricted|Blocked|Unsupported|Raw IP/i.test(err?.message)) {
        finalResponse?.body?.cancel?.().catch(() => {});
        throw err;
      }
    }
  }

  // Step C: Tier 2 Extraction — Bounded 512 KB HTML Scrape (og:image / __PWS_DATA__ / i.pinimg.com)
  try {
    let html = "";
    if (finalResponse?.ok && finalResponse.url === canonicalUrl) {
      html = await readBoundedHtml(finalResponse, MAX_HTML_BYTES);
    } else {
      finalResponse?.body?.cancel?.().catch(() => {});
      await assertSafePublicUrl(canonicalUrl);
      const htmlRes = await fetch(canonicalUrl, {
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (htmlRes.ok) {
        html = await readBoundedHtml(htmlRes, MAX_HTML_BYTES);
      } else {
        htmlRes.body?.cancel?.().catch(() => {});
      }
    }

    if (html) {
      const titleMatch =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
        html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const rawTitle = decodeHtmlAttr(titleMatch?.[1] || "Pinterest Image");
      assertSafeContentMetadata(rawTitle, 0);

      // Check for video Pin metadata first
      const ogVideoMatch =
        html.match(/<meta[^>]+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url|:secure_url)?["']/i) ||
        html.match(/https?:\/\/v\d*\.pinimg\.com\/videos\/[^\s"'<>\\]+\.mp4/i);
      if (ogVideoMatch) {
        const videoCandidate = decodeHtmlAttr(ogVideoMatch[1] || ogVideoMatch[0]);
        await assertSafePublicUrl(videoCandidate);
        return {
          kind: "video",
          images: [],
          title: rawTitle || "Pinterest Video",
          duration: null,
          canonicalUrl,
        };
      }

      const rawCandidates = [];
      const ogImgRegex =
        /<meta[^>]+(?:property=["']og:image["'][^>]+content=["']([^"']+)["']|content=["']([^"']+)["'][^>]+property=["']og:image["'])/gi;
      let m;
      while ((m = ogImgRegex.exec(html)) !== null) {
        const u = decodeHtmlAttr(m[1] || m[2]);
        if (u) rawCandidates.push(u);
      }

      const pinOrigMatches =
        html.match(/https?:\/\/i\.pinimg\.com\/originals\/[a-zA-Z0-9/_.-]+\.(?:jpg|jpeg|png|webp|gif)/gi) || [];
      for (const u of pinOrigMatches) {
        rawCandidates.push(u);
      }

      if (rawCandidates.length === 0) {
        const pin736Matches =
          html.match(/https?:\/\/i\.pinimg\.com\/(?:736x|564x)\/[a-zA-Z0-9/_.-]+\.(?:jpg|jpeg|png|webp|gif)/gi) || [];
        for (const u of pin736Matches) {
          rawCandidates.push(u);
        }
      }

      const resolvedUrls = [];
      const seenKeys = new Set();
      for (const candidate of rawCandidates) {
        if (resolvedUrls.length >= MAX_CAROUSEL_SLIDES) break;
        const absUrl = new URL(candidate, canonicalUrl).toString();
        const dedupeKey = absUrl.replace(
          /(\/\/i\.pinimg\.com\/)(?:originals|736x|564x|474x|236x)\//i,
          "$1*/",
        );
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        const upgraded = await upgradePinimgUrl(absUrl);
        resolvedUrls.push(upgraded);
      }

      if (resolvedUrls.length > 0) {
        return {
          kind: resolvedUrls.length > 1 ? "carousel" : "image",
          images: resolvedUrls,
          title: rawTitle || "Pinterest Image",
          duration: null,
          canonicalUrl,
        };
      }
    }
  } catch (err) {
    if (err?.isContentBlock || /NSFW or age-restricted|Blocked|Unsupported|Raw IP/i.test(err?.message)) {
      throw err;
    }
  }

  return null;
}

/**
 * Fast 12s metadata probe for `.cdl <url>` interactive menu.
 * Falls back gracefully to `{ title: 'Media Link', duration: null, safeTitle: 'audio' }`
 * on timeout or extractor rate-limits so the menu is never blocked.
 */
export async function probeMediaInfo(url) {
  const resolved = await resolveTikTokUrl(url);

  if (resolved.isPhotoMode) {
    try {
      const meta = await extractTikTokPhotoCarousel(resolved.canonicalUrl);
      if (meta?.slideUrls?.length) {
        const baseTitle = (meta.title || "TikTok Photo Carousel").slice(0, 80);
        return {
          title: `${baseTitle} (${meta.slideUrls.length} slides)`,
          duration: null,
          safeTitle: sanitizeFileName(baseTitle),
          isCarousel: true,
        };
      }
    } catch (err) {
      if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
        throw err;
      }
    }
    return {
      title: "TikTok Photo Carousel",
      duration: null,
      safeTitle: "tiktok_carousel",
      isCarousel: true,
    };
  }

  if (isPinterestUrl(url) || isPinterestUrl(resolved.canonicalUrl)) {
    try {
      const pinMeta = await resolvePinterestMedia(resolved.canonicalUrl);
      if (pinMeta) {
        if (pinMeta.kind === "image" || pinMeta.kind === "carousel") {
          const baseTitle = (pinMeta.title || "Pinterest Image").slice(0, 80);
          const count = pinMeta.images.length;
          return {
            title: `${baseTitle} (${count} ${count === 1 ? "image" : "images"})`,
            duration: null,
            safeTitle: sanitizeFileName(baseTitle),
            isCarousel: true,
          };
        }
        if (pinMeta.kind === "video") {
          const baseTitle = (pinMeta.title || "Pinterest Video").slice(0, 100);
          return {
            title: baseTitle,
            duration: pinMeta.duration,
            safeTitle: sanitizeFileName(baseTitle),
          };
        }
      }
    } catch (err) {
      if (err?.isContentBlock || /NSFW or age-restricted|Blocked|Unsupported|Raw IP/i.test(err?.message)) {
        throw err;
      }
    }
  }

  try {
    const out = await run(
      "yt-dlp",
      [
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        ...getYtDlpSecurityArgs(false),
        "--",
        resolved.canonicalUrl,
      ],
      PROBE_INFO_TIMEOUT_MS,
    );
    const info = JSON.parse(out);
    const rawTitle = (info?.title || info?.fulltitle || "Media Link").trim();
    assertSafeContentMetadata(rawTitle, info?.age_limit);
    const duration =
      typeof info?.duration === "number" && Number.isFinite(info.duration) ? info.duration : null;
    return {
      title: rawTitle.slice(0, 100) || "Media Link",
      duration,
      safeTitle: sanitizeFileName(rawTitle),
    };
  } catch (err) {
    if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
      throw err;
    }
    if (/tiktok\.com/i.test(resolved.canonicalUrl)) {
      const meta = await extractTikTokPhotoCarousel(resolved.canonicalUrl);
      if (meta?.slideUrls?.length) {
        const baseTitle = (meta.title || "TikTok Photo Carousel").slice(0, 80);
        return {
          title: `${baseTitle} (${meta.slideUrls.length} slides)`,
          duration: null,
          safeTitle: sanitizeFileName(baseTitle),
          isCarousel: true,
        };
      }
    }
    try {
      const pinMeta = await resolvePinterestMedia(resolved.canonicalUrl);
      if (pinMeta?.images?.length) {
        const baseTitle = (pinMeta.title || "Pinterest Image").slice(0, 80);
        const count = pinMeta.images.length;
        return {
          title: `${baseTitle} (${count} ${count === 1 ? "image" : "images"})`,
          duration: null,
          safeTitle: sanitizeFileName(baseTitle),
          isCarousel: true,
        };
      }
    } catch (fallbackErr) {
      if (fallbackErr?.isContentBlock || /NSFW or age-restricted/i.test(fallbackErr?.message)) {
        throw fallbackErr;
      }
    }
    return {
      title: "Media Link",
      duration: null,
      safeTitle: "audio",
    };
  }
}

async function downloadRawToJobDir(url, jobDir) {
  const rawPath = path.join(jobDir, "video.mp4");
  const out = await run("yt-dlp", [
    "--no-playlist",
    "--max-filesize",
    "500M",
    "--no-progress",
    ...getYtDlpSecurityArgs(true),
    "-f",
    FORMAT,
    "--merge-output-format",
    "mp4",
    "--remux-video",
    "mp4",
    "--postprocessor-args",
    "ffmpeg:-movflags +faststart",
    "--print",
    "after_move:title",
    "-o",
    rawPath,
    "--",
    url,
  ]);

  if (/does not pass filter/i.test(out || "")) {
    throw new Error(NSFW_BLOCK_MSG);
  }
  const printedTitle = (out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  assertSafeContentMetadata(printedTitle);

  if (!fs.existsSync(rawPath)) {
    throw new Error("No file produced (video may exceed 500 MB or be unavailable)");
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
    throw new Error("No video stream found in URL");
  }

  const needsVideoTranscode = video !== "h264";
  const needsAudioTranscode = Boolean(audio && audio !== "aac");

  if (!needsVideoTranscode && !needsAudioTranscode) {
    return filePath;
  }

  const transcoded = path.join(jobDir, "video_h264.mp4");
  const ffmpegArgs = needsVideoTranscode
    ? [
        "-y",
        "-i",
        filePath,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        transcoded,
      ]
    : [
        "-y",
        "-i",
        filePath,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        transcoded,
      ];

  await run("ffmpeg", ffmpegArgs);
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
    throw new Error("No audio track found in this link");
  }

  if (audio === "mp3" && path.extname(filePath).toLowerCase() === ".mp3") {
    return filePath;
  }

  const mp3Path = path.join(jobDir, "audio_final.mp3");
  await run("ffmpeg", ["-y", "-i", filePath, "-vn", "-c:a", "libmp3lame", "-q:a", "2", mp3Path]);
  await fs.promises.unlink(filePath);
  return mp3Path;
}

async function extractTikTokAudioViaVideoRewrite(canonicalUrl, jobDir) {
  if (!/\/photo\/\d+/i.test(canonicalUrl)) return null;
  const videoUrl = canonicalUrl.replace(/\/photo\/(\d+)/i, "/video/$1");
  const outputTemplate = path.join(jobDir, "tt_audio.%(ext)s");
  const out = await run("yt-dlp", [
    "--no-playlist",
    "--max-filesize",
    "500M",
    "--no-progress",
    ...getYtDlpSecurityArgs(true),
    "-f",
    "bestaudio/best",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--print",
    "after_move:title",
    "-o",
    outputTemplate,
    "--",
    videoUrl,
  ]);
  if (/does not pass filter/i.test(out || "")) {
    throw new Error(NSFW_BLOCK_MSG);
  }
  const printedTitle = (out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  assertSafeContentMetadata(printedTitle);
  const files = (await fs.promises.readdir(jobDir)).filter(
    (f) => f.startsWith("tt_audio.") && !f.endsWith(".part") && !f.endsWith(".ytdl"),
  );
  if (files.length === 0) return null;
  const filePath = await ensureMp3Audio(path.join(jobDir, files[0]), jobDir);
  return { filePath, printedTitle };
}

/**
 * Download high-quality MP3 audio for `.cdl` (`2` / `mp3`).
 * @returns {Promise<{ filePath: string, sizeInMB: number, fileName: string, cleanup: () => Promise<void> }>}
 */
export async function downloadAudioMp3(url, preferredTitle = "") {
  const resolved = await resolveTikTokUrl(url);
  assertSafeContentMetadata(preferredTitle);

  return withJobDir("audio", async (jobDir, cleanup) => {
    if (resolved.isPhotoMode) {
      let filePath = null;
      let fallbackTitle = "";
      const meta = await extractTikTokPhotoCarousel(resolved.canonicalUrl);
      if (meta?.title) fallbackTitle = meta.title;
      if (meta?.audioUrl) {
        try {
          const rawAudio = path.join(jobDir, "carousel_audio_raw.bin");
          await downloadSafeBinary(meta.audioUrl, rawAudio, MAX_AUDIO_BYTES);
          filePath = await ensureMp3Audio(rawAudio, jobDir);
        } catch {
          filePath = null;
        }
      }
      if (!filePath) {
        const rewritten = await extractTikTokAudioViaVideoRewrite(resolved.canonicalUrl, jobDir);
        if (rewritten) {
          filePath = rewritten.filePath;
          if (!fallbackTitle) fallbackTitle = rewritten.printedTitle;
        }
      }
      if (!filePath) {
        throw new Error("No audio track found in this TikTok photo post");
      }
      const sizeInMB = fs.statSync(filePath).size / (1024 * 1024);
      const safeTitle = sanitizeFileName(preferredTitle || fallbackTitle || "audio");
      return {
        filePath,
        sizeInMB,
        fileName: `${safeTitle}.mp3`,
        cleanup,
      };
    }

    const outputTemplate = path.join(jobDir, "audio.%(ext)s");
    let out;
    try {
      out = await run("yt-dlp", [
        "--no-playlist",
        "--max-filesize",
        "500M",
        "--no-progress",
        ...getYtDlpSecurityArgs(true),
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--print",
        "after_move:title",
        "-o",
        outputTemplate,
        "--",
        resolved.canonicalUrl,
      ]);
    } catch (err) {
      if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
        throw err;
      }
      if (
        isPinterestUrl(url) ||
        isPinterestUrl(resolved.canonicalUrl) ||
        /Requested format is not available|Unsupported URL/i.test(err?.message)
      ) {
        const pinMeta = await resolvePinterestMedia(resolved.canonicalUrl).catch(() => null);
        if (pinMeta && (pinMeta.kind === "image" || pinMeta.kind === "carousel")) {
          throw new Error(
            "This Pinterest Pin is an image and has no audio track. Use .c, .csc, or reply 1 to download the image.",
          );
        }
      }
      throw err;
    }

    if (/does not pass filter/i.test(out || "")) {
      throw new Error(NSFW_BLOCK_MSG);
    }
    const printedTitle = (out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    assertSafeContentMetadata(printedTitle);
    const files = (await fs.promises.readdir(jobDir)).filter(
      (f) => !f.endsWith(".part") && !f.endsWith(".ytdl"),
    );
    if (files.length === 0) {
      throw new Error("No audio file produced (media may exceed 500 MB or be unavailable)");
    }

    const rawFilePath = path.join(jobDir, files[0]);
    const filePath = await ensureMp3Audio(rawFilePath, jobDir);
    const sizeInMB = fs.statSync(filePath).size / (1024 * 1024);
    const safeTitle = sanitizeFileName(preferredTitle || printedTitle || "audio");

    return {
      filePath,
      sizeInMB,
      fileName: `${safeTitle}.mp3`,
      cleanup,
    };
  });
}

/**
 * Safely download a remote binary asset (image slide or audio track) with
 * manual redirect validation via assertSafePublicUrl and streaming size cap.
 */
async function downloadSafeBinary(url, destPath, maxBytes) {
  let currentUrl = url;
  let parsed;
  let res;

  for (let hop = 0; hop <= CAROUSEL_MAX_REDIRECTS; hop++) {
    parsed = await assertSafePublicUrl(currentUrl);
    res = await fetch(currentUrl, {
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(CAROUSEL_FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location || hop === CAROUSEL_MAX_REDIRECTS) {
        throw new Error("Too many or invalid redirects while fetching carousel asset");
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }
    break;
  }

  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch carousel asset (HTTP ${res.status})`);
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error("Carousel asset exceeds maximum allowed size");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of res.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error("Carousel asset exceeds maximum allowed size");
    }
    chunks.push(Buffer.from(chunk));
  }

  await fs.promises.writeFile(destPath, Buffer.concat(chunks));
  return destPath;
}

/**
 * Inspect TikTok Photo Mode (two-tier HTML + tikwm.com API), Pinterest Pins, or yt-dlp JSON
 * for multi-entry carousels / image posts to extract slide image URLs and background audio URL.
 */
async function extractCarouselMetadata(url) {
  const resolved = await resolveTikTokUrl(url);

  // Never call yt-dlp on a TikTok /photo/ URL (yt-dlp throws Unsupported URL)
  if (resolved.isPhotoMode || /tiktok\.com/i.test(resolved.canonicalUrl)) {
    const ttMeta = await extractTikTokPhotoCarousel(resolved.canonicalUrl);
    if (ttMeta?.slideUrls?.length) {
      return ttMeta;
    }
    if (resolved.isPhotoMode) {
      return null;
    }
  }

  // Pinterest image / GIF / carousel fallback
  if (isPinterestUrl(url) || isPinterestUrl(resolved.canonicalUrl)) {
    const pinMeta = await resolvePinterestMedia(resolved.canonicalUrl);
    if (pinMeta?.images?.length) {
      return {
        slideUrls: pinMeta.images,
        audioUrl: null,
        title: pinMeta.title,
        canonicalUrl: pinMeta.canonicalUrl,
      };
    }
  }

  // Try yt-dlp JSON inspection for non-TikTok-photo multi-entry carousels
  try {
    const out = await run(
      "yt-dlp",
      [
        "--ignore-no-formats-error",
        "--dump-single-json",
        "--playlist-items",
        "1-15",
        "--no-warnings",
        ...getYtDlpSecurityArgs(false),
        "--",
        resolved.canonicalUrl,
      ],
      20_000,
    );
    const info = JSON.parse(out);
    assertSafeContentMetadata(info?.title || info?.fulltitle || "", info?.age_limit);

    const slideUrls = [];
    let audioUrl = null;

    if (Array.isArray(info?.entries) && info.entries.length > 0) {
      for (const entry of info.entries) {
        if (!entry) continue;
        assertSafeContentMetadata(entry.title || "", entry.age_limit);
        const hasRealVideo =
          entry.vcodec &&
          entry.vcodec !== "none" &&
          !/^(jpg|jpeg|png|webp|gif)$/i.test(entry.ext || "");
        if (hasRealVideo) continue;

        const imgCandidate =
          (entry.url && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(entry.url) ? entry.url : null) ||
          entry.thumbnails?.slice(-1)[0]?.url ||
          entry.thumbnail ||
          null;
        if (imgCandidate && /^https?:\/\//i.test(imgCandidate)) {
          slideUrls.push(imgCandidate);
        }
        if (!audioUrl && entry.acodec && entry.acodec !== "none" && entry.url) {
          audioUrl = entry.url;
        }
      }
    } else if (info && (!info.vcodec || info.vcodec === "none")) {
      const formats = Array.isArray(info.formats) ? info.formats : [];
      for (const fmt of formats) {
        if (fmt?.url && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(fmt.url)) {
          slideUrls.push(fmt.url);
        } else if (!audioUrl && fmt?.acodec && fmt.acodec !== "none" && fmt?.url) {
          audioUrl = fmt.url;
        }
      }
      if (slideUrls.length === 0 && Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
        const bestThumb = info.thumbnails[info.thumbnails.length - 1]?.url;
        if (bestThumb && /^https?:\/\//i.test(bestThumb)) {
          slideUrls.push(bestThumb);
        }
      }
    }

    if (slideUrls.length > 0) {
      return { slideUrls, audioUrl, canonicalUrl: resolved.canonicalUrl };
    }
  } catch (err) {
    if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
      throw err;
    }
  }

  // Final HTML og:image fallback if yt-dlp produced no slides
  const htmlMeta = await resolvePinterestMedia(resolved.canonicalUrl);
  if (htmlMeta?.images?.length) {
    return {
      slideUrls: htmlMeta.images,
      audioUrl: null,
      title: htmlMeta.title,
      canonicalUrl: htmlMeta.canonicalUrl,
    };
  }

  return null;
}

/**
 * Download up to MAX_CAROUSEL_SLIDES (10) validated slide images (concurrency 3)
 * and optional background MP3 audio into jobDir.
 */
async function resolveCarouselPost(url, jobDir, existingAudioPath = null) {
  const meta = await extractCarouselMetadata(url);
  if (!meta || !meta.slideUrls?.length) return null;

  const totalAvailSlides = meta.slideUrls.length;
  const targetUrls = meta.slideUrls.slice(0, MAX_CAROUSEL_SLIDES);
  const slides = new Array(targetUrls.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < targetUrls.length) {
      const idx = cursor++;
      const slideUrl = targetUrls[idx];
      const slidePath = path.join(jobDir, `slide_${String(idx + 1).padStart(3, "0")}.jpg`);
      await downloadSafeBinary(slideUrl, slidePath, MAX_SLIDE_BYTES);
      const { video } = await probeCodecs(slidePath);
      if (!video) {
        throw new Error(`Downloaded carousel slide ${idx + 1} is not a valid image`);
      }
      slides[idx] = slidePath;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CAROUSEL_CONCURRENCY, targetUrls.length) }, () => worker()),
  );

  let audioPath = null;
  if (existingAudioPath && fs.existsSync(existingAudioPath)) {
    try {
      audioPath = await ensureMp3Audio(existingAudioPath, jobDir);
    } catch {
      audioPath = null;
    }
  }
  if (!audioPath && meta.audioUrl) {
    try {
      const rawAudio = path.join(jobDir, "carousel_audio_raw.bin");
      await downloadSafeBinary(meta.audioUrl, rawAudio, MAX_AUDIO_BYTES);
      audioPath = await ensureMp3Audio(rawAudio, jobDir);
    } catch {
      audioPath = null;
    }
  }
  if (!audioPath && meta.canonicalUrl && /\/photo\/\d+/i.test(meta.canonicalUrl)) {
    try {
      const rewritten = await extractTikTokAudioViaVideoRewrite(meta.canonicalUrl, jobDir);
      if (rewritten) audioPath = rewritten.filePath;
    } catch {
      audioPath = null;
    }
  }

  if (slides.length === 1) {
    const firstUrl = targetUrls[0] || "";
    const firstCodecs = await probeCodecs(slides[0]);
    if (/\.gif(\?|$)/i.test(firstUrl) || firstCodecs.video === "gif") {
      const gifMp4 = path.join(jobDir, "gif_loop.mp4");
      await run("ffmpeg", [
        "-y",
        "-i",
        slides[0],
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-level:v",
        "4.1",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-an",
        "-movflags",
        "+faststart",
        gifMp4,
      ]);
      const sizeInMB = fs.statSync(gifMp4).size / (1024 * 1024);
      return {
        filePath: gifMp4,
        sizeInMB,
        isGif: true,
      };
    }
  }

  return {
    kind: "carousel",
    slides,
    totalAvailSlides,
    audioPath,
  };
}

async function splitStatusIfOver60s(optimizedFilePath, jobDir) {
  const { duration } = await probeCodecs(optimizedFilePath);
  if (duration <= 60) {
    return [{ filePath: optimizedFilePath, partNumber: 1, totalParts: 1 }];
  }

  const segmentPattern = path.join(jobDir, "status_part_%03d.mp4");
  await run("ffmpeg", [
    "-y",
    "-i",
    optimizedFilePath,
    "-c",
    "copy",
    "-map",
    "0",
    "-segment_time",
    "58",
    "-f",
    "segment",
    "-reset_timestamps",
    "1",
    segmentPattern,
  ]);

  // Fix #8: immediately remove unsplit optimized file after segmentation
  await fs.promises.unlink(optimizedFilePath);

  const segmentFiles = (await fs.promises.readdir(jobDir))
    .filter((name) => /^status_part_\d+\.mp4$/.test(name))
    .sort();

  if (segmentFiles.length === 0) {
    throw new Error("Failed to split Status video into segments");
  }

  const totalParts = segmentFiles.length;
  return segmentFiles.map((name, idx) => ({
    filePath: path.join(jobDir, name),
    partNumber: idx + 1,
    totalParts,
  }));
}

/**
 * Render carousel slide images + optional background audio into a 1080x1920
 * WhatsApp Status HD slideshow MP4 (3.0s per slide) and auto-split if > 60s.
 * @returns {Promise<Array<{ filePath: string, partNumber: number, totalParts: number }>>}
 */
export async function buildCarouselStatusVideo(slides, audioPath, jobDir) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error("No slides provided for Status slideshow");
  }

  const normPaths = [];
  for (let i = 0; i < slides.length; i++) {
    const normName = `norm_${String(i + 1).padStart(3, "0")}.jpg`;
    const normPath = path.join(jobDir, normName);
    await run("ffmpeg", [
      "-y",
      "-i",
      slides[i],
      "-frames:v",
      "1",
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p",
      "-q:v",
      "2",
      normPath,
    ]);
    normPaths.push({ normName, normPath });
  }

  const concatLines = ["ffconcat version 1.0"];
  for (const item of normPaths) {
    concatLines.push(`file '${item.normName}'`);
    concatLines.push("duration 3.0");
  }
  concatLines.push(`file '${normPaths[normPaths.length - 1].normName}'`);

  const concatTxtPath = path.join(jobDir, "slides_concat.txt");
  await fs.promises.writeFile(concatTxtPath, `${concatLines.join("\n")}\n`);

  const totalDurationSec = slides.length * 3;
  const slideshowPath = path.join(jobDir, "carousel_status.mp4");
  const hasAudio = Boolean(audioPath && fs.existsSync(audioPath));
  const audioInputArgs = hasAudio
    ? ["-stream_loop", "-1", "-i", audioPath]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];

  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatTxtPath,
    ...audioInputArgs,
    "-t",
    String(totalDurationSec),
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level:v",
    "4.2",
    "-r",
    "30",
    "-crf",
    "21",
    "-maxrate",
    "3800k",
    "-bufsize",
    "7600k",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-shortest",
    "-movflags",
    "+faststart",
    slideshowPath,
  ]);

  for (const item of normPaths) {
    await fs.promises.unlink(item.normPath).catch(() => {});
  }

  return splitStatusIfOver60s(slideshowPath, jobDir);
}

/**
 * Download a WhatsApp-safe (H.264/AAC MP4) video or multi-slide photo carousel
 * for `.c <url>` or `.cdl` (`1` / `mp4`).
 */
export async function downloadVideo(url) {
  const resolved = await resolveTikTokUrl(url);

  return withJobDir("", async (jobDir, cleanup) => {
    if (!resolved.isPhotoMode) {
      try {
        const rawPath = await downloadRawToJobDir(resolved.canonicalUrl, jobDir);
        const filePath = await ensureWhatsAppCodecs(rawPath, jobDir);
        const sizeInMB = fs.statSync(filePath).size / (1024 * 1024);
        return { filePath, sizeInMB, cleanup };
      } catch (err) {
        if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
          throw err;
        }
        const rawCandidate = path.join(jobDir, "video.mp4");
        const carousel = await resolveCarouselPost(
          resolved.canonicalUrl,
          jobDir,
          fs.existsSync(rawCandidate) ? rawCandidate : null,
        );
        if (carousel) {
          return { ...carousel, cleanup };
        }
        throw err;
      }
    }

    const carousel = await resolveCarouselPost(resolved.canonicalUrl, jobDir);
    if (!carousel) {
      throw new Error("Could not extract slides from photo carousel post");
    }
    return { ...carousel, cleanup };
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
    throw new Error("No video stream found in URL");
  }

  const optimizedFilePath = path.join(jobDir, "status_opt.mp4");
  await run("ffmpeg", [
    "-y",
    "-i",
    rawFilePath,
    "-vf",
    STATUS_SCALE_FILTER,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level:v",
    "4.2",
    "-preset",
    "medium",
    "-crf",
    "21",
    "-maxrate",
    "4000k",
    "-bufsize",
    "8000k",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    optimizedFilePath,
  ]);

  // Fix #8: immediately remove raw source file so two copies never sit on disk
  await fs.promises.unlink(rawFilePath);

  return splitStatusIfOver60s(optimizedFilePath, jobDir);
}

/**
 * Download, optimize for WhatsApp Status HD (preserving native FPS or building a
 * 1080x1920 slideshow from photo carousels), and auto-split if > 60s.
 * @returns {Promise<{ parts: Array<{ filePath: string, partNumber: number, totalParts: number }>, cleanup: () => Promise<void> }>}
 */
export async function downloadAndOptimizeForStatus(url) {
  const resolved = await resolveTikTokUrl(url);

  return withJobDir("", async (jobDir, cleanup) => {
    if (!resolved.isPhotoMode) {
      try {
        const rawFilePath = await downloadRawToJobDir(resolved.canonicalUrl, jobDir);
        const parts = await optimizeAndSplitForStatus(rawFilePath, jobDir);
        return { parts, cleanup };
      } catch (err) {
        if (err?.isContentBlock || err?.isAuthRequired || /NSFW or age-restricted/i.test(err?.message)) {
          throw err;
        }
        const rawCandidate = path.join(jobDir, "video.mp4");
        const carousel = await resolveCarouselPost(
          resolved.canonicalUrl,
          jobDir,
          fs.existsSync(rawCandidate) ? rawCandidate : null,
        );
        if (carousel) {
          const slideList = carousel.slides || (carousel.filePath ? [carousel.filePath] : []);
          const parts = await buildCarouselStatusVideo(
            slideList,
            carousel.audioPath || null,
            jobDir,
          );
          return { parts, cleanup };
        }
        throw err;
      }
    }

    const carousel = await resolveCarouselPost(resolved.canonicalUrl, jobDir);
    if (!carousel) {
      throw new Error("Could not extract slides from photo carousel post");
    }
    const slideList = carousel.slides || (carousel.filePath ? [carousel.filePath] : []);
    const parts = await buildCarouselStatusVideo(slideList, carousel.audioPath || null, jobDir);
    return { parts, cleanup };
  });
}
