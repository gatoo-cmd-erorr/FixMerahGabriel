const router = require("express").Router();
const https = require("https");
const { authMiddleware, isOwner } = require("./auth_middleware");
const { MandatoryChannel, getSetting } = require("./db");

// ── Cache verifikasi (5 menit per user) ──────────────────────────────────────
const verifyCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 menit

function getCacheKey(telegramId) { return `verify_${telegramId}`; }

function getCache(telegramId) {
  const key = getCacheKey(telegramId);
  const cached = verifyCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > CACHE_TTL) {
    verifyCache.delete(key);
    return null;
  }
  return cached.data;
}

function setCache(telegramId, data) {
  verifyCache.set(getCacheKey(telegramId), { ts: Date.now(), data });
}

// ── Telegram API: getChatMember ───────────────────────────────────────────────
function checkTelegramMembership(botToken, chatId, userId) {
  return new Promise((resolve) => {
    const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
    https.get(url, (resp) => {
      let data = "";
      resp.on("data", (chunk) => (data += chunk));
      resp.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) return resolve(false);
          const status = json.result?.status;
          // member, administrator, creator = joined
          resolve(["member", "administrator", "creator"].includes(status));
        } catch {
          resolve(false);
        }
      });
    }).on("error", () => resolve(false));
  });
}

// ── GET /mandatory/list ───────────────────────────────────────────────────────
router.get("/list", async (req, res) => {
  try {
    const enabled = await getSetting("mandatory_join_enabled", false);
    if (!enabled) return res.json({ enabled: false, channels: [] });
    const channels = await MandatoryChannel.find({ is_active: true })
      .sort({ order_index: 1 })
      .select("name username type url order_index");
    return res.json({ enabled: true, channels });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /mandatory/verify ────────────────────────────────────────────────────
router.post("/verify", authMiddleware, async (req, res) => {
  try {
    const enabled = await getSetting("mandatory_join_enabled", false);
    if (!enabled) return res.json({ all_joined: true, missing: [] });

    const telegramId = req.body.telegram_id || req.user.telegram_id;
    if (!telegramId) return res.json({ all_joined: true, missing: [] });

    // Cek cache
    const cached = getCache(telegramId);
    if (cached) return res.json(cached);

    const botToken = await getSetting("bot_token", "");
    if (!botToken) return res.json({ all_joined: true, missing: [] });

    const channels = await MandatoryChannel.find({ is_active: true }).sort({ order_index: 1 });
    if (!channels.length) return res.json({ all_joined: true, missing: [] });

    const missing = [];
    for (const ch of channels) {
      const joined = await checkTelegramMembership(botToken, ch.username, telegramId);
      if (!joined) missing.push({
        _id: ch._id,
        name: ch.name,
        username: ch.username,
        url: ch.url,
        type: ch.type,
      });
    }

    const result = { all_joined: missing.length === 0, missing };
    setCache(telegramId, result);
    return res.json(result);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── ADMIN routes ──────────────────────────────────────────────────────────────

// GET /admin/mandatory/list
router.get("/admin/list", authMiddleware, isOwner, async (req, res) => {
  try {
    const channels = await MandatoryChannel.find({}).sort({ order_index: 1 });
    return res.json(channels);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /admin/mandatory/add
router.post("/admin/add", authMiddleware, isOwner, async (req, res) => {
  try {
    const count = await MandatoryChannel.countDocuments();
    if (count >= 10) return res.status(400).json({ message: "Maksimal 10 channel" });

    const { name, username, type, url } = req.body;
    if (!name || !username || !url)
      return res.status(400).json({ message: "name, username, url wajib" });

    const ch = await MandatoryChannel.create({
      name,
      username: username.startsWith("@") ? username : `@${username}`,
      type: type || "channel",
      url,
      is_active: true,
      order_index: count,
      added_by: req.user.username,
      added_at: new Date(),
    });

    // Clear semua cache saat ada perubahan channel
    verifyCache.clear();
    return res.json(ch);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /admin/mandatory/:id
router.delete("/admin/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    await MandatoryChannel.findByIdAndDelete(req.params.id);
    verifyCache.clear();
    return res.json({ message: "Channel dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /admin/mandatory/:id/toggle
router.put("/admin/:id/toggle", authMiddleware, isOwner, async (req, res) => {
  try {
    const ch = await MandatoryChannel.findById(req.params.id);
    if (!ch) return res.status(404).json({ message: "Channel tidak ditemukan" });
    ch.is_active = !ch.is_active;
    await ch.save();
    verifyCache.clear();
    return res.json(ch);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /admin/mandatory/reorder
router.put("/admin/reorder", authMiddleware, isOwner, async (req, res) => {
  try {
    const { order } = req.body; // array of { _id, order_index }
    for (const item of order) {
      await MandatoryChannel.findByIdAndUpdate(item._id, { order_index: item.order_index });
    }
    verifyCache.clear();
    return res.json({ message: "Urutan disimpan" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
