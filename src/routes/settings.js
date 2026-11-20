/**
 * src/routes/settings.js
 * ─────────────────────────────────────────────────────────────
 * Gestión de ajustes del portal cautivo y negocio.
 *
 * GET /api/settings/public → Ajustes visibles para el portal cautivo
 * GET /api/settings        → Todos los ajustes (requiere auth)
 * PUT /api/settings        → Actualizar ajustes (requiere auth)
 */
'use strict';

const { Router } = require('express');
const { getSettings, setSettings } = require('../database');
const { authRequired } = require('../middleware/auth');
const config = require('../config');

const router = Router();

// GET /api/settings/public — Datos para el portal cautivo
router.get('/public', (req, res) => {
  const s = getSettings();
  res.json({
    business_name:    s.business_name || config.business.name,
    business_slogan:  s.business_slogan || 'El paraíso natural junto al río',
    whatsapp_number:  s.whatsapp_number || '',
    whatsapp_message: s.whatsapp_message || '',
    info_active:      s.info_active === '1' || s.info_active === true,
    info_badge:       s.info_badge || 'Avisos & Servicios',
    info_title:       s.info_title || 'Información del Balneario',
    info_content:     s.info_content || '',
    currency:         config.business.currency,
    currencySymbol:   config.business.currencySymbol,
  });
});

// GET /api/settings — Panel de administración (auth)
router.get('/', authRequired, (req, res) => {
  const s = getSettings();
  res.json({
    ...s,
    currency:       config.business.currency,
    currencySymbol: config.business.currencySymbol,
  });
});

// PUT /api/settings — Actualizar ajustes (auth)
router.put('/', authRequired, (req, res) => {
  const {
    business_name,
    business_slogan,
    whatsapp_number,
    whatsapp_message,
    info_active,
    info_badge,
    info_title,
    info_content,
  } = req.body;

  const toUpdate = {};
  if (business_name !== undefined)    toUpdate.business_name    = business_name.trim();
  if (business_slogan !== undefined)  toUpdate.business_slogan  = business_slogan.trim();
  if (whatsapp_number !== undefined)  toUpdate.whatsapp_number  = whatsapp_number.replace(/[^\d+]/g, '');
  if (whatsapp_message !== undefined) toUpdate.whatsapp_message = whatsapp_message.trim();
  if (info_active !== undefined)      toUpdate.info_active      = info_active ? '1' : '0';
  if (info_badge !== undefined)       toUpdate.info_badge       = info_badge.trim();
  if (info_title !== undefined)       toUpdate.info_title       = info_title.trim();
  if (info_content !== undefined)     toUpdate.info_content     = info_content;

  const updated = setSettings(toUpdate);
  res.json({ message: 'Configuración guardada con éxito', settings: updated });
});

module.exports = router;
