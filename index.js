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
  polling: true,
  request: {
    timeout: 120000
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

const queue = [];
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
            ).slice(0, 1500)
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

function tempFile(prefix, ext = "mp4") {
  return path.join(
    DATA_DIR,
    `${prefix}-${crypto
      .randomBytes(8)
      .toString("hex")}.${ext}`
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
  if (!fs.existsSync(file)) {
    return 0;
  }

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
        "🎥 أعلى جودة متاحة من المصدر",
        "",
        "🎬 كليب يدوي:",
        "/clip username",
        "",
        "➕ إضافة حساب:",
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

      if (!chat) return;

      const status =
        update.new_chat_member?.status;

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

    for (const username of usernames) {
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
        "✅ تمت الإضافة:\n" +
        added.join("\n");
    }

    if (already.length) {
      text +=
        "\n\nℹ️ موجود مسبقًا:\n" +
        already.join("\n");
    }

    if (invalid.length) {
      text +=
        "\n\n⚠️ غير صالح:\n" +
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

    for (const username of usernames) {
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

async function getKickInfo(username) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

  try {
    const info =
      await youtubedl(
        url,
        {
          dumpSingleJson: true,
          skipDownload: true,
          noWarnings: true,
          noCheckCertificates: true,

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
      lower.includes("not live") ||
      lower.includes("offline") ||
      lower.includes("not currently live")
    ) {
      return null;
    }

    console.error(
      `⚠️ Kick info @${username}:`,
      message.slice(0, 1200)
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
    info.is_live === true ||
    info.live === true ||
    info.live_status === "is_live"
  );
}

// ==================================================
// STREAM URL
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
          f =>
            f &&
            typeof f.url === "string"
        )
        .sort(
          (a, b) =>
            (Number(b.height) || 0) -
            (Number(a.height) || 0)
        );

    if (formats.length) {
      return formats[0].url;
    }
  }

  return null;
}

// ==================================================
// SAFE PROCESS RUNNER
// ==================================================

function runProcess(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        `▶️ ${command} ${args.join(" ")}`
      );

      const child =
        spawn(
          command,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ],
            ...options
          }
        );

      let stderr = "";
      let stdout = "";

      child.stdout.on(
        "data",
        data => {
          stdout +=
            data.toString();

          if (
            stdout.length > 5000
          ) {
            stdout =
              stdout.slice(-5000);
          }
        }
      );

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length > 12000
          ) {
            stderr =
              stderr.slice(-12000);
          }
        }
      );

      let finished = false;

      const timer =
        setTimeout(() => {
          if (finished) return;

          console.error(
            "⏰ Process timeout"
          );

          try {
            child.kill("SIGKILL");
          } catch {}

          reject(
            new Error(
              "انتهت مهلة معالجة الفيديو"
            )
          );
        }, 120000);

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

          if (code === 0) {
            resolve({
              stdout,
              stderr
            });

            return;
          }

          let reason =
            `Process failed: code=${code}`;

          if (signal) {
            reason +=
              ` signal=${signal}`;
          }

          if (
            stderr.trim()
          ) {
            reason +=
              `\n${stderr.slice(-3000)}`;
          }

          reject(
            new Error(reason)
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
    `📡 الحصول على بث @${username}`
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

  if (!isLiveInfo(info)) {
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

  /*
   * مهم:
   * لا نستخدم -c copy هنا.
   * نعيد ترميز التسجيل مباشرة إلى H.264/AAC
   * لتجنب مشكلة SIGSEGV التي ظهرت مع
   * بعض مقاطع HLS.
   */

  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",

      "-rw_timeout",
      "15000000",

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

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "20",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-movflags",
      "+faststart",

      "-y",
      output
    ]
  );

  if (!fs.existsSync(output)) {
    throw new Error(
      "FFmpeg لم ينشئ ملف التسجيل"
    );
  }

  const size =
    fs.statSync(output).size;

  if (size < 10000) {
    throw new Error(
      "ملف التسجيل فارغ أو تالف"
    );
  }

  console.log(
    `✅ Capture: ${fileSizeMB(output).toFixed(2)} MB`
  );
}

// ==================================================
// MEDIA INFO
// ==================================================

async function getMediaInfo(file) {
  try {
    return await youtubedl(
      file,
      {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noCheckCertificates: true
      }
    );
  } catch {
    return null;
  }
}

async function getMediaDuration(file) {
  const info =
    await getMediaInfo(file);

  return Number(
    info?.duration || 0
  );
}

// ==================================================
// CUT + ENCODE
// ==================================================

async function cutVideo(
  input,
  output,
  start,
  duration
) {
  console.log(
    `✂️ Cut ${duration}s from ${start}s`
  );

  /*
   * هنا أيضًا لا نستخدم -c copy.
   * نعيد الترميز لضمان توافق الملف.
   */

  await runProcess(
    ffmpegPath,
    [
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

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "20",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-movflags",
      "+faststart",

      "-y",
      output
    ]
  );

  if (!fs.existsSync(output)) {
    throw new Error(
      "لم يتم إنشاء الكليب"
    );
  }

  const size =
    fs.statSync(output).size;

  if (size < 10000) {
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
      `🎬 LIVE CLIP @${username}`
    );

    await captureLive(
      username,
      capture
    );

    const duration =
      await getMediaDuration(
        capture
      );

    console.log(
      `⏱️ Capture duration: ${duration}s`
    );

    if (
      duration <
      MIN_CLIP_SECONDS
    ) {
      throw new Error(
        "التسجيل الناتج أقصر من 15 ثانية"
      );
    }

    const clipDuration =
      Math.min(
        randomClipLength(),
        Math.floor(duration)
      );

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

    await cutVideo(
      capture,
      clip,
      start,
      clipDuration
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
      duration: clipDuration,
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
      `لم أستطع الوصول إلى @${username}`
    );
  }

  if (isLiveInfo(info)) {
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
      "لا توجد إعادة بث عامة متاحة"
    );
  }

  const totalDuration =
    Number(
      info.duration || 0
    );

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
      Math.floor(totalDuration)
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

  const downloaded =
    tempFile("vod-source");

  const clip =
    tempFile("vod-clip");

  try {
    console.log(
      `📼 VOD @${username}`
    );

    /*
     * نحمل فقط الجزء المطلوب.
     * لا نحاول الوصول إلى محتوى خاص
     * أو للمشتركين بدون صلاحية.
     */

    await youtubedl(
      vodUrl,
      {
        output: downloaded,

        format:
          "bestvideo+bestaudio/best",

        downloadSections:
          `*${start}-${start + clipDuration}`,

        forceKeyframesAtCuts:
          true,

        mergeOutputFormat:
          "mp4",

        noPart: true,

        noWarnings: true,

        noCheckCertificates: true,

        addHeader: [
          "User-Agent: Mozilla/5.0",
          "Accept-Language: en-US,en;q=0.9"
        ]
      }
    );

    if (
      !fs.existsSync(downloaded)
    ) {
      throw new Error(
        "لم يتم تنزيل جزء الـVOD"
      );
    }

    /*
     * إعادة ترميز نهائية لضمان
     * توافق Telegram والفيديو.
     */

    await cutVideo(
      downloaded,
      clip,
      0,
      clipDuration
    );

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
      duration: clipDuration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );
  } finally {
    deleteFile(downloaded);
    deleteFile(clip);
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
  if (!fs.existsSync(file)) {
    throw new Error(
      "ملف الكليب غير موجود"
    );
  }

  let size =
    fs.statSync(file).size;

  /*
   * إذا كان الملف أكبر من حد تيليجرام
   * نضغطه تلقائيًا مرة ثانية.
   */

  if (size > TELEGRAM_LIMIT) {
    console.log(
      "⚠️ الكليب كبير، سيتم ضغطه"
    );

    const compressed =
      tempFile("compressed");

    try {
      await runProcess(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",

          "-i",
          file,

          "-map",
          "0:v:0",

          "-map",
          "0:a:0?",

          "-c:v",
          "libx264",

          "-preset",
          "veryfast",

          "-crf",
          "25",

          "-maxrate",
          "6M",

          "-bufsize",
          "12M",

          "-c:a",
          "aac",

          "-b:a",
          "96k",

          "-movflags",
          "+faststart",

          "-y",
          compressed
        ]
      );

      if (
        fs.existsSync(compressed) &&
        fs.statSync(compressed).size <
          size
      ) {
        deleteFile(file);

        fs.renameSync(
          compressed,
          file
        );
      } else {
        deleteFile(
          compressed
        );
      }
    } catch {
      deleteFile(
        compressed
      );
    }
  }

  size =
    fs.statSync(file).size;

  if (
    size > TELEGRAM_LIMIT
  ) {
    throw new Error(
      `حجم الكليب ${fileSizeMB(file).toFixed(2)}MB ويتجاوز حد الرفع`
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
// CREATE JOB
// ==================================================

async function createAndSendClip(job) {
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
          "❌ استخدم:",
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
          type: "live",
          streamer: username,
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
        type: "vod",
        streamer: username,
        chatId: msg.chat.id,
        notifyChatId: msg.chat.id
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
        [
          `❌ حدث خطأ أثناء إنشاء كليب @${username}`,
          "",
          String(
            error?.message ||
            "خطأ غير معروف"
          ).slice(0, 1000)
        ].join("\n")
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
    [...streamers];

  shuffled.sort(
    () =>
      Math.random() - 0.5
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

      if (!info) continue;

      if (!isLiveInfo(info)) {
        continue;
      }

      console.log(
        `🟢 AUTO LIVE: @${username}`
      );

      for (
        const channel
        of channelList
      ) {
        const exists =
          queue.some(
            job =>
              job.streamer ===
                username &&
              job.chatId ===
                channel.id
          );

        if (!exists) {
          addToQueue({
            type: "live",
            streamer: username,
            info,
            chatId: channel.id
          });
        }
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
  "🎬 Auto clips: every 10 minutes"
);

console.log(
  `⏱️ Duration: ${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS}s`
);

console.log(
  `🎞️ FFmpeg: ${ffmpegPath}`
);

// أول فحص
setTimeout(
  monitor,
  15000
);

// كل 10 دقائق
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

// ==================================================
// PROCESS ERRORS
// ==================================================

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

// ==================================================
// KEEP ALIVE
// ==================================================

setInterval(
  () => {
    console.log(
      `💚 Drex alive | Queue: ${queue.length} | Processing: ${processing}`
    );
  },
  5 * 60 * 1000
); 