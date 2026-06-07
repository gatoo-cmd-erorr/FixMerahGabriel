const router = require("express").Router();
const nodemailer = require("nodemailer");
const { authMiddleware, isOwner } = require("../middleware/auth");
const { Gmail } = require("../lib/db");

// GET /gmail/list
router.get("/list", authMiddleware, isOwner, async (req, res) => {
  try {
    const list = await Gmail.find({}).sort({ _id: -1 });
    return res.json(list);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /gmail/add
router.post("/add", authMiddleware, isOwner, async (req, res) => {
  try {
    const { email, app_password } = req.body;
    if (!email || !app_password)
      return res.status(400).json({ message: "Email dan app password wajib" });
    const exists = await Gmail.findOne({ email });
    if (exists) return res.status(400).json({ message: "Email sudah terdaftar" });
    const g = await Gmail.create({ email, app_password, added_by: req.user.username });
    return res.json(g);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /gmail/:id
router.delete("/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    await Gmail.findByIdAndDelete(req.params.id);
    return res.json({ message: "Gmail dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /gmail/:id/health — test SMTP
router.get("/:id/health", authMiddleware, isOwner, async (req, res) => {
  try {
    const g = await Gmail.findById(req.params.id);
    if (!g) return res.status(404).json({ message: "Gmail tidak ditemukan" });

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: g.email, pass: g.app_password },
      tls: { rejectUnauthorized: false },
    });

    try {
      await transporter.verify();
      g.status = "ok";
      await g.save();
      return res.json({ ok: true, message: "SMTP OK ✅", email: g.email });
    } catch (e) {
      g.status = "error";
      await g.save();
      return res.json({ ok: false, message: `SMTP Error: ${e.message}`, email: g.email });
    }
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
