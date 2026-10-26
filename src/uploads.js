import JSZip from "jszip";

export const ACCEPT_FILES = ""; // empty accept means: any file

const MB = 1024 * 1024;
const MAX_FILES = 100;
const MAX_IMAGE_BYTES = 20 * MB;
const MAX_TOTAL_BYTES = 120 * MB;
const MAX_ARCHIVE_BYTES = 40 * MB;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"]);

function imageType(file) {
  const type = String(file?.type || "").toLowerCase();
  if (IMAGE_TYPES.has(type)) return type;
  const extension = /\.(jpe?g|png|webp)$/i.exec(file?.name || "")?.[1].toLowerCase();
  return extension ? (extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg") : "";
}

export function isSupportedImage(file) {
  return Boolean(imageType(file));
}

function makeImage(blob, name, type, relativePath, lastModified) {
  const options = { type, lastModified: lastModified ?? Date.now() };
  const file = typeof File === "function"
    ? new File([blob], name, options)
    : Object.assign(new Blob([blob], { type }), { name, lastModified: options.lastModified });
  if (relativePath) file.relativePath = relativePath;
  return file;
}

function errorMessage(error) {
  return error?.message || String(error || "Unknown error");
}

function ignoredArchivePath(path) {
  return path.split(/[\\/]/).some((part) => part.startsWith(".") || part.toUpperCase() === "__MACOSX");
}

/** Accept FileLists, file arrays, and file items from drop/paste without mutating pending files. */
export async function expandUploads(selected, { existingCount = 0, existingBytes = 0 } = {}) {
  const files = [];
  const errors = [];
  let totalBytes = existingBytes;

  if (![existingCount, existingBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { files, errors: ["Existing upload count and byte total must be non-negative integers."] };
  }

  function imageError(size, name) {
    if (!Number.isSafeInteger(size) || size < 0) return `${name}: image size is invalid.`;
    if (size > MAX_IMAGE_BYTES) return `${name}: each image must be 20 MB or smaller.`;
    if (existingCount + files.length >= MAX_FILES) return `${name}: at most 100 images may be pending.`;
    if (totalBytes + size > MAX_TOTAL_BYTES) return `${name}: expanded images must total 120 MB or less, including pending files.`;
    return "";
  }

  function append(file) {
    files.push(file);
    totalBytes += file.size;
  }

  for (const item of Array.from(selected || [])) {
    let name = "Unnamed file";
    try {
      if (item?.kind && item.kind !== "file") continue;
      const file = typeof item?.getAsFile === "function" ? item.getAsFile() : item;
      if (!file) continue;
      name = file.name || name;
      const isZip = /\.zip$/i.test(name) || ZIP_TYPES.has(String(file.type || "").toLowerCase());

      if (!isZip) {
        const type = imageType(file);
        if (!type) {
          // Any other format is still welcome: it travels to ChatGPT untouched
          // and the site shows it as a file card next to the photos.
          if (!Number.isSafeInteger(file.size) || file.size > MAX_IMAGE_BYTES) {
            errors.push(`${name}: file is larger than 20 MB.`);
            continue;
          }
          append(file);
          continue;
        }
        const error = imageError(file.size, name);
        if (error) {
          errors.push(error);
          continue;
        }
        append(file.type === type ? file : makeImage(file, name, type, file.relativePath || file.webkitRelativePath, file.lastModified));
        continue;
      }

      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        errors.push(`${name}: ZIP archive size is invalid.`);
        continue;
      }
      if (file.size > MAX_ARCHIVE_BYTES) {
        errors.push(`${name}: ZIP archives must be 40 MB or smaller.`);
        continue;
      }
      if (existingCount + files.length >= MAX_FILES) {
        errors.push(`${name}: at most 100 images may be pending.`);
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
        errors.push(`${name}: ZIP archives must be 40 MB or smaller.`);
        continue;
      }
      // Uint8Array works in browsers and Node, unlike passing a File directly to JSZip.
      const archive = await JSZip.loadAsync(bytes);
      let imageCount = 0;
      for (const entry of Object.values(archive.files)) {
        const relativePath = entry.name.replace(/\\/g, "/");
        // JSZip sanitizes traversal components; inspect the original path as well.
        if (entry.dir || ignoredArchivePath(entry.unsafeOriginalName || relativePath)) continue;
        const label = `${name}: ${relativePath}`;
        const type = imageType({ name: relativePath });
        if (!type) {
          errors.push(`${label}: unsupported file type. ZIP entries must be JPEG, PNG or WebP images.`);
          continue;
        }
        imageCount += 1;
        try {
          // JSZip 3 exposes the central-directory size here before inflating data.
          const advertisedSize = entry._data?.uncompressedSize;
          const precheckError = imageError(advertisedSize, label);
          if (precheckError) {
            errors.push(precheckError);
            continue;
          }
          const blob = await entry.async("blob");
          const blobError = imageError(blob.size, label);
          if (blobError) {
            errors.push(blobError);
            continue;
          }
          if (blob.size !== advertisedSize) {
            errors.push(`${label}: extracted image size does not match the ZIP entry's advertised size.`);
            continue;
          }
          append(makeImage(blob, relativePath.split("/").pop(), type, relativePath, entry.date?.getTime()));
        } catch (error) {
          errors.push(`${label}: could not extract image. ${errorMessage(error)}`);
        }
      }
      if (!imageCount) errors.push(`${name}: ZIP contains no JPEG, PNG or WebP images.`);
    } catch (error) {
      errors.push(`${name}: could not read upload. ${errorMessage(error)}`);
    }
  }

  return { files, errors };
}

export async function readFileDataUrl(file) {
  const type = imageType(file) || file.type || "application/octet-stream";
  if (typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string" || !reader.result.startsWith("data:") || !reader.result.includes(",")) {
          reject(new Error(`${file.name || "File"}: could not read a data URL.`));
          return;
        }
        resolve(`data:${type};base64,${reader.result.slice(reader.result.indexOf(",") + 1)}`);
      };
      reader.onerror = () => reject(reader.error || new Error(`${file.name || "File"}: could not read file.`));
      reader.onabort = () => reject(new Error(`${file.name || "File"}: file reading was aborted.`));
      reader.readAsDataURL(file);
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let base64;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    // Bound each argument list so large images do not overflow the call stack.
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    base64 = btoa(chunks.join(""));
  }
  return `data:${type};base64,${base64}`;
}
