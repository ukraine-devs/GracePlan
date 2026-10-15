import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {build} from "esbuild";
import {act} from "react";

test("default browser mode keeps unsent files and makes no API request when extension is absent",async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:"https://graceplanner.vercel.app"});
  for(const name of ["window","document","localStorage","HTMLElement","Event","MouseEvent","location"])globalThis[name]=dom.window[name];
  Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("No API fallback permitted");};
  await build({entryPoints:["src/main.jsx"],bundle:true,platform:"node",format:"esm",packages:"external",loader:{".css":"empty"},outfile:"tests/.compiled-browser-ui.mjs",logLevel:"silent"});
  await act(async()=>{await import("./.compiled-browser-ui.mjs?"+Date.now());});
  assert.equal(document.querySelector('[aria-label="Connection mode"]').value,"chatgpt");
  const drop=new dom.window.Event("drop",{bubbles:true,cancelable:true});
  Object.defineProperty(drop,"dataTransfer",{value:{types:["Files"],files:[new File(["source"],"room.jpg",{type:"image/jpeg"})]}});
  await act(async()=>{window.dispatchEvent(drop);await new Promise(resolve=>setTimeout(resolve,100));});
  await act(async()=>{document.querySelector("form.composer").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));});
  assert.ok(document.querySelector('[role="dialog"][aria-label="Connect ChatGPT"]'));
  assert.equal(document.querySelectorAll(".attachment-chip").length,1,"a blocked send remains a recoverable draft");
  assert.equal(document.querySelectorAll(".message.user").length,0,"no false sent receipt");
  assert.equal(calls,0);
});
