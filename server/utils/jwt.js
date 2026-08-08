const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'insecure-dev-secret-change-me';

function signUser(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = { signUser, verifyToken };
