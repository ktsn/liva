import { createApp } from "vue";
import EditorPanel from "./EditorPanel.vue";
import styles from "./editor.css?inline";
import type { EditorController } from "./controller.ts";

export function mountEditor(controller: EditorController) {
  const host = document.createElement("div");
  host.dataset.livaEditor = "";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = styles;
  const container = document.createElement("div");
  shadow.append(style, container);
  document.body.append(host);

  const app = createApp(EditorPanel, { controller });
  app.mount(container);

  import.meta.hot?.dispose(() => {
    app.unmount();
    host.remove();
  });
}
