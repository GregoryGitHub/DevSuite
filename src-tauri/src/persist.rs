//! Gravação dos arquivos de dados fora da thread principal.
//!
//! Comandos Tauri síncronos rodam na thread principal (a mesma da WebView no Windows):
//! um `fs::write` ali trava a interface. Os comandos `save_*` só serializam e entregam o
//! conteúdo para uma thread dedicada, que grava em ordem, de forma atômica (temporário +
//! rename) e descarta versões intermediárias do mesmo arquivo que chegaram em sequência.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::{fs, io, thread};

enum Msg {
    Write(PathBuf, String),
    Flush(Sender<()>),
}

static QUEUE: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();

fn queue() -> Sender<Msg> {
    QUEUE
        .get_or_init(|| {
            let (tx, rx) = channel();
            thread::Builder::new()
                .name("persist".into())
                .spawn(move || writer(rx))
                .expect("failed to start persist thread");
            Mutex::new(tx)
        })
        .lock()
        .unwrap()
        .clone()
}

fn writer(rx: Receiver<Msg>) {
    while let Ok(first) = rx.recv() {
        // Junta o que chegou enquanto a última gravação acontecia.
        let mut batch = vec![first];
        batch.extend(rx.try_iter());

        let mut order: Vec<PathBuf> = Vec::new();
        let mut latest: HashMap<PathBuf, String> = HashMap::new();
        let mut waiters = Vec::new();
        for msg in batch {
            match msg {
                Msg::Write(path, contents) => {
                    if !latest.contains_key(&path) {
                        order.push(path.clone());
                    }
                    latest.insert(path, contents);
                }
                Msg::Flush(done) => waiters.push(done),
            }
        }
        for path in order {
            if let Some(contents) = latest.remove(&path) {
                if let Err(e) = write_atomic(&path, &contents) {
                    eprintln!("falha ao gravar {}: {e}", path.display());
                }
            }
        }
        for done in waiters {
            let _ = done.send(());
        }
    }
}

/// Escreve num temporário ao lado e renomeia: o arquivo nunca fica pela metade.
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let mut tmp: OsString = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

/// Agenda a gravação de `contents` em `path` e retorna na hora.
pub fn write(path: PathBuf, contents: String) {
    let _ = queue().send(Msg::Write(path, contents));
}

/// Bloqueia até todas as gravações agendadas terminarem (usado antes de sair do app).
pub fn flush() {
    let (tx, rx) = channel();
    if queue().send(Msg::Flush(tx)).is_ok() {
        let _ = rx.recv();
    }
}
