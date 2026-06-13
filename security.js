// security.js — Anti-cheat, rate limit, auto block, input sanitize

const { User, CoinTransaction, FixHistory, getSetting } = require("./db");

// ── In-memory rate limit store ────────────────────────────────────────────────
const rateLimitStore = new Map();
const suspiciousStore = new Map();

// ── Sanitize input (anti SQL injection / NoSQL injection) ─────────────────────
function sanitizeInput(obj) {
  if (typeof obj === "string") {
    // Hapus karakter berbahaya
    return obj
      .replace(/[<>]/g, "") // XSS basic
      .replace(/\$where/gi, "") // NoSQL injection
      .replace(/\$ne|\$gt|\$lt|\$gte|\$lte|\$in|\$nin|\$or|\$and|\$not|\$nor/gi, "") // MongoDB operators
      .trim()
      .slice(0, 2000); // max length
  }
  if (Array.isArray(obj)) return obj.map(sanitizeInput);
  if (obj !== null && typeof obj === "object") {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      // Blokir key yang dimulai dengan $
      if (typeof k === "string" && k.startsWith("$")) continue;
      clean[k] = sanitizeInput(v);
    }
    return clean;
  }
  return obj;
}

// ── Middleware: sanitize semua request body ───────────────────────────────────
function sanitizeMiddleware(req, res, next) {
  if (req.body) req.body = sanitizeInput(req.body);
  if (req.query) req.query = sanitizeInput(req.query);
  if (req.params) req.params = sanitizeInput(req.params);
  next();
}

// ── Rate limit per user ───────────────────────────────────────────────────────
function rateLimitUser(userId, action, maxPerWindow, windowMs) {
  const key = `${userId}_${action}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  rateLimitStore.set(key, entry);

  if (entry.count > maxPerWindow) {
    return { blocked: true, resetIn: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { blocked: false };
}

// ── Cek aktivitas mencurigakan ────────────────────────────────────────────────
async function detectSuspiciousActivity(userId, action, metadata = {}) {
  const now = Date.now();
  const key = `${userId}_suspicious`;
  const entry = suspiciousStore.get(key) || { score: 0, lastAction: 0, actions: [] };

  let score = 0;
  const reasons = [];

  // 1. Fix terlalu cepat (bypass cooldown)
  if (action === "fix") {
    const cooldownMs = await getSetting("fix_cooldown_ms", 180000);
    const timeSinceLast = now - (entry.lastFixTime || 0);
    if (timeSinceLast < cooldownMs * 0.5) {
      score += 30;
      reasons.push("fix_too_fast");
    }
    entry.lastFixTime = now;
  }

  // 2. Terlalu banyak request dalam waktu singkat
  if (action === "fix") {
    const recentFixes = await FixHistory.countDocuments({
      user_id: userId,
      _id: { $gte: require("mongoose").Types.ObjectId.createFromTime((now - 60000) / 1000) }
    });
    if (recentFixes > 5) {
      score += 40;
      reasons.push("too_many_fix_per_minute");
    }
  }

  // 3. Device fingerprint berubah terlalu sering
  if (metadata.device_fingerprint) {
    const user = await User.findById(userId).select("device_fingerprint");
    if (user?.device_fingerprint && user.device_fingerprint !== metadata.device_fingerprint) {
      score += 20;
      reasons.push("device_fingerprint_changed");
    }
  }

  // 4. IP berubah terlalu sering
  if (metadata.ip_address) {
    entry.ips = entry.ips || new Set();
    entry.ips.add(metadata.ip_address);
    if (entry.ips.size > 5) {
      score += 25;
      reasons.push("multiple_ips");
    }
  }

  entry.score = (entry.score || 0) + score;
  entry.lastAction = now;
  suspiciousStore.set(key, entry);

  // Auto blokir jika score terlalu tinggi
  if (entry.score >= 80) {
    await User.findByIdAndUpdate(userId, {
      status: "blocked",
      blocked_reason: reasons.join(", "),
      blocked_at: new Date(),
    });

    // Log ke CoinTransaction sebagai suspicious record
    await CoinTransaction.create({
      user_id: userId,
      type: "earn",
      amount: 0,
      reason: "auto_blocked",
      ip_address: metadata.ip_address,
      device_fingerprint: metadata.device_fingerprint,
      timestamp: new Date(),
      is_suspicious: true,
    }).catch(() => {});

    // Notif ke owner via Telegram
    try {
      const botToken = await getSetting("bot_token", "");
      const ownerChatId = await getSetting("backup_chat_id", "7971988947");
      if (botToken && ownerChatId) {
        const https = require("https");
        const msg = `🚨 *AUTO BLOCK!*\n👤 User ID: \`${userId}\`\n⚠️ Alasan: ${reasons.join(", ")}\n🔢 Score: ${entry.score}\n📅 ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`;
        const body = JSON.stringify({ chat_id: ownerChatId, text: msg, parse_mode: "Markdown" });
        const options = {
          hostname: "api.telegram.org",
          path: `/bot${botToken}/sendMessage`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": body.length },
        };
        const req = https.request(options);
        req.write(body);
        req.end();
      }
    } catch {}

    return { suspicious: true, blocked: true, score: entry.score, reasons };
  }

  return { suspicious: score > 0, blocked: false, score: entry.score, reasons };
}

// ── Middleware: cek user tidak diblokir ───────────────────────────────────────
async function checkBlockedMiddleware(req, res, next) {
  if (!req.user) return next();
  if (req.user.status === "blocked") {
    return res.status(403).json({
      message: "Akun kamu diblokir karena aktivitas mencurigakan. Hubungi owner.",
      blocked: true,
    });
  }
  next();
}

// ── Middleware: rate limit global per IP ──────────────────────────────────────
const ipStore = new Map();
function ipRateLimitMiddleware(maxPerMin = 60) {
  return (req, res, next) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const now = Date.now();
    const entry = ipStore.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
    entry.count++;
    ipStore.set(ip, entry);
    if (entry.count > maxPerMin) {
      return res.status(429).json({ message: "Terlalu banyak request. Coba lagi nanti." });
    }
    next();
  };
}

// ── GET /security/blocked-users ───────────────────────────────────────────────
const router = require("express").Router();
const { authMiddleware, isOwner } = require("./auth_middleware");

router.get("/blocked-users", authMiddleware, isOwner, async (req, res) => {
  try {
    const blocked = await User.find({ status: "blocked" })
      .select("-password")
      .sort({ blocked_at: -1 });
    return res.json(blocked);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post("/unblock/:id", authMiddleware, isOwner, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, {
      status: "active",
      blocked_reason: null,
      blocked_at: null,
    });
    // Reset suspicious score
    suspiciousStore.delete(`${req.params.id}_suspicious`);
    return res.json({ message: "User di-unblock" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get("/suspicious-log", authMiddleware, isOwner, async (req, res) => {
  try {
    const logs = await CoinTransaction.find({ is_suspicious: true })
      .sort({ timestamp: -1 })
      .limit(50)
      .populate("user_id", "username role status");
    return res.json(logs);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
module.exports.sanitizeMiddleware = sanitizeMiddleware;
module.exports.checkBlockedMiddleware = checkBlockedMiddleware;
module.exports.ipRateLimitMiddleware = ipRateLimitMiddleware;
module.exports.detectSuspiciousActivity = detectSuspiciousActivity;
module.exports.rateLimitUser = rateLimitUser;
