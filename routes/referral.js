const router = require("express").Router();
const { authMiddleware } = require("../middleware/auth");
const { Referral, User, getSetting } = require("../lib/db");

// GET /referral/my
router.get("/my", authMiddleware, async (req, res) => {
  try {
    let referral = await Referral.findOne({ user_id: req.user._id });
    if (!referral) {
      referral = await Referral.create({
        user_id: req.user._id,
        invite_code: `REF_${req.user._id}`,
        invited: [],
        total_invited: 0,
        bonus_checks: 0,
      });
    }
    const countNeeded = await getSetting("referral_count_needed", 3);
    const bonusFix = await getSetting("referral_bonus_fix", 2);
    return res.json({
      invite_code: referral.invite_code,
      invite_link: `https://t.me/BotFixMerah?start=${referral.invite_code}`,
      total_invited: referral.total_invited,
      bonus_checks: referral.bonus_checks,
      referral_count_needed: countNeeded,
      referral_bonus_fix: bonusFix,
      progress: referral.total_invited % countNeeded,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /referral/leaderboard
router.get("/leaderboard", authMiddleware, async (req, res) => {
  try {
    const top = await Referral.find({})
      .sort({ total_invited: -1 })
      .limit(10)
      .populate("user_id", "username");
    return res.json(top.map((r, i) => ({
      rank: i + 1,
      username: r.user_id?.username || "unknown",
      total_invited: r.total_invited,
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
