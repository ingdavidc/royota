/**
 * src/routes/payments.js
 * ─────────────────────────────────────────────────────────────
 * Endpoints para pagos en línea y QR dinámico Wompi:
 * - POST /api/payments/wompi/create-order
 * - GET  /api/payments/wompi/status/:reference
 * - POST /api/payments/wompi-webhook
 * - POST /api/payments/wompi/simulate-approval (Sandbox only)
 * - GET  /api/payments/wompi/config
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

// GET /api/payments/wompi/status/:reference — Polling del portal cautivo
router.get('/wompi/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const order = await wompiService.getPaymentOrder(reference);

    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    res.json({
      reference: order.reference,
      status: order.status, // PENDING | APPROVED | DECLINED | ERROR
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
    console.log('[WompiWebhook] Evento recibido:', body?.event, 'id:', body?.data?.transaction?.id);

    // 1. Validar integridad criptográfica del webhook
    const isValid = wompiService.verifyWebhookChecksum(body);
    if (!isValid) {
      console.warn('[WompiWebhook] ⚠️ Checksum de firma inválido. Petición no autorizada.');
      return res.status(400).json({ error: 'Firma o checksum inválido' });
    }

    const event = body.event;
    if (event !== 'transaction.updated') {
      return res.json({ received: true, ignored: true, reason: 'Evento no relevante' });
    }

    const transaction = body.data?.transaction;
    if (!transaction) {
      return res.status(400).json({ error: 'Estructura de transacción no encontrada' });
    }

    const reference = transaction.reference;
    const status = transaction.status; // APPROVED | DECLINED | VOIDED | ERROR

    console.log(`[WompiWebhook] Transacción ${transaction.id} (${reference}) estado: ${status}`);

    const existingOrder = await wompiService.getPaymentOrder(reference);
    if (!existingOrder) {
      console.warn(`[WompiWebhook] Orden ${reference} no encontrada en base de datos.`);
      // Retornar 200 para evitar que Wompi reintente indefinidamente
      return res.json({ received: true, warning: 'Orden no registrada' });
    }

    // Idempotencia: si ya fue aprobada y tiene ficha asignada, no re-entregar
    if (existingOrder.status === 'APPROVED' && existingOrder.voucher_code) {
      return res.json({
        received: true,
        alreadyProcessed: true,
        voucher_code: existingOrder.voucher_code,
      });
    }

    if (status === 'APPROVED') {
      // Buscar el plan correspondiente
      const plans = await getPlansLive({ db: getDb() });
      const plan = plans.find((p) => String(p.id) === String(existingOrder.plan_id)) || {
        id: existingOrder.plan_id,
        name: existingOrder.plan_name,
        price: existingOrder.amount,
        duration: '2h',
        speed_limit: '2M/3M',
      };

      // Asignar o generar la ficha desde el pool de entrega inmediata
      const claimResult = await claimBotPoolVoucherSSOT({
        plan,
        senderPhone: existingOrder.client_phone || transaction.customer_email || 'Wompi Online',
        paymentId: transaction.id,
        paymentMethod: `wompi_${transaction.payment_method_type || 'online'}`,
        db: getDb(),
      });

      await wompiService.updatePaymentOrder(reference, {
        status: 'APPROVED',
        voucher_code: claimResult.code,
        instant_ready: Boolean(claimResult.instantReady),
        transaction_id: transaction.id,
        paid_at: new Date().toISOString(),
      });

      console.log(`[WompiWebhook] ✅ Ficha ${claimResult.code} entregada a orden ${reference}`);

      return res.json({
        received: true,
        status: 'APPROVED',
        voucher_code: claimResult.code,
      });
    }

    // Si fue rechazada o falló
    await wompiService.updatePaymentOrder(reference, {
      status,
      transaction_id: transaction.id,
    });

    res.json({ received: true, status });
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

    // Permitido en sandbox
    const wompiConf = await wompiService.getEffectiveWompiConfig();
    if (wompiConf.mode !== 'sandbox' && order.wompi_mode !== 'sandbox') {
      return res.status(403).json({ error: 'Simulación solo permitida en modo Sandbox' });
    }

    if (order.status === 'APPROVED' && order.voucher_code) {
      return res.json({
        success: true,
        status: 'APPROVED',
        voucher_code: order.voucher_code,
        alreadyProcessed: true,
      });
    }

    const plans = await getPlansLive({ db: getDb() });
    const plan = plans.find((p) => String(p.id) === String(order.plan_id)) || {
      id: order.plan_id,
      name: order.plan_name,
      price: order.amount,
      duration: '2h',
      speed_limit: '2M/3M',
    };

    const claimResult = await claimBotPoolVoucherSSOT({
      plan,
      senderPhone: order.client_phone || 'Simulador Sandbox',
      paymentId: `SIM-${Date.now()}`,
      paymentMethod: 'wompi_sandbox_simulated',
      db: getDb(),
    });

    const updated = await wompiService.updatePaymentOrder(reference, {
      status: 'APPROVED',
      voucher_code: claimResult.code,
      instant_ready: Boolean(claimResult.instantReady),
      transaction_id: `SIM-${Date.now()}`,
      paid_at: new Date().toISOString(),
    });

    res.json({
      success: true,
      status: 'APPROVED',
      voucher_code: claimResult.code,
      order: updated,
    });
  } catch (err) {
    console.error('[PaymentsRoute] Error en simulate-approval:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
