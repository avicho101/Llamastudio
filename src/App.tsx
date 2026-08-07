import { useEffect, useState } from "react";
import {
  Category,
  ConfigValues,
  DeviceInfo,
  EnvStatus,
  ChatMsg,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { FlagControl, InfoTip } from "./FlagControl";
import { invoke, openFileDialog, openDirDialog, saveDialog } from "./tauri";
import logo from "./assets/logo.png";

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
    () => (localStorage.getItem("llamastudio-theme") as "dark" | "light") || "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("llamastudio-theme", theme);
  }, [theme]);

  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);

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
      // restart with full current config
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
        binary_path: binaryPath,
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
        // Load config into the UI and auto-start if a model is set
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

  const scanModels = async () => {
    if (!modelsDir) return;
    try {
      const m = await invoke<string[]>("list_models", { dir: modelsDir });
      setModelFiles(m);
    } catch (e) {
      setError(String(e));
    }
  };

  const start = async () => {
    setError("");
    try {
      const args = buildArgs(cfg, binaryPath);
      // first arg is binary; strip it for start_server which prepends binary
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

  const sendChat = async () => {
    if (!input.trim() || streaming) return;
    const msg: ChatMsg = { role: "user", content: input };
    const next = [...chat, msg];
    setChat(next);
    setInput("");
    setStreaming(true);
    const host = String(cfg["--host"] || "127.0.0.1");
    const port = Number(cfg["--port"] || 8080);
    const key = String(cfg["--api-key"] || "");
    try {
      const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: "local",
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
        }),
      });
      if (!res.ok) {
        setError(`Chat error: ${res.status}`);
        setStreaming(false);
        return;
      }
      const data = await res.json();
      const content: string =
        data?.choices?.[0]?.message?.content ?? "(no content)";
      setChat((prev) => [...prev, { role: "assistant", content }]);
    } catch (e) {
      setError(`Chat failed: ${String(e)}`);
    } finally {
      setStreaming(false);
    }
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
          <button className="btn-small" onClick={detectEnv}>
            Detect
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
      </div>

      <main className="content">
        {activeTab === "config" && (
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
                    onClick={() => onChange("--model", m.includes(":\\") || m.startsWith("/") ? m : `${modelsDir}/${m}`)}
                    className={
                      String(cfg["--model"] || "").includes(m)
                        ? "selected"
                        : ""
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
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}

        {activeTab === "logs" && (
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
        )}

        {activeTab === "chat" && (
          <div className="chat-panel">
            <div className="chat-history">
              {chat.length === 0 && (
                <div className="chat-empty">
                  Start a conversation with your model. Make sure the server is
                  running.
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`bubble ${m.role}`}>
                  {m.content}
                </div>
              ))}
            </div>
            <div className="chat-input">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
                placeholder="Type a message… (Enter to send)"
              />
              <button
                className="btn-primary"
                onClick={sendChat}
                disabled={streaming}
              >
                {streaming ? "…" : "Send"}
              </button>
            </div>
          </div>
        )}

        {activeTab === "profiles" && (
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
                  The installer (NSIS .exe) registers <code>.llamaprofile</code> automatically —
                  just install LlamaStudio normally.
                </li>
                <li>
                  For portable/zip builds, click <b>Associate .llamaprofile</b> once (run as Admin if it fails).
                </li>
                <li>
                  Save a profile with <b>Save current config</b>, then double-click the
                  <code>.llamaprofile</code> file in Explorer → LlamaStudio opens and launches the model with your saved flags.
                </li>
              </ol>
              <p className="muted">
                The file is plain JSON (with a <code>llamastudio_profile</code> marker), so you can
                edit or share it. Binary path is optional — if blank, the app uses its current binary.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Build the CLI arguments array from config
function buildArgs(cfg: ConfigValues, binaryPath: string): string[] {
  const args: string[] = [binaryPath];
  const noGpu = cfg["--no-gpu"] === true;
  for (const [name, val] of Object.entries(cfg)) {
    if (name === "--no-gpu") continue; // handled below, not a real flag
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
    // ensure --n-gpu-layers 0 (drop any prior value)
    const idx = args.findIndex((a) => a === "--n-gpu-layers");
    if (idx >= 0) {
      args.splice(idx, 2);
    }
    args.push("--n-gpu-layers", "0");
  }
  return args;
}
