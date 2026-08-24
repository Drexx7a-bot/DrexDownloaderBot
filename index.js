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

// اختياري:
// ضع session_token الخاص بحساب Kick المصرح له بالمحتوى
const KICK_SESSION_TOKEN =
  process.env.KICK_SESSION_TOKEN || "";

const AUTO_CLIP_INTERVAL =
  10 * 60 * 1000;

const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 30;

// نلتقط 35 ثانية ثم نختار منها الكليب
const LIVE_CAPTURE_SECONDS = 35;

// نخلي مساحة أمان تحت حد تيليجرام
const TELEGRAM_LIMIT =
  49 * 1024 * 1024;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

if (!ffmpegPath) {
  console.error("❌ FFmpeg غير موجود");
  process.exit(1);
}

// ==================================================
// BOT
// ==================================================

const bot = new TelegramBot(TOKEN, {
  polling: {
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

// ==================================================
// RENDER
// ==================================================

const server = http.createServer(
  (req, res) => {
    res.writeHead(200, {
      "Content-Type":
        "text/plain; charset=utf-8"
    });

    res.end(
      "Drex Clips Bot is running ✅"
    );
  }
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 Render server running on port ${PORT}`
    );
  }
);

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

const JOBS_FILE = path.join(
  DATA_DIR,
  "jobs.json"
);

fs.mkdirSync(DATA_DIR, {
  recursive: true
});

function loadJSON(
  file,
  fallback
) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(
          fallback,
          null,
          2
        )
      );

      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      `⚠️ JSON error ${file}:`,
      error.message
    );

    return fallback;
  }
}

function saveJSON(
  file,
  data
) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      `❌ JSON save error:`,
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

let jobs = loadJSON(
  JOBS_FILE,
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

  const job =
    queue.shift();

  try {
    await createAndSendClip(
      job
    );
  } catch (error) {
    console.error(
      "❌ Clip job:",
      error?.stack ||
      error?.message ||
      error
    );

    if (
      job.notifyChatId
    ) {
      try {
        await bot.sendMessage(
          job.notifyChatId,
          [
            `❌ فشل إنشاء كليب @${job.streamer}`,
            "",
            String(
              error?.message ||
              "خطأ غير معروف"
            ).slice(0, 900)
          ].join("\n")
        );
      } catch {}
    }
  }

  processing = false;

  setTimeout(
    processQueue,
    2000
  );
}

// ==================================================
// UTILITIES
// ==================================================

function cleanUsername(
  username
) {
  return String(
    username || ""
  )
    .trim()
    .replace(
      /^@/,
      ""
    )
    .replace(
      /^https?:\/\/(www\.)?kick\.com\//i,
      ""
    )
    .split(
      /[/?#]/
    )[0];
}

function randomInt(
  min,
  max
) {
  return (
    Math.floor(
      Math.random() *
        (max - min + 1)
    ) + min
  );
}

function randomClipLength() {
  return randomInt(
    MIN_CLIP_SECONDS,
    MAX_CLIP_SECONDS
  );
}

function tempFile(
  prefix
) {
  return path.join(
    DATA_DIR,
    `${prefix}-${crypto
      .randomBytes(8)
      .toString("hex")}.mp4`
  );
}

function deleteFile(
  file
) {
  try {
    if (
      file &&
      fs.existsSync(file)
    ) {
      fs.unlinkSync(file);
    }
  } catch {}
}

function fileSizeMB(
  file
) {
  try {
    return (
      fs.statSync(file)
        .size /
      1024 /
      1024
    );
  } catch {
    return 0;
  }
}

// ==================================================
// KICK HEADERS
// ==================================================

function kickHeaders() {
  const headers = [
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language: en-US,en;q=0.9",
    "Referer: https://kick.com/"
  ];

  if (
    KICK_SESSION_TOKEN
  ) {
    headers.push(
      `Cookie: session_token=${KICK_SESSION_TOKEN}`
    );
  }

  return headers;
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
        "🎬 كليبات Kick تلقائية",
        "",
        "🔴 كليب كل 10 دقائق",
        "⏱️ مدة 15–30 ثانية",
        "🎥 أعلى جودة متاحة",
        "",
        "🎬 كليب يدوي:",
        "/clip username",
        "",
        "➕ إضافة:",
        "/add username",
        "",
        "📋 القائمة:",
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
      if (!msg.chat)
        return;

      const chat =
        msg.chat;

      const id =
        String(chat.id);

      if (!channels[id]) {
        channels[id] = {
          id: chat.id,
          title:
            chat.title ||
            "بدون اسم",
          username:
            chat.username ||
            null,
          addedAt:
            new Date()
              .toISOString()
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
      const chat =
        update.chat;

      const status =
        update
          .new_chat_member
          ?.status;

      if (!chat) return;

      if (
        chat.type ===
          "channel" &&
        (
          status ===
            "administrator" ||
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
            new Date()
              .toISOString()
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
        chat.type ===
          "channel" &&
        (
          status ===
            "left" ||
          status ===
            "kicked"
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
  async (
    msg,
    match
  ) => {
    const usernames =
      match[1]
        .split(
          /[,\s]+/
        )
        .map(
          cleanUsername
        )
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
        invalid.push(
          username
        );

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
  async (
    msg,
    match
  ) => {
    const usernames =
      match[1]
        .split(
          /[,\s]+/
        )
        .map(
          cleanUsername
        )
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

      if (
        index === -1
      ) {
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
          (
            name,
            index
          ) =>
            `${index + 1}. @${name}`
        )
        .join("\n");

    await bot.sendMessage(
      msg.chat.id,
      [
        "📋 الحسابات:",
        "",
        text,
        "",
        `📊 العدد: ${streamers.length}`
      ].join("\n")
    );
  }
);

// ==================================================
// GET KICK INFO
// ==================================================

async function getKickInfo(
  username
) {
  const url =
    `https://kick.com/${encodeURIComponent(
      username
    )}`;

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

          addHeader:
            kickHeaders()
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
      ) ||
      lower.includes(
        "user not live"
      )
    ) {
      return null;
    }

    console.error(
      `⚠️ Kick @${username}:`,
      message.slice(
        -1500
      )
    );

    return null;
  }
}

// ==================================================
// LIVE CHECK
// ==================================================

function isLiveInfo(
  info
) {
  if (!info)
    return false;

  return (
    info.is_live === true ||
    info.live === true ||
    info.live_status ===
      "is_live"
  );
}

// ==================================================
// STREAM URL
// ==================================================

function findStreamFormat(
  info
) {
  if (
    !info ||
    !Array.isArray(
      info.formats
    )
  ) {
    return null;
  }

  const formats =
    info.formats
      .filter(
        f =>
          f &&
          typeof f.url ===
            "string"
      )
      .filter(
        f =>
          !f.has_drm
      )
      .sort(
        (a, b) => {
          const ah =
            Number(
              a.height
            ) || 0;

          const bh =
            Number(
              b.height
            ) || 0;

          if (
            ah !== bh
          ) {
            return bh - ah;
          }

          return (
            (Number(
              b.tbr
            ) || 0) -
            (Number(
              a.tbr
            ) || 0)
          );
        }
      );

  return (
    formats[0] ||
    null
  );
}

// ==================================================
// FFMPEG
// ==================================================

function runFFmpeg(
  args,
  timeoutMs = 120000
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      console.log(
        "🎞️ FFmpeg starting..."
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
            ],
            windowsHide:
              true
          }
        );

      let stderr = "";

      let finished =
        false;

      const timer =
        setTimeout(
          () => {
            if (
              finished
            )
              return;

            console.error(
              "⏰ FFmpeg timeout"
            );

            try {
              child.kill(
                "SIGKILL"
              );
            } catch {}

            reject(
              new Error(
                "FFmpeg أخذ وقتًا أطول من المتوقع"
              )
            );
          },
          timeoutMs
        );

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
              stderr.slice(
                -12000
              );
          }
        }
      );

      child.on(
        "error",
        error => {
          if (
            finished
          )
            return;

          finished = true;

          clearTimeout(
            timer
          );

          reject(
            error
          );
        }
      );

      child.on(
        "close",
        (
          code,
          signal
        ) => {
          if (
            finished
          )
            return;

          finished = true;

          clearTimeout(
            timer
          );

          if (
            code === 0
          ) {
            resolve();
            return;
          }

          if (
            signal
          ) {
            reject(
              new Error(
                `FFmpeg تم إنهاؤه بإشارة ${signal}`
              )
            );

            return;
          }

          reject(
            new Error(
              `FFmpeg exited with code ${code}\n${stderr.slice(
                -3000
              )}`
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
      `لم يتم الوصول إلى بث @${username}`
    );
  }

  if (
    !isLiveInfo(info)
  ) {
    throw new Error(
      `@${username} ليس مباشرًا الآن`
    );
  }

  const format =
    findStreamFormat(
      info
    );

  if (!format) {
    throw new Error(
      "لم يتم العثور على صيغة بث متاحة"
    );
  }

  const streamUrl =
    format.url;

  console.log(
    `📡 Stream: ${format.height || "?"}p`
  );

  const headers =
    format.http_headers ||
    {};

  const headerArgs =
    [];

  for (
    const [key, value]
    of Object.entries(
      headers
    )
  ) {
    if (
      value === undefined ||
      value === null
    )
      continue;

    headerArgs.push(
      `${key}: ${value}`
    );
  }

  if (
    !headerArgs.some(
      x =>
        x.toLowerCase()
          .startsWith(
            "user-agent:"
          )
    )
  ) {
    headerArgs.push(
      "User-Agent: Mozilla/5.0"
    );
  }

  if (
    KICK_SESSION_TOKEN &&
    !headerArgs.some(
      x =>
        x.toLowerCase()
          .startsWith(
            "cookie:"
          )
    )
  ) {
    headerArgs.push(
      `Cookie: session_token=${KICK_SESSION_TOKEN}`
    );
  }

  /*
   * مهم:
   * لا نستخدم -c copy هنا.
   * نعيد ترميز الفيديو لتقليل احتمال
   * انهيار FFmpeg مع HLS المتقطع.
   *
   * ونستخدم threads=1 لتقليل ضغط Render.
   */

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",

    "-threads",
    "1",

    "-reconnect",
    "1",

    "-reconnect_streamed",
    "1",

    "-reconnect_delay_max",
    "5",

    "-rw_timeout",
    "30000000",

    "-headers",
    headerArgs.join(
      "\r\n"
    ),

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

    "-c:a",
    "aac",

    "-b:a",
    "160k",

    "-pix_fmt",
    "yuv420p",

    "-movflags",
    "+faststart",

    "-y",
    output
  ];

  await runFFmpeg(
    args,
    150000
  );

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
      "الملف الناتج فارغ"
    );
  }

  console.log(
    `✅ Captured ${fileSizeMB(
      output
    ).toFixed(2)} MB`
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
// CUT VIDEO
// ==================================================

async function cutLocalVideo(
  input,
  output,
  start,
  duration
) {
  /*
   * إعادة ترميز الكليب أيضًا.
   * هذا أفضل للاستقرار من copy مع HLS.
   */

  await runFFmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "warning",

      "-threads",
      "1",

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

      "-c:a",
      "aac",

      "-b:a",
      "160k",

      "-pix_fmt",
      "yuv420p",

      "-movflags",
      "+faststart",

      "-y",

      output
    ],
    90000
  );

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
    tempFile("capture");

  const clip =
    tempFile("clip");

  try {
    await captureLive(
      username,
      capture
    );

    const captured =
      await getMediaDuration(
        capture
      );

    console.log(
      `⏱️ Captured: ${captured}s`
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
        Math.floor(
          captured
        )
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
      `✂️ Clip ${duration}s from ${start}s`
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
        new Date()
          .toISOString()
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
      "لم يتم الوصول إلى معلومات الحساب أو إعادة البث"
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
      "لا توجد إعادة بث عامة متاحة"
    );
  }

  const total =
    Number(
      info.duration
    ) || 0;

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
        total -
          duration
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
      `📼 VOD @${username} ${start}s -> ${duration}s`
    );

    const headers =
      kickHeaders();

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

        addHeader:
          headers
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

    clips[
      `${username}-vod-${Date.now()}`
    ] = {
      username,
      type: "vod",
      start,
      duration,
      createdAt:
        new Date()
          .toISOString()
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
    fs.statSync(file)
      .size;

  if (
    size >
    TELEGRAM_LIMIT
  ) {
    throw new Error(
      `حجم الكليب كبير: ${fileSizeMB(
        file
      ).toFixed(2)} MB`
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
    `✅ Sent @${username}`
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
  async (
    msg,
    match
  ) => {
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
          [
            `❌ لم أستطع الوصول إلى @${username}.`,
            "",
            "تأكد أن الحساب متاح وأن جلسة Kick صحيحة إذا كان المحتوى يتطلب تسجيل دخول."
          ].join("\n")
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
          streamer:
            username,
          info,
          chatId:
            msg.chat.id,
          notifyChatId:
            msg.chat.id
        });

        return;
      }

      await bot.sendMessage(
        msg.chat.id,
        [
          `📼 @${username} أوفلاين`,
          "",
          "🔎 جاري البحث عن إعادة بث متاحة..."
        ].join("\n")
      );

      addToQueue({
        type: "vod",
        streamer:
          username,
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

  const shuffled =
    [...streamers];

  shuffled.sort(
    () =>
      Math.random() -
      0.5
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

      const streamId =
        info.id ||
        info.display_id ||
        info.slug ||
        `${username}-live`;

      const jobKey =
        `${username}-${streamId}`;

      /*
       * لا نرسل نفس البث أكثر من مرة
       * لكل دورة.
       */

      if (
        jobs[jobKey]
      ) {
        continue;
      }

      jobs[jobKey] = {
        username,
        streamId,
        createdAt:
          new Date()
            .toISOString()
      };

      saveJSON(
        JOBS_FILE,
        jobs
      );

      console.log(
        `🟢 AUTO LIVE @${username}`
      );

      /*
       * كليب واحد فقط في الدورة.
       */

      const channel =
        channelList[
          randomInt(
            0,
            channelList.length -
              1
          )
        ];

      addToQueue({
        type: "live",
        streamer:
          username,
        info,
        chatId:
          channel.id
      });

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
// CLEAN OLD JOBS
// ==================================================

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const key of Object.keys(
        jobs
      )
    ) {
      const time =
        new Date(
          jobs[key].createdAt
        ).getTime();

      if (
        now - time >
        24 * 60 * 60 * 1000
      ) {
        delete jobs[key];
      }
    }

    saveJSON(
      JOBS_FILE,
      jobs
    );
  },
  60 * 60 * 1000
);

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
  `📢 Channels: ${Object.keys(
    channels
  ).length}`
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

console.log(
  KICK_SESSION_TOKEN
    ? "🔐 Kick session: موجود"
    : "🔓 Kick session: غير مضافة"
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
    const message =
      String(
        error?.message ||
        error
      );

    console.error(
      "❌ Telegram polling:",
      message
    );

    /*
     * 502 / 429 لا نخليها
     * توقف البوت.
     */
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