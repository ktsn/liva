import { createApp } from "vue";
import { createLivaPlugin } from "@liva/vue";
import Hmr from "./Hmr.vue";
createApp(Hmr).use(createLivaPlugin()).mount("#app");
