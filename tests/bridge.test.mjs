import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {readFile} from "node:fs/promises";
import {isSite,isChat,validateRequest,conversationUrl} from "../browser-extension/policy.js";
import {resolvePairedTab,savedPairs} from "../browser-extension/bindings.js";
import {signedOut,assertReady,toMarkdown,allowedFileUrl} from "../browser-extension/dom-adapter.js";
import {bridgeFiles,sendToBrowserChat,browserBridgeStatus} from "../src/browserBridge.js";

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

test("an older extension cannot report a durable pairing as ready",async()=>{
  const oldWindow=globalThis.window,oldLocation=globalThis.location;
  class OldExtension extends EventTarget{postMessage(data){queueMicrotask(()=>{const event=new Event("message");Object.assign(event,{source:this,origin:"https://graceplanner.vercel.app",data:{channel:"GRACE_EXTENSION_V1",id:data.id,callId:data.callId,reply:true,installed:true,paired:true}});this.dispatchEvent(event);});}}
  globalThis.window=new OldExtension();globalThis.location={origin:"https://graceplanner.vercel.app"};
  try{const status=await browserBridgeStatus("test-chat-id","Test");assert.equal(status.paired,false);assert.equal(status.updateRequired,true);assert.equal(status.chatId,"test-chat-id");}finally{globalThis.window=oldWindow;globalThis.location=oldLocation;}
});

test("saved conversation reconnects after restart without trusting a reused tab id",async()=>{
  const chatUrl="https://chatgpt.com/c/approved-conversation";
  const wrong={id:7,url:"https://chatgpt.com/c/unrelated-conversation"},right={id:42,url:chatUrl};
  const tab=await resolvePairedTab({tabId:7,chatUrl},{get:async()=>wrong,query:async()=>[wrong,right]});
  assert.equal(tab.id,42);
  await assert.rejects(()=>resolvePairedTab({tabId:7,chatUrl},{get:async()=>wrong,query:async()=>[wrong]}),/will not choose another chat/);
  await assert.rejects(()=>resolvePairedTab({tabId:7,chatUrl},{get:async()=>wrong,query:async()=>[right,{...right,id:43}]}),/multiple tabs/);
  assert.equal(conversationUrl(chatUrl+"?auth=sensitive#fragment"),chatUrl);
  for(const url of ["https://chatgpt.com/","https://chatgpt.com/share/approved-conversation","https://chatgpt.com/auth/login","https://evil.test/c/approved-conversation"])assert.equal(conversationUrl(url),null);
  assert.equal(conversationUrl("https://chatgpt.com/g/g-example/c/approved-conversation"),"https://chatgpt.com/g/g-example/c/approved-conversation");
});

test("existing opt-in pairing migrates to durable metadata without storing credentials",async()=>{
  const oldChrome=globalThis.chrome;let saved;
  globalThis.chrome={storage:{local:{get:async()=>({}),set:async value=>{saved=value;}},session:{get:async()=>({pairs:{"test-chat-id":{tabId:7,instantConfirmed:true}}})}},tabs:{get:async()=>({id:7,url:"https://chatgpt.com/c/approved-conversation?auth=discard"})}};
  try{const pairs=await savedPairs();assert.equal(pairs['test-chat-id'].chatUrl,"https://chatgpt.com/c/approved-conversation");assert.deepEqual(saved,{gracePairsV2:pairs});assert.ok(!JSON.stringify(saved).includes("discard"));}finally{globalThis.chrome=oldChrome;}
});

test("background sends once and refuses a different conversation in the same tab",async()=>{
  const oldChrome=globalThis.chrome,session={},chatUrl="https://chatgpt.com/c/approved-conversation";
  const local={gracePairsV2:{"test-chat-id":{tabId:7,chatUrl,instantConfirmed:true}}};
  let listener,currentUrl=chatUrl,dispatches=0;
  const area=data=>({get:async key=>({[key]:structuredClone(data[key])}),set:async value=>Object.assign(data,structuredClone(value))});
  globalThis.chrome={storage:{local:area(local),session:area(session)},runtime:{id:"test-extension",getURL:path=>"chrome-extension://test-extension/"+path,onMessage:{addListener:fn=>{listener=fn;}}},tabs:{get:async()=>({id:7,url:currentUrl}),query:async()=>[{id:7,url:currentUrl}],sendMessage:async(id,message)=>{if(message.action==='COMMIT')dispatches++;return message.action==='BEGIN'?{ready:true}:{accepted:true};}}};
  const sender={url:"https://graceplanner.vercel.app/",frameId:0,tab:{id:2}};
  const call=action=>new Promise(resolve=>listener({channel:"GRACE_SITE_V1",id:"test-request-id",chatId:"test-chat-id",text:"2+2",files:[],action},sender,resolve));
  try{
    await import("../browser-extension/background.js?binding-test="+Date.now());
    assert.equal((await call("BEGIN")).accepted,true);
    assert.equal((await call("COMMIT")).accepted,true);
    assert.match((await call("COMMIT")).error,/already dispatched/);
    assert.equal(dispatches,1);
    currentUrl="https://chatgpt.com/c/unrelated-conversation";
    assert.match((await call("COMMIT")).error,/will not choose another chat/);
    assert.equal(dispatches,1);
  }finally{globalThis.chrome=oldChrome;}
});
