# Hush

Private chat. Username-only accounts, end-to-end encryption, messages that vanish once seen, and screenshot protection.

```
Hush/
  app/      Expo app → Android APK, iPhone app, and the web/PWA version
  server/   Node.js server (API + real-time chat + admin dashboard + hosts the web app)
  render.yaml   one-click deploy to Render
```

One link for everyone: `https://YOUR-SERVER/get`. Android phones get the APK, iPhones get the TestFlight link, and anyone can use Hush in Chrome or Safari at `https://YOUR-SERVER/`.

---

## 1. Run it on your computer (IntelliJ)

Needs **Node.js 22** (https://nodejs.org).

1. Open the `Hush` folder in IntelliJ (File → Open). Accept "Trust project".
2. In the IntelliJ terminal run once:
   ```
   npm run setup
   ```
3. Top-right run menu → **"Hush: server + web"** → ▶
   - The server starts on http://localhost:4000 and connects to your Neon database (tables are created automatically).
   - The web app opens on http://localhost:8081. Make two accounts (use a second browser or a private window) to chat with yourself.
4. Admin dashboard: http://localhost:4000/admin. The username and password are in `server/.env` (`ADMIN_USERNAME` and `ADMIN_PASSWORD`).

Run configurations included (`.idea/runConfigurations`):

| Name | What it does |
|---|---|
| 1. Hush server | API + chat server with auto-restart |
| 2. Hush web (browser) | Web version for development |
| 3. Hush app (Expo – phone) | QR code to open the app on your phone with **Expo Go** |
| Build web for server | Bundles the web app into `server/public/web` so the server hosts it |

**On your phone (Expo Go):** install "Expo Go" from Play Store/App Store. In `app/.env` set `EXPO_PUBLIC_API_URL` to your PC's Wi-Fi address, e.g. `http://192.168.1.20:4000` (find it with `ipconfig`). Run "3. Hush app" and scan the QR code. The phone and PC must be on the same Wi-Fi.

> Push notifications and Face ID need a real build (step 3), not Expo Go.

## 2. Put the server online (Render)

1. Create a GitHub repo and push this folder. `.env` files are ignored, so your secrets stay local.
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml` and creates `hush-server` in Singapore.
3. Fill in the values Render asks for:
   - `DATABASE_URL`: your Neon URL (it's in `server/.env`)
   - `ADMIN_PASSWORD`: pick a strong one
   - The R2 keys can stay empty for now. Photo sending switches on once they're set (step 4).
4. When it's live you get `https://hush-server-xxxx.onrender.com`. Opening it shows the web app.

Free plan note: the server sleeps after ~15 min idle and takes ~1 min to wake. Change `plan: free` to `starter` when real people use it.

## 3. Build the APK and iPhone app (no Android Studio / Xcode needed)

Builds run in Expo's cloud (free tier is enough).

```
cd app
npm install -g eas-cli
eas login            # create a free account at expo.dev
eas init             # links the project (enables push notifications)
eas update:configure # enables instant over-the-air updates
```

Then edit `app/eas.json` and replace `https://YOUR-RENDER-APP.onrender.com` with your Render address (both places).

**Android APK:**
```
npm run build:apk
```
When it finishes you get a download link for `Hush.apk`. Share that file on WhatsApp, or paste the link into Admin → App settings → "Android APK download link" so `/get` serves it.

**iPhone:** needs an Apple Developer account ($99/year). This is Apple's fee, not a Hush one.
```
npm run build:ios
npm run submit:ios
```
In App Store Connect → TestFlight, add a "Public link" and paste it into Admin → App settings → "iPhone app link". iPhones cannot install an `.ipa` sent on WhatsApp, so share the `/get` link instead.

**Updates without a new APK:** after changing app code run `npm run update`. Installed apps get it the next time they open. Only changes to native settings (app.json plugins and permissions) need a new build.

## 4. Photos (Cloudflare R2)

1. Cloudflare dashboard → R2 → Create bucket `hush-media`.
2. R2 → Manage API tokens → create a token with "Object Read & Write" on that bucket.
3. Bucket → Settings → CORS policy:
   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
4. Put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in `server/.env` (local) and in Render's Environment tab.

Photos are encrypted on the phone before upload, so R2 only stores unreadable data. They're deleted when opened (view-once) or when the timer runs out.

---

## How it works

- **Accounts:** username + password only (bcrypt-hashed). A 12-word recovery key is shown once at signup and is the only way to reset a forgotten password.
- **One device at a time:** logging in on a new device signs out the old one and creates new encryption keys. Messages sent to the old device can't be opened on the new one.
- **Encryption:** each device makes a key pair (Curve25519 via TweetNaCl). Messages are encrypted on the phone, so the server and the admin dashboard only ever see scrambled text. Compare "safety codes" in a chat (⋮ → Verify safety code) to confirm.
- **Vanishing:**
  - "On seen": deleted from the server the moment it's read, and gone from the reader's screen when they leave the chat.
  - Timers (5s, 30s, 1m, 1h, 24h, 7d) start when the message is seen.
  - Unopened messages expire after 7 days.
  - Screenshot notices disappear after 24 hours.
- **Screenshots:**
  - Android: screenshots and screen recordings of chats come out black.
  - iPhone (iOS 13+): screenshots are blocked or come out blank.
  - In both cases the other person sees "X tried to take a screenshot" in the chat (detection works where the phone's OS reports it: Android 14+, iOS).
  - Browsers can't block or detect screenshots, and the chat says so.
  - Nothing can stop a second phone's camera.
- **Message requests:** strangers can't message you until you accept. You can block (which wipes pending messages) and report. Reports can include the message text, but only if the reporter chooses to attach it.
- **App lock:** 4-digit PIN plus Face ID or fingerprint. Chats are hidden in the app switcher.
- **Notifications:** they only ever say "New message".
- **Admin** (`/admin`): user and activity counts, reports queue, suspend/ban, maintenance mode, announcements, app version and download links, server health, admin activity log. Optional 2-step login: run `npm run admin-2fa` in `server/`.

## Settings reference

| File | Setting | Meaning |
|---|---|---|
| server/.env | DATABASE_URL | Neon Postgres connection |
| server/.env | JWT_SECRET | Signs login tokens. Changing it logs everyone out |
| server/.env | ADMIN_USERNAME / ADMIN_PASSWORD | Admin dashboard login |
| server/.env | ADMIN_TOTP_SECRET | Optional 2-step code for admin |
| server/.env | R2_* | Photo storage |
| app/.env | EXPO_PUBLIC_API_URL | Server address for local phone testing |
| app/eas.json | EXPO_PUBLIC_API_URL | Server address baked into APK/iPhone builds |

Before launch: rotate the Neon password (it was shared in chat during setup) and update `DATABASE_URL` in `server/.env` and Render.
