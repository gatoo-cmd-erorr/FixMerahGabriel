const router = require("express").Router();
const axios = require("axios");
const { authMiddleware } = require("../middleware/auth");
const {
  User, Gmail, Template, FixHistory, Referral,
  getSetting, wibNow, wibDateStr,
  genTrackingId, genBatchId, normalizeNomor
} = require("../lib/db");

// Cooldown store (in-memory, cukup untuk single instance)
const cooldownMap = {};

const ROLE_SLOTS = { free: 1, premium: 2, vip: 5, owner: 5, superowner: 5 };

// GET /fix/cooldown
router.get("/cooldown", authMiddleware, async (req, res) => {
  const uid = String(req.user._id);
  const cooldownMs = await getSetting("fix_cooldown_ms", 180000);
  const lastFix = cooldownMap[uid] || 0;
  const elapsed = Date.now() - lastFix;
  const remaining = Math.max(0, cooldownMs - elapsed);
  return res.json({ remaining_ms: remaining, cooldown_ms: cooldownMs });
});

// POST /fix/send
router.post("/send", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const maintenance = await getSetting("maintenance_mode", false);
    if (maintenance) return res.status(503).json({ message: "Bot sedang maintenance" });

    const { nomor, slots } = req.body;
    if (!nomor) return res.status(400).json({ message: "Nomor wajib diisi" });

    // Cek cooldown
    const cooldownMs = await getSetting("fix_cooldown_ms", 180000);
    const uid = String(user._id);
    const elapsed = Date.now() - (cooldownMap[uid] || 0);
    if (elapsed < cooldownMs) {
      const sisa = Math.ceil((cooldownMs - elapsed) / 1000);
      return res.status(429).json({ message: `Cooldown! Tunggu ${sisa} detik lagi` });
    }

    // Cek limit untuk FREE
    const isUnlimited = ["premium", "vip", "owner", "superowner"].includes(user.role);
    const freeLimit = await getSetting("free_daily_limit", 3);
    const fixGratis = await getSetting("fix_gratis_open", true);
    const todayWib = wibDateStr();

    if (user.daily_fix_date !== todayWib) {
      user.daily_fix_count = 0;
      user.daily_fix_date = todayWib;
    }

    if (!isUnlimited && !fixGratis && user.daily_fix_count >= freeLimit) {
      // Cek bonus referral
      const referral = await Referral.findOne({ user_id: user._id });
      if (!referral || referral.bonus_checks <= 0) {
        return res.status(429).json({ message: "Limit harian habis" });
      }
      referral.bonus_checks -= 1;
      await referral.save();
    }

    // Ambil slots
    const maxSlots = ROLE_SLOTS[user.role] || 1;
    const slotsArr = Array.isArray(slots) && slots.length > 0
      ? slots.slice(0, maxSlots)
      : [{ random: true }];

    if (slotsArr.length > maxSlots)
      return res.status(400).json({ message: `Role ${user.role} max ${maxSlots} slot` });

    // Ambil Gmail aktif
    const gmails = await Gmail.find({ is_active: true });
    if (!gmails.length) return res.status(500).json({ message: "Tidak ada Gmail aktif" });

    // Ambil semua template aktif
    const templates = await Template.find({});
    if (!templates.length) return res.status(500).json({ message: "Tidak ada template tersedia" });

    // Ambil API config
    const apiUrl = await getSetting("api_url", "");
    const apiKey = await getSetting("api_key", "");

    const batchId = slotsArr.length > 1 ? genBatchId() : null;
    const usedGmailIds = new Set();
    const usedTemplateIds = new Set();
    const results = [];
    const normNomor = normalizeNomor(nomor);

    for (let i = 0; i < slotsArr.length; i++) {
      // Pilih Gmail (round-robin, tidak repeat dalam 1 batch)
      let gmail;
      const available = gmails.filter(g => !usedGmailIds.has(String(g._id)));
      if (available.length > 0) {
        gmail = available[i % available.length];
      } else {
        gmail = gmails[i % gmails.length];
      }
      usedGmailIds.add(String(gmail._id));

      // Pilih template random (tidak repeat dalam 1 batch)
      let template;
      const availTpl = templates.filter(t => !usedTemplateIds.has(String(t._id)));
      const pool = availTpl.length > 0 ? availTpl : templates;
      template = pool[Math.floor(Math.random() * pool.length)];
      usedTemplateIds.add(String(template._id));

      // Replace {nomor}
      const finalSubject = template.subject.replace(/\{nomor\}/gi, nomor);
      const finalBody = template.body.replace(/\{nomor\}/gi, nomor);

      const trackingId = genTrackingId();
      let status = "sent";
      let errorMsg = null;

      // Kirim ke email API
      try {
        await axios.post(`${apiUrl}/api/send-email`, {
          to_email: template.to_email,
          subject: finalSubject,
          body: finalBody,
          nomor: normNomor,
          user_id: String(user._id),
          sender_email: gmail.email,
          sender_pass: gmail.app_password,
        }, {
          headers: { "x-api-key": apiKey },
          timeout: 25000,
        });

        // Update gmail stats
        gmail.total_sent += 1;
        gmail.last_used = new Date();
        await gmail.save();
      } catch (e) {
        status = "failed";
        errorMsg = e.response?.data?.error || e.message;
      }

      // Simpan history
      await FixHistory.create({
        user_id: user._id,
        username: user.username,
        nomor,
        nomor_normalized: normNomor,
        template_id: template._id,
        template_name: template.name,
        gmail_sender: gmail.email,
        status,
        tracking_id: trackingId,
        batch_id: batchId,
        timestamp_wib: wibNow(),
        error_message: errorMsg,
        source: slotsArr.length > 1 ? "mail_meteor" : "fix",
      });

      results.push({
        slot: i + 1,
        tracking_id: trackingId,
        gmail_sender: gmail.email,
        template_name: template.name,
        to_email: template.to_email,
        status,
        error: errorMsg,
      });
    }

    // Update user stats
    cooldownMap[uid] = Date.now();
    const sentCount = results.filter(r => r.status === "sent").length;
    if (!isUnlimited) {
      user.daily_fix_count += sentCount;
    }
    user.total_fix += sentCount;
    await user.save();

    return res.json({
      batch_id: batchId,
      nomor,
      results,
      total_sent: sentCount,
      total_failed: results.length - sentCount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: e.message });
  }
});

// GET /fix/history
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const filter = { user_id: req.user._id };
    if (status && status !== "all") filter.status = status;

    const limit = 10;
    const skip = (Number(page) - 1) * limit;
    const total = await FixHistory.countDocuments(filter);
    const items = await FixHistory.find(filter)
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit);

    return res.json({ items, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /fix/history/:id
router.get("/history/:id", authMiddleware, async (req, res) => {
  try {
    const item = await FixHistory.findOne({ _id: req.params.id, user_id: req.user._id });
    if (!item) return res.status(404).json({ message: "History tidak ditemukan" });
    return res.json(item);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
