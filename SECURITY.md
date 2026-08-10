# Security Policy

## Reporting a vulnerability

LlamaStudio is a local, offline desktop app — no telemetry, no network calls
on launch. Still, if you find a security issue, please report it privately:

- **Email:** open an issue with `[SECURITY]` in the title, or contact the
  maintainer via GitHub directly.
- **Do not** open a public issue with exploit details.

You'll get an acknowledgement within 48 hours and a fix timeline.

## Scope

- Remote code execution via crafted models/profiles
- Path traversal / arbitrary file writes via `.llamaprofile` files
- Command injection via flag values passed to `llama-server`

## Out of scope

- Issues in upstream llama.cpp itself (report to ggml-org/llama.cpp)
- The self-signed installer certificate (designed for air-gapped use)
