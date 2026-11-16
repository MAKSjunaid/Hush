// Runs after `expo export` for web: adds the PWA manifest, iPhone home-screen tags and service worker.
const fs = require('fs');
const path = require('path');
const out = process.argv[2] || path.join(__dirname, '..', '..', 'server', 'public', 'web');
const file = path.join(out, 'index.html');
let html = fs.readFileSync(file, 'utf8');
const head = `
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Hush">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>html,body{overflow-x:hidden;overscroll-behavior:none;-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:manipulation}input,textarea{font-size:16px}body{background:#0B0B0F}</style>`;
const sw = `<script>if('serviceWorker' in navigator){addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))}</script>`;
if (!html.includes('manifest.webmanifest')) {
  html = html.replace(/<meta name="viewport"[^>]*>/, '').replace('</head>', `${head}\n</head>`).replace('</body>', `${sw}\n</body>`);
  fs.writeFileSync(file, html);
}
console.log('PWA tags added to', file);
