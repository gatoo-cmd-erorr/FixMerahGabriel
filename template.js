// routes/template.js
const router = require("express").Router();
const { authMiddleware } = require("./auth_middleware");
const { isOwner } = require("./auth_middleware");
const { Template } = require("./db");

// GET /template/random — 1 template acak (semua user)
router.get("/random", authMiddleware, async (req, res) => {
  try {
    const templates = await Template.find({});
    if (!templates.length) return res.status(404).json({ message: "Tidak ada template" });
    const t = templates[Math.floor(Math.random() * templates.length)];
    return res.json(t);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /template/list — owner only
router.get("/list", authMiddleware, isOwner, async (req, res) => {
  try {
    const templates = await Template.find({}).sort({ order_index: 1, _id: -1 });
    return res.json(templates);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /template/add
router.post("/add", authMiddleware, isOwner, async (req, res) => {
  try {
    const { name, to_email, subject, body, is_active } = req.body;
    if (!name || !to_email || !subject || !body)
      return res.status(400).json({ message: "Semua field wajib diisi" });
    if (is_active) await Template.updateMany({}, { $set: { is_active: false } });
    const t = await Template.create({
      name, to_email, subject, body,
      is_active: !!is_active,
      created_by: req.user.username,
    });
    return res.json(t);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /template/:id/set-active
router.post("/:id/set-active", authMiddleware, isOwner, async (req, res) => {
  try {
    await Template.updateMany({}, { $set: { is_active: false } });
    await Template.findByIdAndUpdate(req.params.id, { is_active: true });
    return res.json({ message: "Template diaktifkan" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /template/:id
router.put("/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    const t = await Template.findByIdAndUpdate(req.params.id, req.body, { new: true });
    return res.json(t);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE /template/:id
router.delete("/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    await Template.findByIdAndDelete(req.params.id);
    return res.json({ message: "Template dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
