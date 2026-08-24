const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("❌ BOT_TOKEN غير موجود");
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: true
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
