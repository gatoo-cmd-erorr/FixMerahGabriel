const router = require("express").Router();
const axios = require("axios");
const https = require("https");
const { authMiddleware } = require("./auth_middleware");
const {
  User, Gmail, Template, FixHistory, Referral, MandatoryChannel,
  getSetting, wibNow, wibDateStr,
  genTrackingId, genBatchId, normalizeNomor
} = require("./db");

const cooldownMap = {};
const ROLE_SLOTS = { free: 1, premium: 2, vip: 5, owner: 5, superowner: 5 };

// ── Mandatory Join Verify ─────────────────────────────────────────────────────
const verifyCache = new Map();
async function checkMandatoryJoin(telegramId) {
  const enabled = await getSetting("mandatory_join_enabled", false);
  if (!enabled || !telegramId) return { ok: true };

  const cached = verifyCache.get(`mj_${telegramId}`);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.data;

  const botToken = await getSetting("bot_token", "");
  if (!botToken) return { ok: true };

  const channels = await MandatoryChannel.find({ is_active: true });
  if (!channels.length) return { ok: true };

  const missing = [];
  for (const ch of channels) {
    const joined = await new Promise((resolve) => {
      const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(ch.username)}&user_id=${telegramId}`;
      https.get(url, (resp) => {
        let data = "";
        resp.on("data", c => data += c);
        resp.on("end", () => {
          try {
            const json = JSON.parse(data);
            const status = json.result?.status;
            resolve(["member","administrator","creator"].includes(status));
          } catch { resolve(false); }
        });
      }).on("error", () => resolve(false));
    });
    if (!joined) missing.push({ name: ch.name, url: ch.url });
  }

  const result = missing.length === 0
    ? { ok: true }
    : { ok: false, message: "mandatory_join_required", missing };

  verifyCache.set(`mj_${telegramId}`, { ts: Date.now(), data: result });
  return result;
}

// ── GET /fix/cooldown ─────────────────────────────────────────────────────────
router.get("/cooldown", authMiddleware, async (req, res) => {
  const uid = String(req.user._id);
  const cooldownMs = await getSetting("fix_cooldown_ms", 180000);
  const elapsed = Date.now() - (cooldownMap[uid] || 0);
  return res.json({ remaining_ms: Math.max(0, cooldownMs - elapsed), cooldown_ms: cooldownMs });
});

// ── POST /fix/send ────────────────────────────────────────────────────────────
router.post("/send", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const maintenance = await getSetting("maintenance_mode", false);
    if (maintenance) return res.status(503).json({ message: "Bot sedang maintenance" });

    const { nomor, slots } = req.body;
    if (!nomor) return res.status(400).json({ message: "Nomor wajib diisi" });

    // Cek mandatory join
    const mjCheck = await checkMandatoryJoin(user.telegram_id);
    if (!mjCheck.ok) return res.status(403).json(mjCheck);

    // Cek cooldown
    const cooldownMs = await getSetting("fix_cooldown_ms", 180000);
    const uid = String(user._id);
    const elapsed = Date.now() - (cooldownMap[uid] || 0);
    if (elapsed < cooldownMs) {
      const sisa = Math.ceil((cooldownMs - elapsed) / 1000);
      return res.status(429).json({ message: `Cooldown! Tunggu ${sisa} detik lagi` });
    }

    // Cek limit FREE
    const isUnlimited = ["premium","vip","owner","superowner"].includes(user.role);
    const freeLimit = await getSetting("free_daily_limit", 3);
    const fixGratis = await getSetting("fix_gratis_open", true);
    const todayWib = wibDateStr();

    if (user.daily_fix_date !== todayWib) {
      user.daily_fix_count = 0;
      user.daily_fix_date = todayWib;
    }

    if (!isUnlimited && !fixGratis && user.daily_fix_count >= freeLimit) {
      const referral = await Referral.findOne({ user_id: user._id });
      if (!referral || referral.bonus_checks <= 0)
        return res.status(429).json({ message: "Limit harian habis" });
      referral.bonus_checks -= 1;
      await referral.save();
    }

    const maxSlots = ROLE_SLOTS[user.role] || 1;
    const slotsArr = Array.isArray(slots) && slots.length > 0
      ? slots.slice(0, maxSlots)
      : [{ random: true }];

    const gmails = await Gmail.find({ is_active: true });
    if (!gmails.length) return res.status(500).json({ message: "Tidak ada Gmail aktif" });

    const templates = await Template.find({});
    if (!templates.length) return res.status(500).json({ message: "Tidak ada template tersedia" });

    const apiUrl = await getSetting("api_url", "");
    const apiKey = await getSetting("api_key", "");

    const batchId = slotsArr.length > 1 ? genBatchId() : null;
    const usedGmailIds = new Set();
    const usedTemplateIds = new Set();
    const results = [];
    const normNomor = normalizeNomor(nomor);

    for (let i = 0; i < slotsArr.length; i++) {
      const available = gmails.filter(g => !usedGmailIds.has(String(g._id)));
      const gmail = available.length > 0 ? available[i % available.length] : gmails[i % gmails.length];
      usedGmailIds.add(String(gmail._id));

      const availTpl = templates.filter(t => !usedTemplateIds.has(String(t._id)));
      const pool = availTpl.length > 0 ? availTpl : templates;
      const template = pool[Math.floor(Math.random() * pool.length)];
      usedTemplateIds.add(String(template._id));

      const finalSubject = template.subject.replace(/\{nomor\}/gi, nomor);
      const finalBody = template.body.replace(/\{nomor\}/gi, nomor);
      const trackingId = genTrackingId();
      let status = "sent";
      let errorMsg = null;

      try {
        await axios.post(`${apiUrl}/api/send-email`, {
          to_email: template.to_email,
          subject: finalSubject,
          body: finalBody,
          nomor: normNomor,
          user_id: String(user._id),
          sender_email: gmail.email,
          sender_pass: gmail.app_password,
        }, { headers: { "x-api-key": apiKey }, timeout: 25000 });

        gmail.total_sent += 1;
        gmail.last_used = new Date();
        await gmail.save();
      } catch (e) {
        status = "failed";
        // FIX: stringify object error agar tidak crash FixHistory validation
        const errData = e.response?.data || e.message;
        errorMsg = typeof errData === "object" ? JSON.stringify(errData) : String(errData);
      }

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
        error_message: errorMsg, // sudah string
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

    // Update stats
    cooldownMap[uid] = Date.now();
    const sentCount = results.filter(r => r.status === "sent").length;
    if (!isUnlimited) user.daily_fix_count += sentCount;
    user.total_fix += sentCount;
    await user.save();

    // Confirm referral activity (first fix)
    if (user.total_fix === sentCount && user.referred_by) {
      try {
        const { Referral: Ref } = require("./db");
        const refDoc = await Ref.findOne({ user_id: user.referred_by });
        if (refDoc && !refDoc.confirmed_invited?.map(String).includes(String(user._id))) {
          const { User: UserModel, CoinTransaction } = require("./db");
          await UserModel.findByIdAndUpdate(user.referred_by, {
            $inc: { coin_balance: 5, total_coins_earned: 5 }
          });
          await CoinTransaction.create({
            user_id: user.referred_by,
            type: "earn",
            amount: 5,
            reason: "referral_confirmed",
            ref_user_id: user._id,
            timestamp: new Date(),
          });
          await Ref.findByIdAndUpdate(refDoc._id, {
            $addToSet: { confirmed_invited: user._id },
            $inc: { confirmed_count: 1 },
          });
        }
      } catch (e) {
        console.warn("Referral confirm gagal:", e.message);
      }
    }

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

// ── GET /fix/history ──────────────────────────────────────────────────────────
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const filter = { user_id: req.user._id };
    if (status && status !== "all") filter.status = status;
    const limit = 10;
    const skip = (Number(page) - 1) * limit;
    const total = await FixHistory.countDocuments(filter);
    const items = await FixHistory.find(filter).sort({ _id: -1 }).skip(skip).limit(limit);
    return res.json({ items, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /fix/history/:id ──────────────────────────────────────────────────────
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
