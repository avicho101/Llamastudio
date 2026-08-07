// Tauri v2 API imports (guarded so the app can run in a plain browser for dev)
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  // @ts-ignore - tauri may not be present in plain browser
  if (typeof window !== "undefined" && window.__TAURI__) {
    // @ts-ignore
    return window.__TAURI__.invoke(cmd, args);
  }
  // @ts-ignore
  const tauri = await import("@tauri-apps/api/core").catch(() => null);
  if (tauri) {
    return tauri.invoke(cmd, args);
  }
  throw new Error("Tauri runtime not available (run via `npm run tauri dev`)");
}

export async function openFileDialog(opts: {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
}): Promise<string | string[] | null> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    if (opts.multiple) {
      return (await dialog.open({
        title: opts.title,
        filters: opts.filters,
        multiple: true,
      })) as string[] | null;
    }
    return (await dialog.open({
      title: opts.title,
      filters: opts.filters,
    })) as string | null;
  } catch {
    return null;
  }
}

export async function openDirDialog(opts: {
  title?: string;
}): Promise<string | null> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    return (await dialog.open({
      title: opts.title,
      directory: true,
    })) as string | null;
  } catch {
    return null;
  }
}

export async function saveDialog(opts: {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    return (await dialog.save({
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    })) as string | null;
  } catch {
    return null;
  }
}
