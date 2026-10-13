//! Exportação de notas em PDF: imprime a própria webview direto num arquivo (sem diálogo de
//! impressão). O JS monta a nota num contêiner visível só na mídia `print` antes de chamar.
//! Página A4 com margens de 15 mm; texto vetorial e selecionável, com as fontes da interface.

use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

type Done = Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

fn finish(done: &Done, result: Result<(), String>) {
    if let Some(tx) = done.lock().ok().and_then(|mut d| d.take()) {
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub async fn notes_print_pdf(webview: tauri::Webview, path: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    let done: Done = Arc::new(Mutex::new(Some(tx)));
    let start = done.clone();
    webview
        .with_webview(move |wv| {
            if let Err(e) = print_to_file(wv, &path, start.clone()) {
                finish(&start, Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "A impressão foi interrompida.".to_string())?
}

#[cfg(windows)]
fn print_to_file(wv: tauri::webview::PlatformWebview, path: &str, done: Done) -> Result<(), String> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PrintToPdfCompletedHandler};
    use windows_core::{Interface, HSTRING};

    const MARGIN_IN: f64 = 15.0 / 25.4;
    let run = || -> windows_core::Result<()> {
        unsafe {
            let core: ICoreWebView2_7 = wv.controller().CoreWebView2()?.cast()?;
            let env: ICoreWebView2Environment6 = wv.environment().cast()?;
            let settings = env.CreatePrintSettings()?;
            settings.SetPageWidth(210.0 / 25.4)?;
            settings.SetPageHeight(297.0 / 25.4)?;
            settings.SetMarginTop(MARGIN_IN)?;
            settings.SetMarginBottom(MARGIN_IN)?;
            settings.SetMarginLeft(MARGIN_IN)?;
            settings.SetMarginRight(MARGIN_IN)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            let cb = done.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                finish(
                    &cb,
                    match hr {
                        Err(e) => Err(e.message()),
                        Ok(()) if !ok => Err("O WebView2 não conseguiu gerar o PDF.".into()),
                        Ok(()) => Ok(()),
                    },
                );
                Ok(())
            }));
            core.PrintToPdf(&HSTRING::from(path), &settings, &handler)
        }
    };
    run().map_err(|e| format!("Falha ao gerar o PDF: {}", e.message()))
}

#[cfg(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd"))]
fn print_to_file(wv: tauri::webview::PlatformWebview, path: &str, done: Done) -> Result<(), String> {
    use gtk::{PageSetup, PaperSize, PrintSettings, Unit};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let uri = gtk::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
    let settings = PrintSettings::new();
    settings.set_printer("Print to File");
    settings.set("output-file-format", Some("pdf"));
    settings.set("output-uri", Some(uri.as_str()));
    let paper = PaperSize::new(Some(gtk::PAPER_NAME_A4.as_str()));
    settings.set_paper_size(&paper);
    let setup = PageSetup::new();
    setup.set_paper_size(&paper);
    setup.set_top_margin(15.0, Unit::Mm);
    setup.set_bottom_margin(15.0, Unit::Mm);
    setup.set_left_margin(15.0, Unit::Mm);
    setup.set_right_margin(15.0, Unit::Mm);

    let op = PrintOperation::new(&wv.inner());
    op.set_print_settings(&settings);
    op.set_page_setup(&setup);
    let failed = done.clone();
    op.connect_failed(move |_, err| finish(&failed, Err(format!("Falha ao gerar o PDF: {err}"))));
    // "finished" também chega depois de "failed": aí o resultado já foi enviado.
    op.connect_finished(move |_| finish(&done, Ok(())));
    op.print();
    Ok(())
}

#[cfg(target_os = "macos")]
fn print_to_file(_wv: tauri::webview::PlatformWebview, _path: &str, _done: Done) -> Result<(), String> {
    Err("Exportar PDF ainda não é suportado no macOS.".into())
}
