import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {build} from "esbuild";
import {act} from "react";

test("mobile startup and text submission never depend on the retired extension",async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:"https://graceplanner.vercel.app"});
  for(const name of ["window","document","localStorage","HTMLElement","Event","MouseEvent","location"])globalThis[name]=dom.window[name];
  Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
  Object.defineProperty(navigator,"userAgent",{value:"Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",configurable:true});
  localStorage.setItem("grace-connection-mode-v2","chatgpt");
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;const calls=[],bridgeMessages=[];
  window.addEventListener("message",e=>{if(e.data?.channel==="GRACE_SITE_V1")bridgeMessages.push(e.data);});
  globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return{ok:true,status:200,text:async()=>JSON.stringify({answer:"4",mode:"general",artifacts:[],execution:[]})};};
  await build({entryPoints:["src/main.jsx"],bundle:true,platform:"node",format:"esm",packages:"external",loader:{".css":"empty"},outfile:"tests/.compiled-browser-ui.mjs",logLevel:"silent"});
  await act(async()=>{await import("./.compiled-browser-ui.mjs?"+Date.now());});
  await act(async()=>{window.dispatchEvent(new Event("focus"));});
  assert.equal(document.querySelector('[aria-label="Connection mode"]'),null);
  assert.equal(document.querySelector('[aria-label="Connect ChatGPT"]'),null);
  assert.equal(document.querySelector('a[href="/grace-chatgpt-bridge.zip"]'),null);
  const textarea=document.querySelector(".composer textarea");
  await act(async()=>{
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,"value").set.call(textarea,"2 + 2");
    textarea.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
  });
  await act(async()=>{document.querySelector("form.composer").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));});
  assert.equal(calls.length,1);assert.equal(calls[0].url,"/api/chat");
  assert.equal(calls[0].body.messages.at(-1).content,"2 + 2");
  assert.equal(document.querySelectorAll(".message.user").length,1);
  assert.equal(document.querySelectorAll(".message.assistant")[1].querySelector("p").textContent,"4");
  assert.equal(bridgeMessages.length,0,"no extension handshake on startup, focus, or submit");
  dom.window.close();
});
