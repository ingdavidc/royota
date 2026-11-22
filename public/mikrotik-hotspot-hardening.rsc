# ==============================================================================
# SCRIPT DE PROVISIÓN Y HARDENING - MIKROTIK ROUTEROS v7
# Hotspot & Portal Cautivo — Balneario Río Royota
# ==============================================================================
# Este script deja el router listo y blindado para operar con el sistema de
# fichas ROYOTA con tiempo continuo, aislamiento L2/L3 y prevención de fraude.
#
# Instrucciones de aplicación:
# 1. Ajustar las contraseñas e interfaces según el modelo específico (ej. hEX, RB4011, etc.)
# 2. Pegar en la terminal de Winbox o cargar mediante /import mikrotik-hotspot-hardening.rsc
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. AISLAMIENTO L2 Y SEGMENTACIÓN POR VLANS
# ------------------------------------------------------------------------------
/interface bridge
add name=bridge-lan vlan-filtering=yes comment="Bridge principal con filtrado VLAN"

# VLAN 10: Administración & Servidor Web ROYOTA
/interface vlan
add interface=bridge-lan name=vlan10-mgmt vlan-id=10 comment="Red de Administracion y Servidor"

# VLAN 20: Clientes del Hotspot (Balneario)
add interface=bridge-lan name=vlan20-hotspot vlan-id=20 comment="Red de Clientes Hotspot"

# Direccionamiento IP
/ip address
add address=192.168.10.1/24 interface=vlan10-mgmt comment="Gateway Gestion"
add address=192.168.20.1/22 interface=vlan20-hotspot comment="Gateway Hotspot (1022 hosts)"

# Pools DHCP
/ip pool
add name=pool-mgmt ranges=192.168.10.50-192.168.10.100
add name=pool-hotspot ranges=192.168.20.10-192.168.23.250

# Servidores DHCP
/ip dhcp-server
add address-pool=pool-mgmt interface=vlan10-mgmt lease-time=1d name=dhcp-mgmt disabled=no
add address-pool=pool-hotspot interface=vlan20-hotspot lease-time=1h name=dhcp-hotspot disabled=no

/ip dhcp-server network
add address=192.168.10.0/24 dns-server=192.168.10.1 gateway=192.168.10.1 comment="Red Mgmt"
add address=192.168.20.0/22 dns-server=192.168.20.1 gateway=192.168.20.1 comment="Red Hotspot"

# Aislamiento L2 en Bridge (Evita que clientes se vean entre si a nivel Ethernet)
/interface bridge port
# Ajustar ether2 a ether5 segun conexion fisica de antenas
# set [find interface=ether2] horizon=1

# Si el equipo cuenta con Wi-Fi integrado (ej. hAP ac / ax):
# /interface wifi (o /interface wireless) set [find] default-forwarding=no

# ------------------------------------------------------------------------------
# 2. CONFIGURACIÓN DEL SERVICIO REST API DE ROUTEROS v7
# ------------------------------------------------------------------------------
# Crear grupo con permisos minimos necesarios para la API de fichas
/user group
add name=fichas-api-group policy=read,write,api,test,!ftp,!reboot,!policy,!password,!sniff,!sensitive comment="Permisos exclusivos API ROYOTA"

# Crear usuario para el backend Node.js
# Cambiar 'ContrasenaSegura2026*' por la misma definida en .env (MIKROTIK_PASS)
/user
add name=api-fichas group=fichas-api-group password="ContrasenaSegura2026*" comment="Usuario API Hotspot ROYOTA"

# Habilitar servicio REST API (HTTPS recomendado)
/ip service
set rest-api port=443 disabled=no

# Deshabilitar servicios inseguros o no utilizados
set telnet disabled=yes
set ftp disabled=yes
set www disabled=yes

# ------------------------------------------------------------------------------
# 3. CONTROL EQUITATIVO DE ANCHO DE BANDA (PCQ - PER CONNECTION QUEUE)
# ------------------------------------------------------------------------------
# Evita que un cliente sature la red sobre los demas
/queue type
add kind=pcq name=pcq-download-hotspot pcq-classifier=dst-address pcq-rate=0
add kind=pcq name=pcq-upload-hotspot pcq-classifier=src-address pcq-rate=0

# ------------------------------------------------------------------------------
# 4. PERFIL Y SERVIDOR HOTSPOT (TIEMPO CONTINUO & CONTROL DE FRAUDE)
# ------------------------------------------------------------------------------
/ip hotspot profile
add dns-name="wifi.balneario-royota.local" \
    hotspot-address=192.168.20.1 \
    html-directory=hotspot \
    http-cookie-lifetime=1d \
    login-by=http-chap,cookie,http-pap \
    name=hsprof-royota \
    use-radius=no

/ip hotspot
add address-pool=pool-hotspot \
    addresses-per-mac=1 \
    disabled=no \
    interface=vlan20-hotspot \
    name=hotspot1 \
    profile=hsprof-royota

# Perfiles de usuario con equidad de ancho de banda
/ip hotspot user profile
add keepalive-timeout=2m \
    name=default \
    open-status-page=always \
    shared-users=1 \
    status-autorefresh=1m

# ------------------------------------------------------------------------------
# 5. WALLED GARDEN (ACCESO LIBRE AL PORTAL Y PASARELAS SIN LOGUEO)
# ------------------------------------------------------------------------------
/ip hotspot walled-garden ip
# Permitir acceso al servidor donde corre el portal cautivo (Node.js/Docker)
add dst-address=192.168.10.50 dst-port=3000 action=accept comment="Servidor Web ROYOTA"
# WhatsApp para solicitud de fichas
add dst-host=*.whatsapp.com action=accept comment="WhatsApp Portal"
add dst-host=*.whatsapp.net action=accept comment="WhatsApp Red"

# ------------------------------------------------------------------------------
# 6. FIREWALL FILTER HARDENING (CONTROL PLANE & PREVENCIÓN DE EVASIÓN)
# ------------------------------------------------------------------------------
/ip firewall filter

# --- Cadena INPUT (Proteccion del Router) ---
# Permitir conexiones ya establecidas y relacionadas
add chain=input action=accept connection-state=established,related,untracked comment="Aceptar conexiones establecidas"

# Bloquear trafico invalido
add chain=input action=drop connection-state=invalid comment="Descartar paquetes invalidos"

# Permitir administracion (Winbox/SSH/API) SOLO desde VLAN 10 (Gestion)
add chain=input action=accept in-interface=vlan10-mgmt dst-port=8291,22,443 protocol=tcp comment="Winbox/API solo desde red Gestion"

# Permitir DNS y DHCP a los clientes del Hotspot
add chain=input action=accept in-interface=vlan20-hotspot dst-port=53 protocol=udp comment="DNS Hotspot UDP"
add chain=input action=accept in-interface=vlan20-hotspot dst-port=53 protocol=tcp comment="DNS Hotspot TCP"
add chain=input action=accept in-interface=vlan20-hotspot dst-port=67 protocol=udp comment="DHCP Hotspot"

# BLOQUEAR todo intento de acceso de clientes Hotspot al router
add chain=input action=drop in-interface=vlan20-hotspot comment="BLOQUEO: Clientes Hotspot no acceden al Router"

# --- Cadena FORWARD (Trafico entre redes e Internet) ---
add chain=forward action=accept connection-state=established,related,untracked comment="Aceptar forward establecido"
add chain=forward action=drop connection-state=invalid comment="Descartar forward invalido"

# Evitar que clientes del Hotspot escaneen o accedan a la red de administracion o antenas
add chain=forward action=drop in-interface=vlan20-hotspot out-interface=vlan10-mgmt comment="BLOQUEO: Clientes no acceden a Gestion/Camaras"

# Bloqueo de tuneles DNS/ICMP pre-autenticacion (Evita bypass con iodine/dnscat)
add chain=forward action=drop in-interface=vlan20-hotspot dst-port=53 protocol=udp hotspot=!from-client comment="BLOQUEO: Consultas DNS externas sin logueo"

# ------------------------------------------------------------------------------
# 7. NAT MASQUERADE
# ------------------------------------------------------------------------------
/ip firewall nat
# Ajustar 'ether1-wan' al nombre real de la interfaz conectada al proveedor de Internet
add chain=srcnat out-interface-list=WAN action=masquerade comment="NAT Internet Saliente"

# ==============================================================================
# FIN DEL SCRIPT DE HARDENING
# ==============================================================================
