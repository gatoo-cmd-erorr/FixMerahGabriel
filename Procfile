const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { User } = require("../lib/db");

const loginLimit = rateLimit({ windowMs: 60000, max: 10, message: { message: "Terlalu banyak percobaan login" } });

// POST /auth/login
router.post("/login", loginLimit, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ message: "Username dan password wajib diisi" });

    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user)
      return res.status(401).json({ message: "Username atau password salah" });

    if (user.status !== "active")
      return res.status(401).json({ message: "Akun tidak aktif" });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ message: "Username atau password salah" });

    // Update last login
    user.last_login = new Date();
    await user.save();

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "30m" }
    );

    return res.json({
      token,
      user: {
        _id: user._id,
        username: user.username,
        telegram_id: user.telegram_id,
        role: user.role,
        status: user.status,
        expiry: user.expiry,
        total_fix: user.total_fix,
        created_at: user.created_at,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
