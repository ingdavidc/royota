# ==============================================================================
# SCRIPT DE HARDENING DE RED — MIKROTIK RB760iGS (RouterOS 7.25.1 / HG509R1QT2V)
# Generado tras auditoría Opción A en vivo (2026-11-26 13:36 COT).
# Idempotente y seguro: NO bloquea Cloud Sync saliente, DHCP WAN, portal cautivo
# (http-pap/trial) ni el acceso administrativo por ether2 o WiFi (192.168.20.8).
# IMPORTANTE: Revisar con el propietario antes de aplicar en el router.
# ==============================================================================

# 1. Proteger acceso al router (chain=input actualmente no tiene regla DROP final)
/ip firewall filter
:if ([:len [find comment="HARDENING: Permitir admin WiFi (Ing. David)"]] = 0) do={
  add chain=input action=accept in-interface=bridge-hotspot src-address=192.168.20.8 comment="HARDENING: Permitir admin WiFi (Ing. David)"
}
:if ([:len [find comment="HARDENING: Permitir DHCP client WAN"]] = 0) do={
  add chain=input action=accept in-interface-list=WAN protocol=udp dst-port=68 comment="HARDENING: Permitir DHCP client WAN"
}
:if ([:len [find comment="HARDENING: ICMP limitado al router"]] = 0) do={
  add chain=input action=accept protocol=icmp limit=5,5:packet comment="HARDENING: ICMP limitado al router"
}
:if ([:len [find comment="HARDENING: Bloquear resto acceso al router (WAN y Hotspot)"]] = 0) do={
  add chain=input action=drop comment="HARDENING: Bloquear resto acceso al router (WAN y Hotspot)"
}

# 2. Aislamiento Red Admin (ether2) y aislamiento L3 entre clientes del Hotspot
:local rAp [find comment="1. Permitir APs Ruijie a Internet"]
:if ([:len [find comment="HARDENING: Bloquear Hotspot hacia Red Admin ether2"]] = 0) do={
  :if ([:len $rAp] > 0) do={
    add chain=forward action=drop in-interface=bridge-hotspot out-interface=ether2 place-before=[:pick $rAp 0] comment="HARDENING: Bloquear Hotspot hacia Red Admin ether2"
  } else={
    add chain=forward action=drop in-interface=bridge-hotspot out-interface=ether2 comment="HARDENING: Bloquear Hotspot hacia Red Admin ether2"
  }
}
:if ([:len [find comment="HARDENING: Aislamiento L3 entre clientes Hotspot"]] = 0) do={
  :if ([:len $rAp] > 0) do={
    add chain=forward action=drop in-interface=bridge-hotspot out-interface=bridge-hotspot src-address=192.168.20.10-192.168.23.250 dst-address=192.168.20.10-192.168.23.250 place-before=[:pick $rAp 0] comment="HARDENING: Aislamiento L3 entre clientes Hotspot"
  } else={
    add chain=forward action=drop in-interface=bridge-hotspot out-interface=bridge-hotspot src-address=192.168.20.10-192.168.23.250 dst-address=192.168.20.10-192.168.23.250 comment="HARDENING: Aislamiento L3 entre clientes Hotspot"
  }
}

# 3. Restringir servicios de administración (Winbox/SSH/WWW) solo a red admin y tu IP
/ip service
set winbox address=192.168.10.0/24,192.168.20.8/32
set ssh address=192.168.10.0/24,192.168.20.8/32
set www address=192.168.10.0/24,192.168.20.8/32
:do { set reverse-proxy address=192.168.10.0/24 disabled=yes } on-error={}

# 4. Deshabilitar IPv6 para evitar evasión del Hotspot IPv4 (tráfico actual IPv6 = 0)
/ipv6 settings set disable-ipv6=yes

# ------------------------------------------------------------------------------
# NOTAS DE REVISIÓN (NO APLICAR AUTOMÁTICAMENTE SIN VALIDAR EL PORTAL):
# - NO se deshabilita http-pap ni trial en hsprof-royota porque docs/index.html
#   actualmente usa POST directo sin CHAP y trial=yes para cortesía de 2 min.
#   Si deseas eliminar el trial nativo (riesgo de MAC aleatoria), primero migra
#   el botón de cortesía del portal al flujo de fichas WA- vía Cloud Sync.
# - Activar "Client Isolation / AP Isolation" en Ruijie Cloud dentro del SSID
#   del AP Zona 1 para aislar también tramas WiFi dentro de la misma antena.
# - Revisar el scheduler "reset-midnight-royota": actualmente borra a las 00:00
#   toda ficha con uptime>0s, lo cual cortaría fichas de "1 Dia" vendidas en la tarde.
# ------------------------------------------------------------------------------
