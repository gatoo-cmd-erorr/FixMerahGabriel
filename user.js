const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { authMiddleware } = require("./auth_middleware");
const { User, FixHistory, Referral, getSetting, wibDateStr } = require("./db");

// GET /user/me
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    const referral = await Referral.findOne({ user_id: user._id });
    return res.json({
      ...user.toObject(),
      bonus_checks: referral?.bonus_checks || 0,
      total_invited: referral?.total_invited || 0,
      invite_code: referral?.invite_code || `REF_${user._id}`,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /user/home-stats
router.get("/home-stats", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const referral = await Referral.findOne({ user_id: user._id });

    const freeLimit = await getSetting("free_daily_limit", 3);
    const isUnlimited = ["premium", "vip", "owner", "superowner"].includes(user.role);

    // Reset daily jika beda hari
    const todayWib = wibDateStr();
    if (user.daily_fix_date !== todayWib) {
      user.daily_fix_count = 0;
      user.daily_fix_date = todayWib;
      await user.save();
    }

    const remaining = isUnlimited ? 999 : Math.max(0, freeLimit - user.daily_fix_count);

    // Fix bulan ini
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const monthFix = await FixHistory.countDocuments({
      user_id: user._id,
      status: "sent",
      _id: { $gte: require("mongoose").Types.ObjectId.createFromTime(startOfMonth.getTime() / 1000) }
    });

    return res.json({
      username: user.username,
      role: user.role,
      total_fix: user.total_fix,
      daily_used: user.daily_fix_count,
      daily_limit: isUnlimited ? null : freeLimit,
      remaining,
      is_unlimited: isUnlimited,
      bonus_checks: referral?.bonus_checks || 0,
      total_invited: referral?.total_invited || 0,
      month_fix: monthFix,
      status: user.status,
      reset_label: "00:00 WIB",
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /user/change-password
router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password)
      return res.status(400).json({ message: "Semua field wajib diisi" });
    if (new_password.length < 6)
      return res.status(400).json({ message: "Password minimal 6 karakter" });

    const user = await User.findById(req.user._id);
    const match = await bcrypt.compare(old_password, user.password);
    if (!match)
      return res.status(400).json({ message: "Password lama salah" });

    user.password = await bcrypt.hash(new_password, 12);
    await user.save();
    return res.json({ message: "Password berhasil diubah" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
