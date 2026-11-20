/**
 * cloudflare/worker.js
 * ─────────────────────────────────────────────────────────────
 * Cloudflare Worker para servir el portal desde:
 * https://www.dctelematica.com/royota
 *
 * Reenvía transparentemente las peticiones de /royota hacia tu
 * repositorio en GitHub Pages (ej: https://tuusuario.github.io/fichas-royota)
 */

const GITHUB_PAGES_ORIGIN = 'https://TU_USUARIO.github.io/TU_REPOSITORIO';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Si la ruta comienza con /royota
    if (url.pathname.startsWith('/royota')) {
      // Remover '/royota' para buscar en el origen de GitHub Pages
      let targetPath = url.pathname.replace(/^\/royota/, '') || '/';
      if (targetPath === '/') targetPath = '/index.html';

      const targetUrl = new URL(targetPath + url.search, GITHUB_PAGES_ORIGIN);

      const modifiedRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'follow',
      });

      return fetch(modifiedRequest);
    }

    // Para cualquier otra ruta de www.dctelematica.com, continuar al sitio principal
    return fetch(request);
  },
};
