//! Read-only discovery of the user's global Pi resources, with Pi^n-local selection.
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

static REQUEST_LOCK: Mutex<()> = Mutex::new(());

struct CachedCatalog {
    fingerprint: Vec<(PathBuf, Option<(u64, i64, u32)>)>,
    fetched_at: Instant,
    value: Value,
}

static CATALOG_CACHE: OnceLock<Mutex<Option<CachedCatalog>>> = OnceLock::new();
const CATALOG_CACHE_TTL: Duration = Duration::from_secs(15);

fn catalog_fingerprint(agent_dir: &Path) -> Vec<(PathBuf, Option<(u64, i64, u32)>)> {
    let mut watched = vec![
        agent_dir.join("extensions.json"),
        agent_dir.join("settings.json"),
        agent_dir.join("extensions"),
        agent_dir.join("skills"),
    ];
    let global_dir = std::env::var_os("PI_N_GLOBAL_PI_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".pi").join("agent"))
        });
    if let Some(global) = global_dir {
        watched.push(global.join("extensions.json"));
        watched.push(global.join("settings.json"));
        watched.push(global.join("extensions"));
        watched.push(global.join("skills"));
    }
    watched
        .into_iter()
        .map(|path| {
            let sig = fs::metadata(&path).ok().map(|meta| {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| (d.as_secs() as i64, d.subsec_nanos()))
                    .unwrap_or((0, 0));
                (meta.len(), mtime.0, mtime.1)
            });
            (path, sig)
        })
        .collect()
}

fn discovery_command(root: &Path, agent_dir: &Path) -> Result<Command, String> {
    let mut command = Command::new(crate::native::trusted_node()?);
    command
        .arg("--import")
        // --import expects a module specifier, not a Windows C:\\ filesystem path.
        // Resolve this relative specifier against the explicit installation cwd.
        .arg("./pi/packages/coding-agent/src/experimental/source-resolver.ts")
        .arg(crate::native::host_path(
            &root.join("engine/extensions-host.ts"),
        ))
        .current_dir(root)
        .env("PI_CODING_AGENT_DIR", agent_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::native::bind_trusted_git(&mut command)?;
    crate::native::bind_baseline_context(&mut command);
    Ok(command)
}

pub fn request(body: Value) -> Result<Value, String> {
    if body["version"] != 1
        || !matches!(body["operation"].as_str(), Some("catalog" | "set_enabled"))
    {
        return Err("Invalid Pi extension operation".into());
    }
    let is_catalog = body["operation"].as_str() == Some("catalog");
    let encoded = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    if encoded.len() > 128 * 1024 {
        return Err("Pi extension request too large".into());
    }
    // Serialize read-modify-write selections across HTTP workers.
    let _guard = REQUEST_LOCK
        .lock()
        .map_err(|_| "Pi extension lock unavailable")?;
    let agent_dir = crate::native::agent_dir()?;
    let fingerprint = is_catalog.then(|| catalog_fingerprint(&agent_dir));
    if let Some(fp) = &fingerprint {
        if let Ok(cache) = CATALOG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
            if let Some(entry) = cache.as_ref() {
                if entry.fetched_at.elapsed() < CATALOG_CACHE_TTL && &entry.fingerprint == fp {
                    return Ok(entry.value.clone());
                }
            }
        }
    } else if let Ok(mut cache) = CATALOG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *cache = None;
    }
    let root = crate::native::installation_root();
    let mut command = discovery_command(&root, &agent_dir)?;
    crate::process_control::configure_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Pi extension discovery: {error}"))?;
    let tree = crate::process_control::track(&child).inspect_err(|_error| {
        let _ = child.kill();
        let _ = child.wait();
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Pi extension input unavailable")?;
    // Write stdin on a helper thread concurrently with `wait_with_output()` so
    // a 128 KiB request cannot deadlock if the child fills stdout/stderr first.
    let (write_tx, write_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let res = stdin.write_all(&encoded);
        drop(stdin);
        let _ = write_tx.send(res);
    });
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(Duration::from_secs(40)) {
        Ok(output) => output.map_err(|e| e.to_string())?,
        Err(_) => {
            tree.terminate();
            return Err("Pi extension discovery timed out".into());
        }
    };
    tree.mark_reaped_if_empty();
    if let Ok(Err(error)) = write_rx.recv_timeout(Duration::from_secs(1)) {
        if !output.status.success() {
            return Err(error.to_string());
        }
    }
    let response: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        format!(
            "Pi extension discovery failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    if !output.status.success() {
        return Err("Pi extension discovery failed".into());
    }
    let result = response["result"].clone();
    if let Some(fp) = fingerprint {
        if let Ok(mut cache) = CATALOG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
            *cache = Some(CachedCatalog {
                fingerprint: fp,
                fetched_at: Instant::now(),
                value: result.clone(),
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run_discovery(root: &Path, own: &Path, global: &Path, body: Value) -> std::process::Output {
        let mut child = discovery_command(root, own)
            .unwrap()
            .env("PI_N_GLOBAL_PI_AGENT_DIR", global)
            .env("PI_N_ISOLATED_PI_MODELS", "1")
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&body).unwrap())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    #[test]
    fn node_import_works_from_unicode_roots_with_spaces_and_url_characters() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("扩展 loader # %");
        let resolver = root.join("pi/packages/coding-agent/src/experimental");
        fs::create_dir_all(&resolver).unwrap();
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(resolver.join("source-resolver.ts"), "export {};").unwrap();
        fs::write(
            root.join("engine/extensions-host.ts"),
            "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(0, 'utf8'));",
        )
        .unwrap();
        let body = serde_json::json!({"version": 1, "operation": "catalog"});
        let output = run_discovery(&root, &root, &root, body.clone());
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            body
        );
    }

    #[test]
    fn real_discovery_lists_required_trim_and_rejects_disabling_it() {
        let temp = tempfile::tempdir().unwrap();
        let own = temp.path().join("own");
        let global = temp.path().join("global");
        fs::create_dir_all(&own).unwrap();
        fs::create_dir_all(&global).unwrap();
        fs::write(
            own.join("extensions.json"),
            r#"{"overrides":{"npm:pi-trim":false}}"#,
        )
        .unwrap();
        let root = crate::native::installation_root();
        let output = run_discovery(
            &root,
            &own,
            &global,
            serde_json::json!({"version": 1, "operation": "catalog"}),
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!output.status.success());
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("Unsupported pi-trim override"));
        assert_eq!(
            fs::read_to_string(own.join("extensions.json")).unwrap(),
            r#"{"overrides":{"npm:pi-trim":false}}"#
        );
        fs::write(own.join("extensions.json"), r#"{"overrides":{}}"#).unwrap();
        let output = run_discovery(
            &root,
            &own,
            &global,
            serde_json::json!({"version":1,"operation":"catalog"}),
        );
        assert!(
            output.status.success(),
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        let trim = response["result"]["extensions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|extension| extension["id"] == "npm:pi-trim")
            .unwrap();
        assert_eq!(trim["enabled"], true);
        let output = run_discovery(
            &root,
            &own,
            &global,
            serde_json::json!({
                "version": 1, "operation": "set_enabled", "id": "npm:pi-trim", "enabled": false
            }),
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!output.status.success());
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("pi-trim is required"));
    }
}
