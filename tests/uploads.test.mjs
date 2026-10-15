import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import { ACCEPT_FILES, expandUploads, isSupportedImage, readFileDataUrl } from "../src/uploads.js";

const MB = 1024 * 1024;

function image(name = "photo.jpg", type = "image/jpeg", contents = [0, 127, 128, 255]) {
  return new File([Uint8Array.from(contents)], name, { type, lastModified: 12345 });
}

async function zipFile(entries, { name = "photos.zip", type = "", compression = "DEFLATE" } = {}) {
  const zip = new JSZip();
  for (const [path, contents] of entries) zip.file(path, contents, { createFolders: true });
  return new File([await zip.generateAsync({ type: "uint8array", compression })], name, { type });
}

function setGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function observeArchive(t, modify = () => {}) {
  const originalLoad = JSZip.loadAsync;
  const extracted = [];
  t.mock.method(JSZip, "loadAsync", async function (bytes, ...options) {
    assert.ok(bytes instanceof Uint8Array, "ZIP loading must use Uint8Array, not File");
    const archive = await originalLoad.call(this, bytes, ...options);
    for (const entry of Object.values(archive.files)) {
      const originalAsync = entry.async;
      t.mock.method(entry, "async", function (...args) {
        extracted.push(entry.name);
        return originalAsync.apply(this, args);
      });
    }
    modify(archive);
    return archive;
  });
  return extracted;
}

// Alter only a central-directory size, without allocating a huge payload.
async function withAdvertisedSize(file, path, size) {
  const bytes = Buffer.from(await file.arrayBuffer());
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + nameLength).toString() === path) {
      bytes.writeUInt32LE(size, offset + 24);
      return new File([bytes], file.name, { type: file.type });
    }
  }
  throw new Error(`Missing central-directory entry: ${path}`);
}

test("accept filter lists the supported image extensions, MIME types, and ZIP", () => {
  const accepted = ACCEPT_FILES.split(",");
  for (const value of ["image/jpeg", "image/png", "image/webp", ".jpg", ".jpeg", ".png", ".webp", ".zip", "application/zip"]) {
    assert.ok(accepted.includes(value), value);
  }
  assert.ok(!accepted.includes("image/*"));
});

test("image support uses MIME types and case-insensitive filename inference", () => {
  for (const name of ["plan.JPG", "plan.JPEG", "room.PnG", "room.WEBP"]) {
    assert.equal(isSupportedImage({ name, type: "" }), true, name);
    assert.equal(isSupportedImage({ name, type: "application/octet-stream" }), true, name);
  }
  for (const type of ["image/jpeg", "image/png", "image/webp", "IMAGE/PNG"]) {
    assert.equal(isSupportedImage({ name: "clipboard", type }), true, type);
  }
  for (const file of [null, undefined, {}, { name: "photo.gif", type: "image/gif" }, { name: "plan.svg" }, { name: "photo.jpg.exe" }, { name: "photos.zip" }]) {
    assert.equal(isSupportedImage(file), false);
  }
});

test("empty selection returns independent empty result arrays", async () => {
  for (const selected of [[], null, undefined, { length: 0 }]) {
    assert.deepEqual(await expandUploads(selected), { files: [], errors: [] });
  }
});

test("chooser FileLists retain order, original typed Files, bytes, and inferred types", async () => {
  const jpeg = image();
  const png = image("plan.PNG", "");
  png.relativePath = "plans/plan.PNG";
  const webp = image("room.webp", "application/octet-stream");
  Object.defineProperty(webp, "webkitRelativePath", { value: "rooms/room.webp" });
  const selected = Object.freeze({ 0: jpeg, 1: png, 2: webp, length: 3 });
  const { files, errors } = await expandUploads(selected);
  assert.deepEqual(errors, []);
  assert.equal(files[0], jpeg);
  assert.deepEqual(files.map((file) => file.type), ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(files[1].relativePath, "plans/plan.PNG");
  assert.equal(files[2].relativePath, "rooms/room.webp");
  assert.equal(files[1].lastModified, png.lastModified);
  assert.equal(png.type, "", "input files must not be mutated");
  for (const file of files) assert.deepEqual(new Uint8Array(await file.arrayBuffer()), Uint8Array.from([0, 127, 128, 255]));
});

test("drop/paste items ignore text and null items and retain unnamed clipboard images", async () => {
  const png = image("clipboard", "image/png");
  const selected = {
    0: { kind: "string", getAsFile() { throw new Error("Do not read pasted text"); } },
    1: { kind: "file", getAsFile: () => null },
    2: { kind: "file", getAsFile: () => png },
    length: 3,
  };
  assert.deepEqual(await expandUploads(selected), { files: [png], errors: [] });
});

test("unsupported input and individual read failures never discard earlier or later files", async () => {
  const before = image("before.jpg");
  const after = image("after.png", "image/png");
  const broken = { name: "broken.zip", size: 2, arrayBuffer: async () => { throw new Error("Read failed"); } };
  const item = { kind: "file", getAsFile() { throw new Error("Clipboard failed"); } };
  const existing = [image("pending.webp", "image/webp")];
  const result = await expandUploads([before, image("notes.pdf", "application/pdf"), broken, item, after], {
    existingCount: existing.length,
    existingBytes: existing[0].size,
  });
  assert.deepEqual(result.files, [before, after]);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /notes\.pdf.*unsupported.*JPEG, PNG, WebP/);
  assert.match(result.errors[1], /broken\.zip.*Read failed/);
  assert.match(result.errors[2], /Clipboard failed/);
  assert.deepEqual(existing.map((file) => file.name), ["pending.webp"]);
  assert.deepEqual([...existing, ...result.files].map((file) => file.name), ["pending.webp", "before.jpg", "after.png"]);
});

test("ZIP filename detection uses a literal dot and loads arrayBuffer as Uint8Array", async (t) => {
  const extracted = observeArchive(t);
  const zip = await zipFile([["floor/plan.PNG", [1, 2, 3]]], { name: "floor.ZIP" });
  const result = await expandUploads([zip, image("notazip", "application/octet-stream")]);
  assert.deepEqual(result.files.map((file) => [file.name, file.type, file.relativePath]), [["plan.PNG", "image/png", "floor/plan.PNG"]]);
  assert.deepEqual(extracted, ["floor/plan.PNG"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /notazip.*unsupported/);
});

test("ZIP MIME aliases work without filename extensions", async () => {
  for (const type of ["application/zip", "application/x-zip-compressed", "application/x-zip"]) {
    const result = await expandUploads([await zipFile([["room.jpeg", [1]]], { name: "clipboard-archive", type })]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.files[0].type, "image/jpeg");
  }
});

test("nested ZIP paths and duplicate basenames, selections, and archive selections survive", async () => {
  const zip = await zipFile([["floor1/room/photo.jpg", [1]], ["floor2/room/photo.jpg", [2]], ["floor2/room/photo.webp", [3]]]);
  const direct = image("photo.jpg");
  const result = await expandUploads([direct, direct, zip, zip]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.files.length, 8);
  assert.equal(result.files[0], result.files[1]);
  assert.deepEqual(result.files.slice(2).map((file) => file.relativePath), [
    "floor1/room/photo.jpg", "floor2/room/photo.jpg", "floor2/room/photo.webp",
    "floor1/room/photo.jpg", "floor2/room/photo.jpg", "floor2/room/photo.webp",
  ]);
  assert.deepEqual([...new Uint8Array(await result.files[2].arrayBuffer())], [1]);
  assert.deepEqual([...new Uint8Array(await result.files[3].arrayBuffer())], [2]);
});

test("ZIP skips directories, __MACOSX, dotfiles, hidden directories, and original traversal paths", async (t) => {
  const extracted = observeArchive(t);
  const zip = await zipFile([
    ["__MACOSX/._photo.jpg", [1]], ["floor/__MACOSX/photo.png", [2]],
    [".photo.jpg", [3]], ["floor/.hidden/photo.jpg", [4]], ["floor/._photo.png", [5]],
    [".hidden/../sanitized.jpg", [6]], ["../traversal.jpg", [7]],
    ["floor\\.secret\\photo.jpg", [8]], ["floor/good.jpeg", [9]],
  ]);
  const result = await expandUploads([zip]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files.map((file) => file.relativePath), ["floor/good.jpeg"]);
  assert.deepEqual(extracted, ["floor/good.jpeg"]);
});

test("unsupported ZIP entries report English errors without hiding valid images", async () => {
  const zip = await zipFile([["docs/readme.txt", "notes"], ["room.gif", [1]], ["photo.jpeg.exe", [2]], ["floor/plan.png", [3]]]);
  const result = await expandUploads([zip]);
  assert.equal(result.files.length, 1);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /docs\/readme\.txt.*unsupported.*JPEG, PNG or WebP/);
  assert.match(result.errors[1], /room\.gif.*unsupported/);
  assert.match(result.errors[2], /photo\.jpeg\.exe.*unsupported/);
});

test("empty ZIPs and ZIPs containing only ignored metadata report no images", async () => {
  for (const entries of [[], [["__MACOSX/._photo.jpg", [1]], [".hidden/plan.png", [2]]], [["notes.txt", "notes"]]]) {
    const result = await expandUploads([await zipFile(entries)]);
    assert.deepEqual(result.files, []);
    assert.ok(result.errors.some((error) => /ZIP contains no JPEG, PNG or WebP images/.test(error)));
  }
});

test("a corrupt ZIP does not lose accepted images or prevent later ZIPs", async () => {
  const direct = image();
  const corrupt = new File(["not a ZIP"], "broken.zip");
  const valid = await zipFile([["floor/next.webp", [1]]]);
  const result = await expandUploads([direct, corrupt, valid]);
  assert.deepEqual(result.files.map((file) => file.name), ["photo.jpg", "next.webp"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /broken\.zip.*could not read upload/);
});

test("an extraction failure retains other images in the same ZIP and later selections", async (t) => {
  observeArchive(t, (archive) => {
    t.mock.method(archive.files["broken.jpg"], "async", async () => { throw new Error("Broken compressed data"); });
  });
  const zip = await zipFile([["before.png", [1]], ["broken.jpg", [2]], ["after.webp", [3]]]);
  const result = await expandUploads([zip, image("last.jpg")]);
  assert.deepEqual(result.files.map((file) => file.name), ["before.png", "after.webp", "last.jpg"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /photos\.zip: broken\.jpg.*could not extract image.*Broken compressed data/);
});

test("100-image limit includes pending files and skips inflation beyond the limit", async (t) => {
  const extracted = observeArchive(t);
  const zip = await zipFile(Array.from({ length: 102 }, (_, index) => [`photo-${index}.jpg`, [index]]));
  const result = await expandUploads([zip], { existingCount: 1 });
  assert.equal(result.files.length, 99);
  assert.equal(extracted.length, 99);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((error) => /100 images/.test(error)));
});

test("direct uploads respect the count limit without discarding the first 100", async () => {
  const file = image();
  const result = await expandUploads(Array(101).fill(file));
  assert.equal(result.files.length, 100);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /100 images/);
  const full = await expandUploads([file], { existingCount: 100 });
  assert.deepEqual(full.files, []);
  assert.match(full.errors[0], /100 images/);
});

test("a full pending queue does not even read another ZIP", async () => {
  let reads = 0;
  const zip = { name: "photos.zip", size: 1, arrayBuffer: async () => { reads += 1; throw new Error("Should not read"); } };
  const result = await expandUploads([zip], { existingCount: 100 });
  assert.equal(reads, 0);
  assert.match(result.errors[0], /100 images/);
});

test("20 MB per-image limit is inclusive and a rejected image does not consume budget", async () => {
  const exact = new File([new Uint8Array(20 * MB)], "exact.png", { type: "image/png" });
  const over = { name: "over.jpg", type: "image/jpeg", size: 20 * MB + 1 };
  const next = image("next.jpg");
  const result = await expandUploads([over, exact, next]);
  assert.deepEqual(result.files, [exact, next]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /over\.jpg.*20 MB/);
});

test("120 MB expanded limit includes pending bytes, accepts exact boundary, and keeps smaller later files", async () => {
  const tooLarge = image("too-large.jpg", "image/jpeg", [1, 2, 3]);
  const exact = image("exact.png", "image/png", [1, 2]);
  const later = image("later.webp", "image/webp", [1]);
  const result = await expandUploads([tooLarge, exact, later], { existingBytes: 120 * MB - 2 });
  assert.deepEqual(result.files, [exact]);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((error) => /120 MB.*pending/.test(error)));
});

test("new direct and ZIP images share the same byte and count budgets", async (t) => {
  const extracted = observeArchive(t);
  const zip = await zipFile([["fit.png", [1, 2]], ["over.webp", [1]]]);
  const direct = image("first.jpg", "image/jpeg", [1]);
  const result = await expandUploads([direct, zip, image("last.jpg", "image/jpeg", [1])], {
    existingCount: 98,
    existingBytes: 120 * MB - 3,
  });
  assert.deepEqual(result.files.map((file) => file.name), ["first.jpg", "fit.png"]);
  assert.deepEqual(extracted, ["fit.png"]);
  assert.equal(result.errors.length, 2);
});

test("ZIP advertised image sizes are checked before any extraction", async (t) => {
  const extracted = observeArchive(t);
  const zip = await withAdvertisedSize(await zipFile([["large.jpg", [1]], ["small.png", [2]]]), "large.jpg", 20 * MB + 1);
  const result = await expandUploads([zip]);
  assert.deepEqual(result.files.map((file) => file.name), ["small.png"]);
  assert.deepEqual(extracted, ["small.png"]);
  assert.match(result.errors[0], /large\.jpg.*20 MB/);
});

test("ZIP advertised total sizes are checked against remaining budget before inflation", async (t) => {
  const extracted = observeArchive(t);
  const zip = await withAdvertisedSize(await zipFile([["large.jpg", [1]], ["fits.png", [2]]]), "large.jpg", 20 * MB);
  const result = await expandUploads([zip], { existingBytes: 120 * MB - 1 });
  assert.deepEqual(result.files.map((file) => file.name), ["fits.png"]);
  assert.deepEqual(extracted, ["fits.png"]);
  assert.match(result.errors[0], /large\.jpg.*120 MB/);
});

test("missing or invalid ZIP advertised sizes are rejected before inflation", async (t) => {
  const extracted = observeArchive(t, (archive) => {
    for (const [name, size] of [["missing.jpg", undefined], ["negative.png", -1], ["infinite.webp", Infinity]]) {
      archive.files[name]._data.uncompressedSize = size;
    }
  });
  const zip = await zipFile([["missing.jpg", [1]], ["negative.png", [2]], ["infinite.webp", [3]], ["valid.jpg", [4]]]);
  const result = await expandUploads([zip]);
  assert.deepEqual(extracted, ["valid.jpg"]);
  assert.equal(result.files.length, 1);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((error) => /image size is invalid/.test(error)));
});

test("extracted blob sizes must match advertised sizes", async (t) => {
  observeArchive(t, (archive) => {
    t.mock.method(archive.files["bad.jpg"], "async", async () => new Blob([new Uint8Array(2)]));
  });
  const result = await expandUploads([await zipFile([["before.jpg", [1]], ["bad.jpg", [2]], ["after.png", [3]]])]);
  assert.deepEqual(result.files.map((file) => file.name), ["before.jpg", "after.png"]);
  assert.match(result.errors[0], /bad\.jpg.*does not match.*advertised size/);
});

test("a real ZIP with an under-advertised size fails only that entry", async () => {
  const zip = await withAdvertisedSize(await zipFile([
    ["before.jpg", [1]], ["bad.jpg", [1, 2, 3]], ["after.png", [4]],
  ]), "bad.jpg", 1);
  const result = await expandUploads([zip, image("last.webp", "image/webp")]);
  assert.deepEqual(result.files.map((file) => file.name), ["before.jpg", "after.png", "last.webp"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /bad\.jpg.*could not extract image.*size mismatch/);
});

test("actual extracted blobs are rechecked for per-image and aggregate limits", async (t) => {
  observeArchive(t, (archive) => {
    t.mock.method(archive.files["image-limit.jpg"], "async", async () => ({ size: 20 * MB + 1 }));
    t.mock.method(archive.files["total-limit.png"], "async", async () => ({ size: 3 }));
  });
  const zip = await zipFile([["image-limit.jpg", [1]], ["total-limit.png", [2]], ["good.webp", [3]]]);
  const result = await expandUploads([zip], { existingBytes: 120 * MB - 2 });
  assert.deepEqual(result.files.map((file) => file.name), ["good.webp"]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /image-limit\.jpg.*20 MB/);
  assert.match(result.errors[1], /total-limit\.png.*120 MB/);
});

test("40 MB archive limit rejects before reading and permits an exact boundary", async (t) => {
  let reads = 0;
  const tooLarge = { name: "large.zip", size: 40 * MB + 1, arrayBuffer: async () => { reads += 1; throw new Error("Must not read"); } };
  const rejected = await expandUploads([tooLarge]);
  assert.equal(reads, 0);
  assert.match(rejected.errors[0], /large\.zip.*40 MB/);
  const zip = await zipFile([["photo.jpg", [1]]]);
  const bytes = new Uint8Array(40 * MB);
  bytes.set(new Uint8Array(await zip.arrayBuffer()), bytes.length - zip.size);
  const extracted = observeArchive(t);
  const accepted = await expandUploads([new File([bytes], "exact.zip")]);
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.files.length, 1);
  assert.deepEqual(extracted, ["photo.jpg"]);
});

test("ZIP arrayBuffer is also checked when advertised archive size is misleading", async (t) => {
  let loads = 0;
  t.mock.method(JSZip, "loadAsync", async () => { loads += 1; throw new Error("Must not load"); });
  const file = { name: "misleading.zip", size: 1, arrayBuffer: async () => new ArrayBuffer(40 * MB + 1) };
  const result = await expandUploads([file]);
  assert.equal(loads, 0);
  assert.match(result.errors[0], /40 MB/);
});

test("invalid existing totals cannot bypass limits", async () => {
  for (const options of [{ existingCount: -1 }, { existingCount: 0.5 }, { existingBytes: -1 }, { existingBytes: NaN }, { existingBytes: Infinity }]) {
    const result = await expandUploads([image()], options);
    assert.deepEqual(result.files, []);
    assert.match(result.errors[0], /non-negative integers/);
  }
});

test("Blob-based File fallback retains inferred MIME and ZIP relativePath", async (t) => {
  const direct = image("direct.PNG", "");
  const zip = await zipFile([["nested/room.webp", [1]]]);
  setGlobal(t, "File", undefined);
  const result = await expandUploads([direct, zip]);
  assert.deepEqual(result.errors, []);
  assert.ok(result.files.every((file) => file instanceof Blob));
  assert.deepEqual(result.files.map((file) => [file.name, file.type]), [["direct.PNG", "image/png"], ["room.webp", "image/webp"]]);
  assert.equal(result.files[1].relativePath, "nested/room.webp");
});

test("readFileDataUrl arrayBuffer fallback encodes binary bytes and inferred MIME", async (t) => {
  setGlobal(t, "FileReader", undefined);
  const bytes = Uint8Array.from({ length: 100_003 }, (_, index) => index % 256);
  const file = new File([bytes], "plan.PNG");
  assert.equal(await readFileDataUrl(file), `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  assert.equal(await readFileDataUrl(image("empty.webp", "", [])), "data:image/webp;base64,");
  assert.equal(await readFileDataUrl(new Blob(["abc"])), "data:application/octet-stream;base64,YWJj");
});

test("readFileDataUrl works without FileReader or Node Buffer for large binary input", async (t) => {
  const bytes = Uint8Array.from({ length: 100_003 }, (_, index) => index % 256);
  const expected = Buffer.from(bytes).toString("base64");
  const file = new File([bytes], "room.jpg");
  setGlobal(t, "FileReader", undefined);
  setGlobal(t, "Buffer", undefined);
  assert.equal(await readFileDataUrl(file), `data:image/jpeg;base64,${expected}`);
});

test("readFileDataUrl propagates arrayBuffer read failures", async (t) => {
  setGlobal(t, "FileReader", undefined);
  await assert.rejects(readFileDataUrl({ name: "broken.jpg", arrayBuffer: async () => { throw new Error("Disk read failed"); } }), /Disk read failed/);
});

test("readFileDataUrl uses browser FileReader and supplies an inferred MIME type", async (t) => {
  let input;
  setGlobal(t, "FileReader", class {
    readAsDataURL(file) {
      input = file;
      this.result = "data:application/octet-stream;base64,AH+A/w==";
      queueMicrotask(() => this.onload());
    }
  });
  const file = image("plan.PNG", "");
  t.mock.method(file, "arrayBuffer", async () => { throw new Error("Should use FileReader"); });
  assert.equal(await readFileDataUrl(file), "data:image/png;base64,AH+A/w==");
  assert.equal(input, file);
});

test("readFileDataUrl rejects browser errors, aborts, malformed results, and synchronous throws", async (t) => {
  for (const [action, message] of [
    [function () { this.error = new Error("Browser read failed"); this.onerror(); }, /Browser read failed/],
    [function () { this.onerror(); }, /could not read file/],
    [function () { this.onabort(); }, /aborted/],
    [function () { this.result = null; this.onload(); }, /could not read a data URL/],
    [function () { this.result = "invalid"; this.onload(); }, /could not read a data URL/],
    [function () { throw new Error("Synchronous read failed"); }, /Synchronous read failed/],
  ]) {
    await t.test(String(message), async (t) => {
      setGlobal(t, "FileReader", class { readAsDataURL() { action.call(this); } });
      await assert.rejects(readFileDataUrl(image()), message);
    });
  }
});

test("real floor1.zip expands all six images without macOS metadata", async (t) => {
  let bytes;
  try {
    bytes = await readFile(new URL("../../floor1.zip", import.meta.url));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("Optional floor1.zip fixture is not present");
    return;
  }
  const result = await expandUploads([new File([bytes], "floor1.zip")]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files.map((file) => file.relativePath), [
    "floor1/2D-plan-floor.png", "floor1/photo_43.jpg", "floor1/photo_35.jpg",
    "floor1/photo_37.jpg", "floor1/photo_89.jpg", "floor1/photo_49.jpg",
  ]);
  assert.equal(result.files.reduce((total, file) => total + file.size, 0), 2_527_478);
  assert.deepEqual(result.files.map((file) => file.type), ["image/png", ...Array(5).fill("image/jpeg")]);
  assert.equal((await readFileDataUrl(result.files[0])).startsWith("data:image/png;base64,iVBORw0KGgo"), true);
  for (const file of result.files.slice(1)) {
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer()).slice(0, 2)], [0xff, 0xd8]);
  }
  t.diagnostic("floor1.zip: 6 images, 2,527,478 expanded bytes; nested paths and image signatures verified");
});
