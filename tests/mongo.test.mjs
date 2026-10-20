// Testes do parser mongosh e da conversão de documentos: node tests/mongo.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const { parseCommand, parseShellValue, splitMongo, mongoStatementAt, indexName } = await import(base + "mongoShell.js");
const { bsonType, cellOf, toShell, ejsonFromInput, createDocState, ensureIdColumn, projectionHidesId, docsToRows, buildMongoChanges, cellToEjson } = await import(base + "mongoValue.js");
const { GridModel } = await import(base + "gridModel.js");

// --- parser
let c = parseCommand(`db.users.find({ age: { $gt: 18 }, _id: ObjectId('65F1A2B3C4D5E6F708192A3B'), 'nome completo': /ana/i }, { name: 1 }).sort({ name: -1 }).skip(10).limit(5)`);
assert.equal(c.kind, "op");
assert.equal(c.write, false);
assert.deepEqual(c.op, {
  op: "find", collection: "users",
  filter: { age: { $gt: 18 }, _id: { $oid: "65f1a2b3c4d5e6f708192a3b" }, "nome completo": { $regularExpression: { pattern: "ana", options: "i" } } },
  projection: { name: 1 }, sort: { name: -1 }, skip: 10, limit: 5,
});
c = parseCommand(`db.getCollection("pedidos-2026").aggregate([{ $match: { at: { $gte: ISODate("2026-01-01") } } }, { $group: { _id: "$status", n: { $sum: 1 } } }])`);
assert.equal(c.op.collection, "pedidos-2026");
assert.equal(c.op.pipeline[0].$match.at.$gte.$date, "2026-01-01T00:00:00.000Z");
c = parseCommand(`db.c.updateMany({ a: NumberLong("9007199254740993") }, { $set: { d: NumberDecimal('10.50'), x: 12345678901234567890 } }, { upsert: true });`);
assert.deepEqual(c.op, { op: "updateMany", collection: "c", filter: { a: { $numberLong: "9007199254740993" } }, update: { $set: { d: { $numberDecimal: "10.50" }, x: { $numberLong: "12345678901234567890" } } }, upsert: true });
assert.equal(c.write, true);
assert.throws(() => parseCommand(`db.c.updateOne({}, { a: 1 })`), /operadores/);
assert.deepEqual(parseCommand("db.c.find().count()").op, { op: "countDocuments", collection: "c", filter: {} });
assert.deepEqual(parseCommand("db.c.findOne()").op.limit, 1);
assert.deepEqual(parseCommand("show collections").op, { op: "listCollections" });
assert.deepEqual(parseCommand("use loja"), { kind: "use", db: "loja" });
assert.deepEqual(parseCommand(`db.runCommand({ ping: 1 })`).op, { op: "runCommand", command: { ping: 1 }, admin: false });
assert.deepEqual(parseCommand(`db.c.dropIndex({ a: 1, b: -1 })`).op.name, "a_1_b_-1");
assert.equal(indexName({ x: "text" }), "x_text");
assert.deepEqual(parseCommand(`db.c.remove({ a: 1 }, true)`).op.op, "deleteOne");
const err = (() => { try { parseCommand("db.c.find({ a: foo })"); } catch (e) { return e; } })();
assert.match(err.message, /"foo" não é suportado/);
assert.equal(err.pos, "db.c.find({ a: ".length);
assert.deepEqual(parseShellValue(`{ u: UUID("0b2f1d3e-4c5a-4b6c-8d7e-9f0a1b2c3d4e"), t: Timestamp(5, 1), k: MinKey(), n: -1.5e3, s: "a\\"b" }`), {
  u: { $binary: { base64: "Cy8dPkxaS2yNfp8KGyw9Tg==", subType: "04" } }, t: { $timestamp: { t: 5, i: 1 } }, k: { $minKey: 1 }, n: -1500, s: 'a"b',
});

// --- divisão
const script = "db.a.find({\n  x: 1\n})\n  .limit(2)\ndb.b.find()\nuse x; show dbs";
assert.deepEqual(splitMongo(script).map((s) => s.text), ["db.a.find({\n  x: 1\n})\n  .limit(2)", "db.b.find()", "use x", "show dbs"]);
assert.equal(mongoStatementAt(script, script.indexOf("db.b") + 3).text, "db.b.find()");
assert.equal(splitMongo("// só comentário\n").length, 0);

// --- valores
assert.equal(bsonType({ $numberDouble: "5.0" }), "double");
assert.equal(cellOf({ $numberDouble: "5.0" }), "5.0");
assert.equal(cellOf({ $numberLong: "9007199254740993" }), "9007199254740993");
assert.equal(cellOf({ $numberLong: "7" }), 7);
assert.equal(cellOf({ $oid: "65f1a2b3c4d5e6f708192a3b" }), "65f1a2b3c4d5e6f708192a3b");
assert.equal(cellOf({ $date: "2026-01-01T00:00:00Z" }), "2026-01-01T00:00:00Z");
assert.equal(cellOf({ city: "Rio", n: [1, { $numberLong: "2" }] }), "{ city: 'Rio', n: [ 1, NumberLong('2') ] }");
assert.equal(toShell({ _id: { $oid: "65f1a2b3c4d5e6f708192a3b" }, "a-b": 1 }, "  "), "{\n  _id: ObjectId('65f1a2b3c4d5e6f708192a3b'),\n  'a-b': 1\n}");
assert.deepEqual(ejsonFromInput("12", "long"), { $numberLong: "12" });
assert.deepEqual(ejsonFromInput("5", "double"), { $numberDouble: "5" });
assert.deepEqual(ejsonFromInput("ObjectId('65f1a2b3c4d5e6f708192a3b')", "objectId"), { $oid: "65f1a2b3c4d5e6f708192a3b" });
assert.deepEqual(ejsonFromInput("2026-02-03 10:00:00Z", "date"), { $date: "2026-02-03T10:00:00.000Z" });
assert.deepEqual(ejsonFromInput("{ a: 1 }", "object"), { a: 1 });
assert.equal(ejsonFromInput("olá", ""), "olá");
assert.deepEqual(ejsonFromInput("[1, 2]", ""), [1, 2]);
assert.throws(() => ejsonFromInput("abc", "int"));
assert.deepEqual(cellToEjson(5, "double"), { $numberDouble: "5" });

// --- documentos → linhas e edições
const st = createDocState();
let { rows, added } = docsToRows(st, [
  { _id: { $oid: "65f1a2b3c4d5e6f708192a3b" }, name: "Ana", n: { $numberLong: "1" } },
  { _id: { $oid: "65f1a2b3c4d5e6f708192a3c" }, name: "Bia", tags: ["x"] },
]);
assert.deepEqual(added.map((c) => c.name), ["_id", "name", "n", "tags"]);
assert.equal(rows[0].length, 4);
assert.equal(st.columns[2].kind, "int");
assert.equal(st.columns[3].kind, "json");
const m = new GridModel(st.columns, rows.map((r) => Array.from({ length: st.columns.length }, (_, i) => r[i])));
m.setCell(0, 2, 2); // long continua long
m.setCell(1, 3, undefined); // remove campo
m.setCell(1, 1, "Bia Lú");
const nr = m.addRow(m.blankRow());
m.setCell(nr, 1, "Caio");
m.deleteRows([0]);
const ch = buildMongoChanges("people", st, st.columns, m.pending());
assert.deepEqual(ch.map((x) => x.text), [
  "db.people.deleteOne({ _id: ObjectId('65f1a2b3c4d5e6f708192a3b') })",
  "db.people.updateOne({ _id: ObjectId('65f1a2b3c4d5e6f708192a3c') }, { $set: { name: 'Bia Lú' }, $unset: { tags: '' } })",
  "db.people.insertOne({ name: 'Caio' })",
]);

// Coleção vazia: _id já existe (aba editável) e inserir funciona; documentos depois não duplicam a coluna.
const empty = createDocState();
ensureIdColumn(empty);
assert.deepEqual(empty.columns.map((c) => c.name), ["_id"]);
const em = new GridModel(empty.columns, []);
em.addRow(em.blankRow());
assert.deepEqual(buildMongoChanges("c", empty, empty.columns, em.pending()).map((x) => x.text), ["db.c.insertOne({})"]);
assert.equal(docsToRows(empty, [{ _id: 1, a: 2 }]).added.map((c) => c.name).join(), "a");
assert.equal(projectionHidesId({ _id: 0 }), true);
assert.equal(projectionHidesId({ name: 1 }), false);
assert.equal(projectionHidesId(null), false);
console.log("mongo: ok");

// --- connection string
const { parseMongoUri, connLabel, normalizeConnection, connConfig } = await import(base + "dbModel.js");
let u = parseMongoUri("mongodb+srv://joao%40x:p%40ss@cluster0.ab12.mongodb.net/loja?retryWrites=true&w=majority");
assert.deepEqual([u.uri, u.user, u.password, u.database], ["mongodb+srv://joao%40x@cluster0.ab12.mongodb.net/loja?retryWrites=true&w=majority", "joao@x", "p@ss", "loja"]);
u = parseMongoUri("mongodb://localhost:27017,localhost:27018/?replicaSet=rs0");
assert.equal(u.user, ""); assert.equal(u.password, undefined); assert.equal(u.hosts, "localhost:27017,localhost:27018");
assert.equal(parseMongoUri("http://x").valid, false);
const mc = normalizeConnection({ driver: "mongo", uri: "mongodb://a@db1:27017/app" });
assert.equal(connLabel(mc), "db1:27017");
assert.equal(connConfig(mc).uri, "mongodb://a@db1:27017/app");
console.log("mongo uri: ok");
