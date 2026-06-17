const jwt = require('jsonwebtoken');
require('dotenv').config();

/**
 * verifyToken — Extracts Bearer token from Authorization header.
 * Verifies with JWT_SECRET. Attaches decoded payload to req.user.
 * Returns 401 if no token, 403 if invalid.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role_id, role }
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

/**
 * verifyAdmin — Calls verifyToken first, then checks req.user.role === 'ADMIN'.
 * Returns 403 if not admin.
 */
function verifyAdmin(req, res, next) {
  verifyToken(req, res, () => {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { verifyToken, verifyAdmin };
