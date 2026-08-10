import ReactDOM from "react-dom/client";
import logo from "./assets/logo.png";
import "./splash.css";

ReactDOM.createRoot(document.getElementById("splash-root") as HTMLElement).render(
  <Splash />
);

function Splash() {
  return (
    <div className="splash">
      <div className="splash-card">
        <img src={logo} alt="LlamaStudio" className="splash-logo" />
        <div className="splash-title">LlamaStudio</div>
        <div className="splash-sub">native GUI for llama.cpp</div>
        <div className="splash-spinner" />
      </div>
    </div>
  );
}
