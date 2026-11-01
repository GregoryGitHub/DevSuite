//! Ler/gravar arquivos escolhidos pelo usuário (importação/exportação de Notas e HTTP).
//! Fora do `http.rs` para existir também no app só de Notas (sem a feature `suite`).

use std::fs;

use base64::{engine::general_purpose::STANDARD as B64, Engine};

/// Lê um arquivo de texto escolhido pelo usuário (importação de coleções).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Salva texto (exportação) ou bytes em base64 (corpo de resposta binário).
#[tauri::command]
pub fn write_file(path: String, text: Option<String>, base64: Option<String>) -> Result<(), String> {
    let bytes = match (text, base64) {
        (_, Some(b)) => B64.decode(b).map_err(|e| e.to_string())?,
        (Some(t), None) => t.into_bytes(),
        (None, None) => Vec::new(),
    };
    fs::write(&path, bytes).map_err(|e| e.to_string())
}
