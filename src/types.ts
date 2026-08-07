export interface FlagDef {
  name: string;
  short?: string;
  type:
    | "string"
    | "int"
    | "float"
    | "bool"
    | "enum"
    | "password"
    | "path_file"
    | "path_dir"
    | "multiline";
  default: unknown;
  help: string;
  choices?: string[];
  min?: number;
  max?: number;
  ext?: string;
  multiline?: boolean;
}

export interface Category {
  id: string;
  label: string;
  flags: FlagDef[];
}

export type ConfigValues = Record<string, unknown>;

export interface DeviceInfo {
  index: number;
  name: string;
  vram_mb: number;
  backend: string;
}

export interface EnvStatus {
  cuda_available: boolean;
  cuda_version: string;
  nvcc_available: boolean;
  cudnn_present: boolean;
  binary_valid: boolean;
  binary_version: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export const DEFAULT_CONFIG: ConfigValues = {
  "--model": "",
  "--alias": "",
  "--hf-repo": "",
  "--hf-token": "",
  "--n-gpu-layers": "auto",
  "--no-gpu": false, // CPU-only mode (no GPU offload)
  "--ctx-size": 0,
  "--flash-attn": "auto",
  "--cache-type-k": "f16",
  "--cache-type-v": "f16",
  "--host": "127.0.0.1",
  "--port": 8080,
  "--webui": true,
  "--reasoning": "auto",
  "--temperature": 0.8,
  "--top-p": 0.95,
  "--top-k": 40,
  "--repeat-penalty": 1,
};
