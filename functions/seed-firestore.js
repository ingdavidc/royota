/**
 * functions/seed-firestore.js
 * ─────────────────────────────────────────────────────────────
 * Script para cargar los planes y configuración inicial
 * del Balneario en Google Cloud Firestore.
 *
 * Ejecución:
 *   cd functions
 *   node seed-firestore.js
 */
'use strict';

const admin = require('firebase-admin');

// Si se ejecuta con credenciales de cuenta de servicio o emulador local
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const PLANS = [
  { name: '30 Minutos',  duration: '30m',  speed_limit: '3M/3M',   price: 2000,  shared_users: 1, sort_order: 1, is_active: 1 },
  { name: '1 Hora',      duration: '1h',   speed_limit: '5M/5M',   price: 3000,  shared_users: 1, sort_order: 2, is_active: 1 },
  { name: '2 Horas',     duration: '2h',   speed_limit: '5M/5M',   price: 5000,  shared_users: 1, sort_order: 3, is_active: 1 },
  { name: '5 Horas',     duration: '5h',   speed_limit: '8M/8M',   price: 8000,  shared_users: 1, sort_order: 4, is_active: 1 },
  { name: '1 Día',       duration: '1d',   speed_limit: '10M/10M', price: 12000, shared_users: 2, sort_order: 5, is_active: 1 },
  { name: '3 Días',      duration: '3d',   speed_limit: '10M/10M', price: 25000, shared_users: 2, sort_order: 6, is_active: 1 },
  { name: '7 Días',      duration: '7d',   speed_limit: '15M/15M', price: 45000, shared_users: 3, sort_order: 7, is_active: 1 },
  { name: '30 Días',     duration: '30d',  speed_limit: '20M/20M', price: 120000,shared_users: 3, sort_order: 8, is_active: 1 },
];

const SETTINGS = {
  business_name:    'Balneario Río Royota',
  business_slogan:  'El paraíso natural junto al río · Conexión WiFi de alta velocidad',
  whatsapp_number:  '573123456789',
  whatsapp_message: '¡Hola! Estoy en el Balneario Río Royota y deseo comprar una ficha de internet WiFi.',
  info_active:      true,
  info_badge:       'Avisos & Servicios del Balneario',
  info_title:       '¡Bienvenidos al Balneario Río Royota!',
  info_content:     '🌊 Zona de río y piscinas naturales abiertas de 8:00 AM a 6:00 PM.\n🍹 Kioscos, restaurante y venta de bebidas disponibles.\n🎫 Venta de fichas WiFi en Taquilla Principal y Restaurante.\n🌿 Cuidemos el río: por favor deposita los residuos en los contenedores.',
  currency:         'COP',
  currencySymbol:   '$',
};

async function seed() {
  console.log('🌱 Inicializando Firestore para Balneario Río Royota...');

  // 1. Guardar ajustes
  await db.collection('settings').doc('general').set(SETTINGS, { merge: true });
  console.log('✅ Ajustes del Balneario guardados.');

  // 2. Guardar planes
  for (const p of PLANS) {
    const snap = await db.collection('plans').where('name', '==', p.name).get();
    if (snap.empty) {
      await db.collection('plans').add({ ...p, created_at: new Date().toISOString() });
      console.log(`  + Plan creado: ${p.name}`);
    }
  }

  console.log('✨ Firestore listo con éxito.');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Error al inicializar Firestore:', err);
  process.exit(1);
});
