const mongoose = require("mongoose");

let connected = false;

async function connectDB() {
  if (connected) return;
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || "fixmerah",
    serverSelectionTimeoutMS: 8000,
  });
  connected = true;
  console.log("✅ MongoDB connected");
}

// ── SCHEMAS ────────────────────────────────────────────────────────────────────

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  telegram_id: { type: String, default: "" },
  role: { type: String, enum: ["free","premium","vip","owner","superowner"], default: "free" },
  status: { type: String, enum: ["active","inactive","blocked"], default: "active" },
  expiry: { type: Date, default: null },
  total_fix: { type: Number, default: 0 },
  daily_fix_count: { type: Number, default: 0 },
  daily_fix_date: { type: String, default: "" },
  coin_balance: { type: Number, default: 0, min: 0 },
  total_coins_earned: { type: Number, default: 0 },
  total_coins_spent: { type: Number, default: 0 },
  device_fingerprint: { type: String, default: null },
  registration_ip: { type: String, default: null },
  referred_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  blocked_reason: { type: String, default: null },
  blocked_at: { type: Date, default: null },
  notified_h1: { type: Boolean, default: false },
  notified_h3: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  created_by: { type: String, default: "system" },
  last_login: { type: Date, default: null },
});

const ReferralSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  invite_code: { type: String, unique: true },
  invited: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  confirmed_invited: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  invited_at: [{ type: Date }],
  total_invited: { type: Number, default: 0 },
  confirmed_count: { type: Number, default: 0 },
  bonus_checks: { type: Number, default: 0 },
  referred_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
});

const CoinTransactionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["earn","spend"], required: true },
  amount: { type: Number, required: true },
  reason: { type: String, required: true },
  ref_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ip_address: { type: String, default: null },
  device_fingerprint: { type: String, default: null },
  timestamp: { type: Date, default: Date.now },
  is_suspicious: { type: Boolean, default: false },
});

const MandatoryChannelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true },
  type: { type: String, enum: ["channel","group"], default: "channel" },
  url: { type: String, required: true },
  is_active: { type: Boolean, default: true },
  order_index: { type: Number, default: 0 },
  added_by: { type: String, default: "admin" },
  added_at: { type: Date, default: Date.now },
});

const GmailSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  app_password: { type: String, required: true },
  is_active: { type: Boolean, default: true },
  status: { type: String, default: "ok" },
  total_sent: { type: Number, default: 0 },
  last_used: { type: Date, default: null },
  added_by: { type: String, default: "admin" },
  imap_last_uid: { type: Number, default: 0 },
});

const TemplateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  to_email: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  is_active: { type: Boolean, default: false },
  order_index: { type: Number, default: 0 },
  created_by: { type: String, default: "admin" },
  created_at: { type: Date, default: Date.now },
});

const FixHistorySchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  username: String,
  nomor: String,
  nomor_normalized: String,
  template_id: { type: mongoose.Schema.Types.ObjectId, ref: "Template" },
  template_name: String,
  gmail_sender: String,
  status: { type: String, enum: ["sent","failed"], default: "sent" },
  tracking_id: String,
  batch_id: String,
  reply_detected: { type: Boolean, default: false },
  appeal_id: { type: String, default: null },
  timestamp_wib: String,
  error_message: { type: String, default: null },
  source: { type: String, default: "fix" },
});

const SettingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: mongoose.Schema.Types.Mixed,
  updated_by: { type: String, default: "system" },
  updated_at: { type: Date, default: Date.now },
});

const BroadcastSchema = new mongoose.Schema({
  target: { type: String, enum: ["all","premium","free"] },
  message: String,
  sent_count: { type: Number, default: 0 },
  failed_count: { type: Number, default: 0 },
  total_count: { type: Number, default: 0 },
  created_by: String,
  created_at: { type: Date, default: Date.now },
  status: { type: String, default: "done" },
});

// ── Models ─────────────────────────────────────────────────────────────────────
const User = mongoose.models.User || mongoose.model("User", UserSchema);
const Referral = mongoose.models.Referral || mongoose.model("Referral", ReferralSchema);
const CoinTransaction = mongoose.models.CoinTransaction || mongoose.model("CoinTransaction", CoinTransactionSchema);
const MandatoryChannel = mongoose.models.MandatoryChannel || mongoose.model("MandatoryChannel", MandatoryChannelSchema);
const Gmail = mongoose.models.Gmail || mongoose.model("Gmail", GmailSchema);
const Template = mongoose.models.Template || mongoose.model("Template", TemplateSchema);
const FixHistory = mongoose.models.FixHistory || mongoose.model("FixHistory", FixHistorySchema);
const Setting = mongoose.models.Setting || mongoose.model("Setting", SettingSchema);
const Broadcast = mongoose.models.Broadcast || mongoose.model("Broadcast", BroadcastSchema);

// ── Helpers ────────────────────────────────────────────────────────────────────
function wibNow() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function wibDateStr() {
  return new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
}

function genTrackingId() {
  const now = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const d = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  return `GABRIEL-${d}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

function genBatchId() {
  return `BATCH-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

function normalizeNomor(raw) {
  if (!raw) return "";
  let n = String(raw).replace(/[\s\-().+]/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  if (!n.startsWith("+")) n = "+" + n;
  return n;
}

async function getSetting(key, def = null) {
  try {
    const s = await Setting.findOne({ key });
    return s ? s.value : def;
  } catch { return def; }
}

async function setSetting(key, value, by = "system") {
  await Setting.updateOne(
    { key },
    { $set: { value, updated_by: by, updated_at: new Date() } },
    { upsert: true }
  );
}

async function initSettings() {
  const defaults = {
    bot_name: "Fix Merah",
    maintenance_mode: false,
    fix_cooldown_ms: 180000,
    free_daily_limit: 3,
    reset_hour_wib: 0,
    fix_gratis_open: true,
    referral_count_needed: 3,
    referral_bonus_fix: 2,
    api_url: "https://fix-merahv1.vercel.app",
    api_key: "beckk001",
    mandatory_join_enabled: false,
    bot_token: "8832683954:AAFg3516SCa0Wvy-LNWxuGjXXJ-hE7UJPaE",
    backup_chat_id: "7971988947",
  };
  for (const [k, v] of Object.entries(defaults)) {
    const ex = await Setting.findOne({ key: k });
    if (!ex) await setSetting(k, v);
  }
}

module.exports = {
  connectDB, User, Referral, CoinTransaction, MandatoryChannel,
  Gmail, Template, FixHistory, Setting, Broadcast,
  wibNow, wibDateStr, genTrackingId, genBatchId,
  normalizeNomor, getSetting, setSetting, initSettings,
};
