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

/* =========================
   HTTP SERVER - RENDER
========================= */

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Drex Downloader Bot is running ✅");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Render server running on port ${PORT}`);
});

/* =========================
   PATHS
========================= */

const DATA_DIR = path.join(os.tmpdir(), "drex-downloader");
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");
const STREAMERS_FILE = path.join(DATA_DIR, "streamers.json");
const DOWNLOADED_FILE = path.join(DATA_DIR, "downloaded.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let channels = loadJSON(CHANNELS_FILE, {});
let streamers = loadJSON(STREAMERS_FILE, []);
let downloaded = loadJSON(DOWNLOADED_FILE, {});

/* =========================
   DOWNLOAD QUEUE
========================= */

let queue = [];
let downloading = false;

function addToQueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (downloading || queue.length === 0) {
    return;
  }

  downloading = true;

  const job = queue.shift();

  try {
    await downloadAndSend(job);
  } catch (error) {
    console.error("❌ Job error:", error.message);

    try {
      await bot.sendMessage(
        job.chatId,
        `❌ حدث خطأ أثناء تنزيل بث ${job.streamer}`
      );
    } catch {}
  }

  downloading = false;

  setTimeout(processQueue, 1000);
}

/* =========================
   TELEGRAM START
========================= */

bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    [
      "🤖 Drex Downloader Bot",
      "",
      "البوت يعمل بنجاح ✅",
      "",
      "📥 وظيفته تنزيل بثوث Kick وإرسالها للقناة.",
      "",
      "⚙️ إضافة البوت للقناة كمسؤول تكفي لتحديد مكان النشر.",
      "",
      "🔐 لا يحتاج CHANNEL_ID."
    ].join("\n")
  );
});

/* =========================
   CHANNEL DETECTION
========================= */

bot.on("channel_post", async (msg) => {
  if (!msg.chat) return;

  const chatId = String(msg.chat.id);

  if (!channels[chatId]) {
    channels[chatId] = {
      id: msg.chat.id,
      title: msg.chat.title || "بدون اسم",
      username: msg.chat.username || null,
      addedAt: new Date().toISOString()
    };

    saveJSON(CHANNELS_FILE, channels);

    console.log(
      `📢 Channel detected: ${msg.chat.title} (${msg.chat.id})`
    );
  }
});

/* =========================
   BOT ADDED TO CHANNEL
========================= */

bot.on("my_chat_member", async (update) => {
  try {
    const chat = update.chat;
    const newStatus = update.new_chat_member?.status;

    if (!chat) return;

    if (
      chat.type === "channel" &&
      (newStatus === "administrator" || newStatus === "member")
    ) {
      const chatId = String(chat.id);

      channels[chatId] = {
        id: chat.id,
        title: chat.title || "بدون اسم",
        username: chat.username || null,
        addedAt: new Date().toISOString()
      };

      saveJSON(CHANNELS_FILE, channels);

      console.log(
        `✅ Channel registered automatically: ${chat.title}`
      );
    }

    if (
      chat.type === "channel" &&
      (newStatus === "left" || newStatus === "kicked")
    ) {
      delete channels[String(chat.id)];
      saveJSON(CHANNELS_FILE, channels);

      console.log(`🗑️ Channel removed: ${chat.title}`);
    }
  } catch (error) {
    console.error("❌ my_chat_member:", error.message);
  }
});

/* =========================
   ADD STREAMER
========================= */

bot.onText(/^\/add (.+)$/i, async (msg, match) => {
  const username = match[1]
    .trim()
    .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#\s]/)[0];

  if (!username) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ اكتب اسم حساب Kick.\n\nمثال:\n/add drex_7a"
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ اسم الحساب غير صالح."
    );
  }

  if (!streamers.includes(username)) {
    streamers.push(username);
    saveJSON(STREAMERS_FILE, streamers);

    return bot.sendMessage(
      msg.chat.id,
      `✅ تمت إضافة @${username}\n\nسيتم مراقبة الحساب تلقائيًا.`
    );
  }

  bot.sendMessage(
    msg.chat.id,
    `ℹ️ @${username} موجود بالفعل.`
  );
});

/* =========================
   REMOVE STREAMER
========================= */

bot.onText(/^\/remove (.+)$/i, async (msg, match) => {
  const username = match[1]
    .trim()
    .replace(/^@/, "")
    .split(/[/?#\s]/)[0];

  const index = streamers.indexOf(username);

  if (index === -1) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ @${username} غير موجود.`
    );
  }

  streamers.splice(index, 1);
  saveJSON(STREAMERS_FILE, streamers);

  bot.sendMessage(
    msg.chat.id,
    `✅ تم حذف @${username} من المراقبة.`
  );
});

/* =========================
   LIST STREAMERS
========================= */

bot.onText(/^\/list$/, async (msg) => {
  if (streamers.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      "📋 لا توجد حسابات مضافة."
    );
  }

  const text = streamers
    .map((name, i) => `${i + 1}. @${name}`)
    .join("\n");

  bot.sendMessage(
    msg.chat.id,
    `📋 الحسابات المراقبة:\n\n${text}`
  );
});

/* =========================
   KICK CHECK
========================= */

async function getStreamerInfo(username) {
  const url = `https://kick.com/${encodeURIComponent(username)}`;

  try {
    const data = await youtubedl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noCheckCertificates: true,
      ffmpegLocation: ffmpegPath,
      addHeader: [
        "User-Agent: Mozilla/5.0"
      ]
    });

    return data;
  } catch (error) {
    const message = String(
      error?.stderr ||
      error?.message ||
      ""
    );

    if (
      message.toLowerCase().includes("not currently live") ||
      message.toLowerCase().includes("not live")
    ) {
      return null;
    }

    console.error(
      `⚠️ Kick check failed for ${username}:`,
      message.slice(0, 500)
    );

    return null;
  }
}

/* =========================
   DOWNLOAD STREAM
========================= */

async function downloadStream(username, info, outputFile) {
  const url = `https://kick.com/${encodeURIComponent(username)}`;

  await youtubedl(url, {
    output: outputFile,
    format: "best",
    mergeOutputFormat: "mp4",
    noPart: true,
    noWarnings: true,
    noCheckCertificates: true,
    ffmpegLocation: ffmpegPath,
    addHeader: [
      "User-Agent: Mozilla/5.0"
    ]
  });
}

/* =========================
   SEND VIDEO
========================= */

async function downloadAndSend(job) {
  const {
    chatId,
    streamer,
    info,
    streamId
  } = job;

  const safeId = crypto
    .createHash("md5")
    .update(`${streamer}-${streamId}`)
    .digest("hex");

  const outputFile = path.join(
    DATA_DIR,
    `${safeId}.mp4`
  );

  console.log(
    `⬇️ Downloading @${streamer}`
  );

  await bot.sendMessage(
    chatId,
    [
      "⏬ جاري تنزيل البث...",
      "",
      `👤 ${info.uploader || streamer}`,
      `🎥 ${info.title || "بدون عنوان"}`
    ].join("\n")
  );

  await downloadStream(
    streamer,
    info,
    outputFile
  );

  if (!fs.existsSync(outputFile)) {
    throw new Error("ملف التنزيل غير موجود");
  }

  const stats = fs.statSync(outputFile);

  console.log(
    `📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`
  );

  const caption = [
    `🎥 ${info.title || "بدون عنوان"}`,
    "",
    `👤 ${info.uploader || streamer}`,
    `🎮 ${info.categories?.join(", ") || "Kick"}`,
    "",
    `🔗 https://kick.com/${streamer}`,
    "",
    "© Drex Downloader"
  ].join("\n");

  /*
   * Telegram Bot API الحالي يسمح للبوت برفع ملفات
   * حتى 50MB فقط عبر الرفع المباشر.
   */

  if (stats.size > 50 * 1024 * 1024) {
    await bot.sendMessage(
      chatId,
      [
        "⚠️ تم تنزيل البث، لكن حجمه أكبر من حد Telegram الحالي.",
        "",
        `📦 الحجم: ${(stats.size / 1024 / 1024).toFixed(2)} MB`,
        "",
        "لم يتم حذف الملف من النظام قبل انتهاء المهمة."
      ].join("\n")
    );

    throw new Error(
      "File exceeds Telegram 50MB upload limit"
    );
  }

  await bot.sendVideo(
    chatId,
    outputFile,
    {
      caption,
      supports_streaming: true
    }
  );

  downloaded[streamId] = {
    streamer,
    chatId,
    title: info.title || null,
    downloadedAt: new Date().toISOString()
  };

  saveJSON(DOWNLOADED_FILE, downloaded);

  console.log(
    `✅ Sent @${streamer} to ${chatId}`
  );

  try {
    fs.unlinkSync(outputFile);
  } catch {}
}

/* =========================
   LIVE MONITOR
========================= */

async function monitor() {
  if (streamers.length === 0) {
    return;
  }

  const channelList = Object.values(channels);

  if (channelList.length === 0) {
    console.log(
      "ℹ️ لا توجد قناة مسجلة حاليًا."
    );
    return;
  }

  for (const username of [...streamers]) {
    try {
      const info = await getStreamerInfo(username);

      if (!info || info.live_status !== "is_live") {
        continue;
      }

      const streamId =
        info.id ||
        `${username}-${info.timestamp || "live"}`;

      if (downloaded[streamId]) {
        continue;
      }

      console.log(
        `🟢 LIVE: @${username}`
      );

      for (const channel of channelList) {
        addToQueue({
          chatId: channel.id,
          streamer: username,
          info,
          streamId
        });
      }
    } catch (error) {
      console.error(
        `❌ Monitor ${username}:`,
        error.message
      );
    }
  }
}

/* =========================
   START MONITOR
========================= */

console.log("🤖 Drex Downloader Bot started.");
console.log(`👤 Streamers: ${streamers.length}`);
console.log(`📢 Channels: ${Object.keys(channels).length}`);

setInterval(monitor, 60 * 1000);

setTimeout(monitor, 10 * 1000);

/* =========================
   ERRORS
========================= */

bot.on("polling_error", (error) => {
  console.error(
    "❌ Telegram polling:",
    error.message
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    "❌ Uncaught Exception:",
    error
  );
});

process.on("unhandledRejection", (error) => {
  console.error(
    "❌ Unhandled Rejection:",
    error
  );
});