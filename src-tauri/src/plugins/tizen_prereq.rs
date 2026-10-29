// Samsung Tizen prerequisites check: everything the Samsung flows need on this machine,
// checked up front so a QA machine missing a piece finds out before an install fails halfway.
//
// What needs what: listing, launching, killing and debugging apps speak the SDB protocol over
// TCP themselves and need nothing installed. The signed install is the one that leans on the
// machine — the bundled `sdb` sidecar (disconnect / kill-server / connect), Tizen Studio's
// `tizen` CLI (package + install), the `sdb` the CLI itself calls and the Java the CLI runs on.
//
// Only what has to be installed is listed. Certificate profiles and the TVs they cover are set up
// after that, and the signed install checks them per TV anyway (`tizen_install_signed`). Studio's
// own sdb shows only when it fails: when it works it is the same tool as the bundled one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;

use super::samsung_tizen::studio_candidates;
use crate::error::Error;

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Fail,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrereqCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: CheckStatus,
    /// What was found: a path, a version, or what is missing.
    pub detail: String,
    /// How to fix it. Absent when the check passed.
    pub hint: Option<String>,
}

impl PrereqCheck {
    fn ok(id: &'static str, label: &'static str, detail: impl Into<String>) -> Self {
        Self { id, label, status: CheckStatus::Ok, detail: detail.into(), hint: None }
    }

    fn fail(id: &'static str, label: &'static str, detail: impl Into<String>, hint: impl Into<String>) -> Self {
        Self { id, label, status: CheckStatus::Fail, detail: detail.into(), hint: Some(hint.into()) }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TizenPrerequisites {
    /// The Tizen Studio the checks ran against — the saved one, or the one detected.
    pub studio_path: Option<String>,
    pub checks: Vec<PrereqCheck>,
    /// `macos`, `windows` or `linux` — which install steps the UI shows for a failed check.
    pub os: &'static str,
    /// `aarch64` or `x86_64`. Tizen Studio ships Intel-only binaries, so Apple Silicon needs Rosetta.
    pub arch: &'static str,
}

const INSTALL_STUDIO_HINT: &str =
    "Install the Tizen Studio CLI, then Certificate Manager and the Samsung Certificate \
     Extension with package-manager-cli — the steps below have the commands.";

/// `tizen version` starts a JVM — about 4 s on an M-series Mac — so the limit is generous.
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

#[tauri::command]
pub(crate) async fn tizen_check_prerequisites<R: Runtime>(
    app: AppHandle<R>,
    studio_path: Option<String>,
) -> Result<TizenPrerequisites, Error> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let saved_studio = studio_path.filter(|p| !p.trim().is_empty());
    let (studio, studio_check) = resolve_studio(saved_studio.as_deref(), &studio_candidates(&home));

    let mut checks = vec![bundled_sdb_check(&app).await, studio_check];

    match &studio {
        Some(path) => {
            let (cli, studio_sdb, java) = tokio::join!(
                tizen_cli_check(path),
                studio_sdb_check(path),
                java_check(path),
            );
            checks.push(cli);
            if studio_sdb.status != CheckStatus::Ok {
                checks.push(studio_sdb);
            }
            checks.push(java);
        }
        None => {
            for (id, label) in [
                ("tizen-cli", "Tizen CLI"),
                ("studio-sdb", "Tizen Studio sdb"),
                ("java", "Java for the Tizen CLI"),
            ] {
                checks.push(PrereqCheck::fail(id, label, "Needs Tizen Studio", INSTALL_STUDIO_HINT));
            }
        }
    }

    Ok(TizenPrerequisites {
        studio_path: studio,
        checks,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })
}

// ── Tizen Studio ─────────────────────────────────────────────────────────────

fn tizen_bin(studio: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    return Path::new(studio).join(r"tools\ide\bin\tizen.bat");
    #[cfg(not(target_os = "windows"))]
    return Path::new(studio).join("tools/ide/bin/tizen");
}

fn studio_sdb_bin(studio: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    return Path::new(studio).join(r"tools\sdb.exe");
    #[cfg(not(target_os = "windows"))]
    return Path::new(studio).join("tools/sdb");
}

/// Picks the Tizen Studio to check: the saved path when it holds the CLI, otherwise the first
/// default location that does. A saved path that has gone missing is a failure even when another
/// install is found, because the signed install uses the saved path.
fn resolve_studio(saved: Option<&str>, candidates: &[String]) -> (Option<String>, PrereqCheck) {
    const ID: &str = "studio";
    const LABEL: &str = "Tizen Studio";
    let has_cli = |p: &str| tizen_bin(p).exists();
    let detected = candidates.iter().find(|p| has_cli(p)).cloned();
    let describe = |p: &str| match sdk_version(p) {
        Some(v) => format!("{p} (SDK {v})"),
        None => p.to_owned(),
    };

    match (saved, detected) {
        (Some(s), _) if has_cli(s) => (Some(s.to_owned()), PrereqCheck::ok(ID, LABEL, describe(s))),
        (Some(s), Some(found)) => {
            let detail = format!("Saved path {s} has no Tizen CLI; found one at {found}");
            let hint = "Set up the signing certificate again (Samsung → Apps → Configure) so the \
                        app saves the current Tizen Studio location.";
            (Some(found), PrereqCheck::fail(ID, LABEL, detail, hint))
        }
        (Some(s), None) => (
            None,
            PrereqCheck::fail(ID, LABEL, format!("Not found at the saved path {s}"), INSTALL_STUDIO_HINT),
        ),
        (None, Some(found)) => (Some(found.clone()), PrereqCheck::ok(ID, LABEL, describe(&found))),
        (None, None) => (
            None,
            PrereqCheck::fail(ID, LABEL, format!("Not found in {}", candidates.join(", ")), INSTALL_STUDIO_HINT),
        ),
    }
}

fn sdk_version(studio: &str) -> Option<String> {
    let content = std::fs::read_to_string(Path::new(studio).join("sdk.version")).ok()?;
    sdk_value(&content, "TIZEN_SDK_VERSION")
}

/// A `KEY=value` line out of `sdk.version` / `sdk.info`.
fn sdk_value(content: &str, key: &str) -> Option<String> {
    content
        .lines()
        .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('=').map(|v| v.trim().to_owned()))
        .filter(|v| !v.is_empty())
}

async fn tizen_cli_check(studio: &str) -> PrereqCheck {
    const ID: &str = "tizen-cli";
    const LABEL: &str = "Tizen CLI";
    let bin = tizen_bin(studio);
    match run(&bin, &["version"]).await {
        Ok(out) => match version_line(&out, "Tizen CLI") {
            Some(v) => PrereqCheck::ok(ID, LABEL, v),
            None => PrereqCheck::fail(
                ID, LABEL,
                format!("{} did not report a version: {}", bin.display(), first_line(&out)),
                "The CLI is installed but does not run — usually Java (see below). Reinstalling \
                 Tizen Studio repairs it.",
            ),
        },
        Err(e) => PrereqCheck::fail(ID, LABEL, e, INSTALL_STUDIO_HINT),
    }
}

async fn studio_sdb_check(studio: &str) -> PrereqCheck {
    const ID: &str = "studio-sdb";
    const LABEL: &str = "Tizen Studio sdb";
    let bin = studio_sdb_bin(studio);
    match run(&bin, &["version"]).await {
        Ok(out) => match version_line(&out, "Smart Development Bridge") {
            Some(v) => PrereqCheck::ok(ID, LABEL, format!("{v} — {}", bin.display())),
            None => PrereqCheck::fail(
                ID, LABEL,
                format!("{} did not report a version: {}", bin.display(), first_line(&out)),
                "Reinstall Tizen Studio; `tizen install` connects to the TV through this sdb.",
            ),
        },
        Err(e) => PrereqCheck::fail(
            ID, LABEL, e,
            "Install the Tizen Studio SDK tools; `tizen install` connects to the TV through this sdb.",
        ),
    }
}

/// The Java the Tizen CLI will run on. `tizen.sh` uses `JDK_PATH` from `sdk.info` when that
/// folder exists, then the JDK Tizen Studio ships in `<studio>/jdk`, then `java` on the PATH.
fn java_exec(studio: &str) -> (PathBuf, &'static str) {
    let from_sdk_info = std::fs::read_to_string(Path::new(studio).join("sdk.info"))
        .ok()
        .and_then(|c| sdk_value(&c, "JDK_PATH"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    let (jdk, source) = match from_sdk_info {
        Some(p) => (p, "sdk.info JDK_PATH"),
        None => (Path::new(studio).join("jdk"), "bundled with Tizen Studio"),
    };
    if !jdk.is_dir() {
        return (PathBuf::from("java"), "system");
    }
    #[cfg(target_os = "macos")]
    let java = jdk.join("Contents/Home/bin/java");
    #[cfg(target_os = "windows")]
    let java = jdk.join(r"bin\java.exe");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let java = jdk.join("bin/java");
    (java, source)
}

async fn java_check(studio: &str) -> PrereqCheck {
    const ID: &str = "java";
    const LABEL: &str = "Java for the Tizen CLI";
    let (java, source) = java_exec(studio);
    match run(&java, &["-version"]).await {
        Ok(out) => match java_version(&out) {
            Some(v) => PrereqCheck::ok(ID, LABEL, format!("{v} ({source})")),
            None => PrereqCheck::fail(
                ID, LABEL,
                format!("{} did not report a version: {}", java.display(), first_line(&out)),
                "Reinstall Tizen Studio, which ships its own JDK.",
            ),
        },
        Err(e) => PrereqCheck::fail(
            ID, LABEL, e,
            "Reinstall Tizen Studio, which ships its own JDK, or install a Java runtime.",
        ),
    }
}

// ── Bundled sdb ──────────────────────────────────────────────────────────────

async fn bundled_sdb_check<R: Runtime>(app: &AppHandle<R>) -> PrereqCheck {
    const ID: &str = "sdb";
    const LABEL: &str = "Bundled sdb";
    const HINT: &str = "Reinstall the Smart TV QA Tool. In a dev checkout, run `npm run setup` to \
                        fetch the sdb binary into src-tauri/binaries/.";
    let cmd = match app.shell().sidecar("sdb") {
        Ok(cmd) => cmd.args(["version"]),
        Err(e) => return PrereqCheck::fail(ID, LABEL, format!("Not bundled: {e}"), HINT),
    };
    match tokio::time::timeout(RUN_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            match version_line(&text, "Smart Development Bridge") {
                Some(v) => PrereqCheck::ok(ID, LABEL, v),
                None => PrereqCheck::fail(ID, LABEL, format!("No version reported: {}", first_line(&text)), HINT),
            }
        }
        Ok(Err(e)) => PrereqCheck::fail(ID, LABEL, format!("Does not run: {e}"), HINT),
        Err(_) => PrereqCheck::fail(ID, LABEL, "Did not answer within 30 s", HINT),
    }
}

// ── Running tools ────────────────────────────────────────────────────────────

/// Runs a tool and returns stdout + stderr. `java -version` prints to stderr, and so do some
/// sdb builds, so both are kept.
async fn run(bin: &Path, args: &[&str]) -> Result<String, String> {
    if bin.components().count() > 1 && !bin.exists() {
        return Err(format!("Not found at {}", bin.display()));
    }
    let child = tokio::process::Command::new(bin)
        .args(args)
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(RUN_TIMEOUT, child).await {
        Ok(Ok(out)) => Ok(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )),
        Ok(Err(e)) => Err(format!("{} does not run: {e}", bin.display())),
        Err(_) => Err(format!("{} did not answer within 30 s", bin.display())),
    }
}

/// The line of `output` that starts with `prefix` — `Tizen CLI 2.5.25`,
/// `Smart Development Bridge version 4.2.36`.
fn version_line(output: &str, prefix: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with(prefix) && l.chars().any(|c| c.is_ascii_digit()))
        .map(str::to_owned)
}

/// `openjdk version "1.8.0_322"` → `Java 1.8.0_322`.
fn java_version(output: &str) -> Option<String> {
    regex::Regex::new(r#"(?m)^\S+ version "([^"]+)""#)
        .unwrap()
        .captures(output)
        .map(|c| format!("Java {}", &c[1]))
}

fn first_line(output: &str) -> &str {
    output.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("(no output)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tizen-prereq-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// Runs every check but the bundled sdb against this machine's Tizen Studio and prints them:
    /// `cargo test -p devman tizen_prereq -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn checks_this_machine() {
        let home = std::env::var("HOME").unwrap_or_default();
        let (studio, check) = resolve_studio(None, &studio_candidates(&home));
        let mut checks = vec![check];
        if let Some(path) = &studio {
            checks.extend([tizen_cli_check(path).await, studio_sdb_check(path).await, java_check(path).await]);
        }
        for c in &checks {
            println!("{:?} {}: {}{}", c.status, c.label, c.detail, c.hint.as_deref().map(|h| format!("\n    → {h}")).unwrap_or_default());
        }
    }

    #[test]
    fn reads_versions_from_tool_output() {
        assert_eq!(version_line("Tizen CLI 2.5.25\n", "Tizen CLI").as_deref(), Some("Tizen CLI 2.5.25"));
        assert_eq!(
            version_line("* daemon\nSmart Development Bridge version 4.2.36\n", "Smart Development Bridge")
                .as_deref(),
            Some("Smart Development Bridge version 4.2.36"),
        );
        assert_eq!(version_line("Tizen CLI\n", "Tizen CLI"), None);
        assert_eq!(
            java_version("openjdk version \"1.8.0_322\"\nOpenJDK Runtime Environment").as_deref(),
            Some("Java 1.8.0_322"),
        );
        assert_eq!(java_version("java version \"17.0.2\" 2022-01-18 LTS").as_deref(), Some("Java 17.0.2"));
        assert_eq!(java_version("command not found"), None);
    }

    #[test]
    fn reads_sdk_info_values() {
        let info = "TIZEN_SDK_INSTALLED_PATH=/x/tizen-studio\nJDK_PATH=/x/jdk\nTIZEN_SDK_VERSION=10.0\n";
        assert_eq!(sdk_value(info, "JDK_PATH").as_deref(), Some("/x/jdk"));
        assert_eq!(sdk_value(info, "TIZEN_SDK_VERSION").as_deref(), Some("10.0"));
        assert_eq!(sdk_value("JDK_PATH=\n", "JDK_PATH"), None);
        assert_eq!(sdk_value(info, "TIZEN_SDK"), None);
    }

    #[test]
    fn resolves_the_saved_studio_before_detected_ones() {
        let dir = scratch("studio");
        let saved = dir.join("saved").to_string_lossy().into_owned();
        let other = dir.join("other").to_string_lossy().into_owned();
        write(&tizen_bin(&saved), "");
        write(&tizen_bin(&other), "");
        write(&Path::new(&saved).join("sdk.version"), "TIZEN_SDK_VERSION=10.0\n");

        let (path, check) = resolve_studio(Some(&saved), &[other.clone()]);
        assert_eq!(path.as_deref(), Some(saved.as_str()));
        assert_eq!(check.status, CheckStatus::Ok);
        assert!(check.detail.contains("SDK 10.0"));

        let gone = dir.join("gone").to_string_lossy().into_owned();
        let (path, check) = resolve_studio(Some(&gone), &[other.clone()]);
        assert_eq!(path.as_deref(), Some(other.as_str()));
        assert_eq!(check.status, CheckStatus::Fail);

        let (path, check) = resolve_studio(None, &[gone.clone(), other.clone()]);
        assert_eq!(path.as_deref(), Some(other.as_str()));
        assert_eq!(check.status, CheckStatus::Ok);

        let (path, check) = resolve_studio(None, &[gone]);
        assert_eq!(path, None);
        assert_eq!(check.status, CheckStatus::Fail);
    }
}
