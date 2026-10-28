# Deploying Town-in-a-Box (step by step, no coding needed)

This guide puts the app online at a free address like `https://town-in-a-box.vercel.app`, with the
live AI residents (NVIDIA Nemotron on Nebius Token Factory) working behind it. You will:

1. put the code on GitHub (public, MIT licence visible),
2. import it into Vercel and click **Deploy**,
3. add the Token Factory key and check `/api/health`,
4. keep it online until **15 December 2026** (end of judging),
5. know how to switch the AI off if credits run low.

The app works **without** any key (mock mode: answers start with `[demo]` and a banner says so).
So you can deploy first and add the key later.

---

## 0. What you need

| Thing | Where | Cost |
| --- | --- | --- |
| GitHub account | https://github.com/signup | free |
| Vercel account (sign up **with GitHub**) | https://vercel.com/signup, choose the **Hobby** plan | free |
| Token Factory API key | https://tokenfactory.nebius.com, **API keys** page | uses your credits |

> **Golden rule for the key.** It goes in exactly two places: the repo-root `.env` file on your
> computer (never committed, Git ignores it) and Vercel's **Environment Variables** page.
> Never paste it into code, a GitHub issue, a chat or a screenshot. Never give it a name that starts
> with `VITE_`: Vite would copy anything named `VITE_...` into the public website code.

---

## 1. Put the code on GitHub (public repository)

The project folder is already a Git repository and already contains `LICENSE` (MIT) and `.gitignore`
(which keeps `.env` out).

**In IntelliJ IDEA (easiest, since the project is open there):**

1. Menu **Git → GitHub → Share Project on GitHub** (older versions: **VCS → Share Project on GitHub**).
   Log in to GitHub if asked.
2. **Repository name:** `town-in-a-box`. **Untick "Private"** (the hackathon needs a public repo).
   Description (optional): *Test a city proposal on 2,000 simulated Parisians before public consultation.*
3. Click **Share**. IntelliJ shows the files for the first commit.
   **Check that `.env` is NOT in the list** (`.env.example` is fine, it has no secrets). Click **Add**.
4. When it finishes, click the link to open the repo on github.com.
5. On GitHub, look at the right-hand **About** box: it should say **MIT license**.
   If not, check that `LICENSE` is at the top level of the repository (not inside a folder).

*Using the command line instead?* Create an empty **public** repo on github.com (no README, no licence),
then in the project folder: `git add -A`, `git commit -m "Town-in-a-Box"`,
`git remote add origin https://github.com/<you>/town-in-a-box.git`, `git push -u origin main`.
Before committing, run `git status` and make sure `.env` is not listed.

---

## 2. Import into Vercel

1. Go to https://vercel.com/new. Under **Import Git Repository**, click **Continue with GitHub** if needed,
   then **Import** next to `town-in-a-box`. (If it isn't listed: **Adjust GitHub App Permissions** and
   give Vercel access to that repo.)
2. On **Configure Project**:
   - **Project Name:** `town-in-a-box` (this becomes `town-in-a-box.vercel.app`, if the name is free).
   - **Root Directory:** click **Edit**, pick the **`web`** folder, click **Continue**. **This step matters.**
     Without it Vercel can't find the website or the `/api` functions.
   - **Framework Preset:** should now show **Vite**. Leave **Build and Output Settings** alone:
     `web/vercel.json` already sets them (build `vite build`, output `dist`).
   - **Environment Variables:** you can skip this now (mock mode) or add them right away (step 3).
3. Click **Deploy**. Wait about 1 minute for the confetti.
4. Click **Continue to Dashboard**, then **Visit**. The site opens.

> **Share the right address.** Use the short production domain shown under **Domains**
> (e.g. `https://town-in-a-box.vercel.app`). The long per-deployment URLs (`...-git-...vercel.app`)
> may ask visitors to log in to Vercel (Vercel's default "Deployment Protection" covers them).

---

## 3. Add the Token Factory key and test

1. In the Vercel project: **Settings → Environment Variables**.
2. Add each variable: type the **Key**, paste the **Value**, keep all environments ticked
   (Production, Preview, Development), and choose **Secret** for the API key. Click **Save**.

| Key | Value | Needed? |
| --- | --- | --- |
| `TOKEN_FACTORY_API_KEY` | your key from the Token Factory console | **yes** (mark it **Secret**) |
| `TOKEN_FACTORY_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | optional (this is the default) |
| `MODEL_REACTION` | e.g. `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | optional, see the check below |
| `MODEL_CONVERSATION` | e.g. `nvidia/nemotron-3-super-120b-a12b` | optional |
| `MODEL_SYNTHESIS` | e.g. `nvidia/Nemotron-3-Ultra-550b-a55b` | optional |
| `DISABLE_LIVE` | `0` | optional kill-switch (see step 5) |

   Fine-tuning knobs, all optional: `MODEL_ASK` (model for "ask a resident", default = `MODEL_REACTION`),
   `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_MIN` (default 320 AI calls per visitor at once, refilled at 32 per
   minute: two "Test your own idea" runs back to back), `LLM_BURST` / `LLM_RPM` (default 20 at once, then
   80 per minute in total, which keeps the site under the account's 100 requests per minute for Nano),
   `LIVE_DAILY_CALLS` (default 1000 AI calls per day per server instance, about $0.10; after that the site
   answers with `[demo]` texts until midnight UTC), `LLM_TIMEOUT_MS` (default 25000), `LLM_DISABLE_THINKING` (default 1 = quick direct
   answers), `LIVE_FALLBACK_TO_MOCK` (default 1 = if the AI fails, show a `[demo]` answer instead of an
   error), `ALLOWED_ORIGINS` (only needed for a custom domain behind a proxy).

3. **Redeploy.** Vercel only applies variable changes to *new* deployments:
   **Deployments** tab → the top deployment → **⋯** menu → **Redeploy** → **Redeploy**.
4. **Test.** Open these two addresses in your browser (use your own domain):
   - `https://town-in-a-box.vercel.app/api/health` should show `"ok":true` and `"mock":false`.
     (`"mock":true` means there is no key, or `DISABLE_LIVE=1`, or you forgot to redeploy.)
   - `https://town-in-a-box.vercel.app/api/health?check=1` asks Token Factory for its model list
     (free, uses no tokens) and should show `"keyAccepted":true` and `"modelsFound"` with every
     value `true`. If one is `false`, that model ID is wrong: copy the exact ID from the Token Factory
     **Models** page into the matching `MODEL_...` variable, save, and redeploy.
     The key itself is never shown.
5. In the app, click a resident and ask a question. A live answer does **not** start with `[demo]`.

*For the developer:* `cd web` then `node server/smokeApi.mjs https://town-in-a-box.vercel.app` runs
about 15 automatic checks against the live site (3 small AI calls).

---

## 4. Keep it online until 15 December 2026

- **Do nothing and it stays up.** Vercel never deletes the deployment that is currently "Production"
  (the one your domain points to), whatever its age.
- **Every push to `main` deploys again.** If a new deployment fails to build, the previous one simply
  stays live. If a new one builds but is broken: **Deployments** → the last good one → **⋯** →
  **Promote to Production** (instant rollback).
- **After submitting (30 Oct, 10:00 PT), avoid risky pushes to `main`.** Experiment on another branch:
  it gets its own preview URL and does not touch production.
- **Don't delete or rename** the Vercel project or the GitHub repo, and don't make the repo private.
- **Watch your credits.** Check the Token Factory console about once a week and set a spending limit or
  alert there if it offers one. On Vercel, **Usage** shows the free Hobby quota; a demo like this uses
  a tiny fraction.
- **Settings to leave as they are:** **Settings → Functions** (Fluid compute on by default; region Paris
  `cdg1`, set in `vercel.json`, close to Nebius in Europe) and **Settings → Build and Deployment →
  Node.js Version** (24.x is fine).

---

## 5. Credits running low? Switch the AI off (kill-switch)

The site keeps working. It just answers with clearly flagged `[demo]` texts and shows the mock banner.

1. **Settings → Environment Variables** → `DISABLE_LIVE` → **Edit** → value `1` → **Save**
   (or **Add** it if it doesn't exist yet).
2. **Deployments** → top deployment → **⋯** → **Redeploy**.
3. Check `/api/health`: it now says `"mock":true`.

To switch the AI back on, set `DISABLE_LIVE` to `0` (or delete it) and **Redeploy** again.

If the key ever leaks: revoke it in the Token Factory console, create a new one, paste it into
`TOKEN_FACTORY_API_KEY` on Vercel, and **Redeploy**.

---

## 6. Running it on your computer

```
cd web
npm run dev
```

Open the address it prints (usually http://localhost:5173). The same `/api/...` functions run locally
through a small Vite plugin (`web/server/devApi.ts`). The key goes in the repo-root `.env` file
(`TOKEN_FACTORY_API_KEY=...`). After editing `.env`, stop the server (Ctrl+C) and start it again.
The terminal says `live mode` or `mock mode` (it never prints the key).

Checks for the developer (run from `web/`):

- `npx tsc -p tsconfig.api.json` type-checks the API, dev plugin and Vite config.
- `node server/smokeApi.mjs http://localhost:5173` runs about 15 checks against a running dev server.
- `node server/checkClientBundle.mjs` builds the site and proves no secret ends up in the browser code.

---

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/api/health` shows the web page or "404" | **Root Directory** is not `web`: **Settings → Build and Deployment → Root Directory** → `web` → Save → Redeploy. |
| `"mock":true` although you added the key | Key saved for the wrong environment, or no redeploy yet, or `DISABLE_LIVE=1`. |
| Answers start with `[demo]` but `/api/health` says `"mock":false` | Live calls are failing and the app falls back to demo answers. Open the project's **Logs** tab and search for `[llm]`. `HTTP 401` means a wrong key, `HTTP 404` a wrong model ID (use `?check=1`), `timeout` means Token Factory is slow (try again, or raise `LLM_TIMEOUT_MS`). |
| "Too many requests" message | The per-visitor limit (320 AI calls, refilled at 32 per minute). Wait a few minutes, or raise `RATE_LIMIT_BURST`. |
| Build fails with "Could not resolve ./App" or similar | The website code itself is incomplete or broken. This is not a deployment setting; fix the code and push again. |

---

## 8. How it is wired (for the curious)

- **Website:** Vite + React + PixiJS, built into static files (`web/dist`) and served by Vercel's CDN.
- **Live API:** three Vercel Functions in `web/api/` (Node.js runtime, web-standard `Request`/`Response`):
  - `GET /api/health`: `{ ok, mock, models }` (add `?check=1` to test the key and model IDs).
  - `POST /api/ask`: ask one simulated resident a follow-up question (question at most 300 characters).
  - `POST /api/react`: up to 5 simulated residents react to a proposal (at most 2,000 characters), run in parallel.

  They are written in plain JavaScript with JSDoc types. That way Vercel needs no TypeScript compiler
  (TypeScript 7, used by this project, no longer offers the compiler interface Vercel's builder calls),
  and the types are still checked with `npx tsc -p tsconfig.api.json`.
- **Safety:** inputs are validated and size-limited (64 KB). There is a per-visitor rate limit, kept in
  memory, so best-effort. Same-origin only (other websites can't call it). Errors are generic and never
  include settings. The key stays on the server.
- **What the AI does and doesn't do:** what a proposal *changes* for a resident (exposure) is computed
  from geography and statistics, not by the AI. The AI only writes the resident's *reaction*, and every
  such text is a **simulated voice**, never a real person. These are hypotheses, not evidence of public opinion.

### Alternative: Nebius Serverless AI endpoints (only if needed)

Instead of the shared Token Factory API, Nebius AI Cloud can run a model on your own dedicated,
OpenAI-compatible endpoint (vLLM in a container, billed per second of GPU time while it runs).
It is **not needed** for this hackathon. It would only matter for a custom or fine-tuned model, or
guaranteed capacity. If you ever do it, no code changes: set `TOKEN_FACTORY_BASE_URL` to the endpoint's
`.../v1` address, `TOKEN_FACTORY_API_KEY` to its token, and `MODEL_...` to the served model name, then redeploy.
**Stop the endpoint when you are done**, because it costs money for as long as it runs, even when idle.
