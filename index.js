require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");

// ── Smart require: coba root dulu, fallback ke subfolder ──────────────────────
function req(name) {
  const paths = [
    `./${name}`,
    `./routes/${name}`,
    `./lib/${name}`,
    `./middleware/${name}`,
  ];
  for (const p of paths) {
    try { return require(p); } catch(e) {
      if (!e.message.includes("Cannot find module")) throw e;
    }
  }
  throw new Error(`Module ${name} tidak ditemukan di semua path`);
}

const { connectDB, initSettings, User } = req("db");

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-api-key","x-tg-init-data","x-device-fp"],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",      req("auth"));
app.use("/user",      req("user"));
app.use("/fix",       req("fix"));
app.use("/template",  req("template"));
app.use("/gmail",     req("gmail"));
app.use("/referral",  req("referral"));
app.use("/mandatory", req("mandatory"));
app.use("/admin",     req("admin"));

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixmerah-backend", version: "2.0", timestamp: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  await initSettings();

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
    console.log("✅ SuperOwner dibuat");
  }

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`🚀 Server v2.0 jalan di port ${PORT}`));
}

start().catch(console.error);
