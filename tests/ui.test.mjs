import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { act } from "react";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";

test("window drop and ZIP use the same visible attachment queue, cleared immediately on send", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://graceplanner.vercel.app" });
  for (const name of ["window", "document", "localStorage", "HTMLElement", "Event", "MouseEvent"]) globalThis[name] = dom.window[name];
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  localStorage.setItem("grace-connection-mode-v2", "api");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Prevent the image analysis from completing while we inspect the send boundary.
  globalThis.createImageBitmap = async () => new Promise(() => {});
  await build({ entryPoints: ["src/main.jsx"], bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, outfile: "tests/.compiled-ui.mjs", logLevel: "silent" });
  await act(async () => { await import("./.compiled-ui.mjs?" + Date.now()); });
  const image = new File([new Uint8Array([255,216,255,217])], "plan.jpg", { type: "image/jpeg" });
  const drop = async (files) => {
    const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
    await act(async () => { window.dispatchEvent(event); await new Promise((resolve) => setTimeout(resolve, 100)); });
  };
  await drop([image]);
  assert.equal(document.querySelectorAll(".attachment-chip").length, 1);
  assert.equal(document.querySelector(".attachment-thumb img").alt, "plan.jpg");
  const zip = new JSZip(); zip.file("floor1/room.png", new Uint8Array([1,2,3]));
  await drop([new File([await zip.generateAsync({ type: "uint8array" })], "floor.zip", { type: "application/zip" })]);
  assert.equal(document.querySelectorAll(".attachment-chip").length, 2);
  assert.equal(document.querySelector(".topbar .delete-chat"), null);
  assert.ok(document.querySelector(".agent-indicator.idle"));
  assert.equal(document.querySelector(".composer .file-row").tagName, "DIV");
  assert.equal(document.querySelector(".composer .prompt-box").tagName, "LABEL");
  await act(async () => { document.querySelector(".composer").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(document.querySelectorAll(".attachment-chip").length, 0, "pending previews disappear before the first analysis finishes");
  assert.equal(document.querySelectorAll(".message.user").length, 1);
  assert.ok(document.querySelector(".progress-message"));
  const css = await readFile("src/styles.css", "utf8");
  assert.match(css, /\.composer > \.file-row \{ grid-row: 3; grid-column: 1; \}/);
  assert.match(css, /\.composer > button\[type="submit"\] \{ grid-row: 3; grid-column: 2; \}/);
  dom.window.close();
});
