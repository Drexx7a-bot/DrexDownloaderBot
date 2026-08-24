const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const youtubedl = require("youtube-dl-exec");

// ==================================================
// CONFIG
// ==================================================

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

const AUTO_CLIP_INTERVAL = 10 * 60 * 1000;

const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 30;

const TELEGRAM_LIMIT = 49 * 1024 * 1024;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, {
  polling: true,
  filepath: false
});

// ==================================================
// SERVER
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
      `⚠️ فشل قراءة ${file}:`,
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
      `❌ فشل حفظ ${file}:`,
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
            ).slice(0, 1000)
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
        "📡 أعلى جودة عامة متاحة",
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
        streamers.push(username);

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

  if (
    info.is_live === true ||
    info.live === true
  ) {
    return true;
  }

  if (
    info.live_status === "is_live"
  ) {
    return true;
  }

  if (
    info.live_status === "live"
  ) {
    return true;
  }

  return false;
}

// ==================================================
// STREAM ID
// ==================================================

function getStreamId(
  username,
  info
) {
  return (
    info?.id ||
    info?.display_id ||
    info?.stream_id ||
    `${username}-${info?.timestamp || Date.now()}`
  );
}

// ==================================================
// DOWNLOAD CLIP
// ==================================================

async function downloadClip(
  url,
  output,
  start,
  duration
) {
  console.log(
    `⬇️ Downloading ${duration}s from ${start}s`
  );

  /*
   * نطلب صيغة واحدة تحتوي فيديو + صوت قدر الإمكان.
   * هذا يقلل الحاجة إلى FFmpeg أثناء التنزيل.
   */

  await youtubedl(
    url,
    {
      output,

      format:
        "best[acodec!=none][vcodec!=none]/best",

      downloadSections:
        `*${start}-${start + duration}`,

      noPart: true,
      noWarnings: true,
      noCheckCertificates: true,

      concurrentFragments: 1,

      addHeader: [
        "User-Agent: Mozilla/5.0",
        "Accept: */*",
        "Accept-Language: en-US,en;q=0.9"
      ]
    }
  );

  if (
    !fs.existsSync(output)
  ) {
    throw new Error(
      "لم يتم إنشاء ملف الكليب"
    );
  }

  const size =
    fs.statSync(output).size;

  if (size < 10000) {
    throw new Error(
      "ملف الكليب فارغ أو غير صالح"
    );
  }

  if (
    size > TELEGRAM_LIMIT
  ) {
    throw new Error(
      `حجم الكليب كبير: ${fileSizeMB(output).toFixed(2)} MB`
    );
  }

  console.log(
    `✅ Downloaded: ${fileSizeMB(output).toFixed(2)} MB`
  );
}

// ==================================================
// LIVE CLIP
// ==================================================

async function createLiveClip(
  username,
  info,
  chatId
) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

  const clip =
    tempFile("live");

  try {
    /*
     * نستخدم آخر جزء من البث المتاح بدل تشغيل
     * FFmpeg كمسجل HLS مستقل.
     */

    const duration =
      randomClipLength();

    /*
     * start=0 مع downloadSections يعني أن yt-dlp
     * يطلب مقطعًا قصيرًا من المصدر.
     *
     * إذا رفض المصدر هذا الأسلوب، سيظهر الخطأ
     * بدل انهيار FFmpeg.
     */

    await downloadClip(
      url,
      clip,
      0,
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
      duration,
      createdAt:
        new Date().toISOString()
    };

    saveJSON(
      CLIPS_FILE,
      clips
    );
  } finally {
    deleteFile(clip);
  }
}

// ==================================================
// VOD CLIP
// ==================================================

async function createVodClip(
  username,
  info,
  chatId
) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

  const clip =
    tempFile("vod");

  try {
    /*
     * نطلب معلومات الصفحة مرة أخرى.
     */

    const vodInfo =
      info ||
      await getKickInfo(
        username
      );

    if (!vodInfo) {
      throw new Error(
        "لم يتم العثور على إعادة بث عامة"
      );
    }

    if (
      isLiveInfo(vodInfo)
    ) {
      return createLiveClip(
        username,
        vodInfo,
        chatId
      );
    }

    const duration =
      Number(
        vodInfo.duration
      ) || 0;

    if (
      duration <
      MIN_CLIP_SECONDS
    ) {
      throw new Error(
        "إعادة البث العامة غير متاحة أو مدتها قصيرة"
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

    const vodUrl =
      vodInfo.webpage_url ||
      vodInfo.original_url ||
      url;

    console.log(
      `📼 VOD @${username} | start=${start} | duration=${clipDuration}`
    );

    await downloadClip(
      vodUrl,
      clip,
      start,
      clipDuration
    );

    await sendClip(
      clip,
      username,
      vodInfo,
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
    size > TELEGRAM_LIMIT
  ) {
    throw new Error(
      `حجم الكليب ${fileSizeMB(file).toFixed(2)}MB`
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
// JOB
// ==================================================

async function createAndSendClip(job) {
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
      job.info,
      job.chatId
    );
  }

  throw new Error(
    "نوع الكليب غير معروف"
  );
}

// ==================================================
// /CLIP
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
          [
            `❌ لم أستطع الوصول إلى @${username}.`,
            "",
            "تأكد أن الحساب عام ومتاح."
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
            "🎬 جاري إنشاء كليب..."
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
        info,
        chatId: msg.chat.id,
        notifyChatId: msg.chat.id
      });
    } catch (error) {
      console.error(
        `❌ /clip @${username}:`,
        error
      );

      await bot.sendMessage(
        msg.chat.id,
        [
          `❌ فشل إنشاء كليب @${username}`,
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

      if (
        !isLiveInfo(info)
      ) continue;

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
              job.streamer
                .toLowerCase() ===
              username.toLowerCase() &&
              job.chatId ===
                channel.id
          );

        if (!duplicate) {
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
  "⏱️ Duration: 15-30 seconds"
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

console.log(
  "✅ Bot initialization complete."
);