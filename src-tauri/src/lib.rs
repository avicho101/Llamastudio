use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

/// Path to the persisted config (binary path + last model dir), stored next to the app.
fn config_file() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("llamastudio.config.json"))
}

fn load_saved_binary() -> Option<String> {
    let f = config_file()?;
    let data = std::fs::read_to_string(&f).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    v.get("binary_path")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn save_binary(path: &str) {
    if let Some(f) = config_file() {
        let _ = std::fs::write(
            &f,
            serde_json::json!({ "binary_path": path }).to_string(),
        );
    }
}

/// Resolve the actual llama-server binary to launch.
/// Tries, in order: the configured path, then the app dir, then PATH.
fn resolve_binary(configured: &str) -> Option<String> {
    if !configured.is_empty() {
        if Path::new(configured).is_file() {
            return Some(configured.to_string());
        }
        // maybe a bare name on PATH
        if let Ok(out) = Command::new(configured).arg("--version").output() {
            if out.status.success() {
                return Some(configured.to_string());
            }
        }
    }
    // app dir
    if let Some(exe) = std::env::current_exe().ok() {
        if let Some(dir) = exe.parent() {
            for name in ["llama-server.exe", "llama-server", "llama-server-bin.exe"] {
                let c = dir.join(name);
                if c.is_file() {
                    return Some(c.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

mod nvidia;
mod schema_server;
mod tray;

// Shared state for the running server process + log sink
struct ServerState {
    child: Mutex<Option<Child>>,
    log_buffer: Mutex<Vec<String>>,
    started_at: Mutex<Option<Instant>>,
    binary_path: Mutex<String>,
    models: Mutex<Vec<String>>, // last scanned model paths (for tray swap)
    current_model: Mutex<String>,
    no_gpu: Mutex<bool>, // CPU-only mode (no GPU offload)
    tray: Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>>,
}

#[derive(Serialize, Clone)]
struct LogLine {
    line: String,
    ts: u64,
}

#[derive(Serialize, Clone)]
struct DeviceInfo {
    index: u32,
    name: String,
    vram_mb: u64,
    backend: String, // "cuda" | "rocm" | "metal" | "cpu"
}

#[derive(Serialize, Clone)]
struct EnvStatus {
    cuda_available: bool,
    cuda_version: String,
    nvcc_available: bool,
    cudnn_present: bool,
    binary_valid: bool,
    binary_version: String,
}

// ---- Commands ----

#[tauri::command]
fn set_binary_path(state: tauri::AppHandle, path: String) -> Result<(), String> {
    *state.state::<ServerState>().binary_path.lock().unwrap() = path.clone();
    save_binary(&path);
    Ok(())
}

#[tauri::command]
fn get_binary_path(state: tauri::AppHandle) -> String {
    state.state::<ServerState>().binary_path.lock().unwrap().clone()
}

/// Probe llama-server --version and build info (captures CUDA/ROCm tags).
#[tauri::command]
fn detect_binary(state: tauri::AppHandle) -> EnvStatus {
    let path = state.state::<ServerState>().binary_path.lock().unwrap().clone();
    let mut status = EnvStatus {
        cuda_available: false,
        cuda_version: String::new(),
        nvcc_available: false,
        cudnn_present: false,
        binary_valid: false,
        binary_version: String::new(),
    };
    if path.is_empty() {
        return status;
    }
    let out = Command::new(&path).arg("--version").output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            let e = String::from_utf8_lossy(&o.stderr).to_string();
            let combined = format!("{}{}", s, e);
            status.binary_valid = true;
            // build line e.g. "build: 1 (abc1234)" or "version: 1"
            for line in combined.lines() {
                if line.to_lowercase().contains("build") || line.to_lowercase().contains("version") {
                    status.binary_version = line.trim().to_string();
                }
            }
            // CUDA presence in build info
            let lower = combined.to_lowercase();
            status.cuda_available = lower.contains("cuda") || lower.contains("cublas");
            if let Some(idx) = lower.find("cuda") {
                let tail = &combined[idx..];
                // try to capture a version like "CUDA 12.8"
                let re = regex_extract(&tail, r"cuda[ /]?([0-9]+\.[0-9]+)");
                if let Some(v) = re {
                    status.cuda_version = v;
                }
            }
        }
        Err(_) => return status,
    }
    // nvcc check
    status.nvcc_available = Command::new("nvcc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    status
}

fn regex_extract(text: &str, pat: &str) -> Option<String> {
    let re = regex::Regex::new(pat).ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

#[tauri::command]
fn list_gpus() -> Vec<DeviceInfo> {
    nvidia::detect_devices()
}

#[tauri::command]
fn list_models(state: tauri::AppHandle, dir: String) -> Vec<String> {
    let mut out = Vec::new();
    let mut full_paths = Vec::new();
    let p = Path::new(&dir);
    if !p.exists() {
        return out;
    }
    if let Ok(entries) = std::fs::read_dir(p) {
        for e in entries.flatten() {
            let path = e.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.eq_ignore_ascii_case("gguf") {
                        if let Some(name) = path.file_name() {
                            out.push(name.to_string_lossy().to_string());
                            full_paths.push(path.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    out.sort();
    full_paths.sort();
    {
        let st = state.state::<ServerState>();
        *st.models.lock().unwrap() = full_paths;
    }
    // Rebuild the tray menu so the Swap Model submenu reflects new scans.
    let _ = crate::tray::rebuild_tray(&state);
    out
}

/// Scan a directory and auto-detect the model + auxiliary files (mmproj,
/// lora, control-vector) so the UI can populate every field automatically.
#[derive(serde::Serialize)]
struct DirScan {
    models: Vec<String>,
    mmproj: Option<String>,
    lora: Option<String>,
    control_vector: Option<String>,
}

#[tauri::command]
fn scan_dir(dir: String) -> DirScan {
    let mut models = Vec::new();
    let mut mmproj = None;
    let mut lora = None;
    let mut control_vector = None;
    let p = Path::new(&dir);
    if !p.exists() {
        return DirScan { models, mmproj, lora, control_vector };
    }
    if let Ok(entries) = std::fs::read_dir(p) {
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_file() {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let lower = name.to_lowercase();
            let is_gguf = lower.ends_with(".gguf");
            let is_bin = lower.ends_with(".bin");
            // Multimodal projector: matches "mmproj" anywhere, or a .gguf/.bin
            // projector that is NOT the main model. Prefer explicit "mmproj" naming.
            if lower.contains("mmproj") && (is_gguf || is_bin) {
                if mmproj.is_none() {
                    mmproj = Some(name.clone());
                }
            } else if is_gguf {
                models.push(name.clone());
            } else if is_bin {
                if lower.contains("control") && lower.contains("vector") {
                    if control_vector.is_none() {
                        control_vector = Some(name.clone());
                    }
                } else if lower.contains("lora") {
                    if lora.is_none() {
                        lora = Some(name.clone());
                    }
                }
            }
        }
    }
    models.sort();
    DirScan { models, mmproj, lora, control_vector }
}

/// Swap the currently-loaded model: stop the server, set the new model path,
/// and (if it was running) restart it with the new model + existing config.
#[tauri::command]
fn swap_model(state: tauri::AppHandle, model_path: String) -> Result<(), String> {
    let st = state.state::<ServerState>();
    let was_running = st.child.lock().unwrap().is_some();
    if was_running {
        // stop
        if let Some(mut child) = st.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *st.started_at.lock().unwrap() = None;
    }
    *st.current_model.lock().unwrap() = model_path.clone();
    // Inform frontend to update its --model field
    let _ = state.emit("model-swapped", &model_path);
    if was_running {
        // restart with the new model; build args from current config in frontend
        // For the tray path we just restart minimally with -m; the frontend
        // listens to model-swapped and will call start_server with full config.
    }
    Ok(())
}

#[tauri::command]
fn is_running(state: tauri::AppHandle) -> bool {
    state.state::<ServerState>().child.lock().unwrap().is_some()
}

#[tauri::command]
fn server_uptime(state: tauri::AppHandle) -> f64 {
    let st = state.state::<ServerState>();
    let guard = st.started_at.lock().unwrap();
    match *guard {
        Some(t) => t.elapsed().as_secs_f64(),
        None => 0.0,
    }
}

#[tauri::command]
fn get_logs(state: tauri::AppHandle) -> Vec<String> {
    state.state::<ServerState>().log_buffer.lock().unwrap().clone()
}

/// Start the server with the provided args (already rendered to CLI flags).
#[tauri::command]
fn start_server(state: tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    let st = state.state::<ServerState>();
    {
        let guard = st.child.lock().unwrap();
        if guard.is_some() {
            return Err("Server is already running. Stop it first.".into());
        }
    }
    let configured = st.binary_path.lock().unwrap().clone();
    let path = match resolve_binary(&configured) {
        Some(p) => p,
        None => {
            return Err(
                "llama-server binary not found. Click 'Browse…' next to the binary field and select your llama-server.exe (or place llama-server.exe next to the app).".into(),
            )
        }
    };

    // Clear log buffer
    {
        let mut logs = st.log_buffer.lock().unwrap();
        logs.clear();
    }

    let mut cmd = Command::new(&path);
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(format!("Failed to launch server: {}", e)),
    };

    // Mark started
    *st.started_at.lock().unwrap() = Some(Instant::now());

    // Take stdout/stderr
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");

    // Store child in state
    *st.child.lock().unwrap() = Some(child);

    // Record the model path from args (look for -m / --model)
    if let Some(pos) = args.iter().position(|a| a == "-m" || a == "--model") {
        if let Some(m) = args.get(pos + 1) {
            *st.current_model.lock().unwrap() = m.clone();
        }
    }
    // Update tray tooltip to reflect running state + model + mode
    crate::tray::update_tray_tooltip(&state);

    let app_for_out = state.clone();
    let app_for_err = state.clone();

    // Stream stdout
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            push_log(&app_for_out, &line);
        }
    });
    // Stream stderr
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            push_log(&app_for_err, &line);
        }
    });

    Ok(())
}

fn push_log(app: &tauri::AppHandle, line: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    {
        let st = app.state::<ServerState>();
        let mut logs = st.log_buffer.lock().unwrap();
        logs.push(line.to_string());
        if logs.len() > 2000 {
            let excess = logs.len() - 2000;
            logs.drain(0..excess);
        }
    }
    let _ = app.emit("server-log", LogLine { line: line.to_string(), ts });
}

#[tauri::command]
fn stop_server(state: tauri::AppHandle) -> Result<(), String> {
    let st = state.state::<ServerState>();
    let mut guard = st.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        *st.started_at.lock().unwrap() = None;
        push_log(&state, "--- server stopped ---");
        drop(guard);
        crate::tray::update_tray_tooltip(&state);
        Ok(())
    } else {
        Err("No server running.".into())
    }
}

/// Set CPU-only (no GPU) mode. When on, the server launches with --n-gpu-layers 0.
#[tauri::command]
fn set_no_gpu(state: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    *state.state::<ServerState>().no_gpu.lock().unwrap() = enabled;
    crate::tray::update_tray_tooltip(&state);
    Ok(())
}

/// Render the flag schema as a static payload (so the UI can build forms).
/// Returns the categories array directly (the UI expects Category[]).
#[tauri::command]
fn get_schema() -> serde_json::Value {
    schema_server::schema_json()
        .get("categories")
        .cloned()
        .unwrap_or(serde_json::Value::Array(vec![]))
}

/// Preset definitions: each maps to a partial config patch.
#[tauri::command]
fn get_presets() -> serde_json::Value {
    schema_server::presets_json()
}

/// Query server health/version via HTTP (best-effort; used for status bar).
#[tauri::command]
async fn query_server(host: String, port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://{}:{}/health", host, port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await;
    match resp {
        Ok(r) => {
            let ok = r.status().is_success();
            let body: serde_json::Value = r.json().await.unwrap_or(serde_json::Value::Null);
            Ok(serde_json::json!({ "ok": ok, "body": body }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

// ---- Profile save/load (.llamaprofile) ----

#[derive(Serialize, serde::Deserialize)]
struct Profile {
    llamastudio_profile: String, // magic = "1"
    name: String,
    binary_path: String,
    model: String,
    config: std::collections::HashMap<String, serde_json::Value>,
}

/// Save the current config + model to a .llamaprofile JSON file.
#[tauri::command]
fn save_profile(
    path: String,
    name: String,
    model: String,
    binary_path: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let cfg_map: std::collections::HashMap<String, serde_json::Value> = config
        .as_object()
        .ok_or("config must be an object")?
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let prof = Profile {
        llamastudio_profile: "1".into(),
        name,
        binary_path,
        model,
        config: cfg_map,
    };
    let json = serde_json::to_string_pretty(&prof).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write profile: {}", e))?;
    Ok(())
}

/// Load a .llamaprofile and return it as JSON.
#[tauri::command]
fn load_profile(path: String) -> Result<serde_json::Value, String> {
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read profile: {}", e))?;
    let prof: Profile = serde_json::from_str(&data).map_err(|e| format!("Invalid profile: {}", e))?;
    if prof.llamastudio_profile != "1" {
        return Err("Not a LlamaStudio profile file.".into());
    }
    Ok(serde_json::to_value(prof).map_err(|e| e.to_string())?)
}

/// Path of the running executable (used for file-type registration).
#[tauri::command]
fn get_app_exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Register the .llamaprofile file type with Windows so double-click opens the app.
#[tauri::command]
fn register_association() -> Result<String, String> {
    if !cfg!(windows) {
        return Err("File association is only supported on Windows.".into());
    }
    let exe = get_app_exe_path();
    if exe.is_empty() {
        return Err("Could not determine the app executable path.".into());
    }
    let r1 = std::process::Command::new("cmd")
        .args(["/c", "assoc", ".llamaprofile=LlamaStudio.Profile"])
        .output();
    let ftype_cmd = format!("\"{}\" \"%1\"", exe);
    let r2 = std::process::Command::new("cmd")
        .args(["/c", "ftype", &format!("LlamaStudio.Profile={}", ftype_cmd)])
        .output();
    match (r1, r2) {
        (Ok(o1), Ok(o2)) if o1.status.success() && o2.status.success() => Ok(
            "Associated .llamaprofile with LlamaStudio. Double-click a profile to open it.".into(),
        ),
        _ => Err(
            "Failed to register association. Try running the app as Administrator once.".into(),
        ),
    }
}

/// Find a .llamaprofile path among CLI args (for double-click launch).
fn profile_from_args(args: &[String]) -> Option<String> {
    use std::path::Path;
    args.iter()
        .find(|a| {
            Path::new(a)
                .extension()
                .map(|e| e == "llamaprofile")
                .unwrap_or(false)
        })
        .cloned()
}

pub fn run() {
    let default_binary = default_binary_path();
    // Check for a .llamaprofile passed on the command line (double-click launch).
    let cli_profile = profile_from_args(&std::env::args().collect::<Vec<_>>());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, argv, _cwd| {
                // A second instance was launched (e.g. double-clicking a profile).
                // Bring the window to front and emit the profile path.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                if let Some(p) = profile_from_args(&argv) {
                    let _ = app.emit("open-profile", p);
                }
            }),
        )
        .manage(ServerState {
            child: Mutex::new(None),
            log_buffer: Mutex::new(Vec::new()),
            started_at: Mutex::new(None),
            binary_path: Mutex::new(load_saved_binary().unwrap_or(default_binary)),
            models: Mutex::new(Vec::new()),
            current_model: Mutex::new(String::new()),
            no_gpu: Mutex::new(false),
            tray: Mutex::new(None),
        })
        .setup(|app| {
            // Build the system tray with model-swap menu + toggles
            crate::tray::build_tray(app.handle())?;
            // Splash screen: show logo briefly, then reveal main window.
            // Main window is already visible (visible:true); splash overlays on top.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                // small delay so the splash is visible
                std::thread::sleep(std::time::Duration::from_millis(1400));
                if let Some(splash) = app_handle.get_webview_window("splash") {
                    let _ = splash.close();
                }
                if let Some(main) = app_handle.get_webview_window("main") {
                    let _ = main.set_focus();
                }
                // If launched with a profile (double-click), emit it so the UI opens it.
                if let Some(p) = &cli_profile {
                    let _ = app_handle.emit("open-profile", p.clone());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_binary_path,
            get_binary_path,
            detect_binary,
            list_gpus,
            list_models,
            scan_dir,
            is_running,
            server_uptime,
            get_logs,
            start_server,
            stop_server,
            get_schema,
            get_presets,
            query_server,
            swap_model,
            set_no_gpu,
            save_profile,
            load_profile,
            get_app_exe_path,
            register_association
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn default_binary_path() -> String {
    // On Windows, llama-server.exe next to the app or in a known folder.
    #[cfg(target_os = "windows")]
    {
        if let Some(exe) = std::env::current_exe().ok() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join("llama-server.exe");
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
        "llama-server.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "llama-server".to_string()
    }
}
