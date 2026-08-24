const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

// ==================================================
// CONFIG
// ==================================================

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

const AUTO_CLIP_INTERVAL = 10 * 60 * 1000;

const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 30;

// نلتقط أكثر من المطلوب حتى نقدر نختار مقطع عشوائي
const CAPTURE_SECONDS = 40;

const TELEGRAM_LIMIT = 49 * 1024 * 1024;

// مهلة FFmpeg
const FFMPEG_TIMEOUT = 90 * 1000;

// عدد محاولات FFmpeg
const FFMPEG_RETRIES = 3;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

if (!ffmpegPath) {
  console.error("❌ FFmpeg غير موجود");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 1000,
    params: {
      timeout: 10
    }
  }
});

// ==================================================
// RENDER SERVER
// ==================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Drex Clips Bot is running ✅");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Render server running on port ${PORT}`);
});

// ==================================================
// DATA
// ==================================================

const DATA_DIR = path.join(
  os.tmpdir(),
  "drex-clips"
);

const CHANNELS_FILE = path.join(
  DATA_DIR,
  "channels.json"
);

const STREAMERS_FILE = path.join(
  DATA_DIR,
  "streamers.json"
);

const CLIPS_FILE = path.join(
  DATA_DIR,
  "clips.json"
);

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(fallback, null, 2)
      );

      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.error(
      `⚠️ JSON error ${file}:`,
      error.message
    );

    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error(
      `❌ Save error ${file}:`,
      error.message
    );
  }
}

let channels = loadJSON(
  CHANNELS_FILE,
  {}
);

let streamers = loadJSON(
  STREAMERS_FILE,
  []
);

let clips = loadJSON(
  CLIPS_FILE,
  {}
);

// ==================================================
// QUEUE
// ==================================================

let queue = [];
let processing = false;

function addToQueue(job) {
  queue.push(job);

  console.log(
    `📥 Queue +1 | ${job.type} | @${job.streamer} | ${queue.length}`
  );

  processQueue();
}

async function processQueue() {
  if (processing) return;
  if (!queue.length) return;

  processing = true;

  const job = queue.shift();

  try {
    await createAndSendClip(job);
  } catch (error) {
    console.error(
      "❌ Clip job:",
      error?.stack ||
      error?.message ||
      error
    );

    if (job.notifyChatId) {
      try {
        await bot.sendMessage(
          job.notifyChatId,
          [
            `❌ فشل إنشاء كليب @${job.streamer}`,
            "",
            String(
              error?.message ||
              "خطأ غير معروف"
            ).slice(0, 1200)
          ].join("\n")
        );
      } catch {}
    }
  }

  processing = false;

  setTimeout(
    processQueue,
    1500
  );
}

// ==================================================
// UTILITIES
// ==================================================

function cleanUsername(username) {
  return String(username || "")
    .trim()
    .replace(/^@/, "")
    .replace(
      /^https?:\/\/(www\.)?kick\.com\//i,
      ""
    )
    .split(/[/?#]/)[0];
}

function randomInt(min, max) {
  return Math.floor(
    Math.random() *
      (max - min + 1)
  ) + min;
}

function randomClipLength() {
  return randomInt(
    MIN_CLIP_SECONDS,
    MAX_CLIP_SECONDS
  );
}

function tempFile(prefix) {
  return path.join(
    DATA_DIR,
    `${prefix}-${crypto
      .randomBytes(8)
      .toString("hex")}.mp4`
  );
}

function deleteFile(file) {
  try {
    if (
      file &&
      fs.existsSync(file)
    ) {
      fs.unlinkSync(file);
    }
  } catch {}
}

function fileSizeMB(file) {
  if (!fs.existsSync(file)) return 0;

  return (
    fs.statSync(file).size /
    1024 /
    1024
  );
}

// ==================================================
// START
// ==================================================

bot.onText(
  /^\/start$/i,
  async msg => {
    await bot.sendMessage(
      msg.chat.id,
      [
        "🤖 Drex Clips Bot",
        "",
        "🎬 بوت كليبات Kick",
        "",
        "🔴 كليب تلقائي كل 10 دقائق",
        "⏱️ مدة 15–30 ثانية",
        "📺 أعلى جودة متاحة",
        "",
        "🎬 كليب يدوي:",
        "/clip username",
        "",
        "➕ إضافة:",
        "/add username",
        "",
        "📋 الحسابات:",
        "/list",
        "",
        "➖ حذف:",
        "/remove username"
      ].join("\n")
    );
  }
);

// ==================================================
// CHANNEL DETECTION
// ==================================================

bot.on(
  "channel_post",
  async msg => {
    try {
      if (!msg.chat) return;

      const id = String(
        msg.chat.id
      );

      if (!channels[id]) {
        channels[id] = {
          id: msg.chat.id,
          title:
            msg.chat.title ||
            "بدون اسم",
          username:
            msg.chat.username ||
            null,
          addedAt:
            new Date().toISOString()
        };

        saveJSON(
          CHANNELS_FILE,
          channels
        );

        console.log(
          `📢 Channel detected: ${msg.chat.title}`
        );
      }
    } catch (error) {
      console.error(
        "❌ Channel detection:",
        error.message
      );
    }
  }
);

// ==================================================
// BOT ADDED TO CHANNEL
// ==================================================

bot.on(
  "my_chat_member",
  async update => {
    try {
      const chat =
        update.chat;

      const status =
        update.new_chat_member?.status;

      if (!chat) return;

      if (
        chat.type === "channel" &&
        (
          status === "administrator" ||
          status === "member"
        )
      ) {
        channels[
          String(chat.id)
        ] = {
          id: chat.id,
          title:
            chat.title ||
            "بدون اسم",
          username:
            chat.username ||
            null,
          addedAt:
            new Date().toISOString()
        };

        saveJSON(
          CHANNELS_FILE,
          channels
        );

        console.log(
          `✅ Channel registered: ${chat.title}`
        );
      }

      if (
        chat.type === "channel" &&
        (
          status === "left" ||
          status === "kicked"
        )
      ) {
        delete channels[
          String(chat.id)
        ];

        saveJSON(
          CHANNELS_FILE,
          channels
        );
      }
    } catch (error) {
      console.error(
        "❌ my_chat_member:",
        error.message
      );
    }
  }
);

// ==================================================
// ADD
// ==================================================

bot.onText(
  /^\/add\s+(.+)$/i,
  async (msg, match) => {
    const usernames =
      match[1]
        .split(/[,\s]+/)
        .map(cleanUsername)
        .filter(Boolean);

    const added = [];
    const already = [];
    const invalid = [];

    for (
      const username of usernames
    ) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(
          username
        )
      ) {
        invalid.push(username);
        continue;
      }

      const exists =
        streamers.some(
          x =>
            x.toLowerCase() ===
            username.toLowerCase()
        );

      if (exists) {
        already.push(
          `@${username}`
        );
      } else {
        streamers.push(
          username
        );

        added.push(
          `@${username}`
        );
      }
    }

    saveJSON(
      STREAMERS_FILE,
      streamers
    );

    let text =
      "📋 نتيجة الإضافة:\n\n";

    if (added.length) {
      text +=
        "✅ تمت إضافة:\n" +
        added.join("\n");
    }

    if (already.length) {
      text +=
        "\n\nℹ️ موجودة مسبقًا:\n" +
        already.join("\n");
    }

    if (invalid.length) {
      text +=
        "\n\n⚠️ غير صالحة:\n" +
        invalid.join("\n");
    }

    await bot.sendMessage(
      msg.chat.id,
      text
    );
  }
);

// ==================================================
// REMOVE
// ==================================================

bot.onText(
  /^\/remove\s+(.+)$/i,
  async (msg, match) => {
    const usernames =
      match[1]
        .split(/[,\s]+/)
        .map(cleanUsername)
        .filter(Boolean);

    const removed = [];
    const notFound = [];

    for (
      const username of usernames
    ) {
      const index =
        streamers.findIndex(
          x =>
            x.toLowerCase() ===
            username.toLowerCase()
        );

      if (index === -1) {
        notFound.push(
          `@${username}`
        );
      } else {
        removed.push(
          `@${streamers[index]}`
        );

        streamers.splice(
          index,
          1
        );
      }
    }

    saveJSON(
      STREAMERS_FILE,
      streamers
    );

    let text =
      "📋 نتيجة الحذف:\n\n";

    if (removed.length) {
      text +=
        "✅ تم حذف:\n" +
        removed.join("\n");
    }

    if (notFound.length) {
      text +=
        "\n\n❌ غير موجود:\n" +
        notFound.join("\n");
    }

    await bot.sendMessage(
      msg.chat.id,
      text
    );
  }
);

// ==================================================
// LIST
// ==================================================

bot.onText(
  /^\/list$/i,
  async msg => {
    if (!streamers.length) {
      return bot.sendMessage(
        msg.chat.id,
        "📋 لا توجد حسابات مضافة."
      );
    }

    const text =
      streamers
        .map(
          (x, i) =>
            `${i + 1}. @${x}`
        )
        .join("\n");

    await bot.sendMessage(
      msg.chat.id,
      [
        "📋 الحسابات المراقبة:",
        "",
        text,
        "",
        `📊 العدد: ${streamers.length}`
      ].join("\n")
    );
  }
);

// ==================================================
// KICK INFO
// ==================================================

async function getKickInfo(
  username
) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

  try {
    const info =
      await youtubedl(
        url,
        {
          dumpSingleJson:
            true,

          skipDownload:
            true,

          noWarnings:
            true,

          noCheckCertificates:
            true,

          addHeader: [
            "User-Agent: Mozilla/5.0",
            "Accept: */*",
            "Accept-Language: en-US,en;q=0.9"
          ]
        }
      );

    return info;
  } catch (error) {
    const message =
      String(
        error?.stderr ||
        error?.message ||
        ""
      );

    const lower =
      message.toLowerCase();

    if (
      lower.includes("not currently live") ||
      lower.includes("not live") ||
      lower.includes("offline")
    ) {
      return null;
    }

    console.error(
      `⚠️ Kick info @${username}:`,
      message.slice(0, 1000)
    );

    return null;
  }
}

// ==================================================
// LIVE CHECK
// ==================================================

function isLiveInfo(info) {
  if (!info) return false;

  return (
    info.live_status === "is_live" ||
    info.is_live === true ||
    info.live === true
  );
}

// ==================================================
// GET STREAM URL
// ==================================================

function findStreamUrl(info) {
  if (!info) return null;

  if (
    typeof info.url === "string" &&
    /^https?:\/\//i.test(info.url)
  ) {
    return info.url;
  }

  if (
    Array.isArray(info.formats)
  ) {
    const formats =
      info.formats
        .filter(
          x =>
            x &&
            typeof x.url === "string"
        )
        .sort(
          (a, b) =>
            (
              Number(b.height) || 0
            ) -
            (
              Number(a.height) || 0
            )
        );

    if (formats.length) {
      return formats[0].url;
    }
  }

  return null;
}

// ==================================================
// FFMPEG PROCESS
// ==================================================

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        "🎞️ Starting FFmpeg..."
      );

      let child;

      try {
        child = spawn(
          ffmpegPath,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ],
            windowsHide: true
          }
        );
      } catch (error) {
        return reject(error);
      }

      let stderr = "";
      let finished = false;

      const timer =
        setTimeout(() => {
          if (finished) return;

          console.error(
            "⏰ FFmpeg timeout"
          );

          try {
            child.kill("SIGKILL");
          } catch {}

          finished = true;

          reject(
            new Error(
              "FFmpeg انتهت مهلته أثناء التقاط البث"
            )
          );
        }, FFMPEG_TIMEOUT);

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            12000
          ) {
            stderr =
              stderr.slice(-12000);
          }
        }
      );

      child.on(
        "error",
        error => {
          if (finished) return;

          finished = true;
          clearTimeout(timer);

          reject(error);
        }
      );

      child.on(
        "close",
        (code, signal) => {
          if (finished) return;

          finished = true;
          clearTimeout(timer);

          console.log(
            `🎞️ FFmpeg closed | code=${code} signal=${signal || "none"}`
          );

          if (code === 0) {
            resolve();
            return;
          }

          const reason =
            signal
              ? `تم إنهاء FFmpeg بإشارة ${signal}`
              : `FFmpeg exited with code ${code}`;

          reject(
            new Error(
              `${reason}\n${stderr.slice(-3000)}`
            )
          );
        }
      );
    }
  );
}

// ==================================================
// CAPTURE LIVE
// ==================================================

async function captureLive(
  username,
  output
) {
  const info =
    await getKickInfo(
      username
    );

  if (!info) {
    throw new Error(
      `تعذر الوصول إلى بث @${username}`
    );
  }

  if (
    !isLiveInfo(info)
  ) {
    throw new Error(
      `@${username} ليس مباشرًا الآن`
    );
  }

  const streamUrl =
    findStreamUrl(info);

  if (!streamUrl) {
    throw new Error(
      "لم يتم العثور على رابط البث"
    );
  }

  console.log(
    `📡 Stream URL found for @${username}`
  );

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",

    "-rw_timeout",
    "30000000",

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "5",

    "-i",
    streamUrl,

    "-t",
    String(
      CAPTURE_SECONDS
    ),

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-c",
    "copy",

    "-movflags",
    "+faststart",

    "-y",
    output
  ];

  let lastError;

  for (
    let attempt = 1;
    attempt <= FFMPEG_RETRIES;
    attempt++
  ) {
    try {
      console.log(
        `🎞️ FFmpeg attempt ${attempt}/${FFMPEG_RETRIES}`
      );

      deleteFile(output);

      await runFFmpeg(args);

      if (
        !fs.existsSync(output)
      ) {
        throw new Error(
          "FFmpeg انتهى بدون إنشاء الملف"
        );
      }

      const size =
        fs.statSync(output).size;

      if (size < 10000) {
        throw new Error(
          "ملف البث الناتج فارغ"
        );
      }

      console.log(
        `✅ Capture complete: ${fileSizeMB(output).toFixed(2)} MB`
      );

      return;
    } catch (error) {
      lastError = error;

      console.error(
        `⚠️ FFmpeg attempt ${attempt} failed:`,
        error.message
      );

      deleteFile(output);

      if (
        attempt <
        FFMPEG_RETRIES
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              3000
            )
        );
      }
    }
  }

  throw lastError ||
    new Error(
      "فشل التقاط البث"
    );
}

// ==================================================
// MEDIA DURATION
// ==================================================

async function getMediaDuration(
  file
) {
  try {
    const info =
      await youtubedl(
        file,
        {
          dumpSingleJson:
            true,

          skipDownload:
            true,

          noWarnings:
            true,

          noCheckCertificates:
            true
        }
      );

    return (
      Number(
        info.duration
      ) || 0
    );
  } catch {
    return 0;
  }
}

// ==================================================
// CUT CLIP
// ==================================================

async function cutLocalVideo(
  input,
  output,
  start,
  duration
) {
  await runFFmpeg([
    "-hide_banner",
    "-loglevel",
    "warning",

    "-ss",
    String(start),

    "-i",
    input,

    "-t",
    String(duration),

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-c",
    "copy",

    "-movflags",
    "+faststart",

    "-y",

    output
  ]);

  if (
    !fs.existsSync(output)
  ) {
    throw new Error(
      "لم يتم إنشاء الكليب"
    );
  }

  if (
    fs.statSync(output).size <
    10000
  ) {
    throw new Error(
      "الكليب الناتج فارغ"
    );
  }
}

// ==================================================
// LIVE CLIP
// ==================================================

async function createLiveClip(
  username,
  info,
  chatId
) {
  const capture =
    tempFile("capture");

  const clip =
    tempFile("clip");

  try {
    console.log(
      `🎬 Creating LIVE clip @${username}`
    );

    await captureLive(
      username,
      capture
    );

    const captured =
      await getMediaDuration(
        capture
      );

    console.log(
      `⏱️ Capture duration: ${captured}s`
    );

    if (
      captured <
      MIN_CLIP_SECONDS
    ) {
      throw new Error(
        "الجزء الملتقط أقل من 15 ثانية"
      );
    }

    const duration =
      Math.min(
        randomClipLength(),
        Math.floor(captured)
      );

    const maxStart =
      Math.max(
        0,
        Math.floor(
          captured -
          duration
        )
      );

    const start =
      randomInt(
        0,
        maxStart
      );

    console.log(
      `✂️ Random clip: ${start}s -> ${duration}s`
    );

    await cutLocalVideo(
      capture,
      clip,
      start,
      duration
    );

    await sendClip(
      clip,
      username,
      info,
      "live",
      chatId
    );

    clips[
      `${username}-${Date.now()}`
    ] = {
      username,
      type: "live",
      start,
      duration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );
  } finally {
    deleteFile(capture);
    deleteFile(clip);
  }
}

// ==================================================
// VOD CLIP
// ==================================================

async function createVodClip(
  username,
  chatId
) {
  const info =
    await getKickInfo(
      username
    );

  if (!info) {
    throw new Error(
      `لا توجد إعادة بث عامة متاحة لـ @${username}`
    );
  }

  if (
    isLiveInfo(info)
  ) {
    return createLiveClip(
      username,
      info,
      chatId
    );
  }

  const vodUrl =
    info.webpage_url ||
    info.original_url ||
    info.url;

  if (!vodUrl) {
    throw new Error(
      "لم يتم العثور على إعادة بث عامة"
    );
  }

  const total =
    Number(info.duration) || 0;

  if (
    total <
    MIN_CLIP_SECONDS
  ) {
    throw new Error(
      "إعادة البث غير متاحة أو مدتها قصيرة"
    );
  }

  const duration =
    Math.min(
      randomClipLength(),
      Math.floor(total)
    );

  const maxStart =
    Math.max(
      0,
      Math.floor(
        total - duration
      )
    );

  const start =
    randomInt(
      0,
      maxStart
    );

  const clip =
    tempFile("vod");

  try {
    console.log(
      `📼 VOD @${username} | ${start}s | ${duration}s`
    );

    await youtubedl(
      vodUrl,
      {
        output: clip,

        format:
          "bestvideo+bestaudio/best",

        downloadSections:
          `*${start}-${start + duration}`,

        forceKeyframesAtCuts:
          true,

        mergeOutputFormat:
          "mp4",

        noPart:
          true,

        noWarnings:
          true,

        noCheckCertificates:
          true,

        addHeader: [
          "User-Agent: Mozilla/5.0",
          "Accept-Language: en-US,en;q=0.9"
        ]
      }
    );

    if (
      !fs.existsSync(clip)
    ) {
      throw new Error(
        "لم يتم إنشاء كليب الإعادة"
      );
    }

    await sendClip(
      clip,
      username,
      info,
      "vod",
      chatId
    );
  } finally {
    deleteFile(clip);
  }
}

// ==================================================
// SEND
// ==================================================

async function sendClip(
  file,
  username,
  info,
  type,
  chatId
) {
  if (
    !fs.existsSync(file)
  ) {
    throw new Error(
      "ملف الكليب غير موجود"
    );
  }

  const size =
    fs.statSync(file).size;

  if (
    size >
    TELEGRAM_LIMIT
  ) {
    throw new Error(
      `حجم الكليب ${fileSizeMB(file).toFixed(2)} MB ويتجاوز الحد`
    );
  }

  const title =
    info?.title ||
    "لقطة عشوائية";

  let category = "Kick";

  if (
    Array.isArray(
      info?.categories
    ) &&
    info.categories.length
  ) {
    category =
      info.categories.join(", ");
  }

  const caption = [
    "🎬 Drex Clips",
    "",
    `👤 @${username}`,
    `🎥 ${title}`,
    `🎮 ${category}`,
    "",
    type === "live"
      ? "🔴 من البث المباشر"
      : "📼 من إعادة البث",
    "",
    `🔗 https://kick.com/${username}`,
    "",
    "© Drex"
  ].join("\n");

  await bot.sendVideo(
    chatId,
    file,
    {
      caption,
      supports_streaming: true
    }
  );

  console.log(
    `✅ Clip sent @${username} -> ${chatId}`
  );
}

// ==================================================
// JOB
// ==================================================

async function createAndSendClip(
  job
) {
  if (
    job.type === "live"
  ) {
    return createLiveClip(
      job.streamer,
      job.info,
      job.chatId
    );
  }

  if (
    job.type === "vod"
  ) {
    return createVodClip(
      job.streamer,
      job.chatId
    );
  }

  throw new Error(
    "نوع الكليب غير معروف"
  );
}

// ==================================================
// /clip
// ==================================================

bot.onText(
  /^\/clip(?:\s+(.+))?$/i,
  async (msg, match) => {
    const username =
      cleanUsername(
        match?.[1]
      );

    if (!username) {
      return bot.sendMessage(
        msg.chat.id,
        "❌ مثال:\n/clip ogabdullah"
      );
    }

    try {
      await bot.sendMessage(
        msg.chat.id,
        `🔎 جاري التحقق من @${username}...`
      );

      const info =
        await getKickInfo(
          username
        );

      if (!info) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ تعذر الوصول إلى @${username}`
        );
      }

      if (
        isLiveInfo(info)
      ) {
        await bot.sendMessage(
          msg.chat.id,
          [
            `🔴 @${username} أونلاين`,
            "",
            "🎬 جاري أخذ كليب..."
          ].join("\n")
        );

        addToQueue({
          streamer: username,
          type: "live",
          info,
          chatId: msg.chat.id,
          notifyChatId: msg.chat.id
        });

        return;
      }

      await bot.sendMessage(
        msg.chat.id,
        [
          `📼 @${username} أوفلاين`,
          "",
          "🔎 جاري البحث عن إعادة بث عامة..."
        ].join("\n")
      );

      addToQueue({
        streamer: username,
        type: "vod",
        chatId: msg.chat.id,
        notifyChatId: msg.chat.id
      });
    } catch (error) {
      console.error(
        "❌ /clip:",
        error
      );

      await bot.sendMessage(
        msg.chat.id,
        `❌ حدث خطأ أثناء إنشاء كليب @${username}`
      );
    }
  }
);

// ==================================================
// AUTO MONITOR
// ==================================================

async function monitor() {
  if (!streamers.length) {
    console.log(
      "ℹ️ لا توجد حسابات للمراقبة."
    );

    return;
  }

  const channelList =
    Object.values(channels);

  if (!channelList.length) {
    console.log(
      "ℹ️ لا توجد قناة مسجلة."
    );

    return;
  }

  const shuffled =
    [...streamers].sort(
      () => Math.random() - 0.5
    );

  for (
    const username of shuffled
  ) {
    try {
      const info =
        await getKickInfo(
          username
        );

      if (
        !info ||
        !isLiveInfo(info)
      ) {
        continue;
      }

      console.log(
        `🟢 AUTO LIVE @${username}`
      );

      for (
        const channel
        of channelList
      ) {
        const duplicate =
          queue.some(
            job =>
              job.streamer ===
                username &&
              job.chatId ===
                channel.id &&
              job.type === "live"
          );

        if (!duplicate) {
          addToQueue({
            streamer: username,
            type: "live",
            info,
            chatId: channel.id
          });
        }
      }

      break;
    } catch (error) {
      console.error(
        `❌ Monitor @${username}:`,
        error.message
      );
    }
  }
}

// ==================================================
// BOOT
// ==================================================

console.log(
  "🤖 Drex Clips Bot started."
);

console.log(
  `👤 Streamers: ${streamers.length}`
);

console.log(
  `📢 Channels: ${Object.keys(channels).length}`
);

console.log(
  "🎬 Auto clips: every 10 minutes"
);

console.log(
  `⏱️ Duration: ${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS}s`
);

console.log(
  `🎞️ FFmpeg: ${ffmpegPath}`
);

setTimeout(
  monitor,
  15000
);

setInterval(
  monitor,
  AUTO_CLIP_INTERVAL
);

// ==================================================
// TELEGRAM ERRORS
// ==================================================

bot.on(
  "polling_error",
  error => {
    console.error(
      "❌ Telegram polling:",
      error.message
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "❌ Uncaught Exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "❌ Unhandled Rejection:",
      error
    );
  }
);

console.log(
  "✅ Drex Clips Bot جاهز."
);