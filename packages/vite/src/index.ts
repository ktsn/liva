import { fileURLToPath } from "node:url";
import { EditorService } from "./editor/communication/server.ts";
import { readFile } from "node:fs/promises";
import type { Plugin, ViteDevServer } from "vite-plus";
import {
  compileSfc,
  diagnosticLocation,
  hasErrors,
  hasLivaBlock,
  type SourceSnapshot,
} from "./compiler.ts";

export default function liva(): Plugin {
  let server: ViteDevServer | undefined;
  let editor: EditorService | undefined;
  const valid = new Map<string, SourceSnapshot>();

  const compileFile = async (file: string) => {
    const source = await readFile(file, "utf8");
    const previous = valid.get(file);
    if (previous?.source === source) return previous;
    const snapshot = compileSfc(source, file, !!server);
    if (!hasErrors(snapshot)) valid.set(file, snapshot);
    return snapshot;
  };

  return {
    name: "liva",
    enforce: "pre",
    config() {
      return { optimizeDeps: { exclude: ["@liva/vue"] } };
    },
    configureServer(devServer) {
      server = devServer;
      editor = new EditorService(devServer.config.root);
      editor.install(devServer);
    },
    resolveId(id) {
      if (id === "@liva/vue") return "\0liva:vue-plugin";
    },
    load(id) {
      if (id === "\0liva:vue-plugin" && editor) {
        const client = "/@fs/" + fileURLToPath(new URL("./editor/client.ts", import.meta.url));
        return `export * from "@liva/vue/runtime"; import { createDevPlugin } from ${JSON.stringify(client)}; export default createDevPlugin(${JSON.stringify(editor.token)});`;
      }
      if (id === "\0liva:vue-plugin")
        return `export * from "@liva/vue/runtime"; import { createLivaPlugin } from '@liva/vue/runtime'; export default createLivaPlugin();`;
    },
    async transform(_code, id) {
      const [file, query = ""] = id.split("?", 2);
      const parameters = new URLSearchParams(query);
      if (!file.endsWith(".vue")) return;

      if (!query) {
        // Validate the descriptor even when a second custom block would otherwise
        // be compiled independently by Vue.
        if (hasLivaBlock(_code, file)) {
          const snapshot = await compileFile(file);
          if (hasErrors(snapshot) && !server) {
            const diagnostic = snapshot.result.diagnostics.find((d) => d.severity === "error")!;
            this.error({
              message: diagnostic.message,
              id: file,
              loc: diagnosticLocation(snapshot, diagnostic),
            });
          }
        }
        return;
      }

      if (!parameters.has("vue") || parameters.get("type") !== "liva") return;
      let snapshot = await compileFile(file);

      if (hasErrors(snapshot)) {
        const diagnostic = snapshot.result.diagnostics.find((d) => d.severity === "error")!;
        const previous = valid.get(file);
        if (!server || !previous)
          this.error({
            message: diagnostic.message,
            id: file,
            loc: diagnosticLocation(snapshot, diagnostic),
          });
        this.warn({
          message: diagnostic.message,
          id: file,
          loc: diagnosticLocation(snapshot, diagnostic),
        });
        snapshot = previous;
      }

      const bundle = JSON.stringify({ schemaVersion: 1, definitions: snapshot.result.definitions })
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
      const association = editor
        ? `component.livaSource = ${JSON.stringify(await editor.register(file))};`
        : "";
      return {
        code: `import { decodeBundle } from '@liva/runtime'; const bundle = decodeBundle(${JSON.stringify(bundle)}); export default (component) => { component.livaDefinitions = bundle.definitions; ${association} };`,
        map: null,
      };
    },
    async handleHotUpdate(context) {
      if (!context.file.endsWith(".vue")) return;
      const source = await context.read();
      if (!hasLivaBlock(source, context.file)) return;

      try {
        if (editor)
          server?.ws.send({
            type: "custom",
            event: "liva:source-changed",
            data: { sourceId: await editor.register(context.file) },
          });
        const snapshot = compileSfc(source, context.file, true);
        if (hasErrors(snapshot)) {
          server?.ws.send({
            type: "custom",
            event: "liva:diagnostics",
            data: snapshot.result.diagnostics,
          });
          return [];
        }
        valid.set(context.file, snapshot);
      } catch (error) {
        server?.ws.send({
          type: "custom",
          event: "liva:diagnostics",
          data: [{ message: String(error) }],
        });
        return [];
      }
    },
  };
}
