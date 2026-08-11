import { useEffect, useState, useRef } from "react";
import {
  Category,
  ConfigValues,
  DeviceInfo,
  EnvStatus,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { FlagControl, InfoTip } from "./FlagControl";
import { invoke, openFileDialog, openDirDialog, saveDialog } from "./tauri";
import logo from "./assets/logo.png";
import ChatPanel from "./ChatPanel";
import { buildTools } from "./tools";
import type { ChatTool } from "./chatTypes";

type Tab = "config" | "logs" | "chat" | "profiles";

export default function App() {
  const [schema, setSchema] = useState<Category[]>([]);
  const [presets, setPresets] = useState<
    { id: string; label: string; description: string; patch: Record<string, unknown> }[]
  >([]);
  const [cfg, setCfg] = useState<ConfigValues>({ ...DEFAULT_CONFIG });
  const [binaryPath, setBinaryPath] = useState("");
  const [modelsDir, setModelsDir] = useState("");
  const [modelFiles, setModelFiles] = useState<string[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("config");
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [logTail, setLogTail] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [cliPreview, setCliPreview] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("llamastudio-theme") as "dark" | "light") || "light"
  );
  const [floatTab, setFloatTab] = useState<Tab | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number }>({ x: 60, y: 90 });
  const [flagQuery, setFlagQuery] = useState("");
  const [flagResults, setFlagResults] = useState<
    { name: string; short?: string; help?: string; catLabel: string }[]
  >([]);
  const [flashFlag, setFlashFlag] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("llamastudio-theme", theme);
  }, [theme]);

  const [chatTools, setChatTools] = useState<ChatTool[]>(() => buildTools());
  const [workspace, setWorkspace] = useState(
    () => localStorage.getItem("llamastudio-workspace") || "C:\\Users\\hjb834"
  );

  useEffect(() => {
    localStorage.setItem("llamastudio-workspace", workspace);
  }, [workspace]);

  // Load schema + binary path on mount
  useEffect(() => {
    (async () => {
      try {
        const s = await invoke<Category[]>("get_schema");
        setSchema(s);
        const bp = await invoke<string>("get_binary_path");
        setBinaryPath(bp);
        const p = await invoke<
          { id: string; label: string; description: string; patch: Record<string, unknown> }[]
        >("get_presets");
        setPresets(p);
        // Load persisted ContextShift settings so the toggle survives restarts.
        const st = await invoke<{
          context_shift: boolean;
          context_shift_port: number;
          context_shift_keep: number;
        }>("load_settings");
        if (st) {
          setCfg((prev) => ({
            ...prev,
            "--context-shift": st.context_shift,
            "--context-shift-port": st.context_shift_port,
            "--context-shift-keep": st.context_shift_keep,
          }));
          // Tell the backend the persisted enable state so auto-start works.
          if (st.context_shift) {
            await invoke("set_context_shift", { enabled: true }).catch(() => {});
          }
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  // Listen for server log events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const tauri = await import("@tauri-apps/api/event").catch(() => null);
        if (tauri) {
          unlisten = await tauri.listen("server-log", (e: any) => {
            setLogs((prev) => {
              const next = [...prev, e.payload.line];
              return next.length > 2000 ? next.slice(-2000) : next;
            });
          });
        }
      } catch {
        /* ignore */
      }
    })();
    return () => unlisten?.();
  }, []);

  // Listen for tray menu events (start/stop/swap-model/toggles)
  useEffect(() => {
    let unsub: Array<() => void> = [];
    (async () => {
      try {
        const tauri = await import("@tauri-apps/api/event").catch(() => null);
        if (!tauri) return;
        const a = await tauri.listen<string>("tray-action", (e) => {
          if (e.payload === "start") start();
          else if (e.payload === "stop") stop();
          else if (e.payload === "open-config") setActiveTab("config");
        });
        const b = await tauri.listen<any>("tray-toggle", (e) => {
          const [name, val] = e.payload as [string, unknown];
          onChange(name, val);
        });
        const c = await tauri.listen<string>("tray-swap-model", (e) => {
          onChange("--model", e.payload);
          swapAndRestart(e.payload);
        });
        const d = await tauri.listen<string>("model-swapped", (e) => {
          onChange("--model", e.payload);
        });
        unsub = [a, b, c, d];
      } catch {
        /* ignore */
      }
    })();
    return () => unsub.forEach((u) => u());
  }, []); // eslint-disable-line

  // Swap model from tray: stop, set, restart with current config
  const swapAndRestart = async (modelPath: string) => {
    try {
      if (running) {
        await invoke("stop_server");
        setRunning(false);
      }
      await invoke("swap_model", { modelPath });
      const args = buildArgs({ ...cfg, "--model": modelPath }, binaryPath);
      await invoke("start_server", { args: args.slice(1) });
      setRunning(true);
      setStatus("Running (swapped model)");
      setActiveTab("logs");
    } catch (e) {
      setError(String(e));
    }
  };

  // Start the server with an explicit config override (used by profile launch)
  const startWith = async (override: ConfigValues, model: string, bin: string) => {
    const merged = { ...cfg, ...override, "--model": model } as ConfigValues;
    setCfg(merged);
    if (bin) setBinaryPath(bin);
    try {
      const args = buildArgs(merged, bin || binaryPath);
      await invoke("start_server", { args: args.slice(1) });
      setRunning(true);
      setStatus(`Running · ${model || "profile"}`);
      setActiveTab("logs");
    } catch (e) {
      setError(String(e));
    }
  };

  // --- Profile handlers ---
  const saveCurrentProfile = async () => {
    try {
      const path = await saveDialog({
        title: "Save LlamaStudio profile",
        defaultPath: `${profileName || "my-profile"}.llamaprofile`,
        filters: [{ name: "LlamaStudio Profile", extensions: ["llamaprofile"] }],
      });
      if (!path) return;
      const config = { ...cfg } as Record<string, unknown>;
      await invoke("save_profile", {
        path,
        name: profileName || "Untitled",
        model: String(cfg["--model"] || ""),
        binaryPath: binaryPath,
        config,
      });
      setProfileMsg(`Saved: ${path}`);
    } catch (e) {
      setProfileMsg(`Error: ${String(e)}`);
    }
  };

  const loadProfileFromFile = async () => {
    try {
      const path = await openFileDialog({
        title: "Open LlamaStudio profile",
        filters: [{ name: "LlamaStudio Profile", extensions: ["llamaprofile"] }],
      });
      if (!path || Array.isArray(path)) return;
      await applyProfilePath(path, false);
    } catch (e) {
      setProfileMsg(`Error: ${String(e)}`);
    }
  };

  const applyProfilePath = async (path: string, autostart: boolean) => {
    try {
      const prof = await invoke<any>("load_profile", { path });
      setCfg({ ...DEFAULT_CONFIG, ...prof.config });
      if (prof.binary_path) setBinaryPath(prof.binary_path);
      setProfileName(prof.name || "");
      setProfileMsg(`Loaded: ${prof.name || path}`);
      if (autostart && prof.model) {
        await startWith(prof.config, prof.model, prof.binary_path);
      }
    } catch (e) {
      setProfileMsg(`Error: ${String(e)}`);
    }
  };

  const registerFileType = async () => {
    try {
      const msg = await invoke<string>("register_association");
      setProfileMsg(msg);
    } catch (e) {
      setProfileMsg(`Error: ${String(e)}`);
    }
  };

  // Listen for a profile opened via double-click (single-instance / CLI arg)
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      const tauri = await import("@tauri-apps/api/event").catch(() => null);
      if (!tauri) return;
      const a = await tauri.listen<string>("open-profile", (e) => {
        const path = e.payload;
        setProfileMsg(`Opening profile: ${path}…`);
        setActiveTab("profiles");
        applyProfilePath(path, true);
      });
      unsub = a;
    })();
    return () => unsub?.();
  }, []); // eslint-disable-line
  // Auto-scroll logs
  useEffect(() => {
    logTail?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Build CLI preview
  useEffect(() => {
    const parts = buildArgs(cfg, binaryPath);
    setCliPreview(
      parts.length ? parts.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ") : ""
    );
  }, [cfg, binaryPath]);

  const onChange = (name: string, value: unknown) => {
    setCfg((prev) => ({ ...prev, [name]: value }));
  };

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setCfg((prev) => ({ ...prev, ...p.patch }));
  };

  // Toggle the ContextShift proxy on/off. When on, start a relay in front of
  // llama.cpp that trims chat history to fit -c. When off (or on server stop),
  // stop the proxy.
  const toggleContextShift = async (enabled: boolean) => {
    onChange("--context-shift", enabled);
    try {
      if (enabled) {
        const targetHost = String(cfg["--host"] || "127.0.0.1");
        const targetPort = Number(cfg["--port"] || 8080);
        const listenHost = "0.0.0.0"; // bind permissively so 127.0.0.1 reaches it
        const listenPort = Number(cfg["--context-shift-port"] || 8081);
        const ctxSize = Number(cfg["--ctx-size"] || 0) || 8192;
        const keepPct = Number(cfg["--context-shift-keep"] || 75);
        const msg = await invoke<string>("start_proxy", {
          listenHost,
          listenPort,
          targetHost,
          targetPort,
          ctxSize,
          keepPct,
        });
        setStatus(`ContextShift on · ${msg}`);
      } else {
        await invoke("stop_proxy");
        setStatus("ContextShift off");
      }
      // Persist so it survives restarts, and tell the backend the desired state.
      await invoke("save_settings", {
        contextShift: enabled,
        contextShiftPort: Number(cfg["--context-shift-port"] || 8081),
        contextShiftKeep: Number(cfg["--context-shift-keep"] || 75),
      });
      // Keep the backend context_shift flag in sync (drives auto-start on server start).
      await invoke("set_context_shift", { enabled }).catch(() => {});
    } catch (e) {
      setError(String(e));
    }
  };

  // Flat index of every flag (with its category) for the flag finder.
  const allFlags = schema.flatMap((cat) =>
    cat.flags.map((f) => ({
      name: f.name,
      short: f.short,
      help: f.help,
      catLabel: cat.label,
    }))
  );

  // Filter the finder as the user types (matches start of name first).
  useEffect(() => {
    const q = flagQuery.trim().toLowerCase();
    if (!q) {
      setFlagResults([]);
      return;
    }
    const matches = allFlags
      .filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.short && f.short.toLowerCase().includes(q)) ||
          (f.help && f.help.toLowerCase().includes(q)) ||
          f.catLabel.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs;
      })
      .slice(0, 10);
    setFlagResults(matches);
  }, [flagQuery, schema]);

  // Jump to a flag: switch to Configuration tab, scroll to the field, flash it.
  const jumpToFlag = (name: string) => {
    setFlagQuery("");
    setFlagResults([]);
    setActiveTab("config");
    setFlashFlag(name);
    // Wait for the tab/content to render, then scroll.
    setTimeout(() => {
      const el = document.getElementById(`row-flag-${name.replace(/[^a-z0-9]/gi, "")}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setTimeout(() => setFlashFlag(null), 1600);
    }, 60);
  };

  const detectEnv = async () => {
    setStatus("Detecting environment…");
    try {
      if (binaryPath) await invoke("set_binary_path", { path: binaryPath });
      const e = await invoke<EnvStatus>("detect_binary");
      setEnv(e);
      const g = await invoke<DeviceInfo[]>("list_gpus");
      setDevices(g);
      setStatus("Detection complete");
    } catch (e) {
      setError(String(e));
      setStatus("Detection failed");
    }
  };

  // Auto-detect environment on startup (replaces the old manual Detect button)
  useEffect(() => {
    detectEnv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Floating-window drag
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const onFloatPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { dx: e.clientX - floatPos.x, dy: e.clientY - floatPos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onFloatPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setFloatPos({
      x: Math.max(0, e.clientX - dragRef.current.dx),
      y: Math.max(0, e.clientY - dragRef.current.dy),
    });
  };
  const onFloatPointerUp = () => {
    dragRef.current = null;
  };

  const scanModels = async () => {
    if (!modelsDir) return;
    try {
      const res = await invoke<{
        models: string[];
        mmproj: string | null;
        lora: string | null;
        control_vector: string | null;
      }>("scan_dir", { dir: modelsDir });
      setModelFiles(res.models);
      // Auto-populate every detected file into its corresponding field.
      if (res.models.length > 0) {
        onChange("--model", `${modelsDir}/${res.models[0]}`);
      }
      if (res.mmproj) {
        onChange("--mmproj", `${modelsDir}/${res.mmproj}`);
      }
      if (res.lora) {
        onChange("--lora", `${modelsDir}/${res.lora}`);
      }
      if (res.control_vector) {
        onChange("--control-vector", `${modelsDir}/${res.control_vector}`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const start = async () => {
    setError("");
    try {
      const args = buildArgs(cfg, binaryPath);
      await invoke("start_server", { args: args.slice(1) });
      setRunning(true);
      setStatus("Running");
      setActiveTab("logs");
    } catch (e) {
      setError(String(e));
      setStatus("Failed to start");
    }
  };

  const stop = async () => {
    try {
      await invoke("stop_server");
      setRunning(false);
      setStatus("Stopped");
    } catch (e) {
      setError(String(e));
    }
  };

  const pickBinary = async () => {
    try {
      const res = await openFileDialog({
        title: "Select llama-server binary",
        filters: [
          {
            name: "Executable",
            extensions:
              navigator.platform.toLowerCase().includes("win")
                ? ["exe"]
                : ["*"],
          },
        ],
      });
      if (typeof res === "string") {
        setBinaryPath(res);
        await invoke("set_binary_path", { path: res });
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const renderTab = (tab: Tab) => {
    if (tab === "config") {
      return (
        <div className="config-layout">
          <div className="models-panel">
            <h3>Models Folder</h3>
            <div className="path-row">
              <input
                className="path-input"
                value={modelsDir}
                onChange={(e) => setModelsDir(e.target.value)}
                placeholder="folder with .gguf files"
              />
              <button
                className="btn-small"
                onClick={async () => {
                  try {
                    const res = await openDirDialog({ title: "Select models folder" });
                    if (typeof res === "string") {
                      setModelsDir(res);
                      await scanModels();
                    }
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Browse…
              </button>
            </div>
            <button className="btn-small" onClick={scanModels}>
              Scan
            </button>
            <ul className="model-list">
              {modelFiles.map((m) => (
                <li
                  key={m}
                  onClick={() =>
                    onChange(
                      "--model",
                      m.includes(":\\") || m.startsWith("/") ? m : `${modelsDir}/${m}`
                    )
                  }
                  className={
                    String(cfg["--model"] || "").includes(m) ? "selected" : ""
                  }
                >
                  {m}
                </li>
              ))}
              {modelFiles.length === 0 && (
                <li className="empty">No models found</li>
              )}
            </ul>

            {devices.length > 0 && (
              <div className="devices">
                <h3>Detected Devices</h3>
                {devices.map((d) => (
                  <div key={d.index} className="device-card">
                    <div className="dev-name">{d.name}</div>
                    <div className="dev-meta">
                      {d.backend.toUpperCase()} ·{" "}
                      {d.vram_mb > 0
                        ? `${Math.round(d.vram_mb / 1024)} GB VRAM`
                        : "no VRAM"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flags-panel">
            <div className="cli-preview">
              <div className="cli-head">
                Command preview (copy & run manually if you prefer)
              </div>
              <code>{cliPreview || "(set model + flags)"}</code>
            </div>
            {schema.map((cat) => (
              <section key={cat.id} className="cat">
                <h2>{cat.label}</h2>
                <div className="flags-grid">
                  {cat.flags.map((f) => (
                    <FlagControl
                      key={f.name}
                      flag={f}
                      value={cfg[f.name] ?? f.default}
                      onChange={onChange}
                      flash={flashFlag === f.name}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      );
    }
    if (tab === "logs") {
      return (
        <div className="logs-panel">
          {logs.length === 0 ? (
            <div className="logs-empty">
              No logs yet. Start the server to see output.
            </div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="log-line">
                {l}
              </div>
            ))
          )}
          <div ref={(el) => setLogTail(el)} />
        </div>
      );
    }
    if (tab === "chat") {
      const host = String(cfg["--host"] || "127.0.0.1");
      const proxyEnabled = Boolean(cfg["--context-shift"]);
      // Route through the ContextShift proxy when enabled (it trims history
      // to fit -c), otherwise talk to llama-server directly.
      const port = proxyEnabled
        ? Number(cfg["--context-shift-port"] ?? 8081)
        : Number(cfg["--port"] || 8080);
      const key = String(cfg["--api-key"] || "");
      return (
        <ChatPanel
          baseUrl={`http://${host}:${port}/v1`}
          apiKey={key}
          model={String(cfg["--model"] || "local")}
          tools={chatTools}
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          onToolsChange={setChatTools}
        />
      );
    }
    // profiles
    return (
      <div className="profiles-panel">
        <h3>LlamaStudio Profiles</h3>
        <p className="muted">
          Save your current flags + model as a <code>.llamaprofile</code> file.
          Double-click it later to reopen the model with the exact same settings.
        </p>

        <div className="profile-row">
          <label>Profile name</label>
          <input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="e.g. Gemma4-26B-Q4-CLI"
          />
        </div>

        <div className="profile-actions">
          <button className="btn-primary" onClick={saveCurrentProfile}>
            💾 Save current config
          </button>
          <button className="btn" onClick={loadProfileFromFile}>
            📂 Load profile
          </button>
          <button className="btn" onClick={registerFileType}>
            🔗 Associate .llamaprofile (double-click)
          </button>
        </div>

        {profileMsg && <div className="profile-msg">{profileMsg}</div>}

        <div className="profile-help">
          <h4>How double-click works</h4>
          <ol>
            <li>
              The installer (NSIS .exe) registers <code>.llamaprofile</code>{" "}
              automatically — just install LlamaStudio normally.
            </li>
            <li>
              For portable/zip builds, click <b>Associate .llamaprofile</b> once
              (run as Admin if it fails).
            </li>
            <li>
              Save a profile with <b>Save current config</b>, then double-click
              the <code>.llamaprofile</code> file in Explorer → LlamaStudio opens
              and launches the model with your saved flags.
            </li>
          </ol>
          <p className="muted">
            The file is plain JSON (with a <code>llamastudio_profile</code> marker),
            so you can edit or share it. Binary path is optional — if blank, the
            app uses its current binary.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={logo} alt="LlamaStudio" className="brand-logo" />
          <span className="title">LlamaStudio</span>
        </div>
        <div className="binary-line">
          <span className="lbl">binary:</span>
          <input
            className="binary-path"
            value={binaryPath}
            onChange={(e) => setBinaryPath(e.target.value)}
            placeholder="path to llama-server(.exe)"
          />
          <button className="btn-small" onClick={pickBinary}>
            Browse…
          </button>
        </div>
        <div className="server-controls">
          {running ? (
            <button className="btn-danger" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button className="btn-primary" onClick={start}>
              ▶ Start Server
            </button>
          )}
          <button
            className="btn-small theme-toggle"
            title="Toggle light / dark theme"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
          </button>
          <div className="flag-finder">
            <input
              className="flag-search"
              value={flagQuery}
              onChange={(e) => setFlagQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && flagResults.length > 0) {
                  jumpToFlag(flagResults[0].name);
                } else if (e.key === "Escape") {
                  setFlagQuery("");
                  setFlagResults([]);
                }
              }}
              placeholder="🔍 find flag…"
            />
            {flagResults.length > 0 && (
              <ul className="flag-results">
                {flagResults.map((r) => (
                  <li
                    key={r.name}
                    onClick={() => jumpToFlag(r.name)}
                    className="flag-result"
                  >
                    <code>{r.name}</code>
                    {r.short && <span className="flag-short">{r.short}</span>}
                    <span className="flag-cat">{r.catLabel}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </header>

      <div className="statusbar">
        <span className={`dot ${running ? "on" : "off"}`} />
        <span className="status-text">{status}</span>
        {env && (
          <span className="env-chip">
            {env.binary_valid
              ? `binary ✓ ${env.binary_version.slice(0, 40)}`
              : "binary ✗"}
            {env.cuda_available && ` · CUDA ${env.cuda_version || "?"}`}
          </span>
        )}
        {devices.length > 0 && (
          <span className="env-chip">
            {devices
              .filter((d) => d.backend === "cuda")
              .map((d) => `${d.name} (${Math.round(d.vram_mb / 1024)}GB)`)
              .join(", ") || "CPU only"}
          </span>
        )}
      </div>

      {error && <div className="error-banner">⚠ {error}</div>}

      {/* Quick settings — the things you touch most often, KoboldCpp-style front row */}
      <div className="quickbar">
        <div className="quick-field">
          <label>
            Context Size <span className="q-sub">(-c / --ctx-size)</span>
            <InfoTip text="Maximum prompt context window in tokens. 0 = model default. Raise it for long chats/documents; more VRAM used." />
          </label>
          <input
            type="number"
            min={0}
            value={Number(cfg["--ctx-size"] ?? 0)}
            onChange={(e) =>
              onChange("--ctx-size", e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        </div>
        <div className="quick-field">
          <label>
            KV Cache <span className="q-sub">(K/V)</span>
            <InfoTip text="KV cache data type. q8_0 halves KV memory vs f16 (best on 8GB cards, ~2x compression, <5% speed hit). Use q8_0 when you get CUDA out-of-memory on load. Applies to both K and V." />
          </label>
          <select
            value={String(cfg["--cache-type-k"] ?? "f16")}
            onChange={(e) => {
              const v = e.target.value;
              onChange("--cache-type-k", v);
              onChange("--cache-type-v", v);
            }}
          >
            {["f16", "q8_0", "bf16", "f32", "q4_0"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="quick-field">
          <label>
            GPU Layers <span className="q-sub">(-ngl)</span>
            <InfoTip text="How many model layers to offload to your GPU (VRAM). 'auto' fills VRAM, 'all' forces everything to GPU. Lower it if you run out of VRAM." />
          </label>
          <input
            type="text"
            value={String(cfg["--n-gpu-layers"] ?? "auto")}
            onChange={(e) => onChange("--n-gpu-layers", e.target.value)}
          />
        </div>
        <div className="quick-field quick-toggle">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={cfg["--no-gpu"] === true}
              onChange={(e) => {
                onChange("--no-gpu", e.target.checked);
                invoke("set_no_gpu", { enabled: e.target.checked }).catch(() => {});
              }}
            />
            <span>
              No GPU <span className="q-sub">(CPU only)</span>
              <InfoTip text="Run fully on CPU — no GPU offload. Use this on machines without a CUDA GPU, or to free VRAM. Forces --n-gpu-layers 0. The tray tooltip will show 'CPU'." />
            </span>
          </label>
        </div>
        <div className="quick-field">
          <label>
            Temperature <span className="q-sub">(--temp)</span>
            <InfoTip text="Sampling randomness. 0 = deterministic, ~0.8 default, higher = more creative/chaotic." />
          </label>
          <input
            type="number"
            step="0.1"
            min={0}
            value={Number(cfg["--temperature"] ?? 0.8)}
            onChange={(e) =>
              onChange("--temperature", e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        </div>

        <div className="quick-field preset-field">
          <label>Preset <InfoTip text="One-click bundles of context size + GPU layers + batch + cache settings, tuned for a goal. Pick one, then fine-tune." /></label>
          <select onChange={(e) => { if (e.target.value) applyPreset(e.target.value); }}>
            <option value="">— choose a preset —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id} title={p.description}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="quick-field quick-toggle ctx-shift-field">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={cfg["--context-shift"] === true}
              onChange={(e) => toggleContextShift(e.target.checked)}
            />
            <span>
              ContextShift <span className="q-sub">(proxy)</span>
              <InfoTip text="Optional relay in front of llama.cpp. When the chat history would exceed the context size (-c), it drops the oldest messages and keeps the recent ones — so requests always fit without restarting the server (KoboldCpp-style). Point your client (e.g. Goose) at the proxy port instead of llama.cpp's port." />
            </span>
          </label>
          {cfg["--context-shift"] === true && (
            <div className="ctx-shift-opts">
              <label className="mini">
                Port
                <input
                  type="number"
                  className="mini-input"
                  value={Number(cfg["--context-shift-port"] ?? 8081)}
                  onChange={(e) => {
                    const v = e.target.value === "" ? "" : Number(e.target.value);
                    onChange("--context-shift-port", v);
                    if (cfg["--context-shift"] === true)
                      invoke("save_settings", {
                        contextShift: true,
                        contextShiftPort: Number(v || 8081),
                        contextShiftKeep: Number(cfg["--context-shift-keep"] || 75),
                      }).catch(() => {});
                  }}
                />
              </label>
              <label className="mini">
                Keep %
                <input
                  type="number"
                  className="mini-input"
                  min={20}
                  max={95}
                  value={Number(cfg["--context-shift-keep"] ?? 75)}
                  onChange={(e) => {
                    const v = e.target.value === "" ? "" : Number(e.target.value);
                    onChange("--context-shift-keep", v);
                    if (cfg["--context-shift"] === true)
                      invoke("save_settings", {
                        contextShift: true,
                        contextShiftPort: Number(cfg["--context-shift-port"] || 8081),
                        contextShiftKeep: Number(v || 75),
                      }).catch(() => {});
                  }}
                />
              </label>
              <span className="ctx-shift-url">
                → {String(cfg["--host"] || "127.0.0.1")}:{Number(cfg["--context-shift-port"] ?? 8081)}/v1/chat/completions
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="tabs">
        <button
          className={activeTab === "config" ? "tab active" : "tab"}
          onClick={() => setActiveTab("config")}
        >
          Configuration
        </button>
        <button
          className={activeTab === "logs" ? "tab active" : "tab"}
          onClick={() => setActiveTab("logs")}
        >
          Logs
        </button>
        <button
          className={activeTab === "chat" ? "tab active" : "tab"}
          onClick={() => setActiveTab("chat")}
        >
          Chat
        </button>
        <button
          className={activeTab === "profiles" ? "tab active" : "tab"}
          onClick={() => setActiveTab("profiles")}
        >
          Profiles
        </button>
        <button
          className="btn-small float-btn"
          title="Open the current tab in a floating window"
          onClick={() => setFloatTab(activeTab)}
        >
          ⧉ Float
        </button>
      </div>

      <main className="content">
        {activeTab === "config" && renderTab("config")}
        {activeTab === "logs" && renderTab("logs")}
        <div
          className="tab-frame"
          style={{ display: activeTab === "chat" ? "block" : "none" }}
        >
          {renderTab("chat")}
        </div>
        {activeTab === "profiles" && renderTab("profiles")}
      </main>

      {/* Floating tab window — detaches the current tab into a draggable overlay */}
      {floatTab && (
        <div className="float-window" style={{ left: floatPos.x, top: floatPos.y }}>
          <div
            className="float-header"
            onPointerDown={onFloatPointerDown}
            onPointerMove={onFloatPointerMove}
            onPointerUp={onFloatPointerUp}
          >
            <span className="float-title">
              {floatTab === "logs"
                ? "Logs"
                : floatTab === "chat"
                ? "Chat"
                : floatTab === "profiles"
                ? "Profiles"
                : "Configuration"}
            </span>
            <button
              className="float-close"
              title="Dock back"
              onClick={() => setFloatTab(null)}
            >
              ✕
            </button>
          </div>
          <div className="float-body">{renderTab(floatTab)}</div>
        </div>
      )}
    </div>
  );
}

// Build the CLI arguments array from config
function buildArgs(cfg: ConfigValues, binaryPath: string): string[] {
  const args: string[] = [binaryPath];
  const noGpu = cfg["--no-gpu"] === true;
  const grpAttnN = Number(cfg["--grp-attn-n"] ?? 1);
  const selfExtendOn = grpAttnN > 1;
  for (const [name, val] of Object.entries(cfg)) {
    if (name === "--no-gpu") continue; // handled below, not a real flag
    // ContextShift settings are LlamaStudio-only (proxy toggle/port/keep), not llama.cpp flags
    if (
      name === "--context-shift" ||
      name === "--context-shift-port" ||
      name === "--context-shift-keep"
    )
      continue;
    // Self-extend: only pass --grp-attn-* when actually enabled (n > 1),
    // because older llama-server builds reject the flag entirely.
    if (name === "--grp-attn-n" || name === "--grp-attn-w") {
      if (!selfExtendOn) continue;
      if (name === "--grp-attn-w" && !(Number(val) > 0)) continue;
    }
    if (val === "" || val === null || val === undefined) continue;
    if (typeof val === "boolean") {
      if (val) args.push(name);
      // false => omit (matches default-off flags)
    } else {
      args.push(name, String(val));
    }
  }
  // CPU-only mode: force zero GPU layers regardless of --n-gpu-layers value
  if (noGpu) {
    const idx = args.findIndex((a) => a === "--n-gpu-layers");
    if (idx >= 0) {
      args.splice(idx, 2);
    }
    args.push("--n-gpu-layers", "0");
  }
  return args;
}
