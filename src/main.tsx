import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "highlight.js/styles/github-dark.css";

// Error boundary: shows a readable message instead of a black window
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("LlamaStudio crashed:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "#e6e9ef", background: "#0f1117", height: "100vh", fontFamily: "system-ui" }}>
          <h2 style={{ color: "#ff5470" }}>LlamaStudio failed to start</h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#9aa3b2" }}>{String(this.state.error?.stack || this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
