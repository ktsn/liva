/// <reference types="vite-plus/client" />
declare module "virtual:liva-plugin" {
  import type { Plugin } from "vue";
  const plugin: Plugin;
  export default plugin;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
