const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: true
});

// =========================
// RENDER SERVER
// =========================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Drex Clips Bot is running ✅");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Render server running on port ${PORT}`);
});

// =========================
// DATA
// =========================

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
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
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

// =========================
// SETTINGS
// =========================

const AUTO_CLIP_INTERVAL = 10 * 60 * 1000;

const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 30;

const LIVE_CAPTURE_SECONDS = 32;

const TELEGRAM_LIMIT =
  49 * 1024 * 1024;

// =========================
// QUEUE
// =========================

let queue = [];
let processing = false;

function addToQueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (processing || queue.length === 0) {
    return;
  }

  processing = true;

  const job = queue.shift();

  try {
    await createAndSendClip(job);
  } catch (error) {
    console.error(
      "❌ Clip job:",
      error?.message || error
    );

    if (job.notifyChatId) {
      try {
        await bot.sendMessage(
          job.notifyChatId,
          `❌ فشل إنشاء كليب @${job.streamer}\n\n${error?.message || "خطأ غير معروف"}`
        );
      } catch {}
    }
  }

  processing = false;

  setTimeout(
    processQueue,
    1000
  );
}

// =========================
// START
// =========================

bot.onText(/^\/start$/i, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    [
      "🤖 Drex Clips Bot",
      "",
      "🎬 بوت كليبات Kick",
      "",
      "🔴 كليب تلقائي كل 10 دقائق.",
      "⏱️ مدة الكليب: 15–30 ثانية.",
      "🏆 أعلى جودة متاحة.",
      "",
      "🎬 طلب كليب يدوي:",
      "/clip username",
      "",
      "➕ إضافة حساب:",
      "/add username",
      "",
      "➕ إضافة عدة حسابات:",
      "/add user1 user2 user3",
      "",
      "📋 الحسابات:",
      "/list",
      "",
      "➖ حذف:",
      "/remove username"
    ].join("\n")
  );
});

// =========================
// CHANNEL DETECTION
// =========================

bot.on("channel_post", async (msg) => {
  try {
    if (!msg.chat) return;

    const chat = msg.chat;
    const chatId = String(chat.id);

    if (!channels[chatId]) {
      channels[chatId] = {
        id: chat.id,
        title: chat.title || "بدون اسم",
        username: chat.username || null,
        addedAt: new Date().toISOString()
      };

      saveJSON(
        CHANNELS_FILE,
        channels
      );

      console.log(
        `📢 Channel detected: ${chat.title}`
      );
    }
  } catch (error) {
    console.error(
      "❌ Channel detection:",
      error.message
    );
  }
});

// =========================
// BOT ADDED TO CHANNEL
// =========================

bot.on("my_chat_member", async (update) => {
  try {
    const chat = update.chat;
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
      channels[String(chat.id)] = {
        id: chat.id,
        title: chat.title || "بدون اسم",
        username: chat.username || null,
        addedAt: new Date().toISOString()
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

      console.log(
        `🗑️ Channel removed: ${chat.title}`
      );
    }
  } catch (error) {
    console.error(
      "❌ my_chat_member:",
      error.message
    );
  }
});

// =========================
// CLEAN USERNAME
// =========================

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

// =========================
// ADD
// =========================

bot.onText(/^\/add\s+(.+)$/i, async (msg, match) => {
  const usernames = match[1]
    .split(/[,\s]+/)
    .map(cleanUsername)
    .filter(Boolean);

  const added = [];
  const already = [];
  const invalid = [];

  for (const username of usernames) {
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      invalid.push(username);
      continue;
    }

    const exists = streamers.some(
      x => x.toLowerCase() === username.toLowerCase()
    );

    if (exists) {
      already.push(`@${username}`);
    } else {
      streamers.push(username);
      added.push(`@${username}`);
    }
  }

  saveJSON(
    STREAMERS_FILE,
    streamers
  );

  let text = "📋 نتيجة الإضافة:\n\n";

  if (added.length) {
    text +=
      `✅ تمت إضافة ${added.length}:\n` +
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
});

// =========================
// REMOVE
// =========================

bot.onText(/^\/remove\s+(.+)$/i, async (msg, match) => {
  const usernames = match[1]
    .split(/[,\s]+/)
    .map(cleanUsername)
    .filter(Boolean);

  const removed = [];
  const notFound = [];

  for (const username of usernames) {
    const index = streamers.findIndex(
      x =>
        x.toLowerCase() ===
        username.toLowerCase()
    );

    if (index === -1) {
      notFound.push(`@${username}`);
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

  let text = "📋 نتيجة الحذف:\n\n";

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
});

// =========================
// LIST
// =========================

bot.onText(/^\/list$/i, async (msg) => {
  if (!streamers.length) {
    return bot.sendMessage(
      msg.chat.id,
      "📋 لا توجد حسابات مضافة."
    );
  }

  const text = streamers
    .map(
      (name, index) =>
        `${index + 1}. @${name}`
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
});

// =========================
// KICK INFO
// =========================

async function getKickInfo(username) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

  try {
    return await youtubedl(
      url,
      {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegPath,

        addHeader: [
          "User-Agent: Mozilla/5.0"
        ]
      }
    );
  } catch (error) {
    const text = String(
      error?.stderr ||
      error?.message ||
      ""
    ).toLowerCase();

    if (
      text.includes("not currently live") ||
      text.includes("not live") ||
      text.includes("offline")
    ) {
      return null;
    }

    console.error(
      `⚠️ Kick info @${username}:`,
      text.slice(0, 500)
    );

    return null;
  }
}

// =========================
// RANDOM CLIP LENGTH
// =========================

function randomClipLength() {
  return Math.floor(
    Math.random() *
      (
        MAX_CLIP_SECONDS -
        MIN_CLIP_SECONDS +
        1
      )
  ) + MIN_CLIP_SECONDS;
}

// =========================
// RANDOM NUMBER
// =========================

function randomInt(min, max) {
  return Math.floor(
    Math.random() *
      (max - min + 1)
  ) + min;
}

// =========================
// SAFE FILE
// =========================

function tempFile(prefix) {
  return path.join(
    DATA_DIR,
    `${prefix}-${crypto.randomBytes(8).toString("hex")}.mp4`
  );
}

// =========================
// GET VIDEO DURATION
// =========================

async function getDuration(file) {
  const data = await youtubedl(
    file,
    {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noCheckCertificates: true,
      ffmpegLocation: ffmpegPath
    }
  );

  const duration =
    Number(data.duration) || 0;

  return duration;
}

// =========================
// FFMPEG CUT
// =========================

async function cutVideo(
  input,
  output,
  start,
  duration
) {
  await youtubedl(
    input,
    {
      output,

      format: "best",

      noWarnings: true,
      noCheckCertificates: true,

      ffmpegLocation: ffmpegPath,

      downloadSections:
        `*${start}-${start + duration}`,

      forceKeyframesAtCuts: true,

      mergeOutputFormat: "mp4"
    }
  );

  if (!fs.existsSync(output)) {
    throw new Error(
      "ملف الكليب لم يتم إنشاؤه"
    );
  }
}

// =========================
// LIVE CAPTURE
// =========================

async function captureLive(
  username,
  output
) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

  /*
   * نلتقط جزءًا قصيرًا من البث فقط.
   * لا يتم تنزيل البث كاملًا.
   */

  await youtubedl(
    url,
    {
      output,

      format:
        "bv*+ba/b",

      mergeOutputFormat: "mp4",

      noPart: true,

      noWarnings: true,
      noCheckCertificates: true,

      ffmpegLocation: ffmpegPath,

      downloader: "ffmpeg",

      downloaderArgs: {
        ffmpeg_i:
          `-t ${LIVE_CAPTURE_SECONDS}`
      },

      addHeader: [
        "User-Agent: Mozilla/5.0"
      ]
    }
  );

  if (!fs.existsSync(output)) {
    throw new Error(
      "لم يتم التقاط جزء من البث"
    );
  }
}

// =========================
// VOD DOWNLOAD SECTION
// =========================

async function downloadVodSection(
  vodUrl,
  output,
  start,
  duration
) {
  await youtubedl(
    vodUrl,
    {
      output,

      format:
        "bv*+ba/b",

      mergeOutputFormat: "mp4",

      noPart: true,

      noWarnings: true,
      noCheckCertificates: true,

      ffmpegLocation: ffmpegPath,

      downloadSections:
        `*${start}-${start + duration}`,

      forceKeyframesAtCuts: true,

      addHeader: [
        "User-Agent: Mozilla/5.0"
      ]
    }
  );

  if (!fs.existsSync(output)) {
    throw new Error(
      "لم يتم إنشاء كليب الـVOD"
    );
  }
}

// =========================
// BUILD CAPTION
// =========================

function buildCaption(
  username,
  info,
  type
) {
  const title =
    info?.title ||
    "لقطة عشوائية";

  const category =
    Array.isArray(info?.categories)
      ? info.categories.join(", ")
      : "Kick";

  return [
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
}

// =========================
// SEND CLIP
// =========================

async function sendClip(
  file,
  username,
  info,
  type,
  chatId,
  duration
) {
  if (!fs.existsSync(file)) {
    throw new Error(
      "ملف الكليب غير موجود"
    );
  }

  let stats =
    fs.statSync(file);

  let size =
    stats.size;

  /*
   * Telegram Bot API cloud limit.
   * إذا كان الملف كبيرًا جدًا،
   * نعيد ترميزه بحجم أخف.
   */

  if (size > TELEGRAM_LIMIT) {
    const compressed =
      tempFile("compressed");

    await youtubedl(
      file,
      {
        output: compressed,

        format: "best",

        noWarnings: true,
        noCheckCertificates: true,

        ffmpegLocation: ffmpegPath,

        recodeVideo: "mp4",

        postprocessorArgs: [
          "VideoConvertor:-vf scale='min(1920,iw)':-2 -c:v libx264 -crf 23 -preset veryfast -c:a aac -b:a 128k"
        ]
      }
    );

    if (fs.existsSync(compressed)) {
      try {
        fs.unlinkSync(file);
      } catch {}

      fs.renameSync(
        compressed,
        file
      );
    }
  }

  stats =
    fs.statSync(file);

  size =
    stats.size;

  if (size > TELEGRAM_LIMIT) {
    throw new Error(
      "الكليب أكبر من الحد المسموح به في Telegram"
    );
  }

  const caption =
    buildCaption(
      username,
      info,
      type
    );

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

// =========================
// CREATE LIVE CLIP
// =========================

async function createLiveClip(
  username,
  info,
  chatId
) {
  const capture =
    tempFile("live");

  const clip =
    tempFile("clip");

  try {
    console.log(
      `🎬 Capturing LIVE @${username}`
    );

    await captureLive(
      username,
      capture
    );

    const duration =
      randomClipLength();

    const capturedDuration =
      await getDuration(
        capture
      );

    if (
      !capturedDuration ||
      capturedDuration < 15
    ) {
      throw new Error(
        "مدة الجزء الملتقط قصيرة جدًا"
      );
    }

    const maxStart =
      Math.max(
        0,
        Math.floor(
          capturedDuration -
          duration
        )
      );

    const start =
      randomInt(
        0,
        maxStart
      );

    await cutVideo(
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
      chatId,
      duration
    );

    clips[
      `${username}-live-${Date.now()}`
    ] = {
      username,
      type: "live",
      duration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );
  } finally {
    try {
      if (fs.existsSync(capture)) {
        fs.unlinkSync(capture);
      }
    } catch {}

    try {
      if (fs.existsSync(clip)) {
        fs.unlinkSync(clip);
      }
    } catch {}
  }
}

// =========================
// CREATE VOD CLIP
// =========================

async function createVodClip(
  username,
  notifyChatId = null
) {
  const info =
    await getKickInfo(
      username
    );

  /*
   * getKickInfo قد يرجع بيانات VOD
   * أو بيانات القناة حسب استجابة Kick.
   */

  if (!info) {
    throw new Error(
      `لا يوجد بث/VOD متاح حاليًا لـ @${username}`
    );
  }

  const vodUrl =
    info.webpage_url ||
    info.original_url ||
    info.url;

  if (!vodUrl) {
    throw new Error(
      "لم يتم العثور على رابط إعادة بث متاح"
    );
  }

  const duration =
    Number(info.duration) || 0;

  if (
    !duration ||
    duration < MIN_CLIP_SECONDS
  ) {
    throw new Error(
      "إعادة البث غير متاحة أو مدتها قصيرة"
    );
  }

  /*
   * إذا كان المحتوى للمشتركين فقط
   * غالبًا yt-dlp سيرفض الوصول.
   * لا نحاول تجاوز الحماية.
   */

  const clipDuration =
    randomClipLength();

  const maxStart =
    Math.max(
      0,
      Math.floor(
        duration -
        clipDuration
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
      `📼 VOD clip @${username} | ${start}s | ${clipDuration}s`
    );

    await downloadVodSection(
      vodUrl,
      clip,
      start,
      clipDuration
    );

    await sendClip(
      clip,
      username,
      info,
      "vod",
      notifyChatId,
      clipDuration
    );

    clips[
      `${username}-vod-${start}`
    ] = {
      username,
      type: "vod",
      start,
      duration: clipDuration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );
  } finally {
    try {
      if (fs.existsSync(clip)) {
        fs.unlinkSync(clip);
      }
    } catch {}
  }
}

// =========================
// CREATE + SEND
// =========================

async function createAndSendClip(job) {
  const {
    streamer,
    type,
    info,
    chatId,
    notifyChatId
  } = job;

  if (type === "live") {
    await createLiveClip(
      streamer,
      info,
      chatId
    );

    return;
  }

  if (type === "vod") {
    await createVodClip(
      streamer,
      notifyChatId || chatId
    );

    return;
  }

  throw new Error(
    "نوع كليب غير معروف"
  );
}

// =========================
// MANUAL /clip
// =========================

bot.onText(/^\/clip(?:\s+(.+))?$/i, async (msg, match) => {
  const username =
    cleanUsername(
      match?.[1]
    );

  if (!username) {
    return bot.sendMessage(
      msg.chat.id,
      [
        "❌ استخدم الأمر هكذا:",
        "",
        "/clip username",
        "",
        "مثال:",
        "/clip drb7h"
      ].join("\n")
    );
  }

  if (
    !/^[a-zA-Z0-9_-]+$/.test(username)
  ) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ اسم الحساب غير صالح."
    );
  }

  await bot.sendMessage(
    msg.chat.id,
    `🎬 جاري البحث عن كليب لـ @${username}...`
  );

  addToQueue({
    streamer: username,
    type: "vod",
    notifyChatId: msg.chat.id,
    chatId: msg.chat.id
  });
});

// =========================
// MONITOR LIVE
// =========================

async function monitor() {
  if (!streamers.length) {
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

  /*
   * نختار ستريمرًا واحدًا عشوائيًا
   * في كل دورة بدل إنشاء كليب لكل الحسابات.
   */

  const shuffled =
    [...streamers]
      .sort(
        () =>
          Math.random() - 0.5
      );

  for (const username of shuffled) {
    try {
      const info =
        await getKickInfo(
          username
        );

      if (!info) {
        continue;
      }

      const live =
        info.live_status === "is_live" ||
        info.is_live === true ||
        info.live === true;

      if (!live) {
        continue;
      }

      console.log(
        `🟢 LIVE CLIP: @${username}`
      );

      /*
       * لكل قناة مسجلة.
       */

      for (
        const channel
        of channelList
      ) {
        addToQueue({
          streamer: username,
          type: "live",
          info,
          chatId: channel.id
        });
      }

      /*
       * ستريمر واحد فقط في كل دورة.
       */

      break;
    } catch (error) {
      console.error(
        `❌ Monitor @${username}:`,
        error?.message || error
      );
    }
  }
}

// =========================
// START
// =========================

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
  "⏱️ Clip duration: 15-30 seconds"
);

setInterval(
  monitor,
  AUTO_CLIP_INTERVAL
);

setTimeout(
  monitor,
  15000
);

// =========================
// ERRORS
// =========================

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