// index.js — Baileys socket + .c / .cs / .csc / .cdl / .chelp (.menu) router (see .agents/skills/whatsapp-baileys-architect)
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  extractMessageContent,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import {
  downloadVideo,
  downloadAndOptimizeForStatus,
  downloadAudioMp3,
  probeMediaInfo,
} from "./downloader.js";
import {
  createSticker,
  convertStickerToMedia,
  MAX_STICKER_CONVERT_BYTES,
} from "./sticker.js";

const INLINE_LIMIT_MB = 50;
const MAX_STICKER_BYTES = 15 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = 2;
const RECONNECT_DELAY_MS = 3000;
const MENU_TTL_MS = 120_000; // 2-minute TTL for .cdl interactive selection menus
const HELP_COOLDOWN_MS = 10_000; // 10-second per-chat cooldown for .chelp / .menu
const MAX_SENT_IDS = 200;
const C_USAGE = "Usage: Send .c <url> to download an HD video.";
const CS_USAGE =
  "Usage: Send .cs <url> to download a Status HD video (auto-splits >60s).";
const STICKER_USAGE =
  'Usage: Reply to an image/GIF with .csc, send an image with caption .csc, or send .csc <image-url> (add "crop" for square crop).';
const STICKER_TO_MEDIA_USAGE =
  "Usage: Reply to a sticker with .cimg (to PNG), .cvid (to MP4 video), or .cgif (to looping GIF).";
const CDL_USAGE =
  "Usage: Send .cdl <url> (for interactive MP4/MP3 menu) or .cdl mp4 <url> / .cdl mp3 <url>.";
const HELP_TEXT = `🤖 *CITAMO BOT — COMMANDS*

🎬 *Video, Audio & Carousels*
• \`.c <url>\` — HD video or photo carousel
• \`.cs <url>\` — Status HD (auto-splits >60s & builds slideshow video from photo posts)
• \`.cdl <url>\` — Choose MP4 or MP3 menu
• \`.cdl mp4/mp3 <url>\` — Direct MP4 or MP3

🖼️ *Stickers* _(reply, caption, or URL)_
• \`.csc [url]\` — Full-frame sticker
• \`.csc crop [url]\` — Square-cropped sticker
• \`.cimg\` — Sticker to PNG image _(reply)_
• \`.cvid / .cgif\` — Animated sticker to MP4/GIF _(reply)_

💡 *Supports:* YouTube, TikTok, IG, FB, X, Reddit, SoundCloud & more.`;

const logger = pino({ level: "silent" });

// Fix #3: Module-level active socket reference updated across reconnects
let activeSock = null;

// Fix #6: Lightweight in-memory FIFO concurrency semaphore
let activeJobs = 0;
const waitQueue = [];

// Self-message loop guard: bounded Set of message IDs sent by the bot
const sentMessageIds = new Set();

function rememberSentId(id) {
  if (!id) return;
  sentMessageIds.add(id);
  if (sentMessageIds.size > MAX_SENT_IDS) {
    const oldest = sentMessageIds.values().next().value;
    sentMessageIds.delete(oldest);
  }
}

// Per-chat cooldown store for .chelp / .menu keyed by `remoteJid`
const helpCooldowns = new Map();

// Pending .cdl interactive menus keyed by `${remoteJid}_${senderJid}`
const pendingCdlMenus = new Map();

function setPendingCdlMenu(menuKey, data) {
  const existing = pendingCdlMenus.get(menuKey);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pendingCdlMenus.delete(menuKey);
  }, MENU_TTL_MS);
  timer.unref?.();

  pendingCdlMenus.set(menuKey, { ...data, timer });
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return ` (${mins}:${String(secs).padStart(2, "0")})`;
}

async function withJobSlot(fn) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    await new Promise((resolve) => waitQueue.push(resolve));
  }
  activeJobs++;
  try {
    return await fn();
  } finally {
    activeJobs--;
    if (waitQueue.length > 0) {
      const next = waitQueue.shift();
      next();
    }
  }
}

/**
 * Wait briefly if activeSock is mid-reconnect so in-flight jobs don't fail
 * when a brief Wi-Fi blip swaps the socket instance.
 */
async function getReadySock(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sock = activeSock;
    if (sock) {
      try {
        await sock.waitForSocketOpen();
        if (activeSock === sock) return sock;
      } catch {
        // Socket closed while waiting; loop and wait for replacement socket
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!activeSock) {
    throw new Error("WhatsApp socket is disconnected");
  }
  return activeSock;
}

async function sendSafe(jid, content, options) {
  const sock = await getReadySock();
  const res = await sock.sendMessage(jid, content, options);
  rememberSentId(res?.key?.id);
  return res;
}

/**
 * Inspect an unwrapped message payload and return sticker-compatible media info if present.
 */
function extractStickerMediaNode(unwrapped) {
  if (!unwrapped) return null;
  if (unwrapped.imageMessage) {
    return {
      mime: unwrapped.imageMessage.mimetype || "image/jpeg",
      fileLength: Number(unwrapped.imageMessage.fileLength || 0),
      isAnimated: null,
    };
  }
  if (unwrapped.videoMessage) {
    return {
      mime: unwrapped.videoMessage.mimetype || "video/mp4",
      fileLength: Number(unwrapped.videoMessage.fileLength || 0),
      isAnimated: true,
    };
  }
  if (unwrapped.stickerMessage) {
    return {
      mime: unwrapped.stickerMessage.mimetype || "image/webp",
      fileLength: Number(unwrapped.stickerMessage.fileLength || 0),
      isAnimated: unwrapped.stickerMessage.isAnimated ? true : null,
    };
  }
  return null;
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
  });
  activeSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (sock !== activeSock) return;
    if (qr) {
      console.log("Scan this QR code in WhatsApp → Linked devices → Link a device:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      activeSock = sock;
      console.log("✅ Connected to WhatsApp. Listening for .c, .cs, .csc, .cdl, and .chelp");
    }
    if (connection === "close") {
      sock.ev.removeAllListeners();
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error(
          '❌ Logged out. Delete the "auth_info_baileys/" folder and restart to scan a new QR code.',
        );
        process.exit(1);
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        console.warn(
          "⚠️ Connection replaced by another active WhatsApp session. Stopping reconnect loop.",
        );
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log("Restart required by WhatsApp server. Reconnecting immediately...");
        startSock().catch(console.error);
        return;
      }

      console.log(
        `Connection closed (code ${statusCode}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
      );
      setTimeout(() => startSock().catch(console.error), RECONNECT_DELAY_MS);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (sock !== activeSock || type !== "notify") return; // ignore stale socket & history sync
    for (const msg of messages) {
      if (!msg.message || msg.key.remoteJid === "status@broadcast") continue;

      // Self-message loop guard: ignore messages sent by the bot itself
      if (msg.key?.id && sentMessageIds.has(msg.key.id)) continue;

      // Fix #1: Unwrap ephemeral / disappearing, viewOnce, and documentWithCaption wrappers
      const content = extractMessageContent(msg.message);
      if (!content) continue;

      const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        "";

      const trimmed = text.trim();
      if (!trimmed) continue;

      const remoteJid = msg.key.remoteJid;
      const senderJid = msg.key.participant || remoteJid;
      const menuKey = `${remoteJid}_${senderJid}`;

      // 1. Check if user is replying to an active .cdl menu (`1`, `2`, `mp4`, `mp3`, `img`)
      const choice = trimmed.toLowerCase();
      if (
        pendingCdlMenus.has(menuKey) &&
        (choice === "1" || choice === "2" || choice === "mp4" || choice === "mp3" || choice === "img")
      ) {
        const entry = pendingCdlMenus.get(menuKey);
        clearTimeout(entry.timer);
        pendingCdlMenus.delete(menuKey);

        const format = choice === "1" || choice === "mp4" || choice === "img" ? "mp4" : "mp3";
        handleCdlDownload(msg, format, entry.url, entry.title).catch((e) =>
          console.error(".cdl menu handler error:", e),
        );
        continue;
      }

      // 2. Check for .chelp or .menu command (with 10s per-chat cooldown)
      if (choice === ".chelp" || choice === ".menu") {
        const now = Date.now();
        const lastHelpAt = helpCooldowns.get(remoteJid) || 0;
        if (now - lastHelpAt < HELP_COOLDOWN_MS) continue;
        helpCooldowns.set(remoteJid, now);
        setTimeout(() => helpCooldowns.delete(remoteJid), HELP_COOLDOWN_MS).unref?.();

        sendSafe(remoteJid, { text: HELP_TEXT }, { quoted: msg }).catch((e) =>
          console.error(".chelp handler error:", e),
        );
        continue;
      }

      const tokens = trimmed.split(/\s+/);
      const cmd = tokens[0]?.toLowerCase();

      if (cmd === ".c") {
        const url = tokens[1];
        if (!url || !/^https?:\/\//i.test(url)) {
          sendSafe(remoteJid, { text: C_USAGE }, { quoted: msg }).catch(() => {});
          continue;
        }
        handleCdlDownload(msg, "mp4", url).catch((e) => console.error("Handler error:", e));
      } else if (cmd === ".cs") {
        const url = tokens[1];
        if (!url || !/^https?:\/\//i.test(url)) {
          sendSafe(remoteJid, { text: CS_USAGE }, { quoted: msg }).catch(() => {});
          continue;
        }
        handleStatusCommand(msg, url).catch((e) => console.error("Handler error:", e));
      } else if (cmd === ".csc") {
        const args = tokens.slice(1);
        const crop = args.some((t) => t.toLowerCase() === "crop");
        const url = args.find((t) => /^https?:\/\//i.test(t)) || null;
        handleStickerCommand(msg, content, { crop, url }).catch((e) =>
          console.error("Sticker handler error:", e),
        );
      } else if (cmd === ".cimg" || cmd === ".cvid" || cmd === ".cgif") {
        const targetFormat = cmd === ".cimg" ? "img" : cmd === ".cvid" ? "vid" : "gif";
        handleStickerToMediaCommand(msg, content, targetFormat).catch((e) =>
          console.error(`${cmd} handler error:`, e),
        );
      } else if (cmd === ".cdl") {
        const arg1 = tokens[1];
        const arg2 = tokens[2];
        const lowerArg1 = arg1?.toLowerCase();

        // Direct shortcut mode: `.cdl mp4 <url>` or `.cdl mp3 <url>`
        if ((lowerArg1 === "mp4" || lowerArg1 === "mp3") && arg2 && /^https?:\/\//i.test(arg2)) {
          handleCdlDownload(msg, lowerArg1, arg2).catch((e) =>
            console.error(".cdl direct handler error:", e),
          );
        } else if (arg1 && /^https?:\/\//i.test(arg1)) {
          // Interactive 2-step menu mode: `.cdl <url>`
          handleCdlMenu(msg, menuKey, arg1).catch((e) =>
            console.error(".cdl menu prompt error:", e),
          );
        } else {
          sendSafe(remoteJid, { text: CDL_USAGE }, { quoted: msg }).catch(() => {});
        }
      }
    }
  });
}

async function handleCdlMenu(msg, menuKey, url) {
  const jid = msg.key.remoteJid;
  const react = (emoji) => sendSafe(jid, { react: { text: emoji, key: msg.key } });

  await react("🔍");
  try {
    const info = await withJobSlot(() => probeMediaInfo(url));
    const durationText = formatDuration(info.duration);
    const opt1 = info.isCarousel ? "*img*" : "*mp4*";
    const opt1Label = info.isCarousel ? "Photo + Audio" : "HD Video (MP4)";

    const menuText =
      `🎬 *${info.title}*${durationText}\n\n` +
      `Reply with:\n` +
      `*1* or ${opt1} — ${opt1Label}\n` +
      `*2* or *mp3* — Audio Only (MP3)\n\n` +
      `_(Expires in 2 minutes)_`;

    const sentMsg = await sendSafe(jid, { text: menuText }, { quoted: msg });
    setPendingCdlMenu(menuKey, {
      url,
      title: info.title,
      originalMsg: msg,
      promptMsgId: sentMsg?.key?.id,
    });
  } catch (err) {
    console.error(`Command .cdl menu failed for ${url}:`, err.message);
    await react("❌").catch(() => {});
    await sendSafe(
      jid,
      { text: `❌ Download failed: ${err.message.slice(0, 200)}` },
      { quoted: msg },
    ).catch(() => {});
  }
}

async function handleCdlDownload(msg, format, url, preferredTitle = "") {
  const jid = msg.key.remoteJid;
  const react = (emoji) => sendSafe(jid, { react: { text: emoji, key: msg.key } });

  await react("⏳");
  let media;
  try {
    await withJobSlot(async () => {
      if (format === "mp4") {
        media = await downloadVideo(url);
        if (media.kind === "carousel") {
          console.log(
            `[.cdl mp4] Sending ${media.slides.length} carousel slide(s) to ${jid}`,
          );
          for (let i = 0; i < media.slides.length; i++) {
            const slidePath = media.slides[i];
            const extraNote =
              i === 0 && media.totalAvailSlides > media.slides.length
                ? ` (Showing first ${media.slides.length} of ${media.totalAvailSlides} slides)`
                : "";
            const caption = `📸 Slide ${i + 1}/${media.slides.length}${extraNote}`;
            await sendSafe(
              jid,
              { image: { url: slidePath }, caption },
              { quoted: msg },
            );
            if (i < media.slides.length - 1 || media.audioPath) {
              await new Promise((r) => setTimeout(r, 350));
            }
          }
          if (media.audioPath) {
            await sendSafe(
              jid,
              {
                audio: { url: media.audioPath },
                mimetype: "audio/mpeg",
                ptt: false,
              },
              { quoted: msg },
            );
          }
        } else {
          const { filePath, sizeInMB, isGif } = media;
          console.log(`[.cdl mp4] Sending ${sizeInMB.toFixed(1)} MB ${isGif ? "GIF" : "video"} to ${jid}`);

          const payload =
            sizeInMB <= INLINE_LIMIT_MB
              ? {
                  video: { url: filePath },
                  mimetype: "video/mp4",
                  ...(isGif ? { gifPlayback: true } : {}),
                }
              : {
                  document: { url: filePath },
                  mimetype: "video/mp4",
                  fileName: "video_hd.mp4",
                  caption: "✅ HD Video (Sent as document to preserve original quality)",
                };
          await sendSafe(jid, payload, { quoted: msg });
        }
      } else {
        media = await downloadAudioMp3(url, preferredTitle);
        const { filePath, sizeInMB, fileName } = media;
        console.log(`[.cdl mp3] Sending ${sizeInMB.toFixed(1)} MB audio (${fileName}) to ${jid}`);

        const payload =
          sizeInMB <= INLINE_LIMIT_MB
            ? {
                audio: { url: filePath },
                mimetype: "audio/mpeg",
                ptt: false,
                fileName,
              }
            : {
                document: { url: filePath },
                mimetype: "audio/mpeg",
                fileName,
                caption: "🎵 High-Quality MP3 (Sent as document due to size > 50MB)",
              };
        await sendSafe(jid, payload, { quoted: msg });
      }
    });

    await react("✅");
  } catch (err) {
    console.error(`Command .cdl (${format}) failed for ${url}:`, err.message);
    await react("❌").catch(() => {});
    await sendSafe(
      jid,
      { text: `❌ Download failed: ${err.message.slice(0, 200)}` },
      { quoted: msg },
    ).catch(() => {});
  } finally {
    if (media?.cleanup) await media.cleanup();
  }
}

async function handleStickerCommand(msg, content, { crop, url }) {
  const jid = msg.key.remoteJid;
  const react = (emoji) => sendSafe(jid, { react: { text: emoji, key: msg.key } });

  // Resolve media source in priority order:
  // Case A: Direct media message with `.csc` caption
  let targetMsg = null;
  let mediaInfo = extractStickerMediaNode(content);
  if (mediaInfo) {
    targetMsg = { key: msg.key, message: content };
  }

  // Case B: Replied / Tagged / Quoted media message
  if (!targetMsg) {
    const contextInfo =
      content.extendedTextMessage?.contextInfo ||
      content.imageMessage?.contextInfo ||
      content.videoMessage?.contextInfo ||
      content.documentMessage?.contextInfo ||
      content.stickerMessage?.contextInfo;

    if (contextInfo?.quotedMessage) {
      const unwrappedQuoted = extractMessageContent(contextInfo.quotedMessage);
      mediaInfo = extractStickerMediaNode(unwrappedQuoted);
      if (mediaInfo) {
        targetMsg = {
          key: {
            remoteJid: jid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
          },
          message: unwrappedQuoted,
        };
      }
    }
  }

  // Case C: Direct image/GIF URL (.csc <url>)
  if (!targetMsg && !url) {
    await sendSafe(jid, { text: STICKER_USAGE }, { quoted: msg }).catch(() => {});
    return;
  }

  await react("⏳");
  try {
    if (mediaInfo?.fileLength > MAX_STICKER_BYTES) {
      throw new Error("Media exceeds 15 MB limit for sticker creation");
    }

    await withJobSlot(async () => {
      let stickerBuffer;
      if (targetMsg) {
        const sock = await getReadySock();
        const mediaBuffer = await downloadMediaMessage(
          targetMsg,
          "buffer",
          {},
          { logger, reuploadRequest: sock.updateMediaMessage },
        );
        if (mediaBuffer.length > MAX_STICKER_BYTES) {
          throw new Error("Media exceeds 15 MB limit for sticker creation");
        }
        stickerBuffer = await createSticker({
          buffer: mediaBuffer,
          mime: mediaInfo.mime,
          isAnimated: mediaInfo.isAnimated,
          crop,
        });
      } else {
        stickerBuffer = await createSticker({ url, crop });
      }

      console.log(
        `[.csc] Sending ${(stickerBuffer.length / 1024).toFixed(1)} KB sticker (crop=${crop}) to ${jid}`,
      );
      await sendSafe(jid, { sticker: stickerBuffer }, { quoted: msg });
    });

    await react("✅");
  } catch (err) {
    console.error(`Command .csc failed:`, err.message);
    await react("❌").catch(() => {});
    await sendSafe(
      jid,
      { text: `❌ Sticker failed: ${err.message.slice(0, 200)}` },
      { quoted: msg },
    ).catch(() => {});
  }
}

async function handleStickerToMediaCommand(msg, content, targetFormat) {
  const jid = msg.key.remoteJid;
  const react = (emoji) => sendSafe(jid, { react: { text: emoji, key: msg.key } });

  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.stickerMessage?.contextInfo;

  const unwrappedQuoted = contextInfo?.quotedMessage
    ? extractMessageContent(contextInfo.quotedMessage)
    : null;
  const stickerNode = unwrappedQuoted?.stickerMessage;

  if (!stickerNode) {
    await sendSafe(jid, { text: STICKER_TO_MEDIA_USAGE }, { quoted: msg }).catch(() => {});
    return;
  }

  await react("⏳");
  let media;
  try {
    if (Number(stickerNode.fileLength || 0) > MAX_STICKER_CONVERT_BYTES) {
      throw new Error("Sticker exceeds 2 MB limit for conversion");
    }

    const targetMsg = {
      key: {
        remoteJid: jid,
        id: contextInfo.stanzaId,
        participant: contextInfo.participant,
      },
      message: unwrappedQuoted,
    };

    await withJobSlot(async () => {
      const sock = await getReadySock();
      const stickerBuffer = await downloadMediaMessage(
        targetMsg,
        "buffer",
        {},
        { logger, reuploadRequest: sock.updateMediaMessage },
      );
      if (stickerBuffer.length > MAX_STICKER_CONVERT_BYTES) {
        throw new Error("Sticker exceeds 2 MB limit for conversion");
      }

      media = await convertStickerToMedia(stickerBuffer, targetFormat);

      if (targetFormat === "img") {
        await sendSafe(
          jid,
          { image: { url: media.filePath }, caption: "🖼️ Converted from sticker" },
          { quoted: msg },
        );
      } else if (targetFormat === "vid") {
        await sendSafe(
          jid,
          {
            video: { url: media.filePath },
            mimetype: "video/mp4",
            caption: "🎬 Converted from animated sticker",
          },
          { quoted: msg },
        );
      } else {
        await sendSafe(
          jid,
          {
            video: { url: media.filePath },
            mimetype: "video/mp4",
            gifPlayback: true,
            caption: "👾 Converted to GIF",
          },
          { quoted: msg },
        );
      }
    });

    await react("✅");
  } catch (err) {
    console.error(`Command .c${targetFormat} failed:`, err.message);
    await react("❌").catch(() => {});
    await sendSafe(
      jid,
      { text: `❌ Conversion failed: ${err.message.slice(0, 200)}` },
      { quoted: msg },
    ).catch(() => {});
  } finally {
    if (media?.cleanup) await media.cleanup();
  }
}

async function handleStatusCommand(msg, url) {
  const jid = msg.key.remoteJid;
  const react = (emoji) => sendSafe(jid, { react: { text: emoji, key: msg.key } });

  await react("⏳");
  let media;
  try {
    await withJobSlot(async () => {
      media = await downloadAndOptimizeForStatus(url);
      console.log(`[.cs] Sending ${media.parts.length} Status HD part(s) to ${jid}`);

      for (const part of media.parts) {
        const caption =
          part.totalParts === 1
            ? "✅ Status HD (Original FPS • Optimized Bitrate)"
            : `✅ Status HD — Part ${part.partNumber}/${part.totalParts}`;

        await sendSafe(
          jid,
          {
            video: { url: part.filePath },
            mimetype: "video/mp4",
            caption,
          },
          { quoted: msg },
        );
      }
    });

    await react("✅");
  } catch (err) {
    console.error(`Command .cs failed for ${url}:`, err.message);
    await react("❌").catch(() => {});
    await sendSafe(
      jid,
      { text: `❌ Download failed: ${err.message.slice(0, 200)}` },
      { quoted: msg },
    ).catch(() => {});
  } finally {
    if (media?.cleanup) await media.cleanup();
  }
}

startSock().catch(console.error);
