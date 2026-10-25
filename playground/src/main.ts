import { createApp } from "vue";
import liva from "virtual:liva-plugin";
import App from "./App.vue";
import "./style.css";

createApp(App).use(liva).mount("#app");
