// A nuvem do sync (interface `remote` de syncEngine.js) no Firebase:
//  - Firestore: users/{uid}/notes/{id} e users/{uid}/folders/{id} =
//    { ver, deleted, data, rev (hora do servidor), device };
//  - Storage: users/{uid}/images/{nome} (nome = SHA-256 do conteúdo: nunca muda).
// O SDK fica em src/vendor/firebase (offline e no app desktop, sem CDN). Cada envio é uma
// transação: confere `ver` (outro aparelho gravou antes = "stale") e falha na hora sem rede,
// em vez de ficar numa fila do SDK. As regras do Firestore conferem o mesmo `ver`.

import { initializeApp } from "../../vendor/firebase/firebase-app.js";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
} from "../../vendor/firebase/firebase-auth.js";
import {
  initializeFirestore, memoryLocalCache, collection, doc, query, where, orderBy, limit, startAfter, getDocsFromServer, getDocFromServer,
  runTransaction, serverTimestamp, Timestamp, onSnapshot, connectFirestoreEmulator,
} from "../../vendor/firebase/firebase-firestore.js";
import { getStorage, connectStorageEmulator, ref, uploadBytes, getBytes } from "../../vendor/firebase/firebase-storage.js";
import { firebaseConfig } from "./firebaseConfig.js";

const PAGE = 500;
/** Limite do Firestore é 1 MiB por documento; o resto fica para os outros campos. */
const MAX_DOC_BYTES = 1_000_000;
const PUSH_TIMEOUT_MS = 30_000;
const COLLECTIONS = { note: "notes", folder: "folders" };

let app = null;
let auth = null;
let db = null;
let storage = null;

function init() {
  if (app) return;
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // O banco local (notes.db / IndexedDB) é a fonte offline: o Firestore não precisa de cache.
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
  storage = firebaseConfig.storageBucket ? getStorage(app) : null;
  if (useEmulators()) {
    // Testes locais (firebase emulators:start; portas do firebase.json): nada vai para a nuvem.
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    if (storage) connectStorageEmulator(storage, "127.0.0.1", 9199);
  }
}

/** `?emulador` numa página servida de localhost/127.0.0.1 (fica gravado para os recarregamentos). */
function useEmulators() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return false;
  try {
    if (new URLSearchParams(location.search).has("emulador")) localStorage.setItem("notas-emulador", "1");
    return localStorage.getItem("notas-emulador") === "1";
  } catch {
    return false;
  }
}

// ---------- Conta ----------

const AUTH_ERRORS = {
  "auth/invalid-email": "E-mail inválido.",
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/wrong-password": "E-mail ou senha incorretos.",
  "auth/user-not-found": "E-mail ou senha incorretos.",
  "auth/email-already-in-use": "Já existe uma conta com esse e-mail.",
  "auth/weak-password": "Senha fraca (mínimo de 6 caracteres).",
  "auth/too-many-requests": "Muitas tentativas. Tente de novo em alguns minutos.",
  "auth/network-request-failed": "Sem conexão com a internet.",
  "auth/configuration-not-found": "O login ainda não foi ativado no projeto Firebase (console → Authentication → Começar → E-mail/senha).",
  "auth/operation-not-allowed": "Login por e-mail/senha desativado no projeto Firebase (console → Authentication → Método de login).",
};

export const authMessage = (e) => AUTH_ERRORS[e?.code] || e?.message || String(e);

export const account = {
  /** cb(user | null) sempre que o login muda (também na abertura, com a sessão salva). */
  watch(cb) {
    init();
    return onAuthStateChanged(auth, cb);
  },
  signIn: (email, password) => (init(), signInWithEmailAndPassword(auth, email, password)),
  signUp: (email, password) => (init(), createUserWithEmailAndPassword(auth, email, password)),
  resetPassword: (email) => (init(), sendPasswordResetEmail(auth, email)),
  signOut: () => (init(), signOut(auth)),
  current: () => auth?.currentUser || null,
};

// ---------- Nuvem ----------

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`${what}: sem resposta do servidor.`), { code: "unavailable" })), ms))]);

const revMs = (rev) => (rev && typeof rev.toMillis === "function" ? rev.toMillis() : 0);

/** Documento do Firestore → { kind, id, ver, deleted, data, rev }. */
function fromDoc(kind, snap) {
  const d = snap.data();
  return { kind, id: Number(snap.id), ver: d.ver || 0, deleted: !!d.deleted, data: d.data || null, rev: revMs(d.rev) };
}

/** Remote do motor para a conta `uid`; `device` = nome deste aparelho (vai em cada envio). */
export function firebaseRemote(uid, device) {
  init();
  const col = (kind) => collection(db, "users", uid, COLLECTIONS[kind]);
  const imageRef = (name) => ref(storage, `users/${uid}/images/${name}`);

  return {
    /** Tudo que mudou depois de `since` (ms), em páginas. */
    async pull(since) {
      const docs = [];
      let maxRev = 0;
      for (const kind of ["folder", "note"]) {
        let last = null;
        for (;;) {
          const parts = [where("rev", ">", Timestamp.fromMillis(since)), orderBy("rev"), limit(PAGE)];
          if (last) parts.push(startAfter(last));
          const snap = await getDocsFromServer(query(col(kind), ...parts));
          for (const s of snap.docs) {
            const d = fromDoc(kind, s);
            docs.push(d);
            maxRev = Math.max(maxRev, d.rev);
          }
          if (snap.docs.length < PAGE) break;
          last = snap.docs[snap.docs.length - 1];
        }
      }
      return { docs, maxRev };
    },

    /** Estado atual de alguns documentos (envios recusados por "stale"). */
    async fetch(keys) {
      const out = [];
      for (const k of keys) {
        const snap = await getDocFromServer(doc(col(k.kind), String(k.id)));
        if (snap.exists()) out.push(fromDoc(k.kind, snap));
      }
      return out;
    },

    /** Grava `doc.ver` se a nuvem ainda está em `doc.ver - 1`; senão erro { code: "stale" }. */
    async push(item) {
      const payload = { ver: item.ver, deleted: item.deleted, data: item.data, device };
      if (JSON.stringify(payload).length > MAX_DOC_BYTES) throw Object.assign(new Error("Documento grande demais."), { code: "too-big" });
      const target = doc(col(item.kind), String(item.id));
      await withTimeout(
        runTransaction(db, async (t) => {
          const cur = await t.get(target);
          const ver = cur.exists() ? cur.data().ver || 0 : 0;
          if (ver !== item.ver - 1) throw Object.assign(new Error("stale"), { code: "stale" });
          t.set(target, { ...payload, rev: serverTimestamp() });
        }),
        PUSH_TIMEOUT_MS,
        "Envio",
      ).catch((e) => {
        if (e?.code === "permission-denied") throw Object.assign(new Error("stale"), { code: "stale" });
        throw e;
      });
    },

    async uploadImage(name, bytes) {
      if (!storage) return; // sem bucket: as imagens ficam só neste aparelho
      const ext = name.split(".").pop();
      const type = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" }[ext] || "application/octet-stream";
      await uploadBytes(imageRef(name), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { contentType: type, cacheControl: "private, max-age=31536000, immutable" });
    },

    async downloadImage(name) {
      if (!storage) throw new Error("Sem Firebase Storage configurado.");
      return new Uint8Array(await getBytes(imageRef(name)));
    },

    /**
     * Avisa (cb) quando outro aparelho grava algo, enquanto o app está aberto. Devolve a
     * função que para de ouvir.
     */
    watch(cb) {
      const since = Timestamp.now();
      const stops = Object.keys(COLLECTIONS).map((kind) =>
        onSnapshot(
          query(col(kind), where("rev", ">", since)),
          (snap) => {
            if (snap.docChanges().some((c) => c.doc.data().device !== device && !c.doc.metadata.hasPendingWrites)) cb();
          },
          (e) => console.warn("sync watch:", e),
        ),
      );
      return () => stops.forEach((s) => s());
    },
  };
}
