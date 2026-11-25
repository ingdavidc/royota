# ==============================================================================
# PLANTILLA HARDENING (SIN CREDENCIALES) — MIKROTIK ROUTEROS v7
# Ubicada fuera de public/ y docs/ para evitar exposición pública.
# ==============================================================================
# Ver recomendaciones finales después de recolectar /export real por Opción A.
/ip hotspot profile
set [find name=hsprof-royota] login-by=http-chap,cookie

# Mantener IPv6 bloqueado si no se usa
/ipv6 settings set disable-ipv6=yes
