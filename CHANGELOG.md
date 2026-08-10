# Changelog

All notable changes to LlamaStudio are documented here.

## [0.1.3] - 2026-08-11

### Changed
- App icons regenerated with white rounded background — clearly visible on the Windows taskbar (previously transparent, dark llama blended into dark taskbars).
- README now shows the app screenshot.
- Repo is public, MIT licensed.

### Added
- New llama logo (splash + all app icons).
- Light theme as default (dark still available via toggle).
- Redesigned splash screen (light card layout).
- README app screenshot + social preview card.
- CHANGELOG, CONTRIBUTING, SECURITY, issue templates.

## [0.1.2] - 2026-08-10

### Added
- New llama brand logo (splash + app icons).
- MIT license, public-facing README.

### Fixed
- Logo visibility in dark mode (white chip behind topbar logo).

## [0.1.1] - 2026-08-07

### Added
- ContextShift proxy (streaming, content-length framing).
- System tray menu (show/hide, start/stop, swap model, toggles, quit).
- Profiles (`.llamaprofile`) portable config files.
- CUDA/GPU detection via `nvidia-smi` / WMI.
- Model browser (GGUF folder scan).

## [0.1.0] - 2026-08-05

### Added
- Initial release: full `llama-server` flag coverage, live log streaming, chat panel, command preview, dark UI.
