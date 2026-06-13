const router = require("express").Router();
const https = require("https");
const { authMiddleware, isOwner } = require("./auth_middleware");
const { User, FixHistory, getSetting, wibNow } = require("../db");

// ── Kirim pesan Telegram ──────────────────────────────────────────────────────
function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${botToken}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data || "{}")));
    });
    req.on("error", () => resolve({ ok: false }));
    req.write(body);
    req.end();
  });
}

// ── GET /monitoring/premium ───────────────────────────────────────────────────
router.get("/premium", authMiddleware, isOwner, async (req, res) => {
  try {
    const { role, status, page = 1 } = req.query;
    const filter = { role: { $in: ["premium", "vip", "owner", "superowner"] } };
    if (role && role !== "all") filter.role = role;

    const now = new Date();
    if (status === "active") filter.$or = [{ expiry: null }, { expiry: { $gt: now } }];
    if (status === "expired") filter.expiry = { $lte: now };
    if (status === "expiring_soon") {
      const h72 = new Date(now.getTime() + 72 * 60 * 60 * 1000);
      filter.expiry = { $gt: now, $lte: h72 };
    }

    const limit = 20;
    const skip = (Number(page) - 1) * limit;
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-password")
      .sort({ expiry: 1 })
      .skip(skip)
      .limit(limit);

    // Tambah info days_left per user
    const enriched = users.map((u) => {
      const obj = u.toObject();
      if (u.expiry) {
        const diff = u.expiry - now;
        obj.days_left = Math.ceil(diff / (1000 * 60 * 60 * 24));
        obj.expiry_status = diff <= 0 ? "expired" : diff <= 24 * 60 * 60 * 1000 ? "h1" : diff <= 72 * 60 * 60 * 1000 ? "h3" : "active";
      } else {
        obj.days_left = null;
        obj.expiry_status = "permanent";
      }
      return obj;
    });

    return res.json({ users: enriched, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /monitoring/stats ─────────────────────────────────────────────────────
router.get("/stats", authMiddleware, isOwner, async (req, res) => {
  try {
    const now = new Date();
    const h24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const h72 = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    const [
      totalPremium, totalVip, totalOwner,
      expiredCount, expiringH1, expiringH3,
      blockedCount,
    ] = await Promise.all([
      User.countDocuments({ role: "premium" }),
      User.countDocuments({ role: "vip" }),
      User.countDocuments({ role: "owner" }),
      User.countDocuments({ role: { $in: ["premium","vip"] }, expiry: { $lte: now } }),
      User.countDocuments({ role: { $in: ["premium","vip"] }, expiry: { $gt: now, $lte: h24 } }),
      User.countDocuments({ role: { $in: ["premium","vip"] }, expiry: { $gt: h24, $lte: h72 } }),
      User.countDocuments({ status: "blocked" }),
    ]);

    return res.json({
      total_premium: totalPremium,
      total_vip: totalVip,
      total_owner: totalOwner,
      expired: expiredCount,
      expiring_h1: expiringH1,
      expiring_h3: expiringH3,
      blocked_users: blockedCount,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /monitoring/check-expiry ─────────────────────────────────────────────
// Dipanggil oleh scheduler (setiap jam)
router.post("/check-expiry", authMiddleware, isOwner, async (req, res) => {
  try {
    await runExpiryCheck();
    return res.json({ ok: true, message: "Expiry check selesai", time: wibNow() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── Expiry check logic ────────────────────────────────────────────────────────
async function runExpiryCheck() {
  const botToken = await getSetting("bot_token", "");
  const ownerChatId = await getSetting("backup_chat_id", "7971988947");
  if (!botToken) return;

  const now = new Date();
  const h24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const h72 = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  // H-1 notif
  const expiringH1 = await User.find({
    role: { $in: ["premium", "vip"] },
    expiry: { $gt: now, $lte: h24 },
    notified_h1: { $ne: true },
  });

  for (const u of expiringH1) {
    const expStr = u.expiry.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });

    // Notif ke owner
    await sendTelegramMessage(botToken, ownerChatId,
      `⚠️ *Premium H-1 Expired!*\n👤 User: \`${u.username}\`\n💎 Role: ${u.role.toUpperCase()}\n📅 Expired: ${expStr}`
    );

    // Notif ke user (jika punya telegram_id)
    if (u.telegram_id) {
      await sendTelegramMessage(botToken, u.telegram_id,
        `⚠️ *Peringatan!* Premium kamu akan berakhir besok!\n📅 Expired: ${expStr}\n\nSegera perpanjang via menu Referral → Beli Premium 💎`
      );
    }

    await User.findByIdAndUpdate(u._id, { notified_h1: true });
  }

  // H-3 notif
  const expiringH3 = await User.find({
    role: { $in: ["premium", "vip"] },
    expiry: { $gt: h24, $lte: h72 },
    notified_h3: { $ne: true },
  });

  for (const u of expiringH3) {
    const expStr = u.expiry.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
    await sendTelegramMessage(botToken, ownerChatId,
      `📅 *Premium H-3 Expired*\n👤 User: \`${u.username}\`\n💎 Role: ${u.role.toUpperCase()}\n📅 Expired: ${expStr}`
    );
    if (u.telegram_id) {
      await sendTelegramMessage(botToken, u.telegram_id,
        `📅 Premium kamu akan berakhir dalam 3 hari!\n📅 Expired: ${expStr}\n\nPerpanjang sekarang via menu Referral 💎`
      );
    }
    await User.findByIdAndUpdate(u._id, { notified_h3: true });
  }

  // Auto downgrade yang sudah expired
  const expired = await User.find({
    role: { $in: ["premium", "vip"] },
    expiry: { $lte: now },
  });

  for (const u of expired) {
    await User.findByIdAndUpdate(u._id, { role: "free", expiry: null });
    await sendTelegramMessage(botToken, ownerChatId,
      `🔴 *Premium Expired & Downgraded*\n👤 User: \`${u.username}\`\nStatus: FREE`
    );
    if (u.telegram_id) {
      await sendTelegramMessage(botToken, u.telegram_id,
        `😢 Premium kamu sudah berakhir dan statusmu kembali ke FREE.\n\nPerpanjang via menu Referral! 💎`
      );
    }
  }
}

module.exports = router;
module.exports.runExpiryCheck = runExpiryCheck;
