use crate::DeviceInfo;

/// Detect NVIDIA GPUs via nvidia-smi (most reliable on Windows without extra deps).
/// Falls back gracefully to empty list if not present (CPU-only).
pub fn detect_devices() -> Vec<DeviceInfo> {
    let mut devices = Vec::new();

    // Try nvidia-smi query (works with standard driver install)
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=index,name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .output();

    if let Ok(o) = out {
        if o.status.success() {
            let text = String::from_utf8_lossy(&o.stdout);
            let mut driver = String::new();
            for line in text.lines() {
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 4 {
                    let index = parts[0].parse::<u32>().unwrap_or(0);
                    let name = parts[1].to_string();
                    let mem = parts[2].parse::<u64>().unwrap_or(0);
                    driver = parts[3].to_string();
                    devices.push(DeviceInfo {
                        index,
                        name,
                        vram_mb: mem,
                        backend: "cuda".to_string(),
                    });
                }
            }
            if !devices.is_empty() {
                // annotate driver via first device (stored only once; we keep per-device name)
                let _ = driver;
            }
        }
    }

    // If nvidia-smi not found, try WMI via powershell on Windows (common in air-gapped)
    #[cfg(target_os = "windows")]
    if devices.is_empty() {
        devices = detect_via_powershell();
    }

    if devices.is_empty() {
        // CPU only fallback entry so the UI shows something
        devices.push(DeviceInfo {
            index: 0,
            name: "CPU (no GPU detected)".to_string(),
            vram_mb: 0,
            backend: "cpu".to_string(),
        });
    }
    devices
}

#[cfg(target_os = "windows")]
fn detect_via_powershell() -> Vec<DeviceInfo> {
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -like '*NVIDIA*' } | ForEach-Object { $_.Name }",
        ])
        .output();
    let mut devices = Vec::new();
    if let Ok(o) = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -like '*NVIDIA*' } | ForEach-Object { $_.DeviceID + '|' + $_.Name }",
        ])
        .output()
    {
        let text = String::from_utf8_lossy(&o.stdout);
        let mut idx = 0u32;
        for line in text.lines() {
            let mut parts = line.splitn(2, '|');
            let name = parts.next().unwrap_or("").to_string();
            let gpu_name = parts.next().unwrap_or("NVIDIA GPU").to_string();
            if !name.is_empty() || !gpu_name.is_empty() {
                devices.push(DeviceInfo {
                    index: idx,
                    name: if gpu_name.is_empty() { name } else { gpu_name },
                    vram_mb: 0,
                    backend: "cuda".to_string(),
                });
                idx += 1;
            }
        }
    }
    devices
}
