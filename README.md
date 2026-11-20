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
