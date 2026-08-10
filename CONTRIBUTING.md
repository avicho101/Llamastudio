# Contributing

Thanks for your interest in LlamaStudio! Here's how to help.

## Ways to contribute

- **Report bugs** — open an issue with: LlamaStudio version, llama-server version,
  your GPU/VRAM, and the exact steps (screenshot of the Logs tab helps a lot).
- **Request features** — open an issue describing the workflow you need.
- **Add flags** — if a new `llama-server` flag is missing, it's added in
  `src-tauri/src/schema_server.rs` (one line per flag: name, short flag, type,
  default, help text, enum options).
- **Fix bugs / improve UI** — fork, branch, PR.

## Development setup

```bat
git clone https://github.com/avicho101/Llamastudio
cd Llamastudio
npm install
npm run tauri dev
```

Prereqs: Rust stable, Node 20+, VS2022 Build Tools (MSVC v143 + Win11 SDK + CMake).

## Pull request checklist

- [ ] Build passes: `npm run build` (frontend) + `npm run tauri build` (app)
- [ ] Works in both light and dark themes (if UI change)
- [ ] Flag additions match upstream `llama-server --help`
- [ ] CHANGELOG entry added under "Unreleased"

## Release process (maintainers)

1. Bump `package.json` + `src-tauri/tauri.conf.json` (keep them in sync)
2. `npm install --package-lock-only`
3. Commit, tag `vX.Y.Z`, push tag → CI builds + signs + publishes the Release
