//! Prévia de .md com Espaço no Explorer e na Área de Trabalho (Windows), como o Quick Look do
//! macOS. Um hook de teclado de baixo nível (WH_KEYBOARD_LL) só observa a tecla: nunca a
//! engole nem espera nada. Se o Espaço caiu na lista de arquivos de uma janela do Explorer
//! (ou na Área de Trabalho), a thread de trabalho pergunta ao Shell (COM) qual é o item
//! selecionado e, sendo um único .md, abre/fecha a prévia (md_files::toggle_preview).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;
use windows::core::{w, Interface, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IDispatch, IServiceProvider, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_SPACE};
use windows::Win32::UI::Shell::{IFolderView2, IShellBrowser, IShellWindows, ShellWindows, CSIDL_DESKTOP, SID_STopLevelBrowser, SIGDN_FILESYSPATH, SWC_DESKTOP, SWFO_NEEDDISPATCH};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, FindWindowExW, GetAncestor, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW,
    TranslateMessage, GA_ROOT, GUITHREADINFO, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYUP,
};

use crate::md_files;

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Espaço pressionado (a repetição da tecla segurada não reabre a prévia).
static SPACE_DOWN: AtomicBool = AtomicBool::new(false);
/// Fila para a thread de trabalho (HWND da janela em primeiro plano).
static WORKER: OnceLock<Mutex<Sender<isize>>> = OnceLock::new();

/// Liga/desliga (Configurações). O hook e a thread nascem na 1ª vez e ficam; desligado, o
/// callback só repassa as teclas.
pub fn set_enabled(app: &AppHandle, on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    if !on {
        return;
    }
    WORKER.get_or_init(|| {
        let (tx, rx) = channel();
        let app = app.clone();
        std::thread::spawn(move || worker(app, rx));
        std::thread::spawn(hook_thread);
        Mutex::new(tx)
    });
    // Janela da prévia pré-aquecida (criar janela fora da thread do loop de eventos).
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = md_files::ensure_preview(&app) {
            eprintln!("prévia: {e}");
        }
    });
}

fn hook_thread() {
    unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).ok().map(|m| HINSTANCE(m.0));
        if SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0).is_err() {
            eprintln!("prévia: não foi possível instalar o hook de teclado");
            return;
        }
        // O hook de baixo nível precisa de um laço de mensagens nesta thread.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn pressed(vk: u16) -> bool {
    unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 0 {
        let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if kb.vkCode == VK_SPACE.0 as u32 {
            let msg = wparam.0 as u32;
            if msg == WM_KEYUP || msg == WM_SYSKEYUP {
                SPACE_DOWN.store(false, Ordering::Relaxed);
            } else if msg == WM_KEYDOWN
                && !SPACE_DOWN.swap(true, Ordering::Relaxed)
                && ENABLED.load(Ordering::Relaxed)
                && kb.flags.0 & LLKHF_INJECTED.0 == 0
                && ![VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN].iter().any(|k| pressed(k.0))
            {
                let fg = unsafe { GetForegroundWindow() };
                if is_file_list(fg) {
                    if let Some(tx) = WORKER.get() {
                        let _ = tx.lock().unwrap().send(fg.0 as isize);
                    }
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn is_desktop(class: &str) -> bool {
    class == "Progman" || class == "WorkerW"
}

/// Janela do Explorer/Área de Trabalho com o foco na lista de itens (não no campo de
/// renomear, na barra de endereço ou na busca).
fn is_file_list(fg: HWND) -> bool {
    if fg.is_invalid() {
        return false;
    }
    let class = class_name(fg);
    if class != "CabinetWClass" && class != "ExploreWClass" && !is_desktop(&class) {
        return false;
    }
    let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
    let thread = unsafe { GetWindowThreadProcessId(fg, None) };
    if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_err() {
        return false;
    }
    matches!(class_name(info.hwndFocus).as_str(), "DirectUIHWND" | "SysListView32")
}

fn worker(app: AppHandle, rx: Receiver<isize>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    for raw in rx {
        let fg = HWND(raw as *mut core::ffi::c_void);
        if let Some(path) = unsafe { selected_file(fg) } {
            if md_files::is_md(&path) && path.is_file() {
                md_files::toggle_preview(&app, path);
            }
        }
    }
}

fn variant_i4(value: i32) -> VARIANT {
    let mut v = VARIANT::default();
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_I4;
        inner.Anonymous.lVal = value;
    }
    v
}

unsafe fn top_browser(disp: &IDispatch) -> Option<IShellBrowser> {
    let sp: IServiceProvider = disp.cast().ok()?;
    unsafe { sp.QueryService(&SID_STopLevelBrowser).ok() }
}

/// Caminho do único item selecionado na janela `fg` (aba ativa no Explorer do Windows 11).
unsafe fn selected_file(fg: HWND) -> Option<PathBuf> {
    unsafe {
        let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()?;
        let browser = if is_desktop(&class_name(fg)) {
            let mut hwnd = 0i32;
            let disp = shell.FindWindowSW(&variant_i4(CSIDL_DESKTOP as i32), &VARIANT::default(), SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH).ok()?;
            top_browser(&disp)?
        } else {
            // Cada aba é uma "janela" do Shell; a aba visível é a 1ª ShellTabWindowClass filha.
            let tab = FindWindowExW(Some(fg), None, w!("ShellTabWindowClass"), PCWSTR::null()).ok().filter(|h| !h.is_invalid());
            let mut found = None;
            for i in 0..shell.Count().ok()? {
                let Ok(disp) = shell.Item(&variant_i4(i)) else { continue };
                let Some(b) = top_browser(&disp) else { continue };
                let Ok(h) = b.GetWindow() else { continue };
                let hit = match tab {
                    Some(t) => h == t,
                    None => h == fg || GetAncestor(h, GA_ROOT) == fg,
                };
                if hit {
                    found = Some(b);
                    break;
                }
            }
            found?
        };
        let view: IFolderView2 = browser.QueryActiveShellView().ok()?.cast().ok()?;
        let items = view.GetSelection(false).ok()?;
        if items.GetCount().ok()? != 1 {
            return None;
        }
        let name = items.GetItemAt(0).ok()?.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as *const core::ffi::c_void));
        path.map(PathBuf::from)
    }
}
