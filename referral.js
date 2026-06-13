const router = require("express").Router();
const { authMiddleware } = require("./auth_middleware");
const {
  User, Referral, CoinTransaction, getSetting,
  wibNow
} = require("./db");

// ── Helper atomic coin update ─────────────────────────────────────────────────
async function addCoins(userId, amount, reason, meta = {}) {
  await User.findByIdAndUpdate(userId, {
    $inc: { coin_balance: amount, total_coins_earned: amount }
  });
  await CoinTransaction.create({
    user_id: userId,
    type: "earn",
    amount,
    reason,
    ...meta,
    timestamp: new Date(),
    is_suspicious: false,
  });
}

async function spendCoins(userId, amount, reason, meta = {}) {
  const user = await User.findById(userId);
  if (!user || user.coin_balance < amount)
    throw new Error("Koin tidak cukup");
  await User.findByIdAndUpdate(userId, {
    $inc: { coin_balance: -amount, total_coins_spent: amount }
  });
  await CoinTransaction.create({
    user_id: userId,
    type: "spend",
    amount,
    reason,
    ...meta,
    timestamp: new Date(),
    is_suspicious: false,
  });
}

// ── GET /referral/my ──────────────────────────────────────────────────────────
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    let referral = await Referral.findOne({ user_id: user._id });
    if (!referral) {
      referral = await Referral.create({
        user_id: user._id,
        invite_code: `REF_${user._id}`,
        invited: [],
        confirmed_invited: [],
        total_invited: 0,
        confirmed_count: 0,
        bonus_checks: 0,
      });
    }

    const transactions = await CoinTransaction.find({ user_id: user._id })
      .sort({ timestamp: -1 }).limit(5);

    return res.json({
      invite_code: referral.invite_code,
      invite_link: `https://t.me/BotFixMerah?start=${referral.invite_code}`,
      total_invited: referral.total_invited,
      confirmed_count: referral.confirmed_count || 0,
      coin_balance: user.coin_balance || 0,
      total_coins_earned: user.total_coins_earned || 0,
      total_coins_spent: user.total_coins_spent || 0,
      recent_transactions: transactions,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /referral/leaderboard ─────────────────────────────────────────────────
router.get("/leaderboard", authMiddleware, async (req, res) => {
  try {
    const top = await User.find({ total_coins_earned: { $gt: 0 } })
      .sort({ total_coins_earned: -1 })
      .limit(10)
      .select("username total_coins_earned coin_balance");
    return res.json(top.map((u, i) => ({
      rank: i + 1,
      username: u.username,
      total_coins_earned: u.total_coins_earned || 0,
      coin_balance: u.coin_balance || 0,
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── GET /referral/transactions ────────────────────────────────────────────────
router.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit = 20;
    const skip = (Number(page) - 1) * limit;
    const total = await CoinTransaction.countDocuments({ user_id: req.user._id });
    const txs = await CoinTransaction.find({ user_id: req.user._id })
      .sort({ timestamp: -1 }).skip(skip).limit(limit);
    return res.json({ transactions: txs, total, page: Number(page) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /referral/register ───────────────────────────────────────────────────
// Dipanggil saat user baru join via referral link
router.post("/register", async (req, res) => {
  try {
    const { referral_code, new_user_id, device_fingerprint, ip_address } = req.body;
    if (!referral_code || !new_user_id)
      return res.status(400).json({ message: "referral_code dan new_user_id wajib" });

    const referral = await Referral.findOne({ invite_code: referral_code });
    if (!referral) return res.status(404).json({ message: "Kode referral tidak valid" });

    const referrerId = String(referral.user_id);
    const newUserId = String(new_user_id);

    // Anti-cheat 1: self-referral
    if (referrerId === newUserId)
      return res.status(400).json({ message: "Tidak bisa pakai referral sendiri", suspicious: true });

    // Anti-cheat 2: sudah pernah diinvite
    if (referral.invited.map(String).includes(newUserId))
      return res.status(400).json({ message: "User sudah pernah diinvite" });

    // Anti-cheat 3: cek IP duplikat (max 3 akun per IP per 24 jam)
    if (ip_address) {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sameIpCount = await User.countDocuments({
        registration_ip: ip_address,
        created_at: { $gte: yesterday }
      });
      if (sameIpCount >= 3) {
        await CoinTransaction.create({
          user_id: referral.user_id,
          type: "earn",
          amount: 0,
          reason: "referral_blocked_ip",
          ref_user_id: new_user_id,
          ip_address,
          device_fingerprint,
          timestamp: new Date(),
          is_suspicious: true,
        });
        return res.status(400).json({ message: "Terlalu banyak akun dari IP ini", suspicious: true });
      }
    }

    // Anti-cheat 4: device fingerprint duplikat
    if (device_fingerprint) {
      const sameDevice = await User.findOne({ device_fingerprint });
      if (sameDevice && String(sameDevice._id) !== newUserId) {
        await CoinTransaction.create({
          user_id: referral.user_id,
          type: "earn",
          amount: 0,
          reason: "referral_blocked_device",
          ref_user_id: new_user_id,
          ip_address,
          device_fingerprint,
          timestamp: new Date(),
          is_suspicious: true,
        });
        return res.status(400).json({ message: "Device sudah terdaftar", suspicious: true });
      }
    }

    // Anti-cheat 5: rate limit max 10 referral per 24 jam
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentInvites = referral.invited_at?.filter(t => new Date(t) > yesterday).length || 0;
    if (recentInvites >= 10)
      return res.status(429).json({ message: "Terlalu banyak referral hari ini" });

    // Update device fingerprint dan IP di user baru
    await User.findByIdAndUpdate(new_user_id, {
      device_fingerprint,
      registration_ip: ip_address,
      referred_by: referral.user_id,
    });

    // Tambah ke list invited (belum confirmed, koin belum diberikan)
    await Referral.findByIdAndUpdate(referral._id, {
      $addToSet: { invited: new_user_id },
      $push: { invited_at: new Date() },
      $inc: { total_invited: 1 },
    });

    return res.json({ ok: true, message: "Referral tercatat, koin diberikan setelah fix pertama" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /referral/confirm-activity ──────────────────────────────────────────
// Dipanggil setelah referred user melakukan fix pertama
router.post("/confirm-activity", async (req, res) => {
  try {
    const { new_user_id } = req.body;
    if (!new_user_id) return res.status(400).json({ message: "new_user_id wajib" });

    const newUser = await User.findById(new_user_id);
    if (!newUser || !newUser.referred_by)
      return res.status(400).json({ message: "User tidak punya referrer" });

    // Cek apakah sudah pernah confirmed
    const referral = await Referral.findOne({ user_id: newUser.referred_by });
    if (!referral) return res.status(400).json({ message: "Referral tidak ditemukan" });

    if (referral.confirmed_invited?.map(String).includes(String(new_user_id)))
      return res.status(400).json({ message: "Sudah pernah dikonfirmasi" });

    // Berikan 5 koin ke referrer
    await addCoins(newUser.referred_by, 5, "referral_confirmed", {
      ref_user_id: new_user_id,
    });

    // Update referral doc
    await Referral.findByIdAndUpdate(referral._id, {
      $addToSet: { confirmed_invited: new_user_id },
      $inc: { confirmed_count: 1 },
    });

    return res.json({ ok: true, message: "+5 koin diberikan ke referrer" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /referral/redeem-fix ─────────────────────────────────────────────────
router.post("/redeem-fix", authMiddleware, async (req, res) => {
  try {
    const COST = 3;
    await spendCoins(req.user._id, COST, "redeem_fix");

    // Tambah bonus fix ke referral
    await Referral.updateOne(
      { user_id: req.user._id },
      { $inc: { bonus_checks: 1 } },
      { upsert: true }
    );

    const user = await User.findById(req.user._id).select("coin_balance");
    return res.json({ ok: true, message: "+1 bonus fix ditambahkan", coin_balance: user.coin_balance });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// ── POST /referral/buy-premium ────────────────────────────────────────────────
router.post("/buy-premium", authMiddleware, async (req, res) => {
  try {
    const PRICES = { 1: 5, 3: 12, 7: 20, 30: 50 };
    const { duration_days } = req.body;
    const days = Number(duration_days);

    if (!PRICES[days])
      return res.status(400).json({ message: "Durasi tidak valid. Pilih: 1, 3, 7, atau 30 hari" });

    const cost = PRICES[days];
    await spendCoins(req.user._id, cost, `buy_premium_${days}d`);

    // Set premium
    const expiry = new Date();
    const currentExpiry = req.user.expiry;
    if (currentExpiry && currentExpiry > new Date()) {
      expiry.setTime(currentExpiry.getTime());
    }
    expiry.setDate(expiry.getDate() + days);

    await User.findByIdAndUpdate(req.user._id, {
      role: "premium",
      expiry,
    });

    const user = await User.findById(req.user._id).select("coin_balance expiry role");
    return res.json({
      ok: true,
      message: `Premium ${days} hari aktif sampai ${expiry.toLocaleDateString("id-ID")}`,
      coin_balance: user.coin_balance,
      expiry: user.expiry,
      role: user.role,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

module.exports = router;
