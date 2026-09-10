import { ref } from "vue";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdatePhase = "idle" | "available" | "downloading" | "restarting";

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  progress: number | null; // 0..100，下载中才有值
}

const state = ref<UpdateState>({
  phase: "idle",
  version: null,
  notes: null,
  progress: null,
});

/** 启动时调用，不阻塞 UI；离线等异常一律静默忽略 */
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    state.value = {
      phase: "available",
      version: update.version,
      notes: update.body ?? null,
      progress: null,
    };
  } catch {
    // 静默处理：断网、端点不可达等情况下应用照常使用
  }
}

/** 用户点击"立即更新"后调用：下载（带进度）→ 安装 → 重启 */
export async function downloadAndInstallUpdate(): Promise<void> {
  let update: Update | null = null;
  try {
    update = await check();
  } catch {
    update = null;
  }
  if (!update) {
    state.value = { phase: "idle", version: null, notes: null, progress: null };
    return;
  }

  state.value = { phase: "downloading", version: update.version, notes: null, progress: 0 };

  let downloaded = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (total > 0) {
            state.value.progress = Math.round((downloaded / total) * 100);
          }
          break;
        case "Finished":
          state.value.progress = 100;
          break;
      }
    });
    // Windows NSIS passive 模式下，install 结束时旧进程被安装器接管，
    // relaunch 必须是最后一步
    state.value.phase = "restarting";
    await relaunch();
  } catch (e) {
    console.error("Update install failed", e);
    state.value = {
      phase: "available",
      version: state.value.version,
      notes: null,
      progress: null,
    };
  }
}

export { state as updateState };
