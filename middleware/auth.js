const jwt = require("jsonwebtoken");
const { User } = require("../lib/db");

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return res.status(401).json({ message: "Token tidak ada" });

  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");
    if (!user || user.status !== "active")
      return res.status(401).json({ message: "User tidak aktif" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "Token tidak valid" });
  }
}

function isOwner(req, res, next) {
  const r = req.user?.role;
  if (r === "owner" || r === "superowner") return next();
  return res.status(403).json({ message: "Akses ditolak" });
}

function isSuperOwner(req, res, next) {
  if (req.user?.role === "superowner") return next();
  return res.status(403).json({ message: "Akses ditolak - SuperOwner only" });
}

module.exports = { authMiddleware, isOwner, isSuperOwner };
