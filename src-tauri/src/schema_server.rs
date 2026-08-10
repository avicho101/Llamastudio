use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
struct Flag {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    short: Option<String>,
    #[serde(rename = "type")]
    flag_type: String,
    default: Value,
    help: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    choices: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    multiline: Option<bool>,
}

#[derive(Serialize)]
struct Category {
    id: String,
    label: String,
    flags: Vec<Flag>,
}

fn f(
    name: &str,
    short: Option<&str>,
    t: &str,
    default: Value,
    help: &str,
    choices: Option<Vec<&str>>,
    min: Option<i64>,
    max: Option<i64>,
    ext: Option<&str>,
    multiline: bool,
) -> Flag {
    Flag {
        name: name.to_string(),
        short: short.map(|s| s.to_string()),
        flag_type: t.to_string(),
        default,
        help: help.to_string(),
        choices: choices.map(|c| c.iter().map(|s| s.to_string()).collect()),
        min,
        max,
        ext: ext.map(|s| s.to_string()),
        multiline: if multiline { Some(true) } else { None },
    }
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}
fn fl(v: f64) -> Value {
    Value::Number(serde_json::Number::from_f64(v).unwrap_or(serde_json::Number::from(0)))
}
fn i(v: i64) -> Value {
    Value::Number(v.into())
}

pub fn schema_json() -> Value {
    let categories = vec![
        Category {
            id: "model".into(),
            label: "Model & Loading".into(),
            flags: vec![
                f("--model", Some("-m"), "path_file", s(""), "Path to the GGUF model file to load.", None, None, None, Some(".gguf"), false),
                f("--alias", Some("-a"), "string", s(""), "Comma-separated model name aliases used by the API.", None, None, None, None, false),
                f("--hf-repo", Some("-hf"), "string", s(""), "HuggingFace repo (user/model:quant). Downloads model + mmproj automatically.", None, None, None, None, false),
                f("--hf-file", Some("-hff"), "string", s(""), "Specific HF file (overrides quant).", None, None, None, None, false),
                f("--hf-token", Some("-hft"), "password", s(""), "HuggingFace access token (gated models).", None, None, None, None, false),
                f("--model-url", Some("-mu"), "string", s(""), "Direct model download URL.", None, None, None, None, false),
                f("--no-mmproj", None, "bool", Value::Bool(false), "Disable automatic multimodal projector download (used with -hf).", None, None, None, None, false),
                f("--lora", None, "path_file", s(""), "LoRA adapter path(s), comma-separated.", None, None, None, Some(".bin,.gguf"), false),
                f("--lora-scaled", None, "string", s(""), "LoRA adapter with user scaling (FNAME:SCALE,...).", None, None, None, None, false),
                f("--control-vector", None, "path_file", s(""), "Add a control vector.", None, None, None, None, false),
                f("--override-tensor", Some("-ot"), "string", s(""), "Override tensor buffer type (pattern=type,...).", None, None, None, None, false),
                f("--override-kv", None, "string", s(""), "Override model metadata (KEY=TYPE:VALUE,...).", None, None, None, None, false),
                f("--check-tensors", None, "bool", Value::Bool(false), "Check model tensor data for invalid values.", None, None, None, None, false),
                f("--load-mode", Some("-lm"), "enum", s("mmap"), "Model loading mode.", Some(vec!["mmap","mlock","mmap+mlock","dio","none"]), None, None, None, false),
            ],
        },
        Category {
            id: "cuda".into(),
            label: "CUDA / GPU Offload".into(),
            flags: vec![
                f("--n-gpu-layers", Some("-ngl"), "string", s("auto"), "Max layers in VRAM: number, 'auto', or 'all'.", None, None, None, None, false),
                f("--device", Some("-dev"), "string", s(""), "Comma-separated device list for offload (none = no offload). Use --list-devices.", None, None, None, None, false),
                f("--list-devices", None, "bool", Value::Bool(false), "Print available devices and exit.", None, None, None, None, false),
                f("--split-mode", Some("-sm"), "enum", s("layer"), "How to split model across multiple GPUs.", Some(vec!["none","layer","row","tensor"]), None, None, None, false),
                f("--tensor-split", Some("-ts"), "string", s(""), "Fraction per GPU (e.g. 3,1).", None, None, None, None, false),
                f("--main-gpu", Some("-mg"), "int", i(0), "GPU for model (split-mode=none) or KV/intermediate.", None, Some(0), None, None, false),
                f("--fit", None, "enum", s("on"), "Adjust unset args to fit device memory.", Some(vec!["on","off"]), None, None, None, false),
                f("--fit-target", Some("-fitt"), "string", s("1024"), "Target margin MiB per device for --fit.", None, None, None, None, false),
                f("--fit-ctx", Some("-fitc"), "int", i(4096), "Min ctx size --fit may set.", None, Some(0), None, None, false),
                f("--cpu-moe", Some("-cmoe"), "bool", Value::Bool(false), "Keep all MoE weights on CPU.", None, None, None, None, false),
                f("--n-cpu-moe", Some("-ncmoe"), "int", i(0), "Keep MoE weights of first N layers on CPU.", None, Some(0), None, None, false),
                f("--op-offload", None, "bool", Value::Bool(true), "Offload host tensor ops to device.", None, None, None, None, false),
                f("--kv-offload", Some("-kvo"), "bool", Value::Bool(true), "Enable KV cache offloading.", None, None, None, None, false),
                f("--flash-attn", Some("-fa"), "enum", s("auto"), "Flash Attention mode.", Some(vec!["on","off","auto"]), None, None, None, false),
                f("--cache-type-k", Some("-ctk"), "enum", s("f16"), "KV cache dtype for K.", Some(vec!["f32","f16","bf16","q8_0","q4_0","q4_1","iq4_nl","q5_0","q5_1"]), None, None, None, false),
                f("--cache-type-v", Some("-ctv"), "enum", s("f16"), "KV cache dtype for V.", Some(vec!["f32","f16","bf16","q8_0","q4_0","q4_1","iq4_nl","q5_0","q5_1"]), None, None, None, false),
                f("--numa", None, "enum", s(""), "NUMA optimizations.", Some(vec!["distribute","isolate","numactl"]), None, None, None, false),
                f("--rpc", None, "string", s(""), "Comma-separated RPC servers (host:port).", None, None, None, None, false),
            ],
        },
        Category {
            id: "context".into(),
            label: "Context & Batching".into(),
            flags: vec![
                f("--ctx-size", Some("-c"), "int", i(0), "Prompt context size (0 = model default). Raise this for long contexts.", None, Some(0), None, None, false),
                f("--grp-attn-n", Some("-gan"), "int", i(1), "Self-extend group attention factor (1 = disabled). Extends effective context beyond trained length. Used with --grp-attn-w. E.g. 4 with -c 32768 gives ~128k effective.", None, Some(1), None, None, false),
                f("--grp-attn-w", Some("-gaw"), "int", i(512), "Self-extend group attention width (tokens per group, default 512). Used with --grp-attn-n.", None, Some(1), None, None, false),
                f("--predict", Some("-n"), "int", i(-1), "Tokens to predict (-1 = infinity).", None, Some(-1), None, None, false),
                f("--batch-size", Some("-b"), "int", i(2048), "Logical max batch size.", None, Some(1), None, None, false),
                f("--ubatch-size", Some("-ub"), "int", i(512), "Physical max batch size.", None, Some(1), None, None, false),
                f("--keep", None, "int", i(0), "Tokens to keep from initial prompt (-1 = all).", None, Some(0), None, None, false),
                f("--threads", Some("-t"), "int", i(-1), "CPU threads for generation (-1 = auto).", None, Some(-1), None, None, false),
                f("--threads-batch", Some("-tb"), "int", i(-1), "Threads for batch/prompt processing.", None, Some(-1), None, None, false),
                f("--cpu-mask", Some("-C"), "string", s(""), "CPU affinity hex mask.", None, None, None, None, false),
                f("--cpu-range", Some("-Cr"), "string", s(""), "CPU affinity range lo-hi.", None, None, None, None, false),
                f("--prio", None, "int", i(0), "Process priority (-1 low .. 3 realtime).", None, Some(-1), Some(3), None, false),
                f("--poll", None, "int", i(50), "Polling level for work wait.", None, Some(0), Some(100), None, false),
                f("--cont-batching", Some("-cb"), "bool", Value::Bool(true), "Continuous (dynamic) batching.", None, None, None, None, false),
                f("--parallel", Some("-np"), "int", i(-1), "Server slots (-1 = auto).", None, Some(-1), None, None, false),
                f("--cache-prompt", None, "bool", Value::Bool(true), "Prompt caching (KV shift reuse).", None, None, None, None, false),
                f("--cache-reuse", None, "int", i(0), "Min chunk size to reuse from cache.", None, Some(0), None, None, false),
                f("--context-shift", None, "bool", Value::Bool(false), "Context shift on infinite generation.", None, None, None, None, false),
                f("--swa-full", None, "bool", Value::Bool(false), "Use full-size SWA cache.", None, None, None, None, false),
            ],
        },
        Category {
            id: "rope".into(),
            label: "RoPE / Context Scaling".into(),
            flags: vec![
                f("--rope-scaling", None, "enum", s(""), "RoPE frequency scaling method.", Some(vec!["none","linear","yarn"]), None, None, None, false),
                f("--rope-scale", None, "float", fl(0.0), "RoPE context scaling factor.", None, Some(0), None, None, false),
                f("--rope-freq-base", None, "float", fl(0.0), "RoPE base frequency (NTK-aware).", None, Some(0), None, None, false),
                f("--rope-freq-scale", None, "float", fl(0.0), "RoPE freq scale factor (1/N).", None, Some(0), None, None, false),
                f("--yarn-orig-ctx", None, "int", i(0), "YaRN original context size.", None, Some(0), None, None, false),
                f("--yarn-ext-factor", None, "float", fl(-1.0), "YaRN extrapolation mix factor.", None, None, None, None, false),
                f("--yarn-attn-factor", None, "float", fl(-1.0), "YaRN attention magnitude scale.", None, None, None, None, false),
                f("--yarn-beta-slow", None, "float", fl(-1.0), "YaRN high correction dim.", None, None, None, None, false),
                f("--yarn-beta-fast", None, "float", fl(-1.0), "YaRN low correction dim.", None, None, None, None, false),
            ],
        },
        Category {
            id: "speculative".into(),
            label: "Speculative Decoding".into(),
            flags: vec![
                f("--spec-type", None, "enum", s("none"), "Speculative decoding type(s), comma-separated.", Some(vec!["none","draft-simple","draft-eagle3","draft-mtp","draft-dflash","draft-dspark","ngram-simple","ngram-map-k","ngram-map-k4v","ngram-mod","ngram-cache"]), None, None, None, false),
                f("--model-draft", Some("-md"), "path_file", s(""), "Draft model for speculative decoding.", None, None, None, Some(".gguf"), false),
                f("--spec-draft-ngl", Some("-ngld"), "string", s("auto"), "Draft model GPU layers (number, auto, all).", None, None, None, None, false),
                f("--spec-draft-n-max", None, "int", i(3), "Tokens to draft.", None, Some(0), None, None, false),
                f("--spec-draft-n-min", None, "int", i(0), "Min draft tokens.", None, Some(0), None, None, false),
                f("--spec-draft-p-min", None, "float", fl(0.0), "Min speculative decoding probability (greedy).", None, Some(0), Some(1), None, false),
                f("--spec-draft-p-split", None, "float", fl(0.1), "Speculative decoding split probability.", None, Some(0), Some(1), None, false),
                f("--spec-ngram-mod-n-min", None, "int", i(48), "ngram-mod min ngram tokens.", None, Some(0), None, None, false),
                f("--spec-ngram-mod-n-max", None, "int", i(64), "ngram-mod max ngram tokens.", None, Some(0), None, None, false),
                f("--spec-ngram-mod-n-match", None, "int", i(24), "ngram-mod lookup length.", None, Some(0), None, None, false),
            ],
        },
        Category {
            id: "sampling".into(),
            label: "Sampling".into(),
            flags: vec![
                f("--temperature", Some("--temp"), "float", fl(0.8), "Sampling temperature.", None, Some(0), None, None, false),
                f("--top-k", None, "int", i(40), "Top-k sampling (0 = disabled).", None, Some(0), None, None, false),
                f("--top-p", None, "float", fl(0.95), "Top-p sampling (1.0 = disabled).", None, Some(0), Some(1), None, false),
                f("--min-p", None, "float", fl(0.05), "Min-p sampling (0 = disabled).", None, Some(0), Some(1), None, false),
                f("--typical", None, "float", fl(1.0), "Locally typical sampling p (1 = disabled).", None, Some(0), Some(1), None, false),
                f("--top-n-sigma", None, "float", fl(-1.0), "Top-n-sigma sampling (-1 = disabled).", None, Some(-1), None, None, false),
                f("--xtc-probability", None, "float", fl(0.0), "XTC probability (0 = disabled).", None, Some(0), Some(1), None, false),
                f("--xtc-threshold", None, "float", fl(0.1), "XTC threshold (1 = disabled).", None, Some(0), Some(1), None, false),
                f("--repeat-last-n", None, "int", i(64), "Last n tokens for repeat penalty.", None, Some(0), None, None, false),
                f("--repeat-penalty", None, "float", fl(1.0), "Repeat penalty (1 = disabled).", None, Some(0), None, None, false),
                f("--presence-penalty", None, "float", fl(0.0), "Presence penalty (0 = disabled).", None, Some(0), None, None, false),
                f("--frequency-penalty", None, "float", fl(0.0), "Frequency penalty (0 = disabled).", None, Some(0), None, None, false),
                f("--mirostat", None, "enum", s("0"), "Mirostat mode (0 = disabled).", Some(vec!["0","1","2"]), None, None, None, false),
                f("--mirostat-lr", None, "float", fl(0.1), "Mirostat learning rate.", None, Some(0), None, None, false),
                f("--mirostat-ent", None, "float", fl(5.0), "Mirostat target entropy.", None, Some(0), None, None, false),
                f("--dynatemp-range", None, "float", fl(0.0), "Dynamic temperature range (0 = disabled).", None, Some(0), None, None, false),
                f("--dynatemp-exp", None, "float", fl(1.0), "Dynamic temperature exponent.", None, Some(0), None, None, false),
                f("--seed", Some("-s"), "int", i(-1), "RNG seed (-1 = random).", None, Some(-1), None, None, false),
                f("--samplers", None, "string", s(""), "Sampler order (;-separated). Leave empty for defaults.", None, None, None, None, false),
                f("--ignore-eos", None, "bool", Value::Bool(false), "Ignore end-of-stream, keep generating.", None, None, None, None, false),
                f("--dry-multiplier", None, "float", fl(0.0), "DRY sampling multiplier (0 = disabled).", None, Some(0), None, None, false),
                f("--dry-base", None, "float", fl(1.75), "DRY sampling base value.", None, None, None, None, false),
                f("--dry-allowed-length", None, "int", i(2), "DRY allowed length.", None, Some(0), None, None, false),
                f("--grammar", None, "string", s(""), "BNF grammar to constrain output.", None, None, None, None, true),
                f("--json-schema", Some("-j"), "string", s(""), "JSON schema to constrain output.", None, None, None, None, true),
            ],
        },
        Category {
            id: "chat".into(),
            label: "Chat & Templates".into(),
            flags: vec![
                f("--chat-template", None, "enum", s(""), "Built-in chat template (blank = from model metadata).", Some(vec!["","bailing","bailing-think","bailing2","chatglm3","chatglm4","chatml","command-r","deepseek","deepseek-ocr","deepseek2","deepseek3","exaone-moe","exaone3","exaone4","falcon3","gemma","gigachat","glmedge","gpt-oss","granite","granite-4.0","granite-4.1","grok-2","hunyuan-dense","hunyuan-moe","hunyuan-vl","kimi-k2","llama2","llama2-sys","llama2-sys-bos","llama2-sys-strip","llama3","llama4","megrez","minicpm","mistral-v1","mistral-v3","mistral-v3-tekken","mistral-v7","mistral-v7-tekken","monarch","openchat","orion","pangu-embedded","phi3","phi4","rwkv-world","seed_oss","smolvlm","solar-open","vicuna","vicuna-orca","yandex","zephyr"]), None, None, None, false),
                f("--jinja", None, "bool", Value::Bool(true), "Use jinja template engine for chat.", None, None, None, None, false),
                f("--reasoning", Some("-rea"), "enum", s("auto"), "Reasoning/thinking in chat.", Some(vec!["on","off","auto"]), None, None, None, false),
                f("--reasoning-format", None, "enum", s("auto"), "How thoughts are extracted/returned.", Some(vec!["none","deepseek","deepseek-legacy"]), None, None, None, false),
                f("--reasoning-budget", None, "int", i(-1), "Token budget for thinking (-1 unrestricted, 0 immediate end).", None, Some(-1), None, None, false),
                f("--reasoning-budget-message", None, "string", s(""), "Message injected when budget exhausted.", None, None, None, None, false),
                f("--skip-chat-parsing", None, "bool", Value::Bool(false), "Force pure content parser.", None, None, None, None, false),
                f("--prefill-assistant", None, "bool", Value::Bool(true), "Prefill assistant response if last msg is assistant.", None, None, None, None, false),
                f("--chat-template-kwargs", None, "string", s(""), "JSON kwargs for template parser.", None, None, None, None, false),
                f("--special", Some("-sp"), "bool", Value::Bool(false), "Enable special tokens output.", None, None, None, None, false),
            ],
        },
        Category {
            id: "multimodal".into(),
            label: "Multimodal (Vision)".into(),
            flags: vec![
                f("--mmproj", Some("-mm"), "path_file", s(""), "Multimodal projector file.", None, None, None, Some(".gguf,.bin"), false),
                f("--mmproj-url", Some("-mmu"), "string", s(""), "URL to mmproj file.", None, None, None, None, false),
                f("--mmproj-auto", None, "bool", Value::Bool(true), "Use mmproj if available (with -hf).", None, None, None, None, false),
                f("--mmproj-offload", None, "bool", Value::Bool(true), "GPU offload for mmproj.", None, None, None, None, false),
                f("--image-min-tokens", None, "int", i(0), "Min tokens per image (vision w/ dynamic res).", None, Some(0), None, None, false),
                f("--image-max-tokens", None, "int", i(0), "Max tokens per image.", None, Some(0), None, None, false),
                f("--mtmd-batch-max-tokens", None, "int", i(1024), "Max image tokens per batch when encoding.", None, Some(1), None, None, false),
            ],
        },
        Category {
            id: "server".into(),
            label: "Server & Network".into(),
            flags: vec![
                f("--host", None, "string", s("127.0.0.1"), "IP to bind (default localhost). Use 0.0.0.0 for LAN.", None, None, None, None, false),
                f("--port", None, "int", i(8080), "Port to listen on.", None, Some(1), Some(65535), None, false),
                f("--api-key", None, "password", s(""), "API key(s), comma-separated. (Set via api-key-file for safety.)", None, None, None, None, false),
                f("--api-key-file", None, "path_file", s(""), "File with API keys, one per line.", None, None, None, Some(".txt"), false),
                f("--ssl-key-file", None, "path_file", s(""), "PEM SSL private key.", None, None, None, Some(".pem"), false),
                f("--ssl-cert-file", None, "path_file", s(""), "PEM SSL certificate.", None, None, None, Some(".pem"), false),
                f("--cors-origins", None, "string", s("*"), "Allowed CORS origins (comma-separated, or 'localhost').", None, None, None, None, false),
                f("--api-prefix", None, "string", s(""), "API path prefix (no trailing slash).", None, None, None, None, false),
                f("--reuse-port", None, "bool", Value::Bool(false), "Allow multiple sockets on same port.", None, None, None, None, false),
                f("--static-path", Some("--path"), "path_dir", s(""), "Path to serve static files from.", None, None, None, None, false),
                f("--timeout", Some("-to"), "int", i(3600), "Server read/write timeout (s).", None, Some(0), None, None, false),
                f("--threads-http", None, "int", i(-1), "HTTP request threads (-1 = auto).", None, Some(-1), None, None, false),
                f("--sse-ping-interval", None, "int", i(30), "SSE ping interval (-1 = disabled).", None, Some(-1), None, None, false),
                f("--metrics", None, "bool", Value::Bool(false), "Enable Prometheus metrics endpoint.", None, None, None, None, false),
                f("--props", None, "bool", Value::Bool(false), "Enable POST /props to change properties.", None, None, None, None, false),
                f("--slots", None, "bool", Value::Bool(true), "Expose slots monitoring endpoint.", None, None, None, None, false),
                f("--webui", None, "bool", Value::Bool(true), "Enable llama.cpp built-in web UI.", None, None, None, None, false),
                f("--ui-config", None, "string", s(""), "JSON default UI settings.", None, None, None, None, false),
                f("--sleep-idle-seconds", None, "int", i(-1), "Idle seconds before server sleeps (-1 = disabled).", None, Some(-1), None, None, false),
                f("--offline", None, "bool", Value::Bool(false), "Offline mode: use cache, no network.", None, None, None, None, false),
            ],
        },
        Category {
            id: "embedding".into(),
            label: "Embeddings / Rerank".into(),
            flags: vec![
                f("--embedding", None, "bool", Value::Bool(false), "Restrict to embedding use case.", None, None, None, None, false),
                f("--rerank", None, "bool", Value::Bool(false), "Enable reranking endpoint.", None, None, None, None, false),
                f("--pooling", None, "enum", s(""), "Pooling type for embeddings.", Some(vec!["none","mean","cls","last","rank"]), None, None, None, false),
                f("--embd-normalize", None, "int", i(2), "Normalization for embeddings (-1 none, 2 euclidean).", None, None, None, None, false),
            ],
        },
        Category {
            id: "advanced".into(),
            label: "Advanced / Logging".into(),
            flags: vec![
                f("--verbose", Some("-v"), "bool", Value::Bool(false), "Verbosity to infinity (log all).", None, None, None, None, false),
                f("--verbosity", Some("-lv"), "int", i(3), "Verbosity threshold (0 generic..5 debug).", None, Some(0), Some(5), None, false),
                f("--log-file", None, "path_file", s(""), "Log to file.", None, None, None, Some(".log"), false),
                f("--log-disable", None, "bool", Value::Bool(false), "Disable logging.", None, None, None, None, false),
                f("--log-colors", None, "enum", s("auto"), "Colored logging.", Some(vec!["on","off","auto"]), None, None, None, false),
                f("--log-prefix", None, "bool", Value::Bool(true), "Enable prefix in log messages.", None, None, None, None, false),
                f("--log-timestamps", None, "bool", Value::Bool(true), "Enable timestamps in logs.", None, None, None, None, false),
                f("--perf", None, "bool", Value::Bool(false), "Enable internal libllama performance timings.", None, None, None, None, false),
                f("--warmup", None, "bool", Value::Bool(true), "Warmup with empty run.", None, None, None, None, false),
                f("--repack", None, "bool", Value::Bool(true), "Weight repacking.", None, None, None, None, false),
                f("--mlock", None, "bool", Value::Bool(false), "DEPRECATED: keep model in RAM (use --load-mode mlock).", None, None, None, None, false),
                f("--mmap", None, "bool", Value::Bool(true), "DEPRECATED: memory-map model (use --load-mode).", None, None, None, None, false),
            ],
        },
    ];

    serde_json::Value::Object(
        serde_json::Map::from_iter(vec![(
            "categories".to_string(),
            serde_json::to_value(categories).unwrap_or(Value::Null),
        )])
    )
}

#[derive(Serialize)]
struct Preset {
    id: String,
    label: String,
    description: String,
    patch: std::collections::HashMap<String, Value>,
}

pub fn presets_json() -> Value {
    use std::collections::HashMap;
    let mk = |id: &str, label: &str, desc: &str, items: Vec<(&str, Value)>| {
        let mut m: HashMap<String, Value> = HashMap::new();
        for (k, v) in items {
            m.insert(k.to_string(), v);
        }
        Preset {
            id: id.to_string(),
            label: label.to_string(),
            description: desc.to_string(),
            patch: m,
        }
    };

    let list = vec![
        mk(
            "long-ctx",
            "Long Context (32k)",
            "Big context window, more VRAM.",
            vec![
                ("--ctx-size".into(), i(32768)),
                ("--batch-size".into(), i(2048)),
                ("--n-gpu-layers".into(), s("auto")),
                ("--flash-attn".into(), s("on")),
            ],
        ),
        mk(
            "self-extend",
            "Self-Extend (GrpAttn)",
            "Extend effective context ~4x via grouped attention (StreamingLLM-style). Uses q8_0 KV to save VRAM.",
            vec![
                ("--ctx-size".into(), i(32768)),
                ("--grp-attn-n".into(), i(4)),
                ("--grp-attn-w".into(), i(512)),
                ("--cache-type-k".into(), s("q8_0")),
                ("--cache-type-v".into(), s("q8_0")),
                ("--batch-size".into(), i(2048)),
                ("--n-gpu-layers".into(), s("auto")),
                ("--flash-attn".into(), s("on")),
            ],
        ),
        mk(
            "max-speed",
            "Max Speed",
            "Flash attention + more GPU layers, balanced context.",
            vec![
                ("--ctx-size".into(), i(8192)),
                ("--batch-size".into(), i(2048)),
                ("--n-gpu-layers".into(), s("auto")),
                ("--flash-attn".into(), s("on")),
                ("--cont-batching".into(), Value::Bool(true)),
            ],
        ),
        mk(
            "low-vram-4gb",
            "Low VRAM (4GB)",
            "Leave headroom for an 8GB card used for other things.",
            vec![
                ("--ctx-size".into(), i(4096)),
                ("--batch-size".into(), i(512)),
                ("--n-gpu-layers".into(), i(20)),
                ("--flash-attn".into(), s("on")),
                ("--cache-type-k".into(), s("q8_0")),
                ("--cache-type-v".into(), s("q8_0")),
            ],
        ),
        mk(
            "max-quality",
            "Max Quality",
            "Full fp16 KV cache, high context, all layers on GPU.",
            vec![
                ("--ctx-size".into(), i(16384)),
                ("--n-gpu-layers".into(), s("all")),
                ("--cache-type-k".into(), s("f16")),
                ("--cache-type-v".into(), s("f16")),
                ("--flash-attn".into(), s("on")),
            ],
        ),
        mk(
            "default",
            "Balanced (Reset)",
            "Sensible defaults.",
            vec![
                ("--ctx-size".into(), i(0)),
                ("--batch-size".into(), i(2048)),
                ("--n-gpu-layers".into(), s("auto")),
                ("--flash-attn".into(), s("auto")),
                ("--temperature".into(), fl(0.8)),
                ("--top-p".into(), fl(0.95)),
            ],
        ),
    ];

    serde_json::to_value(list).unwrap_or(Value::Null)
}
