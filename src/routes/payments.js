/**
 * src/routes/payments.js
 * ─────────────────────────────────────────────────────────────
 * Endpoints para pagos en línea y QR dinámico Wompi:
 * - GET  /api/payments/wompi/config
 * - POST /api/payments/wompi/create-order
 * - GET  /api/payments/wompi/status/:reference
 * - POST /api/payments/wompi-webhook
 * - POST /api/payments/wompi/simulate-approval (Sandbox only)
 */
'use strict';

const { Router } = require('express');
const wompiService = require('../services/wompi-service');
const {
  getSettingsLive,
  getPlansLive,
  claimBotPoolVoucherSSOT,
} = require('../services/firestore-store');
const { getDb } = require('../database');

const router = Router();

// Bloqueo en memoria para evitar doble entrega si webhook y polling llegan simultáneamente
const _approvingLocks = new Map();

/**
 * Procesa de forma idempotente y segura una transacción de Wompi asociada a una orden.
 * Garantiza verificación de monto y entrega atómica de una única ficha.
 */
async function processWompiTransactionUpdate(order, transaction) {
  if (!order || !transaction) return order;
  const ref = order.reference;

  if (_approvingLocks.has(ref)) {
    return _approvingLocks.get(ref);
  }

  const workPromise = (async () => {
    const freshOrder = (await wompiService.getPaymentOrder(ref)) || order;

    if (freshOrder.status === 'APPROVED' && freshOrder.voucher_code) {
      return freshOrder;
    }

    const txStatus = String(transaction.status || '').toUpperCase();

    if (txStatus === 'APPROVED') {
      const paidCents = Number(transaction.amount_in_cents || 0);
      const expectedCents = Number(freshOrder.amount_in_cents || 0);

      if (expectedCents > 0 && paidCents < expectedCents) {
        console.warn(`[Wompi] ⚠️ Monto insuficiente para ${ref}: pagado=${paidCents}, esperado=${expectedCents}`);
        return wompiService.updatePaymentOrder(ref, {
          status: 'ERROR',
          transaction_id: transaction.id,
          error_reason: `Monto pagado (${paidCents}) menor al esperado (${expectedCents})`,
        });
      }

      const db = getDb();
      const plans = await getPlansLive({ db });
      const plan = plans.find((p) => String(p.id) === String(freshOrder.plan_id)) || {
        id: freshOrder.plan_id,
        name: freshOrder.plan_name,
        price: freshOrder.amount,
        duration: '1h',
        speed_limit: '2M/3M',
      };

      const claimResult = await claimBotPoolVoucherSSOT({
        plan,
        senderPhone: freshOrder.client_phone || transaction.customer_email || 'Wompi Online',
        paymentId: transaction.id,
        paymentMethod: `wompi_${String(transaction.payment_method_type || 'online').toLowerCase()}`,
        db,
      });

      const updated = await wompiService.updatePaymentOrder(ref, {
        status: 'APPROVED',
        voucher_code: claimResult.code,
        instant_ready: Boolean(claimResult.instantReady),
        transaction_id: transaction.id,
        payment_method_type: transaction.payment_method_type || 'online',
        wompi_reference: transaction.reference || null,
        paid_at: new Date().toISOString(),
      });

      console.log(`[Wompi] ✅ Orden ${ref} APROBADA (tx ${transaction.id}). Ficha entregada: ${claimResult.code}`);
      return updated;
    }

    if (txStatus === 'DECLINED' || txStatus === 'ERROR' || txStatus === 'VOIDED') {
      return wompiService.updatePaymentOrder(ref, {
        status: txStatus,
        transaction_id: transaction.id,
        wompi_reference: transaction.reference || null,
      });
    }

    return freshOrder;
  })();

  _approvingLocks.set(ref, workPromise);
  try {
    return await workPromise;
  } finally {
    _approvingLocks.delete(ref);
  }
}

// GET /api/payments/wompi/config — Estado público para el portal cautivo
router.get('/wompi/config', async (_req, res) => {
  try {
    const s = await getSettingsLive({ db: getDb() });
    const wompiConf = await wompiService.getEffectiveWompiConfig();
    const isOnlineActive = s.online_purchase_active !== '0' && s.online_purchase_active !== 0 && s.online_purchase_active !== false;

    res.json({
      enabled: isOnlineActive,
      mode: wompiConf.mode,
      publicKey: wompiConf.publicKey,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/wompi/create-order — Iniciar compra con Link / QR
router.post('/wompi/create-order', async (req, res) => {
  try {
    const { plan_id, plan_name = '', client_phone = '', client_mac = '' } = req.body;

    if (!plan_id && !plan_name) {
      return res.status(400).json({ error: 'plan_id o plan_name es requerido' });
    }

    const plans = await getPlansLive({ db: getDb() });
    let plan = plan_id ? plans.find((p) => String(p.id) === String(plan_id)) : null;
    if (!plan && plan_name) {
      const normalized = String(plan_name).trim().toLowerCase();
      plan = plans.find((p) => String(p.name || '').trim().toLowerCase() === normalized);
    }

    if (!plan) {
      return res.status(404).json({ error: 'Plan no encontrado o no disponible' });
    }

    const order = await wompiService.createPaymentOrder({
      plan,
      clientPhone: String(client_phone).trim(),
      clientMac: String(client_mac).trim(),
    });

    res.status(201).json({
      success: true,
      order,
    });
  } catch (err) {
    console.error('[PaymentsRoute] Error en create-order:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/wompi/status/:reference — Polling y reconciliación activa del portal cautivo
router.get('/wompi/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const txIdHint = req.query?.tx_id ? String(req.query.tx_id).trim() : null;

    let order = await wompiService.getPaymentOrder(reference);
    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    // Reconciliación activa contra Wompi API si sigue PENDING
    if (order.status === 'PENDING') {
      const tx = await wompiService.reconcilePendingOrderFromWompi(order, txIdHint);
      if (tx && tx.status && tx.status !== 'PENDING') {
        order = await processWompiTransactionUpdate(order, tx);
      }
    }

    res.json({
      reference: order.reference,
      status: order.status, // PENDING | APPROVED | DECLINED | VOIDED | ERROR
      voucher_code: order.voucher_code || null,
      instant_ready: Boolean(order.instant_ready),
      amount: order.amount,
      plan_name: order.plan_name,
      paid_at: order.paid_at || null,
    });
  } catch (err) {
    console.error('[PaymentsRoute] Error en status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/wompi-webhook — Receptor oficial de eventos Wompi
router.post('/wompi-webhook', async (req, res) => {
  try {
    const body = req.body;
    const headerChecksum = req.headers['x-event-checksum'] || null;
    console.log('[WompiWebhook] Evento recibido:', body?.event, 'tx:', body?.data?.transaction?.id, 'link:', body?.data?.transaction?.payment_link_id);

    // 1. Validar integridad criptográfica del webhook
    const isValid = wompiService.verifyWebhookChecksum(body, null, headerChecksum);
    if (!isValid) {
      console.warn('[WompiWebhook] ⚠️ Checksum de firma inválido. Petición no autorizada.');
      return res.status(400).json({ error: 'Firma o checksum inválido' });
    }

    if (body.event !== 'transaction.updated') {
      return res.json({ received: true, ignored: true, reason: 'Evento no relevante' });
    }

    const transaction = body.data?.transaction;
    if (!transaction) {
      return res.status(400).json({ error: 'Estructura de transacción no encontrada' });
    }

    console.log(`[WompiWebhook] Transacción ${transaction.id} (ref=${transaction.reference}, link=${transaction.payment_link_id}) estado=${transaction.status}`);

    // 2. Buscar orden por reference o payment_link_id
    const existingOrder = await wompiService.findOrderForTransaction(transaction);
    if (!existingOrder) {
      console.warn(`[WompiWebhook] Orden no registrada (ref=${transaction.reference}, link=${transaction.payment_link_id}).`);
      return res.json({ received: true, warning: 'Orden no registrada' });
    }

    const updated = await processWompiTransactionUpdate(existingOrder, transaction);

    return res.json({
      received: true,
      reference: updated.reference,
      status: updated.status,
      voucher_code: updated.voucher_code || null,
    });
  } catch (err) {
    console.error('[WompiWebhook] Error procesando webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/wompi/simulate-approval — Simulación instantánea para Modo Pruebas
router.post('/wompi/simulate-approval', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) {
      return res.status(400).json({ error: 'reference es requerido' });
    }

    const order = await wompiService.getPaymentOrder(reference);
    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    // Permitido únicamente en sandbox
    const wompiConf = await wompiService.getEffectiveWompiConfig();
    if (wompiConf.mode !== 'sandbox' && order.wompi_mode !== 'sandbox') {
      return res.status(403).json({ error: 'Simulación solo permitida en modo Sandbox' });
    }

    const updated = await processWompiTransactionUpdate(order, {
      id: `SIM-${Date.now()}`,
      status: 'APPROVED',
      amount_in_cents: order.amount_in_cents,
      reference: order.reference,
      payment_link_id: order.link_id,
      payment_method_type: 'SANDBOX_SIMULATED',
    });

    res.json({
      success: true,
      status: updated.status,
      voucher_code: updated.voucher_code,
      order: updated,
    });
  } catch (err) {
    console.error('[PaymentsRoute] Error en simulate-approval:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
