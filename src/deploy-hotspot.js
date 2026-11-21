const { ftpUpload } = require('./ftp-upload');

const loginHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta http-equiv="pragma" content="no-cache">
  <meta http-equiv="expires" content="-1">
  <meta http-equiv="refresh" content="0; url=https://royota.dctelematica.com/?mac=\$(mac)&ip=\$(ip)&username=\$(username)&link-login=\$(link-login-only-esc)&link-orig=\$(link-orig-esc)&error=\$(error-esc)">
  <title>Balneario Río Royota — Conectando</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: linear-gradient(135deg, #041921 0%, #0a2933 100%);
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
      text-align: center;
    }
    .card {
      background: rgba(10, 41, 51, 0.95);
      border: 1px solid rgba(0, 229, 255, 0.35);
      border-radius: 20px;
      padding: 36px 24px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6);
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(0, 229, 255, 0.2);
      border-top-color: #00e5ff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 700;
      color: #00e5ff;
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.25);
      padding: 4px 12px;
      border-radius: 20px;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      margin-bottom: 6px;
      color: #ffffff;
    }
    p {
      font-size: 13.5px;
      color: #80cbc4;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .btn-main {
      display: block;
      width: 100%;
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #041921;
      text-decoration: none;
      font-weight: 800;
      font-size: 15px;
      padding: 14px 20px;
      border-radius: 12px;
      box-shadow: 0 6px 20px rgba(0, 229, 255, 0.4);
      margin-bottom: 14px;
    }
    .btn-wa {
      display: block;
      width: 100%;
      background: #25d366;
      color: #ffffff;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      padding: 12px 20px;
      border-radius: 12px;
      margin-bottom: 16px;
    }
    .fallback-box {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid rgba(0, 229, 255, 0.15);
    }
    .fallback-input {
      width: 100%;
      padding: 12px 14px;
      font-size: 15px;
      text-align: center;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 2px;
      color: #fff;
      background: rgba(4, 25, 33, 0.9);
      border: 1.5px solid rgba(0, 229, 255, 0.3);
      border-radius: 10px;
      margin-bottom: 10px;
      outline: none;
    }
    .fallback-btn {
      width: 100%;
      padding: 11px;
      background: rgba(0, 229, 255, 0.15);
      border: 1px solid #00e5ff;
      color: #00e5ff;
      font-weight: 700;
      border-radius: 10px;
      cursor: pointer;
    }
    .powered {
      font-size: 11px;
      color: #546e7a;
      margin-top: 18px;
    }
  </style>
  <script>
    var target = "https://royota.dctelematica.com/?mac=\$(mac)&ip=\$(ip)&username=\$(username)&link-login=\$(link-login-only-esc)&link-orig=\$(link-orig-esc)&error=\$(error-esc)";
    try {
      window.location.replace(target);
    } catch (_) {
      window.location.href = target;
    }
  </script>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <span class="badge">🌿 BALNEARIO & RÍO ROYOTA</span>
    <h1>Portal WiFi Royota</h1>
    <p>Redirigiendo al portal oficial para activar tu ficha de navegación...</p>

    <a class="btn-main" href="https://royota.dctelematica.com/?mac=\$(mac)&ip=\$(ip)&username=\$(username)&link-login=\$(link-login-only-esc)&link-orig=\$(link-orig-esc)&error=\$(error-esc)">
      🌊 Entrar al Portal Web
    </a>

    <a class="btn-wa" href="https://wa.me/573123456789?text=%C2%A1Hola!%20Estoy%20en%20el%20Balneario%20R%C3%ADo%20Royota%20y%20deseo%20comprar%20una%20ficha%20de%20internet%20WiFi." target="_blank">
      💬 Pedir Ficha por WhatsApp
    </a>

    <div class="fallback-box">
      <p style="font-size:12px; margin-bottom:8px; color:#80cbc4;">¿Ya tienes código? Ingresa directo:</p>
      <form name="login" action="\$(link-login-only)" method="post">
        <input type="hidden" name="dst" value="\$(link-orig)" />
        <input type="hidden" name="popup" value="true" />
        <input type="hidden" name="password" id="passField" value="" />
        <input type="text" name="username" class="fallback-input" placeholder="CÓDIGO DE FICHA" required oninput="document.getElementById('passField').value=this.value.toUpperCase(); this.value=this.value.toUpperCase();">
        <button type="submit" class="fallback-btn">⚡ Conectar Directo</button>
      </form>
    </div>

    <div class="powered">Powered by DC Telemática</div>
  </div>
</body>
</html>`;

const aloginHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="2; url=\$(link-orig-esc)">
  <title>¡Conectado! — Balneario Río Royota</title>
  <style>
    body {
      background: linear-gradient(135deg, #041921 0%, #0a2933 100%);
      color: #ffffff;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 20px;
    }
    .card {
      background: rgba(10, 41, 51, 0.95);
      border: 1px solid rgba(0, 229, 255, 0.35);
      border-radius: 20px;
      padding: 35px 25px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 22px; color: #00e5ff; margin-bottom: 8px; }
    p { font-size: 14px; color: #e0f2f1; line-height: 1.5; margin-bottom: 20px; }
    .btn {
      display: inline-block;
      background: #00e5ff;
      color: #041921;
      padding: 12px 24px;
      border-radius: 12px;
      font-weight: 800;
      text-decoration: none;
    }
  </style>
  <script>
    setTimeout(function() {
      var orig = "\$(link-orig)";
      if (orig && orig !== "" && orig.indexOf("http") === 0) {
        window.location.href = orig;
      }
    }, 2000);
  </script>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>¡Conexión Exitosa!</h1>
    <p>Ya tienes acceso a Internet en el <strong>Balneario Río Royota</strong>. Disfruta tu estadía junto al río 🌿</p>
    <a class="btn" href="\$(link-orig)">Comenzar a navegar</a>
  </div>
</body>
</html>`;

(async () => {
  try {
    console.log('Uploading login.html...');
    const r1 = await ftpUpload('flash/hotspot/login.html', loginHtml);
    console.log('login.html upload result:', r1);

    console.log('Uploading alogin.html...');
    const r2 = await ftpUpload('flash/hotspot/alogin.html', aloginHtml);
    console.log('alogin.html upload result:', r2);

    console.log('DONE!');
  } catch (err) {
    console.error('Upload error:', err);
  }
})();
