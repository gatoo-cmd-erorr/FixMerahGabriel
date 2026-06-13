const router = require("express").Router();
const https = require("https");
const { authMiddleware, isOwner } = require("./auth_middleware");
const {
  User, Referral, Gmail, Template, FixHistory,
  Setting, Broadcast, CoinTransaction, MandatoryChannel,
  getSetting, wibNow
} = require("../db");

// ── Kirim file ZIP ke Telegram ─────────────────────────────────────────────────
async function sendBackupToTelegram(botToken, chatId, zipBuffer, filename, caption) {
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Math.random().toString(16).slice(2);
    const CRLF = "\r\n";

    let body = Buffer.alloc(0);

    // caption field
    const captionField =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}` +
      `${caption}${CRLF}`;
    body = Buffer.concat([body, Buffer.from(captionField)]);

    // document field
    const docHeader =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}` +
      `Content-Type: application/zip${CRLF}${CRLF}`;
    body = Buffer.concat([body, Buffer.from(docHeader), zipBuffer, Buffer.from(CRLF)]);

    // closing boundary
    body = Buffer.concat([body, Buffer.from(`--${boundary}--${CRLF}`)]);

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${botToken}/sendDocument?chat_id=${chatId}`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch { resolve({ ok: false }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Buat ZIP dari semua collection ────────────────────────────────────────────
async function createBackupZip() {
  const archiver = require("archiver");
  const { PassThrough } = require("stream");

  const collections = {
    users: await User.find({}).select("-password").lean(),
    referrals: await Referral.find({}).lean(),
    gmails: await Gmail.find({}).select("-app_password").lean(),
    templates: await Template.find({}).lean(),
    fix_history: await FixHistory.find({}).sort({ _id: -1 }).limit(1000).lean(),
    settings: await Setting.find({}).lean(),
    coin_transactions: await CoinTransaction.find({}).sort({ _id: -1 }).limit(500).lean(),
    mandatory_channels: await MandatoryChannel.find({}).lean(),
  };

  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    for (const [name, data] of Object.entries(collections)) {
      archive.append(JSON.stringify(data, null, 2), { name: `${name}.json` });
    }

    archive.finalize();
  });
}

// ── Trigger backup (internal, dipanggil dari fix/register) ────────────────────
let lastBackupTime = 0;
const BACKUP_COOLDOWN = 60 * 1000; // max 1x per menit

async function triggerAutoBackup(reason = "auto") {
  if (Date.now() - lastBackupTime < BACKUP_COOLDOWN) return;
  lastBackupTime = Date.now();

  try {
    const botToken = await getSetting("bot_token", "");
    const ownerChatId = await getSetting("backup_chat_id", "7971988947");
    if (!botToken || !ownerChatId) return;

    const zipBuffer = await createBackupZip();
    const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const filename = `fixmerah_backup_${Date.now()}.zip`;
    const caption = `🗄️ *Auto Backup Fix Merah*\n📅 ${now}\n📌 Trigger: ${reason}\n📦 Size: ${(zipBuffer.length / 1024).toFixed(1)} KB`;

    await sendBackupToTelegram(botToken, ownerChatId, zipBuffer, filename, caption);
  } catch (e) {
    console.warn("Auto backup gagal:", e.message);
  }
}

// ── POST /backup/manual ───────────────────────────────────────────────────────
router.post("/manual", authMiddleware, isOwner, async (req, res) => {
  try {
    const botToken = await getSetting("bot_token", "");
    const ownerChatId = await getSetting("backup_chat_id", "7971988947");

    const zipBuffer = await createBackupZip();
    const filename = `fixmerah_backup_manual_${Date.now()}.zip`;
    const now = wibNow();
    const caption = `🗄️ *Manual Backup Fix Merah*\n📅 ${now}\n👤 By: ${req.user.username}\n📦 Size: ${(zipBuffer.length / 1024).toFixed(1)} KB`;

    if (botToken && ownerChatId) {
      await sendBackupToTelegram(botToken, ownerChatId, zipBuffer, filename, caption);
    }

    // Juga return file sebagai download
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /backup/status ────────────────────────────────────────────────────────
router.get("/status", authMiddleware, isOwner, async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const fixCount = await FixHistory.countDocuments();
    const lastBackup = lastBackupTime
      ? new Date(lastBackupTime).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
      : "Belum pernah";

    return res.json({
      last_backup: lastBackup,
      total_users: userCount,
      total_fix_history: fixCount,
      backup_chat_id: await getSetting("backup_chat_id", "7971988947"),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
module.exports.triggerAutoBackup = triggerAutoBackup;
