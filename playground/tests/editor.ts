import { createApp, h } from "vue";
import plugin from "@liva/vue";
import EditorToggle from "./EditorToggle.vue";

createApp({
  render: () =>
    h("div", [h(EditorToggle, { label: "First" }), h(EditorToggle, { label: "Second" })]),
})
  .use(plugin)
  .mount("#app");
