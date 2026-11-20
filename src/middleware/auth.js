const jwt = require('jsonwebtoken');
const config = require('../config');

function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, config.jwt.secret);
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function superadminRequired(req, res, next) {
  if (req.admin?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Se requiere rol superadmin' });
  }
  next();
}

module.exports = { authRequired, superadminRequired };
