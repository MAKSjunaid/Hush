-- Hush database schema. Safe to run on every start (idempotent).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  display_name        text NOT NULL,
  password_hash       text NOT NULL,
  recovery_hash       text NOT NULL,
  public_key          text,
  token_version       integer NOT NULL DEFAULT 0,
  push_token          text,
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'active',  -- active | suspended | banned
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  username_changed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_username_prefix_idx ON users (lower(username) text_pattern_ops);

CREATE TABLE IF NOT EXISTS connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending',  -- pending | accepted | declined
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS connections_addressee_idx ON connections (addressee_id, status);
CREATE INDEX IF NOT EXISTS connections_requester_idx ON connections (requester_id, status);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reported_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  reason       text NOT NULL,
  evidence     text,             -- message text the reporter chose to attach (decrypted on their device)
  status       text NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Messages hold only ciphertext. The server cannot read them.
CREATE TABLE IF NOT EXISTS messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          text,
  sender_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               text NOT NULL DEFAULT 'text',   -- text | photo | screenshot | recording
  ciphertext         text,
  nonce              text,
  self_ciphertext    text,
  self_nonce         text,
  sender_public_key  text,
  media_key          text,
  reply_to           uuid,
  view_once          boolean NOT NULL DEFAULT false,
  timer_seconds      integer,                         -- NULL = vanish as soon as seen
  created_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at       timestamptz,
  seen_at            timestamptz,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  UNIQUE (sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient_id, created_at);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id, created_at);
CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages (expires_at);

CREATE TABLE IF NOT EXISTS reactions (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_activity (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL DEFAULT current_date,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day          date PRIMARY KEY DEFAULT current_date,
  messages     integer NOT NULL DEFAULT 0,
  screenshots  integer NOT NULL DEFAULT 0,
  signups      integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id          bigserial PRIMARY KEY,
  admin       text NOT NULL,
  action      text NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Extra indexes for the lookups the server does most.
CREATE INDEX IF NOT EXISTS messages_media_key_idx ON messages (media_key) WHERE media_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_undelivered_idx ON messages (recipient_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_reported_idx ON reports (reported_id);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);
CREATE INDEX IF NOT EXISTS user_activity_day_idx ON user_activity (day);

-- Photos when Cloudflare R2 isn't set up: encrypted bytes, deleted once seen / expired.
CREATE TABLE IF NOT EXISTS media (
  key         text PRIMARY KEY,
  data        bytea NOT NULL,
  size        integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE media ALTER COLUMN data SET STORAGE EXTERNAL; -- already encrypted: skip pointless compression
