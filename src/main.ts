import { createApp } from "vue";
import App from "./App.vue";
import { checkForUpdates } from "./updater";

createApp(App).mount("#app");

// 启动时静默检查更新，不阻塞 UI；失败自动忽略
void checkForUpdates();
