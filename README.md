# Grace Planner

Static Vite site for opening the Grace Plan GPT/plugin from a logged-in ChatGPT account.

## Local

```bash
npm install
npm run dev
```

## Vercel

The project builds with:

```bash
npm run build
```

Optional environment variable:

```bash
VITE_GRACE_PLAN_URL=https://chatgpt.com/plugins/plugins_6ace24a6236c81918643c1d355f8ef4a
```

ChatGPT cannot be safely embedded as an authenticated iframe on another domain. This site opens the Grace Plan page directly, so the existing ChatGPT login session is used by chatgpt.com.
