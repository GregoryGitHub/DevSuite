import { isMongo } from "../utils/dbModel.js";
import { splitBatches, statementAt, isReadOnlyQuery, isWriteStatement } from "../utils/sqlSplit.js";
import { parseCommand, splitMongo, mongoStatementAt, MongoSyntaxError } from "../utils/mongoShell.js";
import { attachSqlComplete, attachMongoComplete } from "./sqlComplete.js";

// Linguagem do console por tipo de conexão. O console (dbConsole.js) só conhece esta interface:
//   units(text, selStart, selEnd, mode) → [{ payload, display, start?, end?, repeat, write, readOnly, local?, error? }]
//   attachComplete(editor, { getSource, dialect }) → { isOpen(), destroy() }
//   rebind(unit, text) → a mesma unidade com outro texto (parâmetros já substituídos)
// payload = texto enviado ao backend; display = o que aparece na Saída e no log.

export const sqlLanguage = {
  id: "sql",
  editorLang: "sql",
  logLang: "sql",
  indent: "    ",
  placeholder: "SELECT * FROM ...   (Ctrl+Enter executa o comando sob o cursor)",
  supportsTx: true,
  supportsPlan: true,
  rowsWord: "linha(s)",
  units(text, s, e, mode) {
    const toUnit = (b) => ({ payload: b.sql, display: b.sql, start: b.start, end: b.end, repeat: b.repeat || 1, write: isWriteStatement(b.sql), readOnly: isReadOnlyQuery(b.sql) });
    if (s !== e) return splitBatches(text.slice(s, e)).map((b) => ({ ...toUnit(b), start: undefined, end: undefined }));
    if (mode === "all") return splitBatches(text).map(toUnit);
    const st = statementAt(text, s);
    return st ? [toUnit({ ...st, repeat: 1 })] : [];
  },
  rebind: (unit, text) => ({ ...unit, payload: text, display: text, write: isWriteStatement(text), readOnly: isReadOnlyQuery(text) }),
  attachComplete: (editor, opts) => attachSqlComplete(editor, opts),
};

const READ_OPS = new Set(["find", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct", "getIndexes", "listCollections", "listDatabases"]);

/** Linha:coluna de uma posição, para mensagens de erro de sintaxe. */
function lineCol(text, pos) {
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  return `linha ${line}, coluna ${pos - before.lastIndexOf("\n")}`;
}

/** Unidade do console MongoDB a partir do texto de um comando. */
function mongoUnit(text, base) {
  try {
    const cmd = parseCommand(text);
    if (cmd.kind === "use") return { ...base, local: { use: cmd.db }, write: false, readOnly: true };
    return { ...base, payload: JSON.stringify(cmd.op), write: cmd.write, readOnly: READ_OPS.has(cmd.op.op) && !cmd.write, op: cmd.op };
  } catch (err) {
    const where = err instanceof MongoSyntaxError ? ` (${lineCol(text, err.pos)})` : "";
    return { ...base, error: `${err.message}${where}` };
  }
}

export const mongoLanguage = {
  id: "mongo",
  editorLang: "javascript",
  logLang: "javascript",
  indent: "  ",
  placeholder: "db.colecao.find({ status: 'ativo' }).sort({ criado: -1 })   (Ctrl+Enter executa o comando sob o cursor)",
  supportsTx: false,
  supportsPlan: false,
  rowsWord: "documento(s)",
  units(text, s, e, mode) {
    const toUnit = (st, offset = 0) => mongoUnit(st.text, { display: st.text, start: offset ? undefined : st.start, end: offset ? undefined : st.end, repeat: 1 });
    if (s !== e) return splitMongo(text.slice(s, e)).map((st) => toUnit(st, 1));
    if (mode === "all") return splitMongo(text).map((st) => toUnit(st));
    const st = mongoStatementAt(text, s);
    return st ? [toUnit(st)] : [];
  },
  rebind: (unit, text) => mongoUnit(text, { display: text, start: unit.start, end: unit.end, repeat: unit.repeat }),
  attachComplete: (editor, opts) => attachMongoComplete(editor, opts),
};

export const languageFor = (conn) => (isMongo(conn) ? mongoLanguage : sqlLanguage);
