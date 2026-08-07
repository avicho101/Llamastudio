use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use crate::ServerState;

const TRAY_ID: &str = "llamastudio-tray";

/// Build the tray icon + menu and store the handle in state so it can be
/// rebuilt later (e.g. when the model list changes).
pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let tray = build_tray_inner(app)?;
    *app.state::<ServerState>().tray.lock().unwrap() = Some(tray);
    update_tray_tooltip(app);
    Ok(())
}

/// Remove the existing tray (if any) and build a fresh one reflecting the
/// current ServerState.models. Safe to call any time after startup.
pub fn rebuild_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Drop the old tray icon first so we don't stack duplicates.
    let _ = app.remove_tray_by_id(TRAY_ID);
    let tray = build_tray_inner(app)?;
    *app.state::<ServerState>().tray.lock().unwrap() = Some(tray);
    update_tray_tooltip(app);
    Ok(())
}

/// Update the tray tooltip to reflect running model + mode (CPU/GPU/stopped).
pub fn update_tray_tooltip(app: &tauri::AppHandle) {
    let state = app.state::<ServerState>();
    let guard = state.tray.lock().unwrap();
    if let Some(tray) = guard.as_ref() {
        let tip = tray_tooltip_string(app);
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// Build the tray tooltip string from current state (model + CPU/GPU/stopped).
pub fn tray_tooltip_string(app: &tauri::AppHandle) -> String {
    let st = app.state::<ServerState>();
    let running = st.child.lock().unwrap().is_some();
    let no_gpu = *st.no_gpu.lock().unwrap();
    let model = st.current_model.lock().unwrap().clone();
    let model_name = std::path::Path::new(&model)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| model.clone());
    if !running {
        return "LlamaStudio — stopped".to_string();
    }
    let backend = if no_gpu { "CPU" } else { "GPU" };
    if model_name.is_empty() {
        format!("LlamaStudio — running ({})", backend)
    } else {
        format!("LlamaStudio — {} · {}", model_name, backend)
    }
}

fn build_tray_inner(app: &tauri::AppHandle) -> tauri::Result<tauri::tray::TrayIcon<tauri::Wry>> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("LlamaStudio")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_tray_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)
}

/// Build the full tray menu, including a dynamic "Swap Model" submenu from
/// the scanned model paths in state.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show_i = MenuItem::with_id(app, "show", "Show LlamaStudio", true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "hide", "Hide Window", true, None::<&str>)?;
    let start_i = MenuItem::with_id(app, "start", "Start Server", true, None::<&str>)?;
    let stop_i = MenuItem::with_id(app, "stop", "Stop Server", true, None::<&str>)?;

    // Toggles submenu
    let fa_on = MenuItem::with_id(app, "fa_on", "Flash Attention: ON", true, None::<&str>)?;
    let fa_off = MenuItem::with_id(app, "fa_off", "Flash Attention: OFF", true, None::<&str>)?;
    let webui_on = MenuItem::with_id(app, "webui_on", "Web UI: ON", true, None::<&str>)?;
    let webui_off = MenuItem::with_id(app, "webui_off", "Web UI: OFF", true, None::<&str>)?;
    let cb_on = MenuItem::with_id(app, "cb_on", "Continuous Batching: ON", true, None::<&str>)?;
    let cb_off = MenuItem::with_id(app, "cb_off", "Continuous Batching: OFF", true, None::<&str>)?;
    let toggles = Submenu::with_items(
        app,
        "Toggles",
        true,
        &[&fa_on, &fa_off, &webui_on, &webui_off, &cb_on, &cb_off],
    )?;

    // Swap Model submenu (built from scanned models)
    let model_sub = build_model_submenu(app)?;

    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &show_i,
            &hide_i,
            &PredefinedMenuItem::separator(app)?,
            &start_i,
            &stop_i,
            &PredefinedMenuItem::separator(app)?,
            &model_sub,
            &toggles,
            &PredefinedMenuItem::separator(app)?,
            &quit_i,
        ],
    )
}

/// Build the "Swap Model" submenu from ServerState.models.
fn build_model_submenu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let models = app.state::<ServerState>().models.lock().unwrap().clone();
    let current = app.state::<ServerState>().current_model.lock().unwrap().clone();

    if models.is_empty() {
        let hint = MenuItem::with_id(
            app,
            "no_models",
            "Scan models in app first…",
            false,
            None::<&str>,
        )?;
        return Submenu::with_items(app, "Swap Model", true, &[&hint]);
    }

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for (idx, path) in models.iter().enumerate() {
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let mark = if path == &current { "● " } else { "" };
        let id = format!("model_{}", idx);
        let item = MenuItem::with_id(app, id, format!("{}{}", mark, name), true, None::<&str>)?;
        items.push(Box::new(item));
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();
    Submenu::with_items(app, "Swap Model", true, &refs)
}

/// Handle a click on a tray menu item.
fn handle_tray_event(app: &tauri::AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "start" => {
            let _ = app.emit("tray-action", "start");
        }
        "stop" => {
            let _ = app.emit("tray-action", "stop");
        }
        s if s.starts_with("model_") => {
            if let Ok(idx) = s["model_".len()..].parse::<usize>() {
                let models = app.state::<ServerState>().models.lock().unwrap().clone();
                if let Some(path) = models.get(idx) {
                    let _ = app.emit("tray-swap-model", path.clone());
                }
            }
        }
        "fa_on" | "fa_off" => {
            let _ = app.emit(
                "tray-toggle",
                ("flash-attn", if id == "fa_on" { "on" } else { "off" }),
            );
        }
        "webui_on" | "webui_off" => {
            let _ = app.emit("tray-toggle", ("webui", id == "webui_on"));
        }
        "cb_on" | "cb_off" => {
            let _ = app.emit("tray-toggle", ("cont-batching", id == "cb_on"));
        }
        "quit" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
            app.exit(0);
        }
        _ => {}
    }
}
