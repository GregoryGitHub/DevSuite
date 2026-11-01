//! Sincronização das notas do banco local (notes.db) com a nuvem (app Notas; o motor fica em
//! `src/js/sync/`). O Rust só guarda o estado local do sync:
//!  - `sync_pending (kind, id, seq)`: o que mudou aqui e ainda não subiu. Preenchida por
//!    gatilhos do SQLite em toda gravação de `notes`/`folders` (nenhum caminho de gravação
//!    precisa lembrar do sync); `seq` (maior + 1) muda a cada alteração, então `sync_done` só
//!    limpa a pendência se ela não mudou enquanto subia;
//!  - `sync_ver (kind, id, ver)`: versão da nuvem que este aparelho já tem (a nuvem recusa
//!    gravar sobre uma versão diferente: concorrência otimista nas regras do Firestore);
//!  - `sync_images (name)`: imagens que já estão na nuvem;
//!  - `meta` `sync:*`: cursor da última leitura, conta, aparelho.
//!
//! Nota apagada de vez = pendência sem linha em `notes` (sobe como lápide).
//! Só o banco local sincroniza: com um cofre aberto os comandos recusam.

use std::collections::HashSet;
use std::fs;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::notes_db::{db, i, upsert, with_backend, Backend, Folder, NoteSave};

/// Migração v3 do notes.db. As notas e pastas que já existem entram como pendentes (a 1ª
/// sincronização sobe tudo).
pub const MIGRATION: &str = "
CREATE TABLE sync_pending (kind TEXT NOT NULL, id INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE sync_ver (kind TEXT NOT NULL, id INTEGER NOT NULL, ver INTEGER NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE sync_images (name TEXT PRIMARY KEY);
CREATE TRIGGER notes_sync_ai AFTER INSERT ON notes BEGIN
    INSERT INTO sync_pending (kind, id, seq) VALUES ('note', new.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_pending))
        ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER notes_sync_au AFTER UPDATE ON notes BEGIN
    INSERT INTO sync_pending (kind, id, seq) VALUES ('note', new.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_pending))
        ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER notes_sync_ad AFTER DELETE ON notes BEGIN
    INSERT INTO sync_pending (kind, id, seq) VALUES ('note', old.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_pending))
        ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER folders_sync_ai AFTER INSERT ON folders BEGIN
    INSERT INTO sync_pending (kind, id, seq) VALUES ('folder', new.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_pending))
        ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER folders_sync_au AFTER UPDATE ON folders BEGIN
    INSERT INTO sync_pending (kind, id, seq) VALUES ('folder', new.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_pending))
        ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq;
END;
CREATE TRIGGER folders_sync_ad AFTER DELETE ON folders BEGIN
    INSERT INTO sync_pending (kind, id, seq) VALUES ('folder', old.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_pending))
        ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq;
END;
INSERT INTO sync_pending (kind, id, seq) SELECT 'folder', id, id FROM folders;
INSERT INTO sync_pending (kind, id, seq) SELECT 'note', id, id FROM notes;
";

/// Alteração local ainda não enviada. `item` = None: apagada (sobe como lápide).
#[derive(Serialize, Debug)]
pub struct Pending {
    pub kind: String,
    pub id: u64,
    pub seq: i64,
    /// Versão da nuvem em que a alteração se baseia (0 = nunca subiu).
    pub ver: i64,
    pub item: Option<serde_json::Value>,
}

/// Envio confirmado: a nuvem está na versão `ver`.
#[derive(Deserialize, Debug)]
pub struct Done {
    pub kind: String,
    pub id: u64,
    pub seq: i64,
    pub ver: i64,
}

#[derive(Deserialize, Debug)]
pub struct RemoteNote {
    #[serde(flatten)]
    pub note: NoteSave,
    pub ver: i64,
}

#[derive(Deserialize, Debug)]
pub struct RemoteFolder {
    #[serde(flatten)]
    pub folder: Folder,
    #[serde(default)]
    pub position: i64,
    pub ver: i64,
}

#[derive(Deserialize, Debug)]
pub struct Gone {
    pub id: u64,
    pub ver: i64,
}

#[derive(Deserialize, Debug)]
pub struct Ver {
    pub kind: String,
    pub id: u64,
    pub ver: i64,
}

/// Mudanças vindas da nuvem, já decididas pelo motor do JS (conflitos resolvidos antes).
#[derive(Deserialize, Debug, Default)]
pub struct RemoteChanges {
    #[serde(default)]
    pub notes: Vec<RemoteNote>,
    #[serde(default)]
    pub deleted_notes: Vec<Gone>,
    #[serde(default)]
    pub folders: Vec<RemoteFolder>,
    #[serde(default)]
    pub deleted_folders: Vec<Gone>,
    /// Só a versão (a alteração local continua pendente e sobe em cima dela).
    #[serde(default)]
    pub vers: Vec<Ver>,
}

fn note_json(conn: &Connection, id: u64) -> rusqlite::Result<Option<serde_json::Value>> {
    conn.query_row(
        "SELECT id, title, preview, content, plain, images, created_at, updated_at, pinned, folder_id, deleted_at, props, links FROM notes WHERE id = ?1",
        params![i(id)],
        |r| {
            let parse = |s: String| if s.is_empty() { serde_json::Value::Null } else { serde_json::from_str(&s).unwrap_or(serde_json::Value::Null) };
            let images: String = r.get(5)?;
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)? as u64,
                "title": r.get::<_, String>(1)?,
                "preview": r.get::<_, String>(2)?,
                "content": r.get::<_, String>(3)?,
                "plain": r.get::<_, String>(4)?,
                "images": images.split_whitespace().collect::<Vec<_>>(),
                "created_at": r.get::<_, String>(6)?,
                "updated_at": r.get::<_, i64>(7)? as u64,
                "pinned": r.get::<_, u32>(8)?,
                "folder_id": r.get::<_, i64>(9)? as u64,
                "deleted_at": r.get::<_, Option<i64>>(10)?,
                "props": parse(r.get(11)?),
                "links": match parse(r.get(12)?) { serde_json::Value::Null => serde_json::json!([]), v => v },
            }))
        },
    )
    .optional()
}

fn folder_json(conn: &Connection, id: u64) -> rusqlite::Result<Option<serde_json::Value>> {
    conn.query_row("SELECT id, name, parent_id, position FROM folders WHERE id = ?1", params![i(id)], |r| {
        Ok(serde_json::json!({
            "id": r.get::<_, i64>(0)? as u64,
            "name": r.get::<_, String>(1)?,
            "parent_id": r.get::<_, i64>(2)? as u64,
            "position": r.get::<_, i64>(3)?,
        }))
    })
    .optional()
}

/// Pendências (pastas primeiro: uma nota nova pode estar numa pasta nova). `items = false` =
/// só ids/versões (o motor confere conflitos sem carregar o HTML).
pub fn pending(conn: &Connection, items: bool, limit: usize) -> rusqlite::Result<Vec<Pending>> {
    let mut st = conn.prepare(
        "SELECT p.kind, p.id, p.seq, COALESCE(v.ver, 0) FROM sync_pending p
         LEFT JOIN sync_ver v ON v.kind = p.kind AND v.id = p.id
         ORDER BY p.kind = 'note', p.seq LIMIT ?1",
    )?;
    let rows = st.query_map(params![limit as i64], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (kind, id, seq, ver) = row?;
        let item = match (items, kind.as_str()) {
            (false, _) => None,
            (true, "note") => note_json(conn, id)?,
            (true, _) => folder_json(conn, id)?,
        };
        out.push(Pending { kind, id, seq, ver, item });
    }
    Ok(out)
}

pub fn pending_count(conn: &Connection) -> rusqlite::Result<u64> {
    conn.query_row("SELECT COUNT(*) FROM sync_pending", [], |r| r.get::<_, i64>(0)).map(|n| n as u64)
}

fn set_ver(conn: &Connection, kind: &str, id: u64, ver: i64) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO sync_ver (kind, id, ver) VALUES (?1, ?2, ?3)", params![kind, i(id), ver])?;
    Ok(())
}

fn ver_of(conn: &Connection, kind: &str, id: u64) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row("SELECT ver FROM sync_ver WHERE kind = ?1 AND id = ?2", params![kind, i(id)], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

fn clear_pending(conn: &Connection, kind: &str, id: u64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sync_pending WHERE kind = ?1 AND id = ?2", params![kind, i(id)])?;
    Ok(())
}

/// Envio confirmado: grava a versão e limpa a pendência (se não mudou enquanto subia).
pub fn done(conn: &mut Connection, items: &[Done]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for d in items {
        set_ver(&tx, &d.kind, d.id, d.ver)?;
        tx.execute("DELETE FROM sync_pending WHERE kind = ?1 AND id = ?2 AND seq = ?3", params![d.kind, i(d.id), d.seq])?;
    }
    tx.commit()
}

/// Aplica mudanças da nuvem sem marcá-las como pendentes. Versão igual ou menor que a que
/// este aparelho já tem é ignorada (eco do próprio envio, leitura repetida).
pub fn apply(conn: &mut Connection, ch: &RemoteChanges) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for f in &ch.folders {
        if f.ver <= ver_of(&tx, "folder", f.folder.id)? {
            continue;
        }
        tx.execute(
            "INSERT INTO folders (id, name, position, parent_id) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = excluded.position, parent_id = excluded.parent_id",
            params![i(f.folder.id), f.folder.name, f.position, i(f.folder.parent_id)],
        )?;
        clear_pending(&tx, "folder", f.folder.id)?;
        set_ver(&tx, "folder", f.folder.id, f.ver)?;
    }
    for g in &ch.deleted_folders {
        if g.ver <= ver_of(&tx, "folder", g.id)? {
            continue;
        }
        tx.execute("DELETE FROM folders WHERE id = ?1", params![i(g.id)])?;
        clear_pending(&tx, "folder", g.id)?;
        set_ver(&tx, "folder", g.id, g.ver)?;
    }
    for n in &ch.notes {
        let id = n.note.meta.id;
        if n.ver <= ver_of(&tx, "note", id)? {
            continue;
        }
        upsert(&tx, &n.note, true)?;
        clear_pending(&tx, "note", id)?;
        set_ver(&tx, "note", id, n.ver)?;
    }
    for g in &ch.deleted_notes {
        if g.ver <= ver_of(&tx, "note", g.id)? {
            continue;
        }
        tx.execute("DELETE FROM notes WHERE id = ?1", params![i(g.id)])?;
        clear_pending(&tx, "note", g.id)?;
        set_ver(&tx, "note", g.id, g.ver)?;
    }
    for v in &ch.vers {
        set_ver(&tx, &v.kind, v.id, v.ver)?;
    }
    tx.commit()
}

/// Outra conta (ou "sincronizar do zero"): esquece as versões e marca tudo como pendente.
pub fn reset(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DELETE FROM sync_ver; DELETE FROM sync_images; DELETE FROM sync_pending;
         DELETE FROM meta WHERE key LIKE 'sync:%';
         INSERT INTO sync_pending (kind, id, seq) SELECT 'folder', id, id FROM folders;
         INSERT INTO sync_pending (kind, id, seq) SELECT 'note', id, id FROM notes;",
    )?;
    tx.commit()
}

pub fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![format!("sync:{key}")], |r| r.get(0)).optional()
}

pub fn meta_set(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    let key = format!("sync:{key}");
    match value {
        Some(v) => conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, v])?,
        None => conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?,
    };
    Ok(())
}

/// Imagens usadas pelas notas que ainda não foram enviadas (as que não existem no disco ficam de fora).
pub fn images_to_upload(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let uploaded: HashSet<String> = {
        let mut st = conn.prepare("SELECT name FROM sync_images")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let (_, used) = crate::notes_db::image_names(conn)?;
    let mut out: Vec<String> = used.into_iter().filter(|n| !uploaded.contains(n)).collect();
    out.sort();
    Ok(out)
}

pub fn images_mark(conn: &mut Connection, names: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for n in names {
        tx.execute("INSERT OR IGNORE INTO sync_images (name) VALUES (?1)", params![n])?;
    }
    tx.commit()
}

// ---------- Comandos Tauri ----------

/// Roda `f` no notes.db; com um cofre aberto, recusa (o cofre não sincroniza com a nuvem).
async fn with_sqlite<T, F>(app: tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
{
    with_backend(app, move |b| match b {
        Backend::Sqlite(c) => db(f(c)),
        Backend::Vault(_) => Err("A sincronização com a nuvem vale só para as notas no banco local (não para o cofre).".into()),
    })
    .await
}

#[tauri::command]
pub async fn sync_pending(app: tauri::AppHandle, items: bool, limit: Option<usize>) -> Result<serde_json::Value, String> {
    with_sqlite(app, move |c| {
        let list = pending(c, items, limit.unwrap_or(200))?;
        Ok(serde_json::json!({ "items": list, "total": pending_count(c)? }))
    })
    .await
}

#[tauri::command]
pub async fn sync_done(app: tauri::AppHandle, items: Vec<Done>) -> Result<(), String> {
    with_sqlite(app, move |c| done(c, &items)).await
}

#[tauri::command]
pub async fn sync_apply(app: tauri::AppHandle, changes: RemoteChanges) -> Result<(), String> {
    with_sqlite(app, move |c| apply(c, &changes)).await
}

#[tauri::command]
pub async fn sync_reset(app: tauri::AppHandle) -> Result<(), String> {
    with_sqlite(app, reset).await
}

#[tauri::command]
pub async fn sync_meta_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    with_sqlite(app, move |c| meta_get(c, &key)).await
}

/// `value` = null apaga a chave.
#[tauri::command]
pub async fn sync_meta_set(app: tauri::AppHandle, key: String, value: Option<String>) -> Result<(), String> {
    with_sqlite(app, move |c| meta_set(c, &key, value.as_deref())).await
}

#[tauri::command]
pub async fn sync_images_pending(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    with_sqlite(app, |c| images_to_upload(c)).await
}

#[tauri::command]
pub async fn sync_images_mark(app: tauri::AppHandle, names: Vec<String>) -> Result<(), String> {
    with_sqlite(app, move |c| images_mark(c, &names)).await
}

/// Bytes de uma imagem do banco local (para enviar). Resposta crua, sem JSON.
#[tauri::command]
pub async fn note_image_read(app: tauri::AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
    if !crate::note_images::valid_name(&name) {
        return Err("Nome de imagem inválido.".into());
    }
    let path = crate::note_images::local_images_dir(&app)?.join(&name);
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(path)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Das imagens pedidas, as que não existem no banco local (baixar da nuvem).
#[tauri::command]
pub async fn note_images_missing(app: tauri::AppHandle, names: Vec<String>) -> Result<Vec<String>, String> {
    let dir = crate::note_images::local_images_dir(&app)?;
    Ok(names.into_iter().filter(|n| crate::note_images::valid_name(n) && !dir.join(n).exists()).collect())
}

/// Grava uma imagem baixada da nuvem com o nome dela (corpo = bytes crus, header `x-name`).
#[tauri::command]
pub async fn note_image_put(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !crate::note_images::valid_name(&name) {
        return Err("Nome de imagem inválido.".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Corpo da imagem ausente.".into());
    };
    let bytes = bytes.clone();
    let dir = crate::note_images::local_images_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir)?;
        let path = dir.join(&name);
        if path.exists() {
            return Ok(());
        }
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes_db::{delete, init, list, save, save_folders, set_meta, NoteMeta};
    use std::collections::HashMap;

    fn vers(conn: &Connection) -> HashMap<(String, u64), i64> {
        let mut st = conn.prepare("SELECT kind, id, ver FROM sync_ver").unwrap();
        let rows = st.query_map([], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64), r.get::<_, i64>(2)?))).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn note(id: u64, text: &str) -> NoteSave {
        NoteSave {
            meta: NoteMeta { id, title: text.into(), updated_at: id, ..Default::default() },
            content: format!("<p>{text}</p>"),
            plain: text.into(),
            images: vec!["a.png".into()],
            ..Default::default()
        }
    }

    fn ids(p: &[Pending]) -> Vec<(String, u64)> {
        p.iter().map(|x| (x.kind.clone(), x.id)).collect()
    }

    #[test]
    fn every_write_marks_pending_and_done_clears_it() {
        let mut c = db();
        save(&c, &note(1, "um")).unwrap();
        save_folders(&mut c, &[Folder { id: 7, name: "Pasta".into(), parent_id: 0 }]).unwrap();
        let p = pending(&c, true, 100).unwrap();
        assert_eq!(ids(&p), vec![("folder".into(), 7), ("note".into(), 1)]);
        assert_eq!(p[1].item.as_ref().unwrap()["content"], "<p>um</p>");
        assert_eq!(p[1].item.as_ref().unwrap()["images"], serde_json::json!(["a.png"]));

        let d: Vec<Done> = p.iter().map(|x| Done { kind: x.kind.clone(), id: x.id, seq: x.seq, ver: 1 }).collect();
        done(&mut c, &d).unwrap();
        assert!(pending(&c, false, 100).unwrap().is_empty());
        assert_eq!(vers(&c)[&("note".into(), 1)], 1);

        set_meta(&mut c, &[NoteMeta { id: 1, pinned: 1, updated_at: 9, ..Default::default() }]).unwrap();
        let p = pending(&c, false, 100).unwrap();
        assert_eq!(ids(&p), vec![("note".into(), 1)]);
        assert_eq!(p[0].ver, 1);
    }

    #[test]
    fn change_while_uploading_keeps_pending() {
        let mut c = db();
        save(&c, &note(1, "um")).unwrap();
        let seq = pending(&c, false, 10).unwrap()[0].seq;
        save(&c, &note(1, "editada")).unwrap();
        done(&mut c, &[Done { kind: "note".into(), id: 1, seq, ver: 1 }]).unwrap();
        assert_eq!(pending(&c, false, 10).unwrap().len(), 1);
    }

    #[test]
    fn deleted_note_is_pending_without_item() {
        let mut c = db();
        save(&c, &note(1, "um")).unwrap();
        delete(&mut c, &[1]).unwrap();
        let p = pending(&c, true, 10).unwrap();
        assert_eq!(ids(&p), vec![("note".into(), 1)]);
        assert!(p[0].item.is_none());
    }

    #[test]
    fn unchanged_folders_are_not_rewritten() {
        let mut c = db();
        let f = vec![Folder { id: 1, name: "A".into(), parent_id: 0 }, Folder { id: 2, name: "B".into(), parent_id: 0 }];
        save_folders(&mut c, &f).unwrap();
        reset(&mut c).unwrap();
        c.execute("DELETE FROM sync_pending", []).unwrap();
        save_folders(&mut c, &f).unwrap();
        assert!(pending(&c, false, 10).unwrap().is_empty());
        save_folders(&mut c, &[f[1].clone()]).unwrap();
        // A saiu (lápide) e B mudou de posição.
        assert_eq!(ids(&pending(&c, false, 10).unwrap()), vec![("folder".into(), 1), ("folder".into(), 2)]);
    }

    #[test]
    fn apply_does_not_mark_pending_and_ignores_old_versions() {
        let mut c = db();
        let ch = RemoteChanges {
            notes: vec![RemoteNote { note: note(5, "remota"), ver: 3 }],
            folders: vec![RemoteFolder { folder: Folder { id: 9, name: "Nuvem".into(), parent_id: 0 }, position: 0, ver: 2 }],
            ..Default::default()
        };
        apply(&mut c, &ch).unwrap();
        assert!(pending(&c, false, 10).unwrap().is_empty());
        assert_eq!(list(&c, 0).unwrap()[0].title, "remota");

        // Eco/versão antiga: não sobrescreve.
        let old = RemoteChanges { notes: vec![RemoteNote { note: note(5, "velha"), ver: 3 }], ..Default::default() };
        apply(&mut c, &old).unwrap();
        assert_eq!(list(&c, 0).unwrap()[0].title, "remota");

        apply(&mut c, &RemoteChanges { deleted_notes: vec![Gone { id: 5, ver: 4 }], ..Default::default() }).unwrap();
        assert!(list(&c, 0).unwrap().is_empty());
        assert!(pending(&c, false, 10).unwrap().is_empty());
    }

    #[test]
    fn existing_data_becomes_pending_on_migration() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
               content TEXT NOT NULL DEFAULT '', plain TEXT NOT NULL DEFAULT '', images TEXT NOT NULL DEFAULT '',
               created_at TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
               folder_id INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
             INSERT INTO notes (id, title) VALUES (1, 'a'), (2, 'b');
             INSERT INTO folders (id, name) VALUES (3, 'p');",
        )
        .unwrap();
        init(&c).unwrap();
        assert_eq!(pending(&c, false, 10).unwrap().len(), 3);
    }

    #[test]
    fn images_to_upload_skips_uploaded() {
        let mut c = db();
        save(&c, &note(1, "um")).unwrap();
        assert_eq!(images_to_upload(&c).unwrap(), vec!["a.png".to_string()]);
        images_mark(&mut c, &["a.png".into()]).unwrap();
        assert!(images_to_upload(&c).unwrap().is_empty());
    }

    #[test]
    fn meta_round_trip() {
        let c = db();
        meta_set(&c, "cursor", Some("123")).unwrap();
        assert_eq!(meta_get(&c, "cursor").unwrap().as_deref(), Some("123"));
        meta_set(&c, "cursor", None).unwrap();
        assert_eq!(meta_get(&c, "cursor").unwrap(), None);
    }
}
