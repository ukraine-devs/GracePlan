import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {readFile} from "node:fs/promises";
import {isSite,isChat,validateRequest} from "../browser-extension/policy.js";
import {signedOut,assertReady,toMarkdown,allowedFileUrl} from "../browser-extension/dom-adapter.js";
import {bridgeFiles,sendToBrowserChat} from "../src/browserBridge.js";

test("bridge only accepts its own origin and a real ChatGPT tab",()=>{
  assert.ok(isSite("https://graceplanner.vercel.app/"));assert.ok(!isSite("https://graceplanner.vercel.app.evil.test/"));
  assert.ok(isChat("https://chatgpt.com/c/example"));assert.ok(!isChat("https://chatgpt.com/share/example"));assert.ok(!isChat("https://chatgpt.com.evil.test/"));
  assert.ok(!allowedFileUrl("javascript:alert(1)"));assert.ok(!allowedFileUrl("http://127.0.0.1/secret"));
  assert.throws(()=>validateRequest({id:"test-request-id",chatId:"test-chat-id",text:"hello",files:[{name:"payload.exe",type:"application/x-executable",size:1}]}));
});
test("signed-out ChatGPT is never used as a sending workaround; hidden reasoning is omitted",()=>{
  const dom=new JSDOM('<button>Увійти</button><textarea></textarea><article><p>Hello <strong>Grace</strong>.</p><details><summary>Thinking</summary>private reasoning</details></article>');
  dom.window.HTMLElement.prototype.getClientRects=function(){return [{}];};
  assert.ok(signedOut(dom.window.document));assert.throws(()=>assertReady(dom.window.document),/Sign in/);
  const md=toMarkdown(dom.window.document.querySelector('article'));assert.match(md,/\*\*Grace\*\*/);assert.ok(!md.includes("private reasoning"));
});
test("many photos are bundled without silently dropping any source",async()=>{
  const files=Array.from({length:12},(_,i)=>new File(["photo"+i],"room-"+i+".jpg",{type:"image/jpeg"}));
  const result=await bridgeFiles(files);assert.equal(result.length,1);assert.equal(result[0].type,"application/zip");
  const {default:JSZip}=await import("jszip");const zip=await JSZip.loadAsync(await result[0].arrayBuffer());assert.equal(Object.keys(zip.files).length,12);
});
test("one send waits for a completed browser response; no API call or automatic resend",async()=>{
  class FakeWindow extends EventTarget {postMessage(data){queueMicrotask(()=>{const reply=new Event("message");Object.assign(reply,{source:this,origin:"https://graceplanner.vercel.app",data:{channel:"GRACE_EXTENSION_V1",id:data.id,callId:data.callId,reply:true,accepted:true}});this.dispatchEvent(reply);if(data.action==="COMMIT"){const done=new Event("message");Object.assign(done,{source:this,origin:"https://graceplanner.vercel.app",data:{channel:"GRACE_EXTENSION_V1",id:data.id,kind:"done",text:"4",artifacts:[]}});this.dispatchEvent(done);}});}}
  const oldWindow=globalThis.window,oldLocation=globalThis.location,oldFetch=globalThis.fetch;let fetches=0;
  globalThis.window=new FakeWindow();globalThis.location={origin:"https://graceplanner.vercel.app"};globalThis.fetch=()=>{fetches++;throw new Error("No API allowed");};
  try{const result=await sendToBrowserChat({chatId:"test-chat-id",text:"2+2"});assert.equal(result.text,"4");assert.equal(fetches,0);}finally{globalThis.window=oldWindow;globalThis.location=oldLocation;globalThis.fetch=oldFetch;}
});
test("extension requests no cookie, debugger, native-messaging or broad-host access",async()=>{
  const manifest=JSON.parse(await readFile("browser-extension/manifest.json","utf8"));assert.deepEqual(manifest.permissions,["storage"]);assert.ok(!manifest.host_permissions.includes("<all_urls>"));
});
