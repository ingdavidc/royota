# 📶 Hotspot Fichas ROYOTA

Sistema web de venta y gestión de fichas (vouchers) para Hotspot MikroTik RouterOS v7.

## 🚀 Quick Start

```bash
# 1. Clonar y configurar
cp .env.example .env
# Editar .env con tus datos de MikroTik

# 2. Con Docker (recomendado)
docker compose up -d

# 3. Sin Docker (desarrollo)
npm install
npm run seed    # Crear planes de ejemplo
npm run dev     # Iniciar en modo desarrollo
```

## 📋 Endpoints

| Ruta | Descripción |
|------|-------------|
| `http://localhost:3000` | Portal cautivo (para clientes) |
| `http://localhost:3000/login` | Login admin |
| `http://localhost:3000/admin` | Panel de administración |

## 🤖 Automatización WhatsApp + IA (Daviplata & Llave Bre-B)

El sistema incluye venta 100% automatizada por WhatsApp mediante lectura de comprobantes con **Google Gemini Flash**:

1. El cliente escribe al WhatsApp ("Hola", "Planes", etc.) y recibe el menú de precios y medios de pago.
2. Transfiere a **Daviplata** o **Llave Bre-B** (`3174251419`).
3. Envía la captura del comprobante por WhatsApp.
4. La IA (Gemini Flash) analiza monto, número de autorización, cuenta de destino y valida contra fraudes (comprobantes duplicados).
5. Se despacha y entrega la ficha de internet de inmediato en el chat.
6. Vinculación fácil con código QR desde el panel admin (`/admin#whatsapp`) o desde la terminal al arrancar.

### Variables en `.env`:
```env
WHATSAPP_ENABLED=true
GEMINI_API_KEY=tu_api_key_gratis_de_google_ai_studio
PAYMENT_PHONE=3174251419
DAVIPLATA_PHONE=3174251419
BREB_KEY=3174251419
```

## 🔑 Credenciales por defecto

- **Usuario:** `admin`
- **Contraseña:** `admin123`

> ⚠️ Cambiar inmediatamente en producción.

## 📂 Estructura

```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src/
│   ├── server.js              # Express app
│   ├── config.js              # Variables de entorno
│   ├── database.js            # SQLite schema + init
│   ├── seed.js                # Datos de ejemplo
│   ├── middleware/auth.js     # JWT middleware
│   ├── routes/
│   │   ├── auth.js            # Login, password
│   │   ├── plans.js           # CRUD planes
│   │   ├── vouchers.js        # Generar, vender, activar
│   │   └── mikrotik.js        # Estado del router
│   └── services/
│       ├── mikrotik-api.js    # Cliente REST API MikroTik
│       └── cleanup-scheduler.js # Limpieza automática
└── public/
    ├── index.html             # Portal cautivo
    ├── login.html             # Login admin
    ├── admin.html             # Panel completo
    ├── css/
    └── js/
```
