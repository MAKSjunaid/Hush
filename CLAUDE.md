# Hush — rules for anyone (or any AI) working on this project

## Always free — no exceptions
- Everything must stay on **free plans**: Neon (database), Render (hosting), Cloudflare, GitHub, Expo/EAS and any other service.
- Never pick a paid plan or paid add-on, never upgrade a plan, and never set anything up that needs a card or payment details.
- If a feature would need a paid service or a card, build a free alternative instead (example: photos are stored briefly in the Neon database instead of Cloudflare R2, which asks for a card).
- Keep usage well inside free limits: minimal database queries, caching, small payloads, no polling.

## How the owner works
- Office laptop: do not run git or commit from the laptop. Changes go to GitHub through the browser.
- Secrets (database URL, passwords, keys) never go into the repo. They live only in Render's Environment settings and the local `server/.env` (gitignored).

## Where things live
- Live app (web, admin, `/get` download link): https://hushchat.onrender.com (Render service `hushchat`, Singapore, free, auto-deploys from `main`).
- Repo: https://github.com/MAKSjunaid/Hush
- `app/` — Expo app (Android APK, iPhone, web/PWA from one codebase). `server/` — Node API + Socket.IO + admin.

## Product rules
- Night mode is the default; users can switch day/night with one tap.
- Messages disappear once seen, but stay on screen until the person leaves the chat.
- Mobile web: no zoom when typing (16px inputs), no horizontal scroll.
