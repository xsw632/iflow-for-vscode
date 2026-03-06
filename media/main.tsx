// Preact webview entry point for IFlow panel.

import { render } from "preact";
import type { ExtensionMessage } from "../src/protocol";
import { handleExtensionMessage } from "./store/actions";
import { postMessage } from "./hooks/usePostMessage";
import { App } from "./components/App";

function bootstrap() {
  const root = document.getElementById("app");
  if (!root) return;

  const faviconUri = root.getAttribute("data-favicon-uri") || "";

  // Mount Preact tree
  render(<App faviconUri={faviconUri} />, root);

  // Listen for extension messages → dispatch to signal store
  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as ExtensionMessage;
    if (!message || typeof message.type !== "string") return;
    handleExtensionMessage(message);
  });

  // Notify extension that webview is ready
  postMessage({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
