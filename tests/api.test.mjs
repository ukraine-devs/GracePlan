import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import handler from "../api/chat.js";

test("ordinary chat stays general after a Grace project and never generates workflow artifacts", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-credential";
  let upstream;
  globalThis.fetch = async (url, options) => {
    upstream = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Привет! 2 + 2 = **4**." } }] }), { status: 200 });
  };
  const req = Readable.from([]);
  req.method = "POST";
  req.body = { previousMode: "grace", clientPipeline: true, messages: [
    { role: "user", content: "@grace новый проект PDF" },
    { role: "assistant", content: "COMMAND: CMD-001 STATUS: waiting NEXT: upload" },
    { role: "user", content: "привет сколько будет 2+2?" }
  ] };
  let result, status;
  const res = { status(value) { status = value; return this; }, json(value) { result = value; return this; } };
  try {
    await handler(req, res);
    assert.equal(status, 200);
    assert.equal(result.mode, "general");
    assert.deepEqual(result.execution, []);
    assert.deepEqual(result.artifacts, []);
    assert.match(result.answer, /\*\*4\*\*/);
    assert.ok(!upstream.messages.some((message) => /COMMAND:/.test(message.content)));
    assert.match(upstream.messages[0].content, /ordinary conversation/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
