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

/** Stores an image blob and returns { src, width, height }. */
export async function storeImageBlob(blob) {
  const [size, src] = await Promise.all([
    imageSize(blob),
    hasTauri
      ? blob.arrayBuffer().then((buf) => saveNoteImageApi(new Uint8Array(buf), EXT_BY_TYPE[blob.type] || "")).then(noteImageUrl)
      : blobToDataUrl(blob), // browser preview without the Rust side
  ]);
  return { src, ...size };
}

/** Copies an image file from disk (Markdown import) and returns { src, width, height }. */
export async function storeImageFile(path) {
  const src = noteImageUrl(await importNoteImageApi(path));
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
  if (!hasTauri || !html.includes("data:image/")) return html;
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
