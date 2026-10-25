import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";
import liva from "@liva/vite";

export default defineConfig({ plugins: [liva(), vue()] });
