const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { authMiddleware, isOwner, isSuperOwner } = require("./auth_middleware");
const {
  User, Gmail, Template, FixHistory,
  Setting, Broadcast, Referral,
  getSetting, setSetting, wibNow
} = require("./db");

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

// GET /admin/dashboard
router.get("/dashboard", authMiddleware, isOwner, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const premiumUsers = await User.countDocuments({ role: { $in: ["premium", "vip"] } });
    const activeGmail = await Gmail.countDocuments({ is_active: true });
    const maintenance = await getSetting("maintenance_mode", false);

    // Fix hari ini
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayFix = await FixHistory.countDocuments({
      status: "sent",
      _id: { $gte: require("mongoose").Types.ObjectId.createFromTime(todayStart.getTime() / 1000) }
    });

    // Chart 7 hari
    const chart = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const dEnd = new Date(d);
      dEnd.setHours(23, 59, 59, 999);
      const count = await FixHistory.countDocuments({
        status: "sent",
        _id: {
          $gte: require("mongoose").Types.ObjectId.createFromTime(d.getTime() / 1000),
          $lte: require("mongoose").Types.ObjectId.createFromTime(dEnd.getTime() / 1000),
        }
      });
      chart.push({
        date: d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }),
        count,
      });
    }

    return res.json({
      total_users: totalUsers,
      premium_users: premiumUsers,
      today_fix: todayFix,
      active_gmail: activeGmail,
      maintenance_mode: maintenance,
      chart,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── USER MANAGEMENT ───────────────────────────────────────────────────────────

// GET /admin/users
router.get("/users", authMiddleware, isOwner, async (req, res) => {
  try {
    const { search, role, page = 1 } = req.query;
    const filter = {};
    if (search) filter.username = { $regex: search, $options: "i" };
    if (role && role !== "all") filter.role = role;

    const limit = 20;
    const skip = (Number(page) - 1) * limit;
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-password")
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit);

    return res.json({ users, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /admin/users/create
router.post("/users/create", authMiddleware, isOwner, async (req, res) => {
  try {
    const { username, password, role, telegram_id, expiry } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Username dan password wajib" });

    // SuperOwner tidak bisa dibuat oleh owner biasa
    if (role === "superowner" && req.user.role !== "superowner")
      return res.status(403).json({ message: "Hanya SuperOwner yang bisa buat SuperOwner" });

    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists) return res.status(400).json({ message: "Username sudah dipakai" });

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({
      username: username.toLowerCase(),
      password: hashed,
      role: role || "free",
      telegram_id: telegram_id || "",
      expiry: expiry ? new Date(expiry) : null,
      created_by: req.user.username,
    });

    // Buat referral doc
    await Referral.create({
      user_id: user._id,
      invite_code: `REF_${user._id}`,
      invited: [],
      total_invited: 0,
      bonus_checks: 0,
    });

    return res.json({ message: "User berhasil dibuat", user: { ...user.toObject(), password: undefined } });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /admin/users/:id
router.put("/users/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    const { role, status, expiry, password } = req.body;

    // Cegah hapus/edit SuperOwner oleh non-superowner
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "User tidak ditemukan" });
    if (target.role === "superowner" && req.user.role !== "superowner")
      return res.status(403).json({ message: "Tidak bisa edit SuperOwner" });

    const update = {};
    if (role) update.role = role;
    if (status) update.status = status;
    if (expiry !== undefined) update.expiry = expiry ? new Date(expiry) : null;
    if (password) update.password = await bcrypt.hash(password, 12);

    const updated = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-password");
    return res.json(updated);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /admin/users/:id
router.delete("/users/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "User tidak ditemukan" });
    if (target.role === "superowner")
      return res.status(403).json({ message: "SuperOwner tidak bisa dihapus" });
    await User.findByIdAndDelete(req.params.id);
    return res.json({ message: "User dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── PREMIUM MANAGEMENT ────────────────────────────────────────────────────────

// POST /admin/premium/add
router.post("/premium/add", authMiddleware, isOwner, async (req, res) => {
  try {
    const { user_id, duration_days } = req.body;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + (Number(duration_days) || 30));
    const user = await User.findByIdAndUpdate(
      user_id,
      { role: "premium", expiry },
      { new: true }
    ).select("-password");
    return res.json({ message: "Premium ditambahkan", user });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /admin/premium/:id
router.delete("/premium/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { role: "free", expiry: null });
    return res.json({ message: "Premium dicabut" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── OWNER MANAGEMENT (SuperOwner only) ───────────────────────────────────────

// POST /admin/owner/add
router.post("/owner/add", authMiddleware, isSuperOwner, async (req, res) => {
  try {
    const { user_id, expiry } = req.body;
    const user = await User.findByIdAndUpdate(
      user_id,
      { role: "owner", expiry: expiry ? new Date(expiry) : null },
      { new: true }
    ).select("-password");
    return res.json({ message: "Owner ditambahkan", user });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /admin/owner/:id
router.delete("/owner/:id", authMiddleware, isSuperOwner, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { role: "free", expiry: null });
    return res.json({ message: "Owner dicabut" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── BROADCAST ─────────────────────────────────────────────────────────────────

// POST /admin/broadcast
router.post("/broadcast", authMiddleware, isOwner, async (req, res) => {
  try {
    const { target, message } = req.body;
    if (!message) return res.status(400).json({ message: "Pesan wajib diisi" });

    const filter = {};
    if (target === "premium") filter.role = { $in: ["premium", "vip"] };
    else if (target === "free") filter.role = "free";

    const total = await User.countDocuments(filter);
    const bc = await Broadcast.create({
      target: target || "all",
      message,
      total_count: total,
      sent_count: total,
      failed_count: 0,
      created_by: req.user.username,
      status: "done",
    });

    return res.json({ message: "Broadcast terkirim", broadcast: bc });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /admin/broadcast/history
router.get("/broadcast/history", authMiddleware, isOwner, async (req, res) => {
  try {
    const history = await Broadcast.find({}).sort({ _id: -1 }).limit(20);
    return res.json(history);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────

// GET /admin/settings
router.get("/settings", authMiddleware, isOwner, async (req, res) => {
  try {
    const keys = [
      "bot_name", "maintenance_mode", "fix_cooldown_ms",
      "free_daily_limit", "reset_hour_wib", "fix_gratis_open",
      "referral_count_needed", "referral_bonus_fix", "api_url", "api_key"
    ];
    const result = {};
    for (const k of keys) result[k] = await getSetting(k);
    return res.json(result);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /admin/settings
router.post("/settings", authMiddleware, isOwner, async (req, res) => {
  try {
    const allowed = [
      "bot_name", "maintenance_mode", "fix_cooldown_ms",
      "free_daily_limit", "reset_hour_wib", "fix_gratis_open",
      "referral_count_needed", "referral_bonus_fix", "api_url", "api_key"
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        await setSetting(k, req.body[k], req.user.username);
      }
    }
    return res.json({ message: "Settings disimpan" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /admin/settings/test-api
router.post("/settings/test-api", authMiddleware, isOwner, async (req, res) => {
  try {
    const axios = require("axios");
    const apiUrl = await getSetting("api_url", "");
    const apiKey = await getSetting("api_key", "");
    const resp = await axios.get(`${apiUrl}/api/health?api_key=${apiKey}`, { timeout: 10000 });
    return res.json({ ok: true, data: resp.data });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
