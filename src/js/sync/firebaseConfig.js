// Projeto Firebase do app Notas (console.firebase.google.com → Configurações do projeto →
// Seus apps → app Web). Estes valores não são segredos: o acesso é protegido pelo login e
// pelas regras (firestore.rules / storage.rules na raiz do repositório).
// Com `apiKey` vazio a sincronização fica desligada e o app funciona só local.

export const firebaseConfig = {
  apiKey: "AIzaSyCxhc_Uukuvo-BB792X9_SKbI6xWhw-UJg",
  authDomain: "notas-df5e6.firebaseapp.com",
  projectId: "notas-df5e6",
  storageBucket: "notas-df5e6.firebasestorage.app",
  messagingSenderId: "948591657788",
  appId: "1:948591657788:web:1d4db232aed8d58df7d439",
};

export const firebaseEnabled = () => !!(firebaseConfig.apiKey && firebaseConfig.projectId);
