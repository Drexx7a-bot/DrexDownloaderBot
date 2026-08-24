const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const youtubedl = require("youtube-dl-exec");

// ==================================================
// CONFIG
// ==================================================

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 10000);

const AUTO_CLIP_INTERVAL = 10 * 60 * 1000;

const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 30;

// جزء صغير من البث يتم تنزيله قبل اختيار اللقطة
const CAPTURE_SECONDS = 32;

const TELEGRAM_LIMIT = 49 * 1024 * 1024;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود");
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
      `⚠️ JSON error: ${file}`,
      error.message
    );

    return fallback;
  }
}

function saveJSON(file, data) {
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

const queue = [];

let processing = false;

function addJob(job) {
  queue.push(job);

  console.log(
    `📥 Queue +1 | ${job.type} | @${job.streamer} | Queue: ${queue.length}`
  );

  processQueue();
}

async function processQueue() {
  if (processing) {
    return;
  }

  if (queue.length === 0) {
    return;
  }

  processing = true;

  const job = queue.shift();

  try {
    if (job.type === "live") {
      await createLiveClip(
        job.streamer,
        job.info,
        job.chatId
      );
    } else if (job.type === "vod") {
      await createVodClip(
        job.streamer,
        job.chatId
      );
    } else {
      throw new Error(
        "نوع المهمة غير معروف"
      );
    }

    if (job.notifyChatId) {
      try {
        await bot.sendMessage(
          job.notifyChatId,
          `✅ تم إنشاء وإرسال كليب @${job.streamer}`
        );
      } catch {}
    }
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
              error
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

function cleanUsername(value) {
  return String(value || "")
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

function tempFile(
  prefix,
  extension = "mp4"
) {
  return path.join(
    DATA_DIR,
    `${prefix}-${crypto
      .randomBytes(8)
      .toString("hex")}.${extension}`
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
  if (
    !file ||
    !fs.existsSync(file)
  ) {
    return 0;
  }

  return (
    fs.statSync(file).size /
    1024 /
    1024
  );
}

// ==================================================
// FFMPEG
// ==================================================

function findBinary(name) {
  const candidates =
    name === "ffmpeg"
      ? [
          "/usr/bin/ffmpeg",
          "/usr/local/bin/ffmpeg"
        ]
      : [
          "/usr/bin/ffprobe",
          "/usr/local/bin/ffprobe"
        ];

  for (
    const candidate
    of candidates
  ) {
    if (
      fs.existsSync(candidate)
    ) {
      return candidate;
    }
  }

  return name;
}

const FFMPEG =
  findBinary("ffmpeg");

const FFPROBE =
  findBinary("ffprobe");

console.log(
  `🎞️ FFmpeg: ${FFMPEG}`
);

console.log(
  `🔎 FFprobe: ${FFPROBE}`
);

// ==================================================
// PROCESS
// ==================================================

function runProcess(
  command,
  args
) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        `▶ ${command} ${args.join(" ")}`
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
            ]
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        data => {
          stdout +=
            data.toString();

          if (
            stdout.length >
            12000
          ) {
            stdout =
              stdout.slice(
                -12000
              );
          }
        }
      );

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            16000
          ) {
            stderr =
              stderr.slice(
                -16000
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
        (
          code,
          signal
        ) => {
          if (
            code === 0
          ) {
            resolve({
              stdout,
              stderr
            });

            return;
          }

          reject(
            new Error(
              [
                `${command} failed`,
                `code=${code}`,
                `signal=${signal || "none"}`,
                stderr.slice(-5000)
              ].join("\n")
            )
          );
        }
      );
    }
  );
}

// ==================================================
// KICK INFO
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

          addHeader: [
            "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept-Language: en-US,en;q=0.9"
          ]
        }
      );

    return info;
  } catch (error) {
    const text =
      String(
        error?.stderr ||
        error?.message ||
        ""
      );

    const lower =
      text.toLowerCase();

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
      text.slice(-1500)
    );

    return null;
  }
}

// ==================================================
// LIVE CHECK
// ==================================================

function isLive(info) {
  if (!info) {
    return false;
  }

  return (
    info.live_status ===
      "is_live" ||
    info.is_live === true ||
    info.live === true
  );
}

// ==================================================
// MEDIA DURATION
// ==================================================

function getMediaDuration(
  file
) {
  return new Promise(
    resolve => {
      const child =
        spawn(
          FFPROBE,
          [
            "-v",
            "error",

            "-show_entries",
            "format=duration",

            "-of",
            "default=noprint_wrappers=1:nokey=1",

            file
          ],
          {
            stdio: [
              "ignore",
              "pipe",
              "ignore"
            ]
          }
        );

      let output = "";

      child.stdout.on(
        "data",
        data => {
          output +=
            data.toString();
        }
      );

      child.on(
        "close",
        code => {
          if (
            code !== 0
          ) {
            resolve(0);
            return;
          }

          const duration =
            Number.parseFloat(
              output.trim()
            );

          resolve(
            Number.isFinite(
              duration
            )
              ? duration
              : 0
          );
        }
      );

      child.on(
        "error",
        () => {
          resolve(0);
        }
      );
    }
  );
}

// ==================================================
// DOWNLOAD LIVE SEGMENT
// ==================================================

async function downloadLiveSegment(
  username,
  output
) {
  const url =
    `https://kick.com/${encodeURIComponent(
      username
    )}`;

  console.log(
    `📡 تنزيل جزء من بث @${username}`
  );

  /*
   * yt-dlp يتعامل مع رابط Kick.
   * لا نشغل FFmpeg على رابط HLS مباشرة.
   */

  await youtubedl(
    url,
    {
      output,

      format:
        "best[protocol*=m3u8]/best",

      downloadSections:
        `*-${CAPTURE_SECONDS}`,

      forceKeyframesAtCuts:
        false,

      mergeOutputFormat:
        "mp4",

      noPart:
        true,

      noWarnings:
        true,

      noCheckCertificates:
        true,

      concurrentFragments:
        1,

      retries:
        3,

      fragmentRetries:
        3,

      ffmpegLocation:
        FFMPEG,

      addHeader: [
        "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language: en-US,en;q=0.9"
      ]
    }
  );

  if (
    !fs.existsSync(output)
  ) {
    throw new Error(
      "لم يتم تنزيل جزء البث"
    );
  }

  if (
    fs.statSync(output).size <
    10000
  ) {
    throw new Error(
      "ملف البث الناتج فارغ"
    );
  }

  console.log(
    `✅ تم تنزيل ${fileSizeMB(output).toFixed(2)} MB`
  );
}

// ==================================================
// CUT CLIP
// ==================================================

async function makeClipFromFile(
  input,
  output,
  requestedDuration
) {
  const total =
    await getMediaDuration(
      input
    );

  console.log(
    `⏱️ مدة الملف: ${total}s`
  );

  if (
    total <
    MIN_CLIP_SECONDS
  ) {
    throw new Error(
      `الملف أقصر من ${MIN_CLIP_SECONDS} ثانية`
    );
  }

  const duration =
    Math.min(
      requestedDuration,
      Math.floor(total),
      MAX_CLIP_SECONDS
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

  console.log(
    `✂️ قص ${duration}s من ${start}s`
  );

  /*
   * إعادة ترميز آمنة بدل -c copy.
   *
   * CRF 18 = جودة عالية.
   * لا يمكن إنشاء 4K حقيقي إذا المصدر نفسه ليس 4K.
   */

  await runProcess(
    FFMPEG,
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
      "18",

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
    ]
  );

  if (
    !fs.existsSync(output)
  ) {
    throw new Error(
      "FFmpeg لم ينشئ الكليب"
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

  return {
    start,
    duration
  };
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
    tempFile(
      "capture"
    );

  const clip =
    tempFile(
      "clip"
    );

  try {
    console.log(
      `🎬 LIVE CLIP @${username}`
    );

    await downloadLiveSegment(
      username,
      capture
    );

    const result =
      await makeClipFromFile(
        capture,
        clip,
        randomClipLength()
      );

    await sendClip(
      clip,
      username,
      info,
      "live",
      chatId,
      result
    );

    clips[
      `${username}-${Date.now()}`
    ] = {
      username,
      type: "live",
      start:
        result.start,
      duration:
        result.duration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );

    console.log(
      `✅ تم إرسال كليب @${username}`
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
// CREATE VOD CLIP
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

  /*
   * إذا رجع Live نستخدم مسار البث المباشر.
   */

  if (
    isLive(info)
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

  const total =
    Number(
      info.duration
    ) || 0;

  if (
    !vodUrl ||
    total <
      MIN_CLIP_SECONDS
  ) {
    throw new Error(
      "لا توجد إعادة بث عامة كافية. إذا كانت الإعادة للمشتركين فقط فلن يستطيع البوت الوصول إليها."
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
    tempFile(
      "vod"
    );

  try {
    console.log(
      `📼 VOD @${username} | ${start}s | ${duration}s`
    );

    await youtubedl(
      vodUrl,
      {
        output:
          clip,

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

        concurrentFragments:
          1,

        retries:
          3,

        fragmentRetries:
          3,

        ffmpegLocation:
          FFMPEG,

        addHeader: [
          "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
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

    if (
      fs.statSync(clip).size <
      10000
    ) {
      throw new Error(
        "كليب الإعادة فارغ"
      );
    }

    await sendClip(
      clip,
      username,
      info,
      "vod",
      chatId,
      {
        start,
        duration
      }
    );

    clips[
      `${username}-vod-${Date.now()}`
    ] = {
      username,
      type: "vod",
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
  chatId,
  meta = {}
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
    meta.start != null
      ? `⏱️ المقطع: ${meta.duration}s`
      : "",
    "",
    `🔗 https://kick.com/${username}`,
    "",
    "© Drex"
  ]
    .filter(Boolean)
    .join("\n");

  await bot.sendVideo(
    chatId,
    file,
    {
      caption,
      supports_streaming:
        true
    }
  );
}

// ==================================================
// /START
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
        "⏱️ كل 10 دقائق",
        "🎞️ مدة 15–30 ثانية",
        "🏆 أعلى جودة متاحة من المصدر",
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
        "➖ حذف حساب:",
        "/remove username"
      ].join("\n")
    );
  }
);

// ==================================================
// CHANNEL DETECTION
// ==================================================

bot.on(
  "my_chat_member",
  update => {
    try {
      const chat =
        update.chat;

      const status =
        update
          .new_chat_member
          ?.status;

      if (
        !chat ||
        chat.type !==
          "channel"
      ) {
        return;
      }

      if (
        status ===
          "administrator" ||
        status ===
          "member"
      ) {
        channels[
          String(chat.id)
        ] = {
          id:
            chat.id,

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
        status === "left" ||
        status === "kicked"
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

bot.on(
  "channel_post",
  msg => {
    try {
      if (!msg.chat) {
        return;
      }

      const id =
        String(
          msg.chat.id
        );

      if (
        !channels[id]
      ) {
        channels[id] = {
          id:
            msg.chat.id,

          title:
            msg.chat.title ||
            "بدون اسم",

          username:
            msg.chat.username ||
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
        .filter(
          Boolean
        );

    const added = [];
    const already = [];
    const invalid = [];

    for (
      const username
      of usernames
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

    await bot.sendMessage(
      msg.chat.id,
      [
        "📋 نتيجة الإضافة:",
        "",

        added.length
          ? `✅ تمت الإضافة:\n${added.join("\n")}`
          : "",

        already.length
          ? `ℹ️ موجودة مسبقًا:\n${already.join("\n")}`
          : "",

        invalid.length
          ? `⚠️ غير صالحة:\n${invalid.join("\n")}`
          : ""
      ]
        .filter(Boolean)
        .join("\n\n")
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
        .filter(
          Boolean
        );

    const removed = [];
    const missing = [];

    for (
      const username
      of usernames
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
        missing.push(
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

    await bot.sendMessage(
      msg.chat.id,
      [
        "📋 نتيجة الحذف:",
        "",

        removed.length
          ? `✅ تم الحذف:\n${removed.join("\n")}`
          : "",

        missing.length
          ? `❌ غير موجود:\n${missing.join("\n")}`
          : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
);

// ==================================================
// LIST
// ==================================================

bot.onText(
  /^\/list$/i,
  async msg => {
    if (
      !streamers.length
    ) {
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
// /CLIP
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
          "❌ الاستخدام:",
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
        isLive(info)
      ) {
        await bot.sendMessage(
          msg.chat.id,
          [
            `🔴 @${username} أونلاين`,
            "",
            "🎬 جاري أخذ كليب..."
          ].join("\n")
        );

        addJob({
          type:
            "live",

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
          "🔎 جاري البحث عن إعادة بث عامة..."
        ].join("\n")
      );

      addJob({
        type:
          "vod",

        streamer:
          username,

        chatId:
          msg.chat.id,

        notifyChatId:
          msg.chat.id
      });
    } catch (error) {
      console.error(
        "❌ /clip:",
        error
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
    [...streamers].sort(
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

      if (
        !info ||
        !isLive(info)
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
        addJob({
          type:
            "live",

          streamer:
            username,

          info,

          chatId:
            channel.id
        });
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
// START
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

setTimeout(
  monitor,
  15000
);

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