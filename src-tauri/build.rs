use std::process::Command;

/// Identificação da build exibida nas Configurações → "Sobre" (`app_build_info`):
/// número = quantidade de commits do HEAD (cresce a cada commit; no CI o checkout é completo),
/// commit curto, "+" se havia alterações não commitadas, e a data/hora da compilação (UTC).
fn main() {
    let git = |args: &[&str]| -> Option<String> {
        let out = Command::new("git").args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
    };
    let number = std::env::var("DEVSUITE_BUILD_NUMBER").ok().or_else(|| git(&["rev-list", "--count", "HEAD"])).unwrap_or_else(|| "0".into());
    let commit = git(&["rev-parse", "--short=8", "HEAD"]).unwrap_or_default();
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some();
    let date = chrono_like_now();
    println!("cargo:rustc-env=DEVSUITE_BUILD_NUMBER={number}");
    println!("cargo:rustc-env=DEVSUITE_BUILD_COMMIT={commit}{}", if dirty { "+" } else { "" });
    println!("cargo:rustc-env=DEVSUITE_BUILD_DATE={date}");
    // Recompila a identificação quando o HEAD ou o índice mudam (commit, checkout, add).
    for f in ["../.git/HEAD", "../.git/index"] {
        if std::path::Path::new(f).exists() {
            println!("cargo:rerun-if-changed={f}");
        }
    }
    if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
        let p = format!("../.git/{r}");
        if std::path::Path::new(&p).exists() {
            println!("cargo:rerun-if-changed={p}");
        }
    }
    println!("cargo:rerun-if-env-changed=DEVSUITE_BUILD_NUMBER");
    // Os scripts de build (build_windows.ps1/build_linux.sh) mudam este valor a cada execução:
    // data e "+" (alterações não commitadas) ficam sempre atuais nas builds de release.
    println!("cargo:rerun-if-env-changed=DEVSUITE_BUILD_STAMP");
    tauri_build::build()
}

/// AAAA-MM-DD HH:MM UTC sem dependências de build (dias civis a partir da época Unix).
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Algoritmo de Howard Hinnant (civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
}
