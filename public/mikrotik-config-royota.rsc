# ==============================================================================
# 📶 SCRIPT DE CONFIGURACIÓN MAESTRO DESDE CERO — MIKROTIK ROUTEROS v7
# Dispositivo: MikroTik hEX S (RB760iGS) — Firmware 7.25.1 / 7.x
# Proyecto: Hotspot Fichas ROYOTA — Balneario Río Royota
# ==============================================================================
# Distribución física de puertos:
#   - ether1: WAN (Módem Internet / ONT de Fibra por DHCP)
#   - ether2: Red de Administración y Servidor Web ROYOTA (192.168.10.0/24)
#   - ether3, ether4, ether5: Antenas / APs Hotspot Clientes (192.168.20.0/22)
#   - sfp1: Disponible para enlace futuro o WAN secundaria
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. IDENTIFICACIÓN Y CONFIGURACIÓN BÁSICA DEL SISTEMA
# ------------------------------------------------------------------------------
/system identity set name="MikroTik-ROYOTA"
/system clock set time-zone-name="America/Bogota"

# Activar MikroTik Cloud (DDNS gratuito para conexión desde la nube / Render)
/ip cloud set ddns-enabled=yes update-time=yes

# ------------------------------------------------------------------------------
# 2. BRIDGES Y SEGMENTACIÓN FÍSICA DE PUERTOS
# ------------------------------------------------------------------------------
# Bridge exclusivo para los Puntos de Acceso del Balneario
/interface bridge
add name=bridge-hotspot comment="Bridge para Antenas del Hotspot (ether3 a ether5)"

# Asignar puertos ether3, ether4 y ether5 al bridge con AISLAMIENTO L2 (Horizon=1)
# El parámetro horizon=1 impide que el tráfico salte entre antenas a nivel de Capa 2
/interface bridge port
add bridge=bridge-hotspot interface=ether3 horizon=1 comment="Antena Zona 1 - Aislada L2"
add bridge=bridge-hotspot interface=ether4 horizon=1 comment="Antena Zona 2 - Aislada L2"
add bridge=bridge-hotspot interface=ether5 horizon=1 comment="Antena Zona 3 - Aislada L2"

# ------------------------------------------------------------------------------
# 3. INTERFACES LIST (WAN & LAN)
# ------------------------------------------------------------------------------
/interface list
add name=WAN
add name=LAN_ADMIN
add name=LAN_HOTSPOT

/interface list member
add interface=ether1 list=WAN comment="Entrada de Internet"
add interface=ether2 list=LAN_ADMIN comment="PC y Servidor ROYOTA"
add interface=bridge-hotspot list=LAN_HOTSPOT comment="Clientes Hotspot"

# ------------------------------------------------------------------------------
# 4. DIRECCIONAMIENTO IP
# ------------------------------------------------------------------------------
/ip address
# Red Admin y Servidor Web ROYOTA (ether2 directo)
add address=192.168.10.1/24 interface=ether2 comment="Gateway Red Administracion y Servidor"

# Red Hotspot Amplia /22 (1022 hosts) para soportar más de 500 clientes concurrentes
add address=192.168.20.1/22 interface=bridge-hotspot comment="Gateway Clientes Hotspot (1022 IPs)"

# Cliente DHCP en ether1 para recibir Internet del módem
/ip dhcp-client
add interface=ether1 disabled=no use-peer-dns=yes use-peer-ntp=yes add-default-route=yes comment="Internet WAN por DHCP"

# ------------------------------------------------------------------------------
# 5. POOLS Y SERVIDORES DHCP
# ------------------------------------------------------------------------------
/ip pool
# Pool para computadoras/servidores en red Admin (192.168.10.50 a 192.168.10.100)
add name=pool-admin ranges=192.168.10.50-192.168.10.100

# Pool para Hotspot: 961 direcciones IP utilizables (.20.10 a .23.250)
add name=pool-hotspot ranges=192.168.20.10-192.168.23.250

# Servidor DHCP Admin (lease 1 día)
/ip dhcp-server
add address-pool=pool-admin interface=ether2 lease-time=1d name=dhcp-admin disabled=no

# Servidor DHCP Hotspot (lease 1 hora: recicla rápidamente IPs de bañistas que se van)
add address-pool=pool-hotspot interface=bridge-hotspot lease-time=1h name=dhcp-hotspot disabled=no

# Parámetros de red entregados por DHCP
/ip dhcp-server network
add address=192.168.10.0/24 gateway=192.168.10.1 dns-server=192.168.10.1 comment="Red Admin"
add address=192.168.20.0/22 gateway=192.168.20.1 dns-server=192.168.20.1 netmask=22 comment="Red Hotspot Clientes (1022 hosts)"

# Servidor DNS con cache local
/ip dns
set allow-remote-requests=yes cache-size=4096KiB servers=1.1.1.1,8.8.8.8

# ------------------------------------------------------------------------------
# 6. GESTIÓN EQUITATIVA DE ANCHO DE BANDA (PCQ - PER CONNECTION QUEUE)
# ------------------------------------------------------------------------------
# Garantiza que un usuario no acapare el canal sobre los otros 499+ clientes
/queue type
add kind=pcq name=pcq-down-hotspot pcq-classifier=dst-address pcq-rate=0 pcq-total-limit=4000KiB
add kind=pcq name=pcq-up-hotspot pcq-classifier=src-address pcq-rate=0 pcq-total-limit=4000KiB

# ------------------------------------------------------------------------------
# 7. PERFIL Y SERVIDOR HOTSPOT (TIEMPO CONTINUO & CONTROL DE FRAUDE)
# ------------------------------------------------------------------------------
/ip hotspot profile
add dns-name="wifi.balneario-royota.local" \
    hotspot-address=192.168.20.1 \
    html-directory=hotspot \
    http-cookie-lifetime=1d \
    login-by=http-chap,cookie,http-pap,trial \
    trial-uptime-limit=2m \
    trial-uptime-reset=1d \
    trial-user-profile=perfil-trial-2m \
    name=hsprof-royota \
    use-radius=no

/ip hotspot
add address-pool=pool-hotspot \
    addresses-per-mac=1 \
    disabled=no \
    interface=bridge-hotspot \
    name=hotspot1 \
    profile=hsprof-royota

# Perfil de usuario con colas y actualización de estado
/ip hotspot user profile
set [find default=yes] \
    keepalive-timeout=2m \
    open-status-page=always \
    shared-users=1 \
    status-autorefresh=1m \
    transparent-proxy=no

# Perfil exclusivo para 2 minutos de navegacion de cortesia para pagos moviles (Daviplata o Bre-B)
add name=perfil-trial-2m \
    rate-limit=5M/5M \
    keepalive-timeout=2m \
    status-autorefresh=30s \
    shared-users=1 \
    comment="Cortesia 2m pago Daviplata Bre-B"

# Programador a medianoche (00:00:00) para eliminar todas las fichas iniciadas y reiniciar cortesias
/system scheduler
add name=reset-midnight-royota \
    start-time=00:00:00 \
    interval=1d \
    on-event="/ip hotspot active remove [find]; /ip hotspot user remove [find uptime>0s]; /ip hotspot user remove [find comment~\"Cortesia\"]; /ip hotspot user remove [find comment~\"WA-\"]; :log info \"ROYOTA: Fichas iniciadas eliminadas a medianoche.\"" \
    comment="Eliminacion de fichas iniciadas a medianoche"

# ------------------------------------------------------------------------------
# 8. WALLED GARDEN (ACCESO EXCLUSIVO AL PORTAL CAUTIVO PREVIO AL PAGO)
# ------------------------------------------------------------------------------
/ip hotspot walled-garden ip
# Acceso libre al Servidor Web ROYOTA si corre en ether2 (192.168.10.0/24 port 3000)
add dst-address=192.168.10.0/24 dst-port=3000 action=accept comment="Servidor Local ROYOTA Port 3000"
# Consultas directas al DNS del router
add dst-address=192.168.20.1 dst-port=53 protocol=udp action=accept comment="DNS Hotspot UDP"
add dst-address=192.168.20.1 dst-port=53 protocol=tcp action=accept comment="DNS Hotspot TCP"

# Dominios estrictamente necesarios para cargar el portal cautivo antes de autenticarse
# NOTA: NO incluir *whatsapp* ni *googleapis.com* generales aquí para evitar fugas de internet sin ficha
/ip hotspot walled-garden
add dst-host=*dctelematica.com* action=allow comment="Portal Oficial royota.dctelematica.com"
add dst-host=*firestore.googleapis.com* action=allow comment="Firebase Firestore DB"
add dst-host=*identitytoolkit.googleapis.com* action=allow comment="Firebase Auth"
add dst-host=*firebaseio.com* action=allow comment="Firebase Realtime"
add dst-host=*onrender.com* action=allow comment="Servidor en la Nube Render"

# ------------------------------------------------------------------------------
# 9. SERVICIO REST API DE ROUTEROS v7 PARA EL SERVIDOR WEB
# ------------------------------------------------------------------------------
/ip service
set rest-api disabled=no port=443
set www disabled=no port=80
set winbox disabled=no port=8291
set ssh disabled=no port=22
set telnet disabled=yes
set ftp disabled=yes
set api disabled=yes
set api-ssl disabled=yes

# Crear grupo con permisos exactos (principio de menor privilegio)
/user group
add name=fichas-api-group \
    policy=read,write,api,test,!ftp,!reboot,!policy,!password,!sniff,!sensitive \
    comment="Permisos exclusivos para automatizacion ROYOTA"

# Crear usuario api-fichas
/user
add name=api-fichas \
    group=fichas-api-group \
    password="RoyotaWifi2026*" \
    comment="Usuario REST API para activacion y corte de fichas"

# ------------------------------------------------------------------------------
# 10. NAT Y FIREWALL DE HARDENING (BLUE TEAM)
# ------------------------------------------------------------------------------
# NAT Masquerade hacia Internet
/ip firewall nat
add chain=srcnat out-interface-list=WAN action=masquerade comment="NAT Internet WAN"

# --- FIREWALL FILTER: CADENA INPUT (Proteccion del Router) ---
/ip firewall filter
# Aceptar conexiones ya establecidas y relacionadas
add chain=input action=accept connection-state=established,related,untracked comment="Aceptar establecidas"
add chain=input action=drop connection-state=invalid comment="Descartar paquetes invalidos"

# Permitir administracion (Winbox/SSH/Web) UNICAMENTE desde la red ether2 (Admin)
add chain=input action=accept in-interface=ether2 protocol=tcp dst-port=8291,22,80,443 comment="Admin permitido desde ether2"

# Permitir REST API desde la WAN (para cuando Render / Nube llame al router)
add chain=input action=accept in-interface-list=WAN protocol=tcp dst-port=443 comment="REST API accesible desde Nube"

# Permitir DNS y DHCP a los clientes del Hotspot
add chain=input action=accept in-interface=bridge-hotspot protocol=udp dst-port=53 comment="DNS Hotspot UDP"
add chain=input action=accept in-interface=bridge-hotspot protocol=tcp dst-port=53 comment="DNS Hotspot TCP"
add chain=input action=accept in-interface=bridge-hotspot protocol=udp dst-port=67 comment="DHCP Hotspot"

# BLOQUEO CRÍTICO: Ningún cliente Hotspot puede acceder a la IP del router ni a Winbox
add chain=input action=drop in-interface=bridge-hotspot comment="BLOQUEO AUDITORIA: Clientes no tocan el Router"

# --- FIREWALL FILTER: CADENA FORWARD (Trafico entre Redes) ---
# Desactivar FastTrack (Incompatible con Hotspot: evita que conexiones HTTPS evadan el portal)
# /ip firewall filter disable [find action=fasttrack-connection]

add chain=forward action=accept connection-state=established,related comment="Aceptar forward establecido"
add chain=forward action=drop connection-state=invalid comment="Descartar forward invalido"

# BLOQUEO CRÍTICO: Los clientes del Hotspot NO pueden alcanzar la red ether2 (Admin/Servidor)
add chain=forward action=drop in-interface=bridge-hotspot out-interface=ether2 comment="BLOQUEO AUDITORIA: Hotspot aislado de Red Admin"

# BLOQUEO DE TÚNELES DNS (Evita bypass pre-autenticación tipo iodine o dnscat)
add chain=forward action=drop in-interface=bridge-hotspot protocol=udp dst-port=53 hotspot=!from-client comment="BLOQUEO AUDITORIA: Tunel DNS no autorizado"

# 🔒 REGLA DE ORO DE SEGURIDAD CONTRA FUGAS (HTTPS / 'Usar sin internet' de iOS):
# BLOQUEAR TODO TRÁFICO HACIA INTERNET DE CLIENTES QUE NO ESTÉN AUTENTICADOS EN EL HOTSPOT
# Sin esta regla, el tráfico HTTPS (puerto 443) navega libremente sin ficha.
add chain=forward action=drop in-interface=bridge-hotspot hotspot=!auth out-interface-list=WAN comment="BLOQUEO HERMETICO: Hotspot no autenticado NO navega en WAN"
add chain=forward action=drop in-interface=bridge-hotspot hotspot=!auth comment="BLOQUEO HERMETICO: Rechazar todo trafico no autenticado"

# ==============================================================================
# FIN DEL SCRIPT DE CONFIGURACIÓN
# ==============================================================================
