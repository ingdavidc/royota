/**
 * src/seed.js — Datos de ejemplo para desarrollo/demo
 * Ejecutar: npm run seed
 */
'use strict';
require('dotenv').config();
const { getDb } = require('./database');

const db = getDb();

const PLANS = [
  { name:'30 Minutos',  duration:'30m',  speed_limit:'3M/3M',   price:2000,  shared_users:1, sort_order:1 },
  { name:'1 Hora',      duration:'1h',   speed_limit:'5M/5M',   price:3000,  shared_users:1, sort_order:2 },
  { name:'2 Horas',     duration:'2h',   speed_limit:'5M/5M',   price:5000,  shared_users:1, sort_order:3 },
  { name:'5 Horas',     duration:'5h',   speed_limit:'8M/8M',   price:8000,  shared_users:1, sort_order:4 },
  { name:'1 Día',       duration:'1d',   speed_limit:'10M/10M', price:12000, shared_users:2, sort_order:5 },
  { name:'3 Días',      duration:'3d',   speed_limit:'10M/10M', price:25000, shared_users:2, sort_order:6 },
  { name:'7 Días',      duration:'7d',   speed_limit:'15M/15M', price:45000, shared_users:3, sort_order:7 },
  { name:'30 Días',     duration:'30d',  speed_limit:'20M/20M', price:120000,shared_users:3, sort_order:8 },
];

const ins = db.prepare(`
  INSERT OR IGNORE INTO plans
    (name, duration, speed_limit, price, shared_users, profile_name, sort_order)
  VALUES (?, ?, ?, ?, ?, 'default', ?)
`);

const tx = db.transaction(function() {
  PLANS.forEach(function(p) {
    ins.run(p.name, p.duration, p.speed_limit, p.price, p.shared_users, p.sort_order);
  });
});

tx();
console.log('✅ ' + PLANS.length + ' planes insertados.');
process.exit(0);
