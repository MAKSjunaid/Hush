import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { migrate, getSetting, pool } from './db.js';
import { api } from './routes.js';
import { admin } from './admin.js';
import { attachRealtime } from './realtime.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Maintenance mode: app API pauses, admin keeps working.
app.use('/api', async (req, res, next) => {
  if (req.path === '/config') return next();
  if (await getSetting('maintenance', false)) {
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
app.use(express.static(webDir, { index: 'index.html', maxAge: '1h' }));
app.get(/^\/(?!api|admin|socket\.io).*/, (_req, res, next) =>
  res.sendFile(path.join(webDir, 'index.html'), (err) => err && next()),
);
app.get('/', (_req, res) => res.type('text').send('Hush server is running. Build the web app to serve it here.'));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

const server = http.createServer(app);
attachRealtime(server);

migrate()
  .then(() => server.listen(config.port, () => console.log(`[hush] server on http://localhost:${config.port}`)))
  .catch((e) => {
    console.error('[db] could not connect:', e.message);
    process.exit(1);
  });
