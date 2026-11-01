import { hasTauri, saveNoteImageApi, importNoteImageApi } from "../api.js";
import { noteImageUrl, localImageName } from "./noteContent.js";

// Turns pasted/imported images into files stored by the app (see noteContent.js).

const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif" };

async function imageSize(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Where images go: the app's image store (default) or, in a .md file window (mdFile.js),
// next to the file. save(bytes, ext) / copy(path) resolve to the image URL.
let target = {
  save: (bytes, ext) => saveNoteImageApi(bytes, ext).then(noteImageUrl),
  copy: (path) => importNoteImageApi(path).then(noteImageUrl),
};

// Browser without a target (plain preview of index.html): images stay as data: URLs.
let hasTarget = hasTauri;

export function setImageTarget(t) {
  target = t;
  hasTarget = true;
}

// Phone photos (3–12 MB) are shrunk before storing: notes sync to the cloud and the
// free Firebase Storage quota is 5 GB. Screenshots and small images stay as they are.
const PHOTO_MAX_SIDE = 2048;
const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const PHOTO_QUALITY = 0.82;

/** JPEG of at most PHOTO_MAX_SIDE px (EXIF orientation applied), or the blob unchanged. */
export async function shrinkPhoto(blob) {
  const photo = /^image\/(jpeg|heic|heif|webp)$/i.test(blob.type) || (blob.type === "image/png" && blob.size > 4 * PHOTO_MAX_BYTES);
  if (!photo || typeof createImageBitmap !== "function") return blob;
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return blob;
  }
  try {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && blob.size <= PHOTO_MAX_BYTES && blob.type !== "image/heic" && blob.type !== "image/heif") return blob;
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    return out && out.size < blob.size ? out : blob;
  } finally {
    bmp.close();
  }
}

/** Stores an image blob and returns { src, width, height }. */
export async function storeImageBlob(blob) {
  blob = await shrinkPhoto(blob);
  const [size, src] = await Promise.all([
    imageSize(blob),
    hasTarget
      ? blob.arrayBuffer().then((buf) => target.save(new Uint8Array(buf), EXT_BY_TYPE[blob.type] || ""))
      : blobToDataUrl(blob), // browser preview without the Rust side
  ]);
  return { src, ...size };
}

/** Copies an image file from disk (Markdown import) and returns { src, width, height }. */
export async function storeImageFile(path) {
  const src = await target.copy(path);
  const size = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
  return { src, ...size };
}

/** Replaces data: URL images in an HTML string with stored files (in parallel). */
export async function storeDataImages(html) {
  if (!hasTarget || !html.includes("data:image/")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const imgs = [...tpl.content.querySelectorAll('img[src^="data:image/"]')];
  await Promise.all(
    imgs.map(async (img) => {
      try {
        const blob = await (await fetch(img.getAttribute("src"))).blob();
        const { src, width, height } = await storeImageBlob(blob);
        img.setAttribute("src", src);
        if (width && height) {
          img.setAttribute("width", width);
          img.setAttribute("height", height);
        }
      } catch (e) {
        console.error("failed to store pasted image", e);
        img.remove();
      }
    }),
  );
  return tpl.innerHTML;
}

function resolvePath(baseDir, src) {
  let path = src.replace(/^file:\/\/(localhost)?/i, "");
  try {
    path = decodeURI(path);
  } catch {}
  if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1); // file:///C:/...
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return path;
  const sep = baseDir.includes("\\") ? "\\" : "/";
  return `${baseDir}${sep}${path.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep)}`;
}

/**
 * Stores the images of imported Markdown: relative/absolute paths (resolved against the
 * .md folder) and data: URLs become app files; remote URLs are kept. Unreadable images
 * are replaced by their alt text. `lookup(src)` may give the file's absolute path first
 * (folder import: `![[x.png]]` of Obsidian points to a file anywhere in the vault).
 */
export async function resolveMarkdownImages(html, baseDir, lookup = null) {
  if (!html.includes("<img")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  await Promise.all(
    [...tpl.content.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") || "";
      if (localImageName(src) || /^https?:\/\//i.test(src)) return;
      try {
        const stored = /^data:image\//i.test(src)
          ? await storeImageBlob(await (await fetch(src)).blob())
          : await storeImageFile(lookup?.(src) || resolvePath(baseDir, src));
        img.setAttribute("src", stored.src);
        if (stored.width && stored.height) {
          img.setAttribute("width", stored.width);
          img.setAttribute("height", stored.height);
        }
      } catch (e) {
        console.error("markdown image not imported", src, e);
        img.replaceWith(img.getAttribute("alt") || "");
      }
    }),
  );
  return tpl.innerHTML;
}
