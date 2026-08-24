const TelegramBot = require("node-telegram-bot-api");
const http = require("http");

const token = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

if (!token) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: true
});

// سيرفر بسيط لـ Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Drex Downloader Bot is running!");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

console.log("🤖 Drex Downloader Bot is running...");

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🤖 أهلاً بك في Drex Downloader Bot\n\nالبوت يعمل بنجاح ✅"
  );
});

bot.on("polling_error", (error) => {
  console.error("❌ Telegram:", error.message);
});