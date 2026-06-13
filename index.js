require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");

const { connectDB, initSettings, User, getSetting } = require("./db");
const { sanitizeMiddleware, checkBlockedMiddleware, ipRateLimitMiddleware } = require("./security");
const { runExpiryCheck } = require("./monitoring");
const { triggerAutoBackup } = require("./backup");

const app = express();
app.set("trust proxy", 1);

// ── Security Middleware ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(ipRateLimitMiddleware(120)); // max 120 req/menit per IP
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-api-key","x-tg-init-data","x-device-fp"],
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(sanitizeMiddleware); // Anti NoSQL/SQL injection
app.use(checkBlockedMiddleware); // Blokir user yang di-block

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/auth",       require("./auth"));
app.use("/user",       require("./user"));
app.use("/fix",        require("./fix"));
app.use("/template",   require("./template"));
app.use("/gmail",      require("./gmail"));
app.use("/referral",   require("./referral"));
app.use("/mandatory",  require("./mandatory"));
app.use("/admin",      require("./admin"));
app.use("/backup",     require("./backup"));
app.use("/monitoring", require("./monitoring"));
app.use("/security",   require("./security"));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "fixmerah-backend",
    version: "3.0",
    timestamp: new Date().toISOString(),
    features: ["backup","monitoring","security","mandatory-join","coin-system"],
  });
});

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// ── Error handler ──────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(500).json({ message: "Internal server error" });
});

// ── Scheduler (setiap 1 jam) ───────────────────────────────────────────────────
function startScheduler() {
  // Cek expiry premium setiap 1 jam
  setInterval(async () => {
    try {
      await runExpiryCheck();
      console.log("⏰ Expiry check selesai:", new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }));
    } catch (e) {
      console.warn("Expiry check error:", e.message);
    }
  }, 60 * 60 * 1000); // 1 jam

  // Auto backup setiap 6 jam
  setInterval(async () => {
    await triggerAutoBackup("scheduled_6h");
  }, 6 * 60 * 60 * 1000);

  console.log("⏰ Scheduler aktif: expiry check (1 jam), backup (6 jam)");
}

// ── Start ──────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  await initSettings();

  // Seed SuperOwner
  const exists = await User.findOne({ role: "superowner" });
  if (!exists) {
    const hashed = await bcrypt.hash("FixMerah2024!", 12);
    await User.create({
      username: "superowner",
      password: hashed,
      role: "superowner",
      status: "active",
      telegram_id: "7971988947",
      created_by: "system",
    });
    console.log("✅ SuperOwner dibuat: superowner / FixMerah2024!");
  }

  startScheduler();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 FixMerah Backend v3.0 jalan di port ${PORT}`);
    console.log(`🔒 Security: sanitize + rate limit + auto block aktif`);
    console.log(`💾 Backup: auto ke Telegram setiap 6 jam`);
    console.log(`📊 Monitoring: expiry check setiap 1 jam`);
  });
}

start().catch(console.error);
