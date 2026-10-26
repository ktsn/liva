import { createLivaPlugin } from "@liva/vue/runtime";
import type { Edit, EditorReply } from "./protocol.ts";
import { EditorController } from "./controller.ts";
import { mountEditor } from "./ui.ts";

export function createDevPlugin(token: string) {
  const controller = new EditorController(async (request) => {
    const response = await fetch("/__liva/editor", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Liva-Session": token },
      body: JSON.stringify(request),
    });
    const result = (await response.json()) as EditorReply & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Editor failed: ${response.status}`);
    return result;
  });
  mountEditor(controller);
  Object.assign(window, { __LIVA_EDITOR__: controller });
  import.meta.hot?.on("liva:source-changed", ({ sourceId }: { sourceId: string }) =>
    controller.sourceChanged(sourceId),
  );
  import.meta.hot?.on("liva:diagnostics", (diagnostics: { message: string }[]) =>
    controller.report(diagnostics.map((d) => d.message).join("\n")),
  );
  return createLivaPlugin({
    observe: (event, binding) => controller.observe(event, binding),
    onDiagnostic: (diagnostic) => controller.report(diagnostic.message),
  });
}

export type { Edit };
