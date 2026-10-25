import { createApp, h } from "vue";
import plugin from "virtual:liva-plugin";
import EditorToggle from "./EditorToggle.vue";

createApp({
  render: () =>
    h("div", [h(EditorToggle, { label: "First" }), h(EditorToggle, { label: "Second" })]),
})
  .use(plugin)
  .mount("#app");
