// test-downloader.js — automated test suite for .c, fallback transcoding, .cs Status HD, .csc WebP stickers, and .cdl MP3 audio extraction.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import webp from 'node-webpmux';
import {
  assertSafeContentMetadata,
  assertSafePublicUrl,
  buildCarouselStatusVideo,
  downloadVideo,
  downloadAndOptimizeForStatus,
  downloadAudioMp3,
  ensureMp3Audio,
  ensureWhatsAppCodecs,
  extractTikTokPhotoCarousel,
  optimizeAndSplitForStatus,
  probeCodecs,
  probeMediaInfo,
  resolveTikTokUrl,
  run,
  TEMP_ROOT,
} from './downloader.js';
import { convertStickerToMedia, createSticker } from './sticker.js';

const url = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19s
let ok = true;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  ok = false;
}

// ---------------------------------------------------------------------------
// Test 1: Standard .c download, H.264/AAC codec verification, and cleanup
// ---------------------------------------------------------------------------
console.log('=== Test 1: Standard .c <url> download ===');
{
  const media = await downloadVideo(url);
  try {
    const codecs = await probeCodecs(media.filePath);
    console.log(
      `[Test 1] file=${path.relative(process.cwd(), media.filePath)} size=${media.sizeInMB.toFixed(2)}MB video=${codecs.video} audio=${codecs.audio}`,
    );
    if (codecs.video !== 'h264' || (codecs.audio && codecs.audio !== 'aac')) {
      fail(`Test 1 codecs not WhatsApp-safe: video=${codecs.video} audio=${codecs.audio}`);
    }
  } finally {
    const jobDir = path.dirname(media.filePath);
    await media.cleanup();
    if (fs.existsSync(jobDir)) {
      fail('Test 1 jobDir still exists after cleanup');
    } else {
      console.log('[Test 1] PASS (h264/aac verified & cleaned up)');
    }
  }
}

// ---------------------------------------------------------------------------
// Test 2: Fallback transcode (VP9 + Opus -> H.264 + AAC) & immediate unlink
// ---------------------------------------------------------------------------
console.log('\n=== Test 2: Synthetic VP9 + Opus fallback transcode & pre-transcode unlink ===');
{
  const jobDir = path.join(TEMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(jobDir, { recursive: true });
  const rawWebm = path.join(jobDir, 'synthetic_vp9_opus.webm');

  try {
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
      '-c:v', 'libvpx-vp9',
      '-c:a', 'libopus',
      rawWebm,
    ]);

    const before = await probeCodecs(rawWebm);
    console.log(`[Test 2] pre-transcode codecs: video=${before.video} audio=${before.audio}`);
    if (before.video !== 'vp9' || before.audio !== 'opus') {
      fail(`Test 2 expected vp9+opus input, got video=${before.video} audio=${before.audio}`);
    }

    const transcodedPath = await ensureWhatsAppCodecs(rawWebm, jobDir);
    if (fs.existsSync(rawWebm)) {
      fail('Test 2 pre-transcode file was NOT unlinked (Fix #8)');
    }

    const after = await probeCodecs(transcodedPath);
    console.log(`[Test 2] post-transcode codecs: video=${after.video} audio=${after.audio}`);
    if (after.video !== 'h264' || after.audio !== 'aac') {
      fail(`Test 2 expected h264+aac output, got video=${after.video} audio=${after.audio}`);
    } else {
      console.log('[Test 2] PASS (vp9+opus transcoded to h264+aac and original unlinked)');
    }
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// Test 3: Status HD (.cs) native FPS preservation & >60s auto-splitting
// ---------------------------------------------------------------------------
console.log('\n=== Test 3: Status HD (.cs) native FPS preservation & >60s auto-split ===');
{
  // 3a: End-to-end downloadAndOptimizeForStatus(url) (< 60s, single part)
  const statusMedia = await downloadAndOptimizeForStatus(url);
  try {
    if (statusMedia.parts.length !== 1) {
      fail(`Test 3a expected 1 part for 19s clip, got ${statusMedia.parts.length}`);
    }
    const part = statusMedia.parts[0];
    const info = await probeCodecs(part.filePath);
    console.log(
      `[Test 3a] parts=${statusMedia.parts.length} video=${info.video} audio=${info.audio} r_frame_rate=${info.rFrameRate} duration=${info.duration.toFixed(1)}s`,
    );
    if (info.video !== 'h264' || (info.audio && info.audio !== 'aac')) {
      fail(`Test 3a invalid codecs: video=${info.video} audio=${info.audio}`);
    }
  } finally {
    await statusMedia.cleanup();
  }

  // 3b: Synthetic 65s 24fps clip -> verify native 24/1 FPS preserved & split into 2 segments
  const jobDir = path.join(TEMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(jobDir, { recursive: true });
  const rawLong = path.join(jobDir, 'synthetic_65s_24fps.mp4');

  try {
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=65:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=65',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      rawLong,
    ]);

    const srcInfo = await probeCodecs(rawLong);
    const parts = await optimizeAndSplitForStatus(rawLong, jobDir);

    if (fs.existsSync(rawLong) || fs.existsSync(path.join(jobDir, 'status_opt.mp4'))) {
      fail('Test 3b intermediate unsplit files were NOT unlinked (Fix #8)');
    }

    if (parts.length !== 2) {
      fail(`Test 3b expected 2 split parts for 65s video, got ${parts.length}`);
    }

    for (const part of parts) {
      const pInfo = await probeCodecs(part.filePath);
      console.log(
        `[Test 3b] part ${part.partNumber}/${part.totalParts}: video=${pInfo.video} audio=${pInfo.audio} r_frame_rate=${pInfo.rFrameRate} duration=${pInfo.duration.toFixed(1)}s`,
      );
      if (pInfo.rFrameRate !== srcInfo.rFrameRate) {
        fail(`Test 3b FPS changed from ${srcInfo.rFrameRate} to ${pInfo.rFrameRate}`);
      }
      if (pInfo.video !== 'h264' || pInfo.audio !== 'aac') {
        fail(`Test 3b segment codecs invalid: video=${pInfo.video} audio=${pInfo.audio}`);
      }
    }
    console.log('[Test 3] PASS (native FPS preserved & >60s clip split into 58s segments)');
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// Test 4: .csc Sticker Pipeline (Static PNG + Animated GIF, Fit + Crop, EXIF)
// ---------------------------------------------------------------------------
console.log('\n=== Test 4: .csc Sticker creation (static <100KB, animated <500KB, 512x512, EXIF) ===');
{
  const synthDir = path.join(TEMP_ROOT, `synth_${crypto.randomUUID()}`);
  fs.mkdirSync(synthDir, { recursive: true });

  try {
    const pngPath = path.join(synthDir, 'input_800x600.png');
    const gifPath = path.join(synthDir, 'input_anim.gif');

    // Generate synthetic 800x600 PNG
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=800x600:rate=1',
      '-vframes', '1',
      pngPath,
    ]);

    // Generate synthetic 2-second 320x240 animated GIF
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12',
      gifPath,
    ]);

    const pngBuffer = await fs.promises.readFile(pngPath);
    const gifBuffer = await fs.promises.readFile(gifPath);

    // 4a: Static sticker (default fit mode)
    const staticWebp = await createSticker({
      buffer: pngBuffer,
      mime: 'image/png',
      isAnimated: false,
      crop: false,
    });

    // 4b: Animated sticker (crop mode)
    const animWebp = await createSticker({
      buffer: gifBuffer,
      mime: 'image/gif',
      isAnimated: true,
      crop: true,
    });

    // Verify Static Sticker with node-webpmux + ffprobe
    const staticImg = new webp.Image();
    await staticImg.load(staticWebp);
    const staticExifStr = staticImg.exif ? staticImg.exif.subarray(22).toString('utf-8') : '';
    const staticExif = staticExifStr ? JSON.parse(staticExifStr) : {};

    console.log(
      `[Test 4a] static WebP: ${staticImg.width}x${staticImg.height} size=${(staticWebp.length / 1024).toFixed(1)}KB pack="${staticExif['sticker-pack-name']}"`,
    );
    if (staticImg.width !== 512 || staticImg.height !== 512) {
      fail(`Test 4a expected 512x512 static WebP, got ${staticImg.width}x${staticImg.height}`);
    }
    if (staticWebp.length > 100 * 1024) {
      fail(`Test 4a static sticker exceeds 100 KB: ${staticWebp.length} bytes`);
    }
    if (staticExif['sticker-pack-id'] !== 'citamo-bot-pack') {
      fail(`Test 4a missing or invalid EXIF sticker-pack-id: ${staticExifStr}`);
    }

    // Verify Animated Sticker with node-webpmux
    const animImg = new webp.Image();
    await animImg.load(animWebp);
    const animExifStr = animImg.exif ? animImg.exif.subarray(22).toString('utf-8') : '';
    const animExif = animExifStr ? JSON.parse(animExifStr) : {};

    console.log(
      `[Test 4b] animated WebP (crop): ${animImg.width}x${animImg.height} anim=${animImg.hasAnim} size=${(animWebp.length / 1024).toFixed(1)}KB pack="${animExif['sticker-pack-name']}"`,
    );
    if (animImg.width !== 512 || animImg.height !== 512) {
      fail(`Test 4b expected 512x512 animated WebP, got ${animImg.width}x${animImg.height}`);
    }
    if (!animImg.hasAnim) {
      fail('Test 4b expected animated WebP (hasAnim === true)');
    }
    if (animWebp.length > 500 * 1024) {
      fail(`Test 4b animated sticker exceeds 500 KB: ${animWebp.length} bytes`);
    }
    if (animExif['sticker-pack-id'] !== 'citamo-bot-pack') {
      fail(`Test 4b missing or invalid EXIF sticker-pack-id: ${animExifStr}`);
    }

    console.log('[Test 4] PASS (static + animated 512x512 WebP stickers with EXIF verified)');
  } finally {
    await fs.promises.rm(synthDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// Test 5: .cdl Metadata Probe, MP3 Audio Extraction & Silent-Stream Rejection
// ---------------------------------------------------------------------------
console.log('\n=== Test 5: .cdl Metadata probe, MP3 audio extraction & silent-stream rejection ===');
{
  // 5a: probeMediaInfo + downloadAudioMp3
  const info = await probeMediaInfo(url);
  console.log(`[Test 5a] probeMediaInfo: title="${info.title}" duration=${info.duration}s safeTitle="${info.safeTitle}"`);

  const audioMedia = await downloadAudioMp3(url, info.title);
  try {
    const codecs = await probeCodecs(audioMedia.filePath);
    console.log(
      `[Test 5a] fileName="${audioMedia.fileName}" size=${audioMedia.sizeInMB.toFixed(2)}MB audio=${codecs.audio}`,
    );
    if (codecs.audio !== 'mp3' || !audioMedia.fileName.endsWith('.mp3')) {
      fail(`Test 5a expected mp3 audio stream, got audio=${codecs.audio} fileName=${audioMedia.fileName}`);
    }
  } finally {
    const jobDir = path.dirname(audioMedia.filePath);
    await audioMedia.cleanup();
    if (fs.existsSync(jobDir)) {
      fail('Test 5a audio jobDir still exists after cleanup');
    }
  }

  // 5b: Silent video-only stream rejection (`No audio track found in this link`)
  const silentDir = path.join(TEMP_ROOT, `silent_${crypto.randomUUID()}`);
  fs.mkdirSync(silentDir, { recursive: true });
  const silentVideo = path.join(silentDir, 'silent.mp4');

  try {
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-an',
      silentVideo,
    ]);

    let rejected = false;
    try {
      await ensureMp3Audio(silentVideo, silentDir);
    } catch (err) {
      rejected = err.message === 'No audio track found in this link';
      console.log(`[Test 5b] silent stream rejected as expected: "${err.message}"`);
    }
    if (!rejected) {
      fail('Test 5b expected ensureMp3Audio to reject silent video without audio track');
    } else {
      console.log('[Test 5] PASS (MP3 extraction + silent stream rejection verified)');
    }
  } finally {
    await fs.promises.rm(silentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// Test 6: SSRF Protection (assertSafePublicUrl) & fetchImageFromUrl HTTP Suite
// ---------------------------------------------------------------------------
console.log('\n=== Test 6: SSRF blocking, safe redirects, & fetchImageFromUrl limits ===');
{
  // 6a: SSRF block by default for loopback, localhost, RFC1918, and cloud metadata IPs
  const blockedTargets = [
    'http://127.0.0.1:8080/secret.png',
    'http://localhost/secret.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/internal.png',
    'http://192.168.1.1/router.png',
    'http://172.16.0.1/internal.png',
    'http://[::1]/secret.png',
    'http://[::ffff:127.0.0.1]/secret.png',
  ];

  for (const badUrl of blockedTargets) {
    let blocked = false;
    try {
      await assertSafePublicUrl(badUrl);
    } catch (err) {
      blocked = /Blocked private or local URL/i.test(err.message);
    }
    if (!blocked) {
      fail(`Test 6a expected SSRF block for ${badUrl}`);
    }
  }
  console.log(`[Test 6a] SSRF blocked all ${blockedTargets.length} loopback/private/metadata targets`);

  // 6b: Local HTTP server tests with ALLOW_LOOPBACK_TESTS=1
  const srvDir = path.join(TEMP_ROOT, `srv_${crypto.randomUUID()}`);
  fs.mkdirSync(srvDir, { recursive: true });
  const srvPngPath = path.join(srvDir, 'srv.png');

  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=256x256:rate=1',
    '-vframes', '1',
    srvPngPath,
  ]);
  const srvPngBuf = await fs.promises.readFile(srvPngPath);

  const server = http.createServer((req, res) => {
    if (req.url === '/valid.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': srvPngBuf.length });
      res.end(srvPngBuf);
    } else if (req.url === '/redirect.png') {
      res.writeHead(302, { Location: '/valid.png' });
      res.end();
    } else if (req.url === '/ssrf-redirect') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (req.url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>not an image</html>');
    } else if (req.url === '/oversize.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      const chunk = Buffer.alloc(1024 * 1024, 0xaa);
      let sent = 0;
      const push = () => {
        while (sent < 16 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) {
            res.once('drain', push);
            return;
          }
        }
        res.end();
      };
      push();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.ALLOW_LOOPBACK_TESTS = '1';

  try {
    // Valid URL via 302 redirect -> 512x512 WebP sticker
    const urlSticker = await createSticker({ url: `${baseUrl}/redirect.png`, crop: false });
    const img = new webp.Image();
    await img.load(urlSticker);
    if (img.width !== 512 || img.height !== 512) {
      fail(`Test 6b expected 512x512 WebP from URL redirect, got ${img.width}x${img.height}`);
    }
    console.log(`[Test 6b] URL redirect -> 512x512 WebP (${(urlSticker.length / 1024).toFixed(1)}KB) OK`);

    // Redirect to cloud metadata IP must still be blocked even when loopback is allowed for tests
    let redirectBlocked = false;
    try {
      await createSticker({ url: `${baseUrl}/ssrf-redirect` });
    } catch (err) {
      redirectBlocked = /Blocked private or local URL/i.test(err.message);
      console.log(`[Test 6b] SSRF redirect hop blocked as expected: "${err.message}"`);
    }
    if (!redirectBlocked) {
      fail('Test 6b expected 302 redirect to 169.254.169.254 to be blocked');
    }

    // Non-image Content-Type rejection
    let htmlRejected = false;
    try {
      await createSticker({ url: `${baseUrl}/html` });
    } catch (err) {
      htmlRejected = /supported image/i.test(err.message);
      console.log(`[Test 6b] HTML response rejected as expected: "${err.message}"`);
    }
    if (!htmlRejected) {
      fail('Test 6b expected text/html URL to be rejected');
    }

    // >15 MB streaming response rejection
    let oversizeRejected = false;
    try {
      await createSticker({ url: `${baseUrl}/oversize.png` });
    } catch (err) {
      oversizeRejected = /15 MB/i.test(err.message);
      console.log(`[Test 6b] >15 MB stream aborted as expected: "${err.message}"`);
    }
    if (!oversizeRejected) {
      fail('Test 6b expected >15 MB stream to be rejected');
    }

    console.log('[Test 6] PASS (SSRF protection, redirect validation, & fetchImageFromUrl limits verified)');
  } finally {
    delete process.env.ALLOW_LOOPBACK_TESTS;
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(srvDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// Test 7: Multi-Layer NSFW Blocker, IP-Grabber Defense & Domain Allowlist
// ---------------------------------------------------------------------------
console.log('\n=== Test 7: NSFW blocker, IP-grabber defense, raw-IP block & domain allowlist ===');
{
  // 7a: Zero-latency NSFW domains, TLDs, and paths (< 5ms, no yt-dlp spawned)
  const nsfwUrls = [
    'https://www.pornhub.com/view_video.php?viewkey=123',
    'https://nhentai.net/g/12345/',
    'https://example.xxx/video.mp4',
    'https://sub.xvideos.com/video123',
    'https://www.reddit.com/r/nsfw/comments/123/post/',
  ];

  const t0 = performance.now();
  for (const nsfwUrl of nsfwUrls) {
    let blocked = false;
    try {
      await assertSafePublicUrl(nsfwUrl);
    } catch (err) {
      blocked = /NSFW or age-restricted/i.test(err.message);
    }
    if (!blocked) {
      fail(`Test 7a expected NSFW block for ${nsfwUrl}`);
    }
  }
  const elapsedMs = performance.now() - t0;
  console.log(`[Test 7a] Blocked all ${nsfwUrls.length} NSFW URLs in ${elapsedMs.toFixed(2)}ms`);
  if (elapsedMs > 50) {
    fail(`Test 7a expected zero-latency pre-DNS NSFW block, took ${elapsedMs.toFixed(2)}ms`);
  }

  // 7b: IP grabbers, canary webhooks, arbitrary untrusted domains, and raw public IPs
  const grabberUrls = [
    'https://grabify.link/ABC123',
    'https://iplogger.org/12345',
    'https://sub.webhook.site/token',
    'https://abc.ngrok-free.app/clip.mp4',
  ];
  for (const gUrl of grabberUrls) {
    let blocked = false;
    try {
      await assertSafePublicUrl(gUrl);
    } catch (err) {
      blocked = /IP grabber|untrusted tracking/i.test(err.message);
    }
    if (!blocked) {
      fail(`Test 7b expected IP grabber block for ${gUrl}`);
    }
  }

  let untrustedBlocked = false;
  try {
    await assertSafePublicUrl('https://my-evil-ip-logger.com/video.mp4');
  } catch (err) {
    untrustedBlocked = /Unsupported(?: or untrusted)? domain/i.test(err.message);
  }
  if (!untrustedBlocked) {
    fail('Test 7b expected unknown domain to be rejected by allowlist before DNS lookup');
  }

  let rawIpBlocked = false;
  try {
    await assertSafePublicUrl('http://93.184.216.34/image.png');
  } catch (err) {
    rawIpBlocked = /Raw IP URLs are blocked/i.test(err.message);
  }
  if (!rawIpBlocked) {
    fail('Test 7b expected raw public IP literal URL to be blocked');
  }
  console.log('[Test 7b] IP grabbers, unknown domains, and raw public IPs blocked pre-DNS');

  // 7c: Metadata title & age_limit filter
  let titleBlocked = false;
  let ageBlocked = false;
  try {
    assertSafeContentMetadata('Leaked 18+ NSFW video', 0);
  } catch (err) {
    titleBlocked = /NSFW or age-restricted/i.test(err.message);
  }
  try {
    assertSafeContentMetadata('Normal Gaming Clip', 18);
  } catch (err) {
    ageBlocked = /NSFW or age-restricted/i.test(err.message);
  }
  if (!titleBlocked || !ageBlocked) {
    fail('Test 7c expected assertSafeContentMetadata to block 18+ title and age_limit >= 18');
  }

  // 7d: Allowed public platforms pass validation
  const allowedCheck = await assertSafePublicUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  if (allowedCheck.hostname !== 'www.youtube.com') {
    fail('Test 7d expected youtube.com to pass assertSafePublicUrl');
  }
  console.log('[Test 7] PASS (NSFW blocker, anti-IP-grabber, domain allowlist & metadata filter verified)');
}

// ---------------------------------------------------------------------------
// Test 8: Sticker-to-Media (.cimg / .cvid / .cgif) & Carousel Status Stitcher
// ---------------------------------------------------------------------------
console.log('\n=== Test 8: Sticker-to-Media (.cimg, .cvid, .cgif) & Carousel Status MP4 ===');
{
  const synthDir = path.join(TEMP_ROOT, `test8_${crypto.randomUUID()}`);
  fs.mkdirSync(synthDir, { recursive: true });

  try {
    const pngPath = path.join(synthDir, 'src.png');
    const gifPath = path.join(synthDir, 'src.gif');

    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x480:rate=1',
      '-vframes', '1',
      pngPath,
    ]);
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      gifPath,
    ]);

    const staticWebp = await createSticker({
      buffer: await fs.promises.readFile(pngPath),
      mime: 'image/png',
      isAnimated: false,
    });
    const animWebp = await createSticker({
      buffer: await fs.promises.readFile(gifPath),
      mime: 'image/gif',
      isAnimated: true,
    });

    // 8a: Static sticker -> .cimg (PNG)
    const imgMedia = await convertStickerToMedia(staticWebp, 'img');
    const imgJobDir = path.dirname(imgMedia.filePath);
    try {
      const codecs = await probeCodecs(imgMedia.filePath);
      console.log(`[Test 8a] .cimg output codec=${codecs.video} mime=${imgMedia.mimetype}`);
      if (codecs.video !== 'png' || imgMedia.mimetype !== 'image/png' || imgMedia.isGifPlayback !== false) {
        fail(`Test 8a expected PNG output, got codec=${codecs.video} mime=${imgMedia.mimetype}`);
      }
    } finally {
      await imgMedia.cleanup();
      if (fs.existsSync(imgJobDir)) {
        fail('Test 8a st2media jobDir still exists after cleanup');
      }
    }

    // 8b: Static sticker passed to .cvid must reject cleanly
    let staticToVidRejected = false;
    try {
      await convertStickerToMedia(staticWebp, 'vid');
    } catch (err) {
      staticToVidRejected = /static sticker.*Use \.cimg/i.test(err.message);
      console.log(`[Test 8b] static sticker -> .cvid rejected as expected: "${err.message}"`);
    }
    if (!staticToVidRejected) {
      fail('Test 8b expected static sticker passed to convertStickerToMedia(..., "vid") to reject');
    }

    // 8c: Animated sticker -> .cvid & .cgif
    for (const fmt of ['vid', 'gif']) {
      const vidMedia = await convertStickerToMedia(animWebp, fmt);
      const vidJobDir = path.dirname(vidMedia.filePath);
      try {
        const probeOut = await run('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-count_frames',
          '-show_entries', 'stream=codec_name,nb_read_frames,width,height',
          '-of', 'json',
          vidMedia.filePath,
        ]);
        const stream = JSON.parse(probeOut).streams?.[0] || {};
        const frames = Number(stream.nb_read_frames || 0);
        console.log(
          `[Test 8c] .c${fmt} codec=${stream.codec_name} ${stream.width}x${stream.height} frames=${frames} gifPlayback=${vidMedia.isGifPlayback}`,
        );
        if (
          stream.codec_name !== 'h264' ||
           !(frames > 5) ||
          vidMedia.isGifPlayback !== (fmt === 'gif')
        ) {
          fail(`Test 8c invalid .c${fmt} output: codec=${stream.codec_name} frames=${frames}`);
        }
      } finally {
        await vidMedia.cleanup();
        if (fs.existsSync(vidJobDir)) {
          fail(`Test 8c .c${fmt} jobDir still exists after cleanup`);
        }
      }
    }

    // 8d: Carousel Slideshow Synthesis (3 synthetic JPEGs + 5s audio -> 1080x1920 h264+aac MP4)
    const carouselDir = path.join(TEMP_ROOT, `carousel_${crypto.randomUUID()}`);
    fs.mkdirSync(carouselDir, { recursive: true });
    try {
      const slides = [];
      for (let i = 1; i <= 3; i++) {
        const slidePath = path.join(carouselDir, `slide_${i}.jpg`);
        await run('ffmpeg', [
          '-y',
          '-f', 'lavfi', '-i', `testsrc=duration=1:size=800x600:rate=1`,
          '-vframes', '1',
          slidePath,
        ]);
        slides.push(slidePath);
      }
      const audioTrack = path.join(carouselDir, 'bgm.mp3');
      await run('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
        '-c:a', 'libmp3lame', '-q:a', '2',
        audioTrack,
      ]);

      const parts = await buildCarouselStatusVideo(slides, audioTrack, carouselDir);
      if (parts.length !== 1) {
        fail(`Test 8d expected 1 status part for 3-slide carousel, got ${parts.length}`);
      }
      const probeOut = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
        '-of', 'json',
        parts[0].filePath,
      ]);
      const parsed = JSON.parse(probeOut);
      const vStream = parsed.streams?.find((s) => s.codec_type === 'video') || {};
      const aStream = parsed.streams?.find((s) => s.codec_type === 'audio') || {};
      console.log(
        `[Test 8d] Carousel Status MP4: ${vStream.width}x${vStream.height} video=${vStream.codec_name} audio=${aStream.codec_name} duration=${Number(parsed.format?.duration || 0).toFixed(1)}s`,
      );
      if (
        vStream.codec_name !== 'h264' ||
        aStream.codec_name !== 'aac' ||
        vStream.width !== 1080 ||
        vStream.height !== 1920
      ) {
        fail(
          `Test 8d expected 1080x1920 h264+aac carousel MP4, got ${vStream.width}x${vStream.height} ${vStream.codec_name}+${aStream.codec_name}`,
        );
      }
    } finally {
      await fs.promises.rm(carouselDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    console.log('[Test 8] PASS (.cimg, .cvid, .cgif & 1080x1920 Carousel Status MP4 verified)');
  } finally {
    await fs.promises.rm(synthDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------------------------------------------------------------------------
// Test 9: TikTok Shortlink & /photo/ Carousel Resolution (No Unsupported URL)
// ---------------------------------------------------------------------------
console.log('\n=== Test 9: TikTok /photo/ shortlink resolution & carousel download ===');
{
  const ttShortUrl = 'https://vt.tiktok.com/ZSpqgVJGW/';
  const resolved = await resolveTikTokUrl(ttShortUrl);
  console.log(
    `[Test 9a] resolveTikTokUrl: canonical="${resolved.canonicalUrl}" isPhotoMode=${resolved.isPhotoMode} photoId=${resolved.photoId}`,
  );
  if (!resolved.isPhotoMode || resolved.photoId !== '7699701644761533703') {
    fail(`Test 9a expected isPhotoMode=true and photoId=7699701644761533703, got ${JSON.stringify(resolved)}`);
  }

  const probe = await probeMediaInfo(ttShortUrl);
  console.log(`[Test 9b] probeMediaInfo: title="${probe.title}" isCarousel=${probe.isCarousel}`);
  if (!probe.isCarousel) {
    fail('Test 9b expected probeMediaInfo to mark TikTok /photo/ URL as isCarousel=true');
  }

  const carouselMedia = await downloadVideo(ttShortUrl);
  try {
    console.log(
      `[Test 9c] downloadVideo: kind=${carouselMedia.kind} slides=${carouselMedia.slides?.length}/${carouselMedia.totalAvailSlides} audio=${Boolean(carouselMedia.audioPath)}`,
    );
    if (carouselMedia.kind !== 'carousel' || !carouselMedia.slides?.length) {
      fail(`Test 9c expected kind="carousel" with slides, got kind=${carouselMedia.kind}`);
    } else {
      const firstSlideCodecs = await probeCodecs(carouselMedia.slides[0]);
      if (!firstSlideCodecs.video) {
        fail('Test 9c expected first carousel slide to be a valid image');
      }
      console.log('[Test 9] PASS (TikTok /photo/ shortlink resolved & downloaded without Unsupported URL error)');
    }
  } finally {
    const jobDir = carouselMedia.slides?.[0]
      ? path.dirname(carouselMedia.slides[0])
      : carouselMedia.filePath
        ? path.dirname(carouselMedia.filePath)
        : null;
    await carouselMedia.cleanup();
    if (jobDir && fs.existsSync(jobDir)) {
      fail('Test 9c carousel jobDir still exists after cleanup');
    }
  }
}

const leftovers = fs.readdirSync(TEMP_ROOT);
if (leftovers.length > 0) {
  fail(`temp/ is not empty after all tests: ${leftovers.join(', ')}`);
} else {
  console.log('\nAll tests completed — cleanup OK (temp/ is empty)');
}

process.exit(ok ? 0 : 1);
