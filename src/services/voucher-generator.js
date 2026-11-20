/**
 * src/services/voucher-generator.js
 * ─────────────────────────────────────────────────────────────
 * Lógica de generación de lotes de fichas (vouchers).
 *
 * Características:
 *  - Longitud configurable (4–16 caracteres)
 *  - Charset sin caracteres confusos (0/O, 1/I/L)
 *  - Generación criptográficamente segura (crypto.randomBytes)
 *  - Deduplicación automática (loop hasta código único)
 *  - Transacción SQLite atómica para el lote completo
 *  - Separador opcional cada N caracteres (ej: "ABCD-EFGH")
 *  - Límite de intentos para evitar bucles infinitos
 */
'use strict';

const crypto = require('crypto');
const { getDb } = require('../database');

// ── Charset sin caracteres ambiguos ───────────────────────────
// Excluidos: 0 (cero), O (letra O), 1 (uno), I (i mayúscula), L (l mayúscula)
const CHARSET_FULL        = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // 32 chars
const CHARSET_NUMERIC_SAFE = '23456789';                           // Solo números seguros
const CHARSET_ALPHA_SAFE   = 'ABCDEFGHJKMNPQRSTUVWXYZ';           // Solo letras seguras

/** Opciones de charset disponibles para el frontend */
const CHARSETS = {
  full:    { label: 'Alfanumérico (recomendado)', chars: CHARSET_FULL },
  numeric: { label: 'Solo números seguros',       chars: CHARSET_NUMERIC_SAFE },
  alpha:   { label: 'Solo letras',                chars: CHARSET_ALPHA_SAFE },
};

/**
 * Genera un código de ficha único y criptográficamente aleatorio.
 *
 * @param {string} chars    Conjunto de caracteres a usar
 * @param {number} length   Longitud del código (sin separadores)
 * @returns {string}        Código en MAYÚSCULAS
 */
function generateCode(chars, length) {
  // Usamos crypto.randomBytes para evitar sesgos de módulo
  // con el método de rechazo (rejection sampling)
  const result = [];
  const maxUsable = 256 - (256 % chars.length); // Evitar sesgo

  while (result.length < length) {
    const bytes = crypto.randomBytes(length * 2); // Buffer generoso
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      if (bytes[i] < maxUsable) {
        result.push(chars[bytes[i] % chars.length]);
      }
    }
  }

  return result.join('');
}

/**
 * Aplica un separador cada N caracteres al código.
 * Ej: formatCode('ABCDEFGH', 4, '-') → 'ABCD-EFGH'
 *
 * @param {string} code       Código sin separadores
 * @param {number} groupSize  Tamaño de cada grupo (0 = sin separador)
 * @param {string} separator  Separador a usar
 * @returns {string}
 */
function formatCode(code, groupSize = 0, separator = '-') {
  if (!groupSize) return code;
  const groups = [];
  for (let i = 0; i < code.length; i += groupSize) {
    groups.push(code.slice(i, i + groupSize));
  }
  return groups.join(separator);
}

/**
 * Genera y guarda en SQLite un lote de fichas para un plan.
 *
 * @param {object} options
 * @param {number} options.planId       ID del plan en la BD
 * @param {number} options.quantity     Cantidad de fichas a generar (1–1000)
 * @param {number} [options.codeLength] Longitud del código (default: 8)
 * @param {string} [options.charset]    Clave del charset: 'full'|'numeric'|'alpha'
 * @param {number} [options.groupSize]  Tamaño de grupo para separador (0 = sin separador)
 * @param {string} [options.separator]  Carácter separador (default: '-')
 * @param {string} [options.prefix]     Prefijo fijo al inicio del código
 * @param {string} [options.batchNote]  Nota del lote para registro
 *
 * @returns {Promise<object>} { batchId, codes: string[], plan: object }
 */
async function generateBatch(options = {}) {
  const {
    planId,
    quantity,
    codeLength  = 8,
    charset     = 'full',
    groupSize   = 0,
    separator   = '-',
    prefix      = '',
    batchNote   = '',
  } = options;

  // ── Validaciones ────────────────────────────────────────────
  if (!planId)         throw new Error('planId es obligatorio');
  if (!quantity || quantity < 1 || quantity > 1000) {
    throw new Error('quantity debe estar entre 1 y 1000');
  }
  if (codeLength < 4 || codeLength > 16) {
    throw new Error('codeLength debe estar entre 4 y 16');
  }
  const charSet = CHARSETS[charset];
  if (!charSet) {
    throw new Error(`charset inválido. Opciones: ${Object.keys(CHARSETS).join(', ')}`);
  }

  const db = getDb();

  // Verificar que el plan existe
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new Error('Plan no encontrado o inactivo');

  // ── Generar lote en transacción atómica ─────────────────────
  // 1. Crear registro del lote
  const batchResult = db.prepare(`
    INSERT INTO voucher_batches (plan_id, quantity, charset, code_length, group_size,
                                 separator, prefix, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(planId, quantity, charset, codeLength, groupSize, separator, prefix, batchNote);

  const batchId = batchResult.lastInsertRowid;

  // 2. Generar códigos únicos
  const insertVoucher = db.prepare(
    'INSERT INTO vouchers (code, plan_id, batch_id) VALUES (?, ?, ?)'
  );

  const codes = [];
  const MAX_ATTEMPTS_PER_CODE = 100;

  const transaction = db.transaction(() => {
    for (let i = 0; i < quantity; i++) {
      let rawCode, fullCode, attempts = 0;

      do {
        if (++attempts > MAX_ATTEMPTS_PER_CODE) {
          throw new Error(
            `No se pudo generar código único después de ${MAX_ATTEMPTS_PER_CODE} intentos. ` +
            `Considera aumentar codeLength o reducir quantity.`
          );
        }
        rawCode  = prefix + generateCode(charSet.chars, codeLength - prefix.length);
        fullCode = formatCode(rawCode, groupSize, separator);
      } while (
        db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(fullCode)
      );

      insertVoucher.run(fullCode, planId, batchId);
      codes.push(fullCode);
    }
  });

  transaction();

  return {
    batchId,
    plan: {
      id:         plan.id,
      name:       plan.name,
      duration:   plan.duration,
      speedLimit: plan.speed_limit,
      price:      plan.price,
    },
    codes,
    generated: codes.length,
  };
}

/**
 * Listar lotes de generación (para historial en admin).
 *
 * @param {number} limit   Máximo de registros
 * @returns {object[]}
 */
function listBatches(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT b.*, p.name AS plan_name, p.price, p.duration, p.speed_limit,
           COUNT(v.id) AS vouchers_total,
           SUM(CASE WHEN v.status = 'available' THEN 1 ELSE 0 END) AS vouchers_available,
           SUM(CASE WHEN v.status = 'sold'      THEN 1 ELSE 0 END) AS vouchers_sold,
           SUM(CASE WHEN v.status = 'active'    THEN 1 ELSE 0 END) AS vouchers_active
    FROM voucher_batches b
    JOIN plans p ON b.plan_id = p.id
    LEFT JOIN vouchers v ON v.batch_id = b.id
    GROUP BY b.id
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Obtener todos los vouchers de un lote (para impresión).
 *
 * @param {number} batchId
 * @param {string} [status]  Filtrar por status (opcional)
 */
function getBatchVouchers(batchId, status = null) {
  const db = getDb();
  if (status) {
    return db.prepare(`
      SELECT v.*, p.name AS plan_name, p.duration, p.speed_limit, p.price
      FROM vouchers v JOIN plans p ON v.plan_id = p.id
      WHERE v.batch_id = ? AND v.status = ?
      ORDER BY v.id ASC
    `).all(batchId, status);
  }
  return db.prepare(`
    SELECT v.*, p.name AS plan_name, p.duration, p.speed_limit, p.price
    FROM vouchers v JOIN plans p ON v.plan_id = p.id
    WHERE v.batch_id = ?
    ORDER BY v.id ASC
  `).all(batchId);
}

module.exports = {
  CHARSETS,
  generateBatch,
  listBatches,
  getBatchVouchers,
  formatCode,       // Exportado para uso en tests
};
