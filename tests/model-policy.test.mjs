import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import analyze from "../api/analyze-image.js";
import render from "../api/render-concept.js";
import verify from "../api/verify-render.js";

test("vision and render orchestration use Instant despite stale environment overrides", async () => {
  const originalFetch = globalThis.fetch;
  const names = ["OPENAI_API_KEY", "OPENAI_CHAT_MODEL", "OPENAI_MODEL", "OPENAI_RENDER_AGENT_MODEL"];
  const saved = names.map((name) => process.env[name]);
  names.forEach((name) => { process.env[name] = name === "OPENAI_API_KEY" ? "unit-test-placeholder" : "gpt-4o-mini"; });
  const img = "data:image/png;base64,AA==";
  try {
    for (const [handler, body, response] of [
      [analyze, {name:"plan.png",data:img}, {choices:[{message:{content:'{"kind":"floor_plan"}'}}]}],
      [verify, {plan:img,render:img}, {choices:[{message:{content:'{"checks":[]}'}}]}],
      [render, {plan:img,contactSheets:[img],photoCount:1}, {output:[{type:"image_generation_call",result:"AA=="}]}]
    ]) {
      let upstream;
      globalThis.fetch = async (url, options) => { upstream = JSON.parse(options.body); return new Response(JSON.stringify(response)); };
      const req = Readable.from([]); req.method="POST"; req.body=body;
      let status, result;
      const res = {status(code){status=code;return this;},json(value){result=value;return this;}};
      await handler(req,res);
      assert.equal(status,200);
      assert.equal(upstream.model,"chat-latest");
      assert.equal(result.model,"chat-latest");
      if(handler===render) assert.equal(upstream.tools[0].type,"image_generation");
    }
    globalThis.fetch = async () => new Response(JSON.stringify({error:{message:"You have no credits remaining.",code:"insufficient_quota"}}),{status:429});
    const req = Readable.from([]);req.method="POST";req.body={plan:img,contactSheets:[img]};
    let failure, status;
    await render(req,{status(code){status=code;return this;},json(value){failure=value;return this;}});
    assert.equal(status,429);
    assert.equal(failure.model,"chat-latest");
    assert.equal(failure.source,"openai");
    assert.equal(failure.code,"insufficient_quota");
    assert.equal(failure.artifact,undefined,"a quota error is never passed off as a generated render");
  } finally {
    globalThis.fetch=originalFetch;
    names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});
  }
});
