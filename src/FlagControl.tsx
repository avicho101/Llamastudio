import { FlagDef } from "./types";
import { openFileDialog, openDirDialog } from "./tauri";

/** KoboldCpp-style info (i) tooltip. Hover or focus to reveal the explanation. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="flag-info" tabIndex={0} role="img" aria-label="explanation">
      ⓘ
      <span className="tip">{text}</span>
    </span>
  );
}

interface Props {
  flag: FlagDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}

export function FlagControl({ flag, value, onChange }: Props) {
  const id = `flag-${flag.name.replace(/[^a-z0-9]/gi, "")}`;

  const pickFile = async () => {
    const exts = flag.ext
      ? flag.ext
          .split(",")
          .map((e) => e.replace(/^\./, ""))
          .filter(Boolean)
      : undefined;
    const res = await openFileDialog({
      title: `Select ${flag.name}`,
      filters: exts ? [{ name: "Files", extensions: exts }] : undefined,
    });
    if (typeof res === "string") onChange(flag.name, res);
  };

  const pickDir = async () => {
    const res = await openDirDialog({ title: `Select ${flag.name}` });
    if (typeof res === "string") onChange(flag.name, res);
  };

  const render = () => {
    switch (flag.type) {
      case "bool":
        return (
          <label className="switch">
            <input
              type="checkbox"
              id={id}
              checked={Boolean(value)}
              onChange={(e) => onChange(flag.name, e.target.checked)}
            />
            <span className="slider" />
          </label>
        );
      case "enum":
        return (
          <select
            id={id}
            value={String(value ?? "")}
            onChange={(e) => onChange(flag.name, e.target.value)}
          >
            <option value="">(default)</option>
            {flag.choices?.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        );
      case "int":
      case "float":
        return (
          <input
            id={id}
            type="number"
            value={value === "" || value === null ? "" : Number(value)}
            min={flag.min}
            max={flag.max}
            step={flag.type === "float" ? "any" : 1}
            onChange={(e) =>
              onChange(
                flag.name,
                e.target.value === "" ? "" : Number(e.target.value)
              )
            }
          />
        );
      case "password":
        return (
          <input
            id={id}
            type="password"
            value={String(value ?? "")}
            placeholder="••••••••"
            onChange={(e) => onChange(flag.name, e.target.value)}
          />
        );
      case "path_file":
        return (
          <div className="path-row">
            <input
              id={id}
              type="text"
              className="path-input"
              value={String(value ?? "")}
              placeholder="path to file"
              onChange={(e) => onChange(flag.name, e.target.value)}
            />
            <button className="btn-small" onClick={pickFile}>
              Browse…
            </button>
          </div>
        );
      case "path_dir":
        return (
          <div className="path-row">
            <input
              id={id}
              type="text"
              className="path-input"
              value={String(value ?? "")}
              placeholder="path to directory"
              onChange={(e) => onChange(flag.name, e.target.value)}
            />
            <button className="btn-small" onClick={pickDir}>
              Browse…
            </button>
          </div>
        );
      case "string":
      default:
        if (flag.multiline) {
          return (
            <textarea
              id={id}
              rows={4}
              value={String(value ?? "")}
              onChange={(e) => onChange(flag.name, e.target.value)}
            />
          );
        }
        return (
          <input
            id={id}
            type="text"
            value={String(value ?? "")}
            onChange={(e) => onChange(flag.name, e.target.value)}
          />
        );
    }
  };

  return (
    <div className={`flag-row ${flag.type === "bool" ? "flag-bool" : ""}`}>
      <div className="flag-head">
        <code className="flag-name">{flag.name}</code>
        {flag.short && <span className="flag-short">{flag.short}</span>}
        {flag.help && <InfoTip text={flag.help} />}
      </div>
      <div className="flag-control">{render()}</div>
    </div>
  );
}
