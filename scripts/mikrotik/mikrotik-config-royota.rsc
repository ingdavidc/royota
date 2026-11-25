# ==============================================================================
# PLANTILLA SANITIZADA (SIN CREDENCIALES) — MIKROTIK ROUTEROS v7
# Hotspot Fichas ROYOTA — Uso exclusivo interno fuera de public/ y docs/
# Sustituye <CAMBIAR_CONTRASENA_FUERTE> y <MIKROTIK_SYNC_TOKEN> antes de importar.
# ==============================================================================

/system identity set name="MikroTik-ROYOTA"
/system clock set time-zone-name="America/Bogota"
/ip cloud set ddns-enabled=yes update-time=yes

/interface bridge
add name=bridge-hotspot comment="Bridge para Antenas del Hotspot"

/interface bridge port
add bridge=bridge-hotspot interface=ether3 horizon=1 comment="Antena Zona 1 - Aislada L2"
add bridge=bridge-hotspot interface=ether4 horizon=1 comment="Antena Zona 2 - Aislada L2"
add bridge=bridge-hotspot interface=ether5 horizon=1 comment="Antena Zona 3 - Aislada L2"

/interface list
add name=WAN
add name=LAN_ADMIN
add name=LAN_HOTSPOT

/interface list member
add interface=ether1 list=WAN
add interface=ether2 list=LAN_ADMIN
add interface=bridge-hotspot list=LAN_HOTSPOT

/ip address
add address=192.168.10.1/24 interface=ether2 comment="Gateway Red Administracion"
add address=192.168.20.1/22 interface=bridge-hotspot comment="Gateway Clientes Hotspot"

/ip pool
add name=pool-admin ranges=192.168.10.50-192.168.10.100
add name=pool-hotspot ranges=192.168.20.10-192.168.23.250

/ip dhcp-server
add address-pool=pool-admin interface=ether2 lease-time=1d name=dhcp-admin disabled=no
add address-pool=pool-hotspot interface=bridge-hotspot lease-time=1h name=dhcp-hotspot disabled=no

/ip dhcp-server network
add address=192.168.10.0/24 gateway=192.168.10.1 dns-server=192.168.10.1
add address=192.168.20.0/22 gateway=192.168.20.1 dns-server=192.168.20.1 netmask=22

/ip dns
set allow-remote-requests=yes cache-size=4096KiB servers=1.1.1.1,8.8.8.8

# NOTA DE AUDITORÍA: Se desactiva 'trial' abierto para impedir bypass por MAC aleatoria
/ip hotspot profile
add dns-name="wifi.balneario-royota.local" \
    hotspot-address=192.168.20.1 \
    html-directory=hotspot \
    http-cookie-lifetime=1d \
    login-by=http-chap,cookie \
    name=hsprof-royota \
    use-radius=no

/ip hotspot
add address-pool=pool-hotspot \
    addresses-per-mac=1 \
    disabled=no \
    interface=bridge-hotspot \
    name=hotspot1 \
    profile=hsprof-royota

# Walled Garden estricto (sin comodines *onrender.com* ni WhatsApp abierto)
/ip hotspot walled-garden
add dst-host=royota.dctelematica.com action=allow comment="Portal Oficial"
add dst-host=royota-bot.onrender.com action=allow comment="Backend API"
add dst-host=firestore.googleapis.com action=allow comment="Firebase Firestore"
add dst-host=identitytoolkit.googleapis.com action=allow comment="Firebase Auth"

/ip service
set rest-api disabled=no port=443
set www disabled=yes
set winbox disabled=no port=8291
set ssh disabled=no port=22
set telnet disabled=yes
set ftp disabled=yes
set api disabled=yes
set api-ssl disabled=yes

/user group
add name=fichas-api-group policy=read,write,api,test,!ftp,!reboot,!policy,!password,!sniff,!sensitive

/user
add name=api-fichas group=fichas-api-group password="<CAMBIAR_CONTRASENA_FUERTE>"

# NOTA DE AUDITORÍA: No exponer puerto 443 REST API a WAN abierta (usar VPN WireGuard/BTH o IP fija)
/ip firewall filter disable [find action=fasttrack-connection]
add chain=input action=accept connection-state=established,related,untracked
add chain=input action=drop connection-state=invalid
add chain=input action=accept in-interface=ether2 protocol=tcp dst-port=8291,22,443
add chain=input action=accept in-interface=bridge-hotspot protocol=udp dst-port=53
add chain=input action=accept in-interface=bridge-hotspot protocol=tcp dst-port=53
add chain=input action=accept in-interface=bridge-hotspot protocol=udp dst-port=67
add chain=input action=drop in-interface=bridge-hotspot

add chain=forward action=drop src-address=192.168.20.0/22 hotspot=!auth comment="BLOQUEO HERMETICO"
add chain=forward action=accept connection-state=established,related
add chain=forward action=drop connection-state=invalid
add chain=forward action=drop in-interface=bridge-hotspot out-interface=ether2
add chain=forward action=drop in-interface=bridge-hotspot protocol=udp dst-port=53 hotspot=!from-client

/ip firewall nat
add chain=srcnat out-interface-list=WAN action=masquerade
