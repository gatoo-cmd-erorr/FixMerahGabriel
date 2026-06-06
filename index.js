require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { connectDB, initSettings, User } = require("./lib/db");
const bcrypt = require("bcryptjs");

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-tg-init-data"],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/auth", require("./routes/auth"));
app.use("/user", require("./routes/user"));
app.use("/fix", require("./routes/fix"));
app.use("/template", require("./routes/template"));
app.use("/gmail", require("./routes/gmail"));
app.use("/referral", require("./routes/referral"));
app.use("/admin", require("./routes/admin"));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixmerah-backend", timestamp: new Date().toISOString() });
});

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// ── Error handler ──────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

// ── Start ──────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  await initSettings();

  // Seed SuperOwner jika belum ada
  const exists = await User.findOne({ role: "superowner" });
  if (!exists) {
    const hashed = await bcrypt.hash("FixMerah2024!", 12);
    await User.create({
      username: "superowner",
      password: hashed,
      role: "superowner",
      status: "active",
      created_by: "system",
    });
    console.log("✅ SuperOwner dibuat: superowner / FixMerah2024!");
  }

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`🚀 Server jalan di port ${PORT}`));
}

start().catch(console.error);
