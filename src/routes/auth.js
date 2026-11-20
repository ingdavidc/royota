/**
 * src/routes/auth.js — Login y gestión de credenciales admin
 */
'use strict';

const { Router } = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const config     = require('../config');
const { getDb }  = require('../database');
const { authRequired } = require('../middleware/auth');

const router = Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());

  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }

  if (!admin.is_active) {
    return res.status(403).json({ error: 'Usuario desactivado' });
  }

  // Registrar último login
  db.prepare("UPDATE admins SET last_login = datetime('now') WHERE id = ?").run(admin.id);

  const token = jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role, name: admin.full_name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  res.json({
    token,
    admin: {
      id:       admin.id,
      username: admin.username,
      role:     admin.role,
      name:     admin.full_name,
    },
  });
});

// GET /api/auth/me
router.get('/me', authRequired, (req, res) => {
  res.json({ admin: req.admin });
});

// POST /api/auth/change-password
router.post('/change-password', authRequired, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }

  const db = getDb();
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);

  if (!bcrypt.compareSync(currentPassword, admin.password)) {
    return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hash, req.admin.id);

  res.json({ message: 'Contraseña actualizada exitosamente' });
});

module.exports = router;
