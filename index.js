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

  res.end("Drex Downloader Bot is running ✅");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Render server running on port ${PORT}`);
});

// =========================
// DATA
// =========================

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

// =========================
// QUEUE
// =========================

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
        `❌ حدث خطأ أثناء تنزيل بث @${job.streamer}`
      );
    } catch {}
  }

  downloading = false;

  setTimeout(processQueue, 1000);
}

// =========================
// START
// =========================

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
      "⚙️ لا يحتاج CHANNEL_ID.",
      "",
      "➕ إضافة حساب:",
      "/add username",
      "",
      "➕ إضافة عدة حسابات:",
      "/add user1 user2 user3",
      "",
      "📋 عرض الحسابات:",
      "/list",
      "",
      "➖ حذف حساب:",
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

      saveJSON(CHANNELS_FILE, channels);

      console.log(
        `📢 Channel detected: ${chat.title} (${chat.id})`
      );
    }
  } catch (error) {
    console.error("❌ Channel detection:", error.message);
  }
});

// =========================
// BOT ADDED TO CHANNEL
// =========================

bot.on("my_chat_member", async (update) => {
  try {
    const chat = update.chat;
    const newStatus = update.new_chat_member?.status;

    if (!chat) return;

    if (
      chat.type === "channel" &&
      (
        newStatus === "administrator" ||
        newStatus === "member"
      )
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
        `✅ Channel registered: ${chat.title}`
      );
    }

    if (
      chat.type === "channel" &&
      (
        newStatus === "left" ||
        newStatus === "kicked"
      )
    ) {
      delete channels[String(chat.id)];

      saveJSON(CHANNELS_FILE, channels);

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
// ADD MULTIPLE STREAMERS
// =========================

bot.onText(/^\/add\s+(.+)$/i, async (msg, match) => {
  const usernames = match[1]
    .split(/[,\s]+/)
    .map(username =>
      username
        .trim()
        .replace(/^@/, "")
        .replace(
          /^https?:\/\/(www\.)?kick\.com\//i,
          ""
        )
        .split(/[/?#]/)[0]
    )
    .filter(Boolean);

  if (usernames.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ اكتب حسابات Kick بعد /add"
    );
  }

  const added = [];
  const already = [];
  const invalid = [];

  for (const username of usernames) {
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      invalid.push(username);
      continue;
    }

    if (streamers.includes(username)) {
      already.push(`@${username}`);
    } else {
      streamers.push(username);
      added.push(`@${username}`);
    }
  }

  saveJSON(STREAMERS_FILE, streamers);

  let text = "📋 نتيجة الإضافة:\n\n";

  if (added.length > 0) {
    text += `✅ تمت إضافة ${added.length} حساب:\n`;
    text += added.join("\n");
  }

  if (already.length > 0) {
    text += `\n\nℹ️ موجودة مسبقًا:\n`;
    text += already.join("\n");
  }

  if (invalid.length > 0) {
    text += `\n\n⚠️ غير صالحة:\n`;
    text += invalid.join("\n");
  }

  await bot.sendMessage(msg.chat.id, text);
});

// =========================
// REMOVE STREAMER
// =========================

bot.onText(/^\/remove\s+(.+)$/i, async (msg, match) => {
  const usernames = match[1]
    .split(/[,\s]+/)
    .map(username =>
      username.trim().replace(/^@/, "")
    )
    .filter(Boolean);

  const removed = [];
  const notFound = [];

  for (const username of usernames) {
    const index = streamers.indexOf(username);

    if (index === -1) {
      notFound.push(`@${username}`);
    } else {
      streamers.splice(index, 1);
      removed.push(`@${username}`);
    }
  }

  saveJSON(STREAMERS_FILE, streamers);

  let text = "📋 نتيجة الحذف:\n\n";

  if (removed.length > 0) {
    text += "✅ تم حذف:\n";
    text += removed.join("\n");
  }

  if (notFound.length > 0) {
    text += "\n\n❌ غير موجود:\n";
    text += notFound.join("\n");
  }

  await bot.sendMessage(msg.chat.id, text);
});

// =========================
// LIST
// =========================

bot.onText(/^\/list$/, async (msg) => {
  if (streamers.length === 0) {
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
    `📋 الحسابات المراقبة:\n\n${text}\n\n📊 العدد: ${streamers.length}`
  );
});

// =========================
// KICK INFO
// =========================

async function getStreamerInfo(username) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

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
      message
        .toLowerCase()
        .includes("not currently live")
    ) {
      return null;
    }

    if (
      message
        .toLowerCase()
        .includes("not live")
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

// =========================
// DOWNLOAD
// =========================

async function downloadStream(
  username,
  outputFile
) {
  const url =
    `https://kick.com/${encodeURIComponent(username)}`;

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

// =========================
// DOWNLOAD + SEND
// =========================

async function downloadAndSend(job) {
  const {
    chatId,
    streamer,
    info,
    streamId
  } = job;

  const safeId = crypto
    .createHash("md5")
    .update(
      `${streamer}-${streamId}`
    )
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
      `👤 @${streamer}`,
      `🎥 ${info.title || "بدون عنوان"}`
    ].join("\n")
  );

  await downloadStream(
    streamer,
    outputFile
  );

  if (!fs.existsSync(outputFile)) {
    throw new Error(
      "ملف التنزيل غير موجود"
    );
  }

  const stats = fs.statSync(
    outputFile
  );

  const sizeMB =
    stats.size / 1024 / 1024;

  console.log(
    `📦 File size: ${sizeMB.toFixed(2)} MB`
  );

  if (
    stats.size >
    50 * 1024 * 1024
  ) {
    await bot.sendMessage(
      chatId,
      [
        "⚠️ تم تنزيل البث.",
        "",
        `📦 الحجم: ${sizeMB.toFixed(2)} MB`,
        "",
        "لكن حجم الملف أكبر من الحد المسموح به للرفع."
      ].join("\n")
    );

    try {
      fs.unlinkSync(outputFile);
    } catch {}

    throw new Error(
      "File exceeds Telegram upload limit"
    );
  }

  const caption = [
    `🎥 ${info.title || "بدون عنوان"}`,
    "",
    `👤 @${streamer}`,
    `🎮 ${info.categories?.join(", ") || "Kick"}`,
    "",
    `🔗 https://kick.com/${streamer}`,
    "",
    "© Drex Downloader"
  ].join("\n");

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
    downloadedAt:
      new Date().toISOString()
  };

  saveJSON(
    DOWNLOADED_FILE,
    downloaded
  );

  console.log(
    `✅ Sent @${streamer} to ${chatId}`
  );

  try {
    fs.unlinkSync(outputFile);
  } catch {}
}

// =========================
// MONITOR
// =========================

async function monitor() {
  if (streamers.length === 0) {
    return;
  }

  const channelList =
    Object.values(channels);

  if (channelList.length === 0) {
    console.log(
      "ℹ️ لا توجد قناة مسجلة."
    );

    return;
  }

  for (
    const username
    of [...streamers]
  ) {
    try {
      const info =
        await getStreamerInfo(
          username
        );

      if (!info) {
        continue;
      }

      if (
        info.live_status &&
        info.live_status !== "is_live"
      ) {
        continue;
      }

      const streamId =
        info.id ||
        info.display_id ||
        `${username}-${info.timestamp || "live"}`;

      if (
        downloaded[streamId]
      ) {
        continue;
      }

      console.log(
        `🟢 LIVE: @${username}`
      );

      for (
        const channel
        of channelList
      ) {
        const alreadyQueued =
          queue.some(
            job =>
              job.chatId === channel.id &&
              job.streamId === streamId
          );

        if (!alreadyQueued) {
          addToQueue({
            chatId: channel.id,
            streamer: username,
            info,
            streamId
          });
        }
      }
    } catch (error) {
      console.error(
        `❌ Monitor @${username}:`,
        error.message
      );
    }
  }
}

// =========================
// START
// =========================

console.log(
  "🤖 Drex Downloader Bot started."
);

console.log(
  `👤 Streamers: ${streamers.length}`
);

console.log(
  `📢 Channels: ${Object.keys(channels).length}`
);

setInterval(
  monitor,
  60 * 1000
);

setTimeout(
  monitor,
  10 * 1000
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