// Samsung Tizen prerequisites check: everything the Samsung flows need on this machine,
// checked up front so a QA machine missing a piece finds out before an install fails halfway.
//
// What needs what: listing, launching, killing and debugging apps speak the SDB protocol over
// TCP themselves and need nothing installed. The signed install is the one that leans on the
// machine — the bundled `sdb` sidecar (disconnect / kill-server / connect), Tizen Studio's
// `tizen` CLI (package + install), the `sdb` the CLI itself calls, the Java the CLI runs on,
// and a certificate profile that covers the TV.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;

use super::samsung_tizen::{cert_profiles_path, parse_cert_profiles, studio_candidates};
use crate::error::Error;

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    /// Works, but a part of the flow will be weaker (e.g. no per-TV certificate matching).
    Warn,
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

    fn warn(id: &'static str, label: &'static str, detail: impl Into<String>, hint: impl Into<String>) -> Self {
        Self { id, label, status: CheckStatus::Warn, detail: detail.into(), hint: Some(hint.into()) }
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
    "Install Tizen Studio (developer.samsung.com/tizenstudio) with the TV Extensions and \
     Samsung Certificate Extension from its Package Manager.";

/// `tizen version` starts a JVM — about 4 s on an M-series Mac — so the limit is generous.
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

#[tauri::command]
pub(crate) async fn tizen_check_prerequisites<R: Runtime>(
    app: AppHandle<R>,
    studio_path: Option<String>,
    cert_profile: Option<String>,
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
            checks.extend([cli, studio_sdb, java]);
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

    // `cert_profiles_path` is what the signed install reads, so check the same file.
    let profiles_xml = cert_profiles_path(studio.as_deref().unwrap_or(&format!("{home}/tizen-studio")));
    checks.extend(cert_checks(Path::new(&profiles_xml), cert_profile.as_deref()));

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

// ── Certificates ─────────────────────────────────────────────────────────────

/// Checks `profiles.xml`, the saved profile, and whether the distributor certificates say which
/// TVs they cover — the three things `tizen_install_signed` relies on to sign for the right TV.
fn cert_checks(profiles_xml: &Path, saved: Option<&str>) -> Vec<PrereqCheck> {
    let xml_display = profiles_xml.display().to_string();
    let Ok(content) = std::fs::read_to_string(profiles_xml) else {
        let hint = "Open Certificate Manager in Tizen Studio and create a Samsung certificate \
                    profile (author + distributor) that lists your TVs' DUIDs.";
        return vec![
            PrereqCheck::fail("profiles", "Certificate profiles", format!("{xml_display} not found"), hint),
            PrereqCheck::fail("cert-profile", "Selected certificate", "No certificate profiles", hint),
        ];
    };
    let profiles = parse_cert_profiles(&xml_display);
    let mut checks = Vec::new();

    if profiles.is_empty() {
        checks.push(PrereqCheck::fail(
            "profiles", "Certificate profiles",
            format!("{xml_display} lists no profiles"),
            "Create a Samsung certificate profile in Certificate Manager.",
        ));
    } else {
        let names = profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
        checks.push(PrereqCheck::ok(
            "profiles", "Certificate profiles",
            format!("{} in {xml_display}: {names}", profiles.len()),
        ));
    }

    const ID: &str = "cert-profile";
    const LABEL: &str = "Selected certificate";
    let saved = saved.map(str::trim).filter(|s| !s.is_empty());
    checks.push(match saved {
        None => PrereqCheck::fail(
            ID, LABEL, "No certificate selected in the app",
            "Samsung → Apps → Configure, and pick the distributor.p12 of the profile to sign with.",
        ),
        Some(name) => match profiles.iter().find(|p| p.name == name) {
            None => PrereqCheck::fail(
                ID, LABEL,
                format!("'{name}' is not a profile in profiles.xml"),
                "Samsung → Apps → Configure, and pick the distributor.p12 inside a folder named \
                 after one of the profiles above — the app takes the profile name from that folder.",
            ),
            Some(_) => {
                let missing = profile_key_files(&content, name)
                    .into_iter()
                    .filter(|(_, path)| !Path::new(path).exists())
                    .map(|(kind, path)| format!("{kind} key {path}"))
                    .collect::<Vec<_>>();
                if missing.is_empty() {
                    PrereqCheck::ok(ID, LABEL, format!("'{name}' — certificate files present"))
                } else {
                    PrereqCheck::fail(
                        ID, LABEL,
                        format!("'{name}' points at missing files: {}", missing.join("; ")),
                        "Put the certificate files back where the profile expects them, or \
                         recreate the profile in Certificate Manager.",
                    )
                }
            }
        },
    });

    if !profiles.is_empty() {
        let with_duids = profiles.iter().filter(|p| !p.duids.is_empty()).collect::<Vec<_>>();
        checks.push(if with_duids.is_empty() {
            PrereqCheck::warn(
                "duids", "TVs covered by certificates",
                "No distributor certificate lists TV DUIDs (device-profile.xml missing)",
                "Installs will sign with the selected profile for every TV, and a TV it does not \
                 cover rejects the install with [118, -12]. Keep the device-profile.xml that \
                 Certificate Manager writes next to distributor.p12.",
            )
        } else {
            let summary = with_duids
                .iter()
                .map(|p| format!("{} ({})", p.name, p.duids.len()))
                .collect::<Vec<_>>()
                .join(", ");
            PrereqCheck::ok(
                "duids", "TVs covered by certificates",
                format!("{} TV DUIDs across {summary}", with_duids.iter().map(|p| p.duids.len()).sum::<usize>()),
            )
        });
    }
    checks
}

/// The author and distributor key files a profile in `profiles.xml` signs with.
fn profile_key_files(profiles_xml: &str, profile: &str) -> Vec<(&'static str, String)> {
    let block = regex::Regex::new(r#"(?s)<profile\s+name="([^"]+)"(.*?)</profile>"#)
        .unwrap()
        .captures_iter(profiles_xml)
        .find(|c| &c[1] == profile)
        .map(|c| c[2].to_owned())
        .unwrap_or_default();
    let item = regex::Regex::new(r#"<profileitem\b[^>]*>"#).unwrap();
    let attr = |tag: &str, name: &str| {
        regex::Regex::new(&format!(r#"\b{name}="([^"]*)""#))
            .unwrap()
            .captures(tag)
            .map(|c| c[1].to_owned())
    };
    item.find_iter(&block)
        .filter_map(|m| {
            let kind = match attr(m.as_str(), "distributor")?.as_str() {
                "0" => "author",
                "1" => "distributor",
                _ => return None,
            };
            attr(m.as_str(), "key").filter(|k| !k.is_empty()).map(|k| (kind, k))
        })
        .collect()
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

    fn profiles_xml(dir: &Path, profiles: &[(&str, &Path)]) -> PathBuf {
        let body = profiles
            .iter()
            .map(|(name, keys)| {
                format!(
                    r#"<profile name="{name}">
<profileitem ca="" distributor="0" key="{a}" password="x" rootca=""/>
<profileitem ca="" distributor="1" key="{d}" password="x" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>"#,
                    a = keys.join("author.p12").display(),
                    d = keys.join("distributor.p12").display(),
                )
            })
            .collect::<String>();
        let path = dir.join("profile/profiles.xml");
        write(&path, &format!(r#"<profiles active="x" version="3.1">{body}</profiles>"#));
        path
    }

    fn status<'a>(checks: &'a [PrereqCheck], id: &str) -> &'a PrereqCheck {
        checks.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no {id} check"))
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
        let xml = cert_profiles_path(studio.as_deref().unwrap_or_default());
        checks.extend(cert_checks(Path::new(&xml), std::env::var("TIZEN_CERT_PROFILE").ok().as_deref()));
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
    fn lists_a_profiles_key_files() {
        let xml = r#"<profiles><profile name="a">
<profileitem ca="" distributor="0" key="/c/a/author.p12" password="p" rootca=""/>
<profileitem ca="" distributor="1" key="/c/a/distributor.p12" password="p" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile><profile name="b">
<profileitem ca="" distributor="0" key="/c/b/author.p12" password="p" rootca=""/>
</profile></profiles>"#;
        assert_eq!(
            profile_key_files(xml, "a"),
            vec![("author", "/c/a/author.p12".to_owned()), ("distributor", "/c/a/distributor.p12".to_owned())],
        );
        assert_eq!(profile_key_files(xml, "b"), vec![("author", "/c/b/author.p12".to_owned())]);
        assert!(profile_key_files(xml, "missing").is_empty());
    }

    #[test]
    fn missing_profiles_file_fails_both_certificate_checks() {
        let dir = scratch("none");
        let checks = cert_checks(&dir.join("profile/profiles.xml"), Some("office"));
        assert_eq!(status(&checks, "profiles").status, CheckStatus::Fail);
        assert_eq!(status(&checks, "cert-profile").status, CheckStatus::Fail);
    }

    #[test]
    fn passes_with_a_complete_profile_that_lists_duids() {
        let dir = scratch("ok");
        let keys = dir.join("SamsungCertificate/office");
        write(&keys.join("author.p12"), "a");
        write(&keys.join("distributor.p12"), "d");
        write(&keys.join("device-profile.xml"), "<TestDevice>DUID-1</TestDevice><TestDevice>DUID-2</TestDevice>");
        let checks = cert_checks(&profiles_xml(&dir, &[("office", &keys)]), Some("office"));
        assert!(checks.iter().all(|c| c.status == CheckStatus::Ok), "{checks:?}");
        assert!(status(&checks, "duids").detail.starts_with("2 TV DUIDs"));
    }

    #[test]
    fn flags_a_saved_profile_that_is_not_in_profiles_xml() {
        let dir = scratch("unknown");
        let keys = dir.join("certs");
        let checks = cert_checks(&profiles_xml(&dir, &[("office", &keys)]), Some("home"));
        let check = status(&checks, "cert-profile");
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.detail.contains("'home'"));
    }

    #[test]
    fn flags_missing_key_files_and_absent_duids() {
        let dir = scratch("keys");
        let keys = dir.join("moved");
        let checks = cert_checks(&profiles_xml(&dir, &[("office", &keys)]), Some("office"));
        let check = status(&checks, "cert-profile");
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.detail.contains("distributor.p12"), "{}", check.detail);
        assert_eq!(status(&checks, "duids").status, CheckStatus::Warn);
    }

    #[test]
    fn no_saved_profile_fails() {
        let dir = scratch("unset");
        let checks = cert_checks(&profiles_xml(&dir, &[("office", &dir)]), None);
        assert_eq!(status(&checks, "cert-profile").status, CheckStatus::Fail);
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
