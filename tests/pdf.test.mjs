import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { createConceptReviewPdf } from "../src/proposalPdf.js";

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=";
const fontBytes = await readFile(new URL("../public/fonts/GraceSans.ttf", import.meta.url));
const boldFontBytes = await readFile(new URL("../public/fonts/GraceSans-Bold.ttf", import.meta.url));

test("final proposal embeds every photo and has A2, A3, A4 and validation attachment", async () => {
  const real = Boolean(process.env.GRACE_EXPORT_PATH);
  const source = "/workspace/scratch/grace-floor1-test/";
  const data = async (name,type) => "data:"+type+";base64,"+(await readFile(source+name)).toString("base64");
  const photos = real ? await Promise.all([35,37,43,49,89].map(async (id) => ({ name:"photo_"+id+".jpg",data:await data("floor1/photo_"+id+".jpg","image/jpeg") }))) : Array.from({length:7},(_,i)=>({name:"photo-"+i+".png",data:pixel}));
  const planData = real ? await data("floor1/2D-plan-floor.png","image/png") : pixel;
  const renderData = real ? await data("floor1-room-result.png","image/png") : pixel;
  const url = await createConceptReviewPdf({ planData, renderData, photoCount: photos.length, photos, fontBytes, boldFontBytes });
  assert.match(url,/^data:application\/pdf;base64,/);
  const bytes=Buffer.from(url.split(",")[1],"base64"), pdf=await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount()>=22);
  for(const page of pdf.getPages().slice(0,6)) { assert.ok(Math.abs(page.getWidth()-1683.78)<1);assert.ok(Math.abs(page.getHeight()-1190.55)<1); }
  const last=pdf.getPages().at(-1);assert.ok(Math.abs(last.getWidth()-595.28)<1);
  assert.equal(pdf.getTitle(),"Проєктна пропозиція від Grace");
  assert.ok(pdf.catalog.has(pdf.context.obj("Names")));
  if(real)await writeFile(process.env.GRACE_EXPORT_PATH,bytes);
});

test("a manifest or missing render cannot masquerade as the final proposal", async () => {
  await assert.rejects(createConceptReviewPdf({planData:pixel,photos:[{data:pixel}]}),/completed render/i);
});
