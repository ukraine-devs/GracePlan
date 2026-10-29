# Grace Planner

The site talks to ChatGPT only through the private bridge that drives the
Chromium on the OCI desktop (VNC). No model API key is used anywhere: there is
no `/api/chat`, `/api/analyze-image` or `/api/render-concept` in the project.

## Local

```bash
npm install
npm run dev
```

## Vercel

* `/api/bridge` is a thin proxy to the relay on the desktop (`GRACE_RELAY_URL`,
  default `http://129.159.218.87:8899`). It forwards `new`, `send`, `render`,
  `publish`, `sync`, `list`, `drop`, `delete`, `read`, `rename`.
* Everything else (analysis of the plan, the concept render, the PDF) happens in
  the browser: the relay puts the message into the ChatGPT conversation and the
  site reads the answer and the generated picture back.

## Relay (desktop)

`bridge/agent.js` runs on the OCI box as `grace-bridge.service`, next to
`chromium-vnc.service`. It reads and writes the real ChatGPT page, so the reply
and the generated image come from the account, not from an API.
