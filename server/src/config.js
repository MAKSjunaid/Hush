import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n[config] Missing ${name}. Copy server/.env.example to server/.env and fill it in.\n`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    totpSecret: process.env.ADMIN_TOTP_SECRET || '',
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || 'hush-media',
  },
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
};

export const r2Enabled = () =>
  Boolean(config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey);
