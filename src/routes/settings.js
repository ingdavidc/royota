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
    business_name:          s.business_name || config.business.name,
    business_slogan:        s.business_slogan || 'El paraíso natural junto al río',
    whatsapp_number:        s.whatsapp_number || '',
    payment_phone:          s.payment_phone || '3174251419',
    online_purchase_active: s.online_purchase_active !== '0' && s.online_purchase_active !== 0 && s.online_purchase_active !== false,
    whatsapp_message:       s.whatsapp_message || '',
    info_active:            s.info_active === '1' || s.info_active === true,
    info_badge:             s.info_badge || 'Avisos & Servicios',
    info_title:             s.info_title || 'Información del Balneario',
    info_content:           s.info_content || '',
    currency:               config.business.currency,
    currencySymbol:         config.business.currencySymbol,
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

// Sincronizar ajustes hacia Cloud Firestore para actualizar en tiempo real el portal cautivo
async function syncSettingsToFirestore(settings) {
  try {
    const fields = {};
    if (settings.business_name !== undefined)          fields.business_name          = { stringValue: String(settings.business_name) };
    if (settings.business_slogan !== undefined)        fields.business_slogan        = { stringValue: String(settings.business_slogan) };
    if (settings.whatsapp_number !== undefined)        fields.whatsapp_number        = { stringValue: String(settings.whatsapp_number) };
    if (settings.payment_phone !== undefined)          fields.payment_phone          = { stringValue: String(settings.payment_phone) };
    if (settings.online_purchase_active !== undefined) fields.online_purchase_active = { stringValue: String(settings.online_purchase_active) };
    if (settings.whatsapp_message !== undefined)       fields.whatsapp_message       = { stringValue: String(settings.whatsapp_message) };
    if (settings.info_active !== undefined)            fields.info_active            = { stringValue: String(settings.info_active) };
    if (settings.info_badge !== undefined)             fields.info_badge             = { stringValue: String(settings.info_badge) };
    if (settings.info_title !== undefined)             fields.info_title             = { stringValue: String(settings.info_title) };
    if (settings.info_content !== undefined)           fields.info_content           = { stringValue: String(settings.info_content) };

    const keys = Object.keys(fields);
    if (!keys.length) return;

    const updatePaths = keys.map(f => `updateMask.fieldPaths=${f}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/fichas-royota/databases/(default)/documents/settings/general?${updatePaths}`;

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
  } catch (err) {
    console.warn('[Settings-Firestore] Error al sincronizar ajustes a Firestore:', err.message);
  }
}

// PUT /api/settings — Actualizar ajustes (auth)
router.put('/', authRequired, (req, res) => {
  const {
    business_name,
    business_slogan,
    whatsapp_number,
    payment_phone,
    online_purchase_active,
    whatsapp_message,
    info_active,
    info_badge,
    info_title,
    info_content,
  } = req.body;

  const toUpdate = {};
  if (business_name !== undefined)          toUpdate.business_name          = business_name.trim();
  if (business_slogan !== undefined)        toUpdate.business_slogan        = business_slogan.trim();
  if (whatsapp_number !== undefined)        toUpdate.whatsapp_number        = whatsapp_number.replace(/[^\d+]/g, '');
  if (payment_phone !== undefined)          toUpdate.payment_phone          = payment_phone.replace(/[^\d+]/g, '');
  if (online_purchase_active !== undefined) toUpdate.online_purchase_active = online_purchase_active ? '1' : '0';
  if (whatsapp_message !== undefined)       toUpdate.whatsapp_message       = whatsapp_message.trim();
  if (info_active !== undefined)            toUpdate.info_active            = info_active ? '1' : '0';
  if (info_badge !== undefined)             toUpdate.info_badge             = info_badge.trim();
  if (info_title !== undefined)             toUpdate.info_title             = info_title.trim();
  if (info_content !== undefined)           toUpdate.info_content           = info_content;

  const updated = setSettings(toUpdate);

  // Sincronizar en tiempo real a Google Firestore (para actualizar portal cautivo al instante)
  syncSettingsToFirestore(toUpdate);

  res.json({ message: 'Configuración guardada con éxito', settings: updated });
});

module.exports = router;
