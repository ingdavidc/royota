/**
 * src/routes/settings.js
 * ─────────────────────────────────────────────────────────────
 * Gestión de ajustes del portal cautivo y negocio.
 */
'use strict';

const { Router } = require('express');
const { getDb } = require('../database');
const { authRequired } = require('../middleware/auth');
const { getSettingsLive, updateSettingsLive } = require('../services/firestore-store');
const config = require('../config');

const router = Router();

// GET /api/settings/public — Datos para el portal cautivo (SSOT Firestore)
router.get('/public', async (req, res) => {
  const s = await getSettingsLive({ db: getDb() });
  res.json({
    business_name:          s.business_name || config.business.name,
    business_slogan:        s.business_slogan || 'El paraíso natural junto al río',
    whatsapp_number:        s.whatsapp_number || '',
    payment_phone:          s.payment_phone || '3174251419',
    online_purchase_active: s.online_purchase_active !== '0' && s.online_purchase_active !== 0 && s.online_purchase_active !== false,
    wompi_mode:             s.wompi_mode || config.wompi.mode || 'production',
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
router.get('/', authRequired, async (req, res) => {
  const s = await getSettingsLive({ db: getDb() });
  res.json({
    ...s,
    currency:       config.business.currency,
    currencySymbol: config.business.currencySymbol,
  });
});

async function syncSettingsToFirestore(settings) {
  try {
    const clean = {};
    if (settings.business_name !== undefined)          clean.business_name          = String(settings.business_name);
    if (settings.business_slogan !== undefined)        clean.business_slogan        = String(settings.business_slogan);
    if (settings.whatsapp_number !== undefined)        clean.whatsapp_number        = String(settings.whatsapp_number);
    if (settings.payment_phone !== undefined)          clean.payment_phone          = String(settings.payment_phone);
    if (settings.online_purchase_active !== undefined) clean.online_purchase_active = String(settings.online_purchase_active);
    if (settings.whatsapp_message !== undefined)       clean.whatsapp_message       = String(settings.whatsapp_message);
    if (settings.info_active !== undefined)            clean.info_active            = String(settings.info_active);
    if (settings.info_badge !== undefined)             clean.info_badge             = String(settings.info_badge);
    if (settings.info_title !== undefined)             clean.info_title             = String(settings.info_title);
    if (settings.info_content !== undefined)           clean.info_content           = String(settings.info_content);

    const keys = Object.keys(clean);
    if (!keys.length) return;

    const updatePaths = keys.map(f => `updateMask.fieldPaths=${f}`).join('&');
    await firestoreFetch(`/settings/general?${updatePaths}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFirestoreFields(clean) }),
    });
  } catch (err) {
    console.warn('[Settings-Firestore] Error al sincronizar ajustes a Firestore:', err.message);
  }
}

// PUT /api/settings — Actualizar ajustes (auth)
router.put('/', authRequired, async (req, res) => {
  const {
    business_name,
    business_slogan,
    whatsapp_number,
    payment_phone,
    online_purchase_active,
    wompi_mode,
    whatsapp_message,
    info_active,
    info_badge,
    info_title,
    info_content,
  } = req.body;

  const toUpdate = {};
  if (business_name !== undefined)          toUpdate.business_name          = String(business_name).trim();
  if (business_slogan !== undefined)        toUpdate.business_slogan        = String(business_slogan).trim();
  if (whatsapp_number !== undefined)        toUpdate.whatsapp_number        = String(whatsapp_number).replace(/[^\d+]/g, '');
  if (payment_phone !== undefined)          toUpdate.payment_phone          = String(payment_phone).replace(/[^\d+]/g, '');
  if (online_purchase_active !== undefined) toUpdate.online_purchase_active = online_purchase_active ? '1' : '0';
  if (wompi_mode !== undefined)             toUpdate.wompi_mode             = wompi_mode === 'production' ? 'production' : 'sandbox';
  if (whatsapp_message !== undefined)       toUpdate.whatsapp_message       = String(whatsapp_message).trim();
  if (info_active !== undefined)            toUpdate.info_active            = info_active ? '1' : '0';
  if (info_badge !== undefined)             toUpdate.info_badge             = String(info_badge).trim();
  if (info_title !== undefined)             toUpdate.info_title             = String(info_title).trim();
  if (info_content !== undefined)           toUpdate.info_content           = String(info_content);

  const updated = await updateSettingsLive(toUpdate, getDb());

  res.json({ message: 'Configuración guardada con éxito', settings: updated });
});

module.exports = router;
