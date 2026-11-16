import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { config } from './config.js';
import { migrate, getSetting, getSettingSync, shutdown } from './db.js';
import { api } from './routes.js';
import { admin } from './admin.js';
import { attachRealtime } from './realtime.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression({ threshold: 1024 }));
app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
app.use(express.json({ limit: '64kb' }));

// Render pings this often: answer from memory so it never wakes the database.
app.get('/health', (_req, res) => res.json({ ok: true }));

// Maintenance mode: app API pauses, admin keeps working.
app.use('/api', async (req, res, next) => {
  if (req.path === '/config') return next();
  if (getSettingSync('maintenance', false)) {
    return res.status(503).json({ error: 'Hush is under maintenance. Please try again soon.', maintenance: true });
  }
  next();
});

app.use('/api', api);
app.use('/admin/api', admin);
app.use('/admin', express.static(path.join(dir, '..', 'public', 'admin')));

// One link for everyone: /get sends Android to the APK, iPhone to the iOS app (TestFlight),
// and anyone else (or anyone who prefers) to the web app in Chrome/Safari.
app.get(['/get', '/download'], async (req, res) => {
  const ua = String(req.headers['user-agent'] || '');
  const apk = await getSetting('apkUrl', null);
  const ios = await getSetting('iosUrl', null);
  const wantsWeb = req.query.web != null;
  if (!wantsWeb && /Android/i.test(ua) && apk) return res.redirect(apk);
  if (!wantsWeb && /iPhone|iPad|iPod/i.test(ua) && ios) return res.redirect(ios);
  res.redirect('/');
});

// Optional: drop hush.apk into server/public/downloads to host it here (served at /downloads/hush.apk).
app.use('/downloads', express.static(path.join(dir, '..', 'public', 'downloads')));

// The web/PWA version of the app (built from /app with `npm run build:web`).
const webDir = path.join(dir, '..', 'public', 'web');
// Hashed app bundles never change → cache for a year. index.html / sw.js always revalidate.
app.use('/_expo', express.static(path.join(webDir, '_expo'), { maxAge: '365d', immutable: true }));
app.use('/assets', express.static(path.join(webDir, 'assets'), { maxAge: '30d' }));
app.use(express.static(webDir, {
  index: 'index.html',
  maxAge: '1d',
  setHeaders: (res, file) => {
    if (/index\.html$|sw\.js$|manifest\.webmanifest$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get(/^\/(?!api|admin|socket\.io).*/, (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(webDir, 'index.html'), (err) => err && next());
});
app.get('/', (_req, res) => res.type('text').send('Hush server is running. Build the web app to serve it here.'));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

const server = http.createServer(app);
attachRealtime(server);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await shutdown();
    process.exit(0);
  });
}

migrate()
  .then(() => server.listen(config.port, () => console.log(`[hush] server on http://localhost:${config.port}`)))
  .catch((e) => {
    console.error('[db] could not connect:', e.message);
    process.exit(1);
  });
