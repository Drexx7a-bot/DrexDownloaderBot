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

// نلتقط 35 ثانية من البث ثم نختار منها 15-30 ثانية
const LIVE_CAPTURE_SECONDS = 35;

const TELEGRAM_LIMIT = 49 * 1024 * 1024;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

if (!ffmpegPath) {
  console.error("❌ FFmpeg غير موجود");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: true
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
  console.log(
    `🌐 Render server running on port ${PORT}`
  );
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
      `⚠️ JSON load error: ${file}`,
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
      `❌ JSON save error: ${file}`,
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
    `📥 Queue +1 | ${job.type} | @${job.streamer} | Queue: ${queue.length}`
  );

  processQueue();
}

async function processQueue() {
  if (processing) return;

  if (queue.length === 0) return;

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
            ).slice(0, 800)
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

function fileSizeMB(file) {
  if (!fs.existsSync(file)) return 0;

  return (
    fs.statSync(file).size /
    1024 /
    1024
  );
}

function deleteFile(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
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
        "🏆 أعلى جودة متاحة",
        "",
        "🎬 كليب يدوي:",
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

      const chat = msg.chat;
      const chatId = String(chat.id);

      if (!channels[chatId]) {
        channels[chatId] = {
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
          `📢 Channel detected: ${chat.title}`
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
  }
);

// ==================================================
// ADD STREAMERS
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
  }
);

// ==================================================
// REMOVE STREAMERS
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
      lower.includes(
        "not currently live"
      ) ||
      lower.includes(
        "not live"
      ) ||
      lower.includes(
        "offline"
      )
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
// IS LIVE
// ==================================================

function isLiveInfo(info) {
  if (!info) return false;

  return (
    info.live_status ===
      "is_live" ||
    info.is_live === true ||
    info.live === true
  );
}

// ==================================================
// FIND STREAM URL
// ==================================================

function findStreamUrl(info) {
  if (!info) return null;

  if (
    typeof info.url === "string" &&
    /^https?:\/\//i.test(
      info.url
    )
  ) {
    return info.url;
  }

  if (
    Array.isArray(info.formats)
  ) {
    const formats =
      info.formats
        .filter(
          f =>
            f &&
            typeof f.url ===
              "string"
        )
        .sort(
          (a, b) =>
            (
              Number(
                b.height
              ) || 0
            ) -
            (
              Number(
                a.height
              ) || 0
            )
        );

    if (formats.length) {
      return formats[0].url;
    }
  }

  return null;
}

// ==================================================
// RUN FFMPEG
// ==================================================

function runFFmpeg(
  args
) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        `🎞️ FFmpeg starting`
      );

      const child =
        spawn(
          ffmpegPath,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );

      let stderr = "";

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            10000
          ) {
            stderr =
              stderr.slice(
                -10000
              );
          }
        }
      );

      child.on(
        "error",
        error => {
          reject(error);
        }
      );

      child.on(
        "close",
        code => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              `FFmpeg exited with code ${code}\n${stderr.slice(-2500)}`
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
  console.log(
    `📡 استخراج رابط بث @${username}`
  );

  const info =
    await getKickInfo(
      username
    );

  if (!info) {
    throw new Error(
      `لم يتم العثور على بث @${username}`
    );
  }

  if (
    !isLiveInfo(info)
  ) {
    throw new Error(
      `@${username} لم يعد Live`
    );
  }

  const streamUrl =
    findStreamUrl(info);

  if (!streamUrl) {
    throw new Error(
      "لم يتم العثور على رابط بث HLS"
    );
  }

  console.log(
    `📡 تم العثور على رابط البث @${username}`
  );

  /*
   * نستخدم FFmpeg مباشرة.
   *
   * لا نستخدم:
   * downloader: "ffmpeg"
   *
   * لتجنب crash السابق.
   */

  await runFFmpeg([
    "-hide_banner",
    "-loglevel",
    "error",

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
      LIVE_CAPTURE_SECONDS
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
  ]);

  if (
    !fs.existsSync(output)
  ) {
    throw new Error(
      "FFmpeg لم ينشئ الملف"
    );
  }

  const size =
    fs.statSync(
      output
    ).size;

  if (
    size < 10000
  ) {
    throw new Error(
      "ملف البث الناتج فارغ"
    );
  }

  console.log(
    `✅ LIVE captured: ${fileSizeMB(output).toFixed(2)} MB`
  );
}

// ==================================================
// GET MEDIA DURATION
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
// CUT LOCAL VIDEO
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
    "error",

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
}

// ==================================================
// CREATE LIVE CLIP
// ==================================================

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
      `🎬 LIVE CLIP @${username}`
    );

    await captureLive(
      username,
      capture
    );

    const capturedDuration =
      await getMediaDuration(
        capture
      );

    console.log(
      `⏱️ Captured duration: ${capturedDuration}s`
    );

    if (
      capturedDuration <
      MIN_CLIP_SECONDS
    ) {
      throw new Error(
        "الجزء الملتقط أقصر من 15 ثانية"
      );
    }

    const duration =
      Math.min(
        randomClipLength(),
        Math.floor(
          capturedDuration
        )
      );

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

    console.log(
      `✂️ Cutting ${duration}s from ${start}s`
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
      `${username}-live-${Date.now()}`
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
    deleteFile(
      capture
    );

    deleteFile(
      clip
    );
  }
}

// ==================================================
// VOD
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
      `لا يوجد VOD عام متاح لـ @${username}`
    );
  }

  /*
   * إذا كان Live لا ندخل مسار VOD.
   */

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
      "لم يتم العثور على رابط إعادة بث عام"
    );
  }

  const totalDuration =
    Number(
      info.duration
    ) || 0;

  if (
    totalDuration <
    MIN_CLIP_SECONDS
  ) {
    throw new Error(
      "إعادة البث غير متاحة أو مدتها قصيرة"
    );
  }

  const clipDuration =
    Math.min(
      randomClipLength(),
      Math.floor(
        totalDuration
      )
    );

  const maxStart =
    Math.max(
      0,
      Math.floor(
        totalDuration -
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
      `📼 VOD @${username} | ${start}s | ${clipDuration}s`
    );

    /*
     * نستخدم yt-dlp فقط لتنزيل الجزء المطلوب.
     * لا نحاول تجاوز VOD خاص بالمشتركين.
     */

    await youtubedl(
      vodUrl,
      {
        output: clip,

        format:
          "bestvideo+bestaudio/best",

        downloadSections:
          `*${start}-${start + clipDuration}`,

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
        "لم يتم إنشاء كليب الـVOD"
      );
    }

    await sendClip(
      clip,
      username,
      info,
      "vod",
      chatId
    );

    clips[
      `${username}-vod-${Date.now()}`
    ] = {
      username,
      type: "vod",
      start,
      duration:
        clipDuration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );
  } finally {
    deleteFile(
      clip
    );
  }
}

// ==================================================
// SEND CLIP
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
    size > TELEGRAM_LIMIT
  ) {
    throw new Error(
      `حجم الكليب كبير: ${fileSizeMB(file).toFixed(2)} MB`
    );
  }

  const title =
    info?.title ||
    "لقطة عشوائية";

  let category =
    "Kick";

  if (
    Array.isArray(
      info?.categories
    ) &&
    info.categories.length
  ) {
    category =
      info.categories.join(
        ", "
      );
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
      supports_streaming:
        true
    }
  );

  console.log(
    `✅ Clip sent @${username} -> ${chatId}`
  );
}

// ==================================================
// CREATE JOB
// ==================================================

async function createAndSendClip(
  job
) {
  if (
    job.type === "live"
  ) {
    await createLiveClip(
      job.streamer,
      job.info,
      job.chatId
    );

    return;
  }

  if (
    job.type === "vod"
  ) {
    await createVodClip(
      job.streamer,
      job.chatId
    );

    return;
  }

  throw new Error(
    "نوع الكليب غير معروف"
  );
}

// ==================================================
// /clip
// LIVE -> LIVE
// OFFLINE -> VOD
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
        [
          "❌ استخدم الأمر:",
          "",
          "/clip username",
          "",
          "مثال:",
          "/clip ogabdullah"
        ].join("\n")
      );
    }

    if (
      !/^[a-zA-Z0-9_-]+$/.test(
        username
      )
    ) {
      return bot.sendMessage(
        msg.chat.id,
        "❌ اسم الحساب غير صالح."
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
          `❌ لم أستطع الوصول إلى @${username}.`
        );
      }

      // ==============================================
      // LIVE
      // ==============================================

      if (
        isLiveInfo(info)
      ) {
        await bot.sendMessage(
          msg.chat.id,
          [
            `🔴 @${username} أونلاين`,
            "",
            "🎬 جاري أخذ كليب من البث..."
          ].join("\n")
        );

        addToQueue({
          streamer:
            username,

          type:
            "live",

          info,

          chatId:
            msg.chat.id,

          notifyChatId:
            msg.chat.id
        });

        return;
      }

      // ==============================================
      // OFFLINE
      // ==============================================

      await bot.sendMessage(
        msg.chat.id,
        [
          `📼 @${username} أوفلاين`,
          "",
          "🔎 جاري البحث عن إعادة بث عامة..."
        ].join("\n")
      );

      addToQueue({
        streamer:
          username,

        type:
          "vod",

        info,

        chatId:
          msg.chat.id,

        notifyChatId:
          msg.chat.id
      });
    } catch (error) {
      console.error(
        `❌ /clip @${username}:`,
        error?.stack ||
        error?.message ||
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
  if (
    !streamers.length
  ) {
    console.log(
      "ℹ️ لا توجد حسابات للمراقبة."
    );

    return;
  }

  const channelList =
    Object.values(
      channels
    );

  if (
    !channelList.length
  ) {
    console.log(
      "ℹ️ لا توجد قناة مسجلة."
    );

    return;
  }

  /*
   * نبحث عن Live عشوائي.
   * إذا وجدنا واحدًا، ننشئ كليبًا واحدًا
   * لكل قناة في هذه الدورة.
   */

  const shuffled =
    [...streamers];

  shuffled.sort(
    () =>
      Math.random() -
      0.5
  );

  for (
    const username
    of shuffled
  ) {
    try {
      const info =
        await getKickInfo(
          username
        );

      if (!info) {
        continue;
      }

      if (
        !isLiveInfo(info)
      ) {
        continue;
      }

      console.log(
        `🟢 AUTO LIVE: @${username}`
      );

      for (
        const channel
        of channelList
      ) {
        addToQueue({
          streamer:
            username,

          type:
            "live",

          info,

          chatId:
            channel.id
        });
      }

      break;
    } catch (error) {
      console.error(
        `❌ Monitor @${username}:`,
        error?.message ||
        error
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
  `🎬 Auto clips: every 10 minutes`
);

console.log(
  `⏱️ Duration: ${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS}s`
);

console.log(
  `🎞️ FFmpeg: ${ffmpegPath}`
);

// أول فحص بعد 15 ثانية
setTimeout(
  monitor,
  15000
);

// ثم كل 10 دقائق
setInterval(
  monitor,
  AUTO_CLIP_INTERVAL
);

// ==================================================
// ERRORS
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