// Product requirement: every language/vision/agent request uses GPT Instant.
// Do not let stale deployment env vars silently route these requests elsewhere.
// Official model reference: https://developers.openai.com/api/docs/models/chat-latest
export const GRACE_AGENT_MODEL = "chat-latest";
export const GRACE_IMAGE_MODEL = "gpt-image-2.5-sunburst";
