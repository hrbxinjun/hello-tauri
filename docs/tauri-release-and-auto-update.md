# Tauri 应用通过 GitHub Actions 发布并配置自动更新指南

本文以 `hello-tauri`（Tauri 2 + Vue 3 + Vite + pnpm）为例，总结如何：

1. 推送 tag 自动构建多平台安装包并发布 GitHub Release
2. 让已安装的用户启动应用时自动检查、下载、安装更新

## 一、整体原理

```
┌─────────┐  push tag v0.2.0   ┌──────────────┐  构建+签名  ┌─────────────────┐
│ 开发者   │ ─────────────────▶ │ GitHub Actions│ ──────────▶ │ GitHub Release   │
└─────────┘                    └──────────────┘             │ 安装包 + .sig     │
                                                           │ + latest.json    │
                                                           └────────┬────────┘
                                                                    │ 下载
                              ┌──────────────┐   比较版本号          ▼
                              │ 用户的应用    │ ◀──────────  https://github.com/
                              │ (内置公钥)    │   有新版→提示    <owner>/<repo>/
                              └──────────────┘                releases/latest/download/latest.json
```

核心机制：

- **签名**：构建时用 minisign 私钥对更新包签名，生成 `.sig` 文件
- **清单**：`tauri-action` 自动汇总各平台产物信息，生成 `latest.json` 上传到 Release
- **校验**：客户端内置公钥，下载更新包后验签，防止更新被篡改
- **比较**：`latest.json` 中的 `version` 严格大于当前版本（semver）时才提示更新

## 二、生成签名密钥对

> ⚠️ **私钥丢失 = 已发布的应用永远无法自动更新**，务必妥善备份！

```bash
pnpm tauri signer generate -w ~/.tauri/hello-tauri.key
# 会提示设置密码（建议设非空密码，原因见下文 GitHub Secrets 一节）
```

产出两个文件：

| 文件 | 用途 |
|---|---|
| `~/.tauri/hello-tauri.key` | 私钥，**绝不提交仓库**，配置到 GitHub Secrets |
| `~/.tauri/hello-tauri.key.pub` | 公钥，写入 `tauri.conf.json` |

注意事项：

- 命令中的 `~` 在 **cmd.exe 不会展开**（会生成到项目下的 `~\` 目录），请在 Git Bash / PowerShell 中执行
- 重新生成密钥 = 全新密钥对，`tauri.conf.json` 里的公钥必须同步更新

## 三、配置 GitHub Secrets

仓库页面 → Settings → Secrets and variables → Actions → New repository secret：

| Name | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `.key` 私钥文件的完整内容（一串 base64） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |

> 💡 GitHub **不允许保存空值**的 secret，所以密钥必须设置非空密码。

## 四、修改应用配置

### 4.1 `src-tauri/tauri.conf.json`

```jsonc
{
  "version": "0.2.0",                    // ⭐ 更新比较依据的权威版本号
  "bundle": {
    "active": true,
    "targets": "all",
    "createUpdaterArtifacts": true,      // ⭐ 构建时生成 .sig 签名文件
    "icon": [/* ... */]
  },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVk...（.key.pub 的完整内容）",
      "endpoints": [
        "https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }  // NSIS 静默安装，只显示小进度条
    }
  }
}
```

### 4.2 Rust 侧

`src-tauri/Cargo.toml`：

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

`src-tauri/src/lib.rs` 注册插件：

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // ...
```

`src-tauri/capabilities/default.json` 加权限：

```json
"permissions": ["core:default", "opener:default", "updater:default", "process:default"]
```

### 4.3 前端

```bash
pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

`src/updater.ts`（核心逻辑，要点）：

```typescript
import { ref } from "vue";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export const updateState = ref({ phase: "idle", version: null, progress: null });

/** 启动时调用，不阻塞 UI；离线等异常一律静默 */
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();          // 无新版返回 null
    if (!update) return;
    updateState.value = { phase: "available", version: update.version, progress: null };
  } catch { /* 静默：断网也不影响应用使用 */ }
}

/** 下载（带进度）→ 安装 → 重启 */
export async function downloadAndInstallUpdate(): Promise<void> {
  const update = await check();
  if (!update) return;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":  /* event.data.contentLength */ break;
      case "Progress": /* event.data.chunkLength，累加算百分比 */ break;
      case "Finished": break;
    }
  });
  await relaunch();  // ⭐ Windows NSIS 会接管进程，relaunch 必须是最后一步
}
```

`src/main.ts` 启动时触发：

```typescript
createApp(App).mount("#app");
void checkForUpdates();   // 非阻塞，失败自动忽略
```

`App.vue` 中根据 `updateState` 渲染横幅：发现新版（按钮）→ 下载进度条 → 重启中。

## 五、发布工作流 `.github/workflows/release.yml`

关键配置：

```yaml
name: Release

on:
  push:
    tags: ['v*']          # 推送 v 开头的 tag 时触发
  workflow_dispatch:      # 支持手动触发

permissions:
  contents: write         # 允许创建 Release 并上传产物

jobs:
  publish:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: 'macos-latest'
            args: '--target aarch64-apple-darwin'
          - platform: 'macos-latest'
            args: '--target x86_64-apple-darwin'
          - platform: 'ubuntu-22.04'
            args: ''
          - platform: 'windows-latest'
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12 }        # ⭐ 与本地 pnpm 版本一致
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: 'pnpm' }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}
      - uses: swatinem/rust-cache@v2
        with: { workspaces: './src-tauri -> target' }
      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: pnpm install
      - name: Build and release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}           # ⭐ 签名
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_type == 'tag' && github.ref_name || format('v-test-{0}', github.run_number) }}
          releaseName: 'hello-tauri v__VERSION__'
          releaseDraft: false
          prerelease: false
          updaterJsonPreferNsis: true   # ⭐ Windows 同产出 .exe/.msi，让 latest.json 指向 NSIS exe
          args: ${{ matrix.args }}
```

`latest.json` 由 `tauri-action` 自动生成并上传，无需手动维护。

## 六、发版流程（每次更新）

```bash
# 1. 升级版本号（⭐ tauri.conf.json 是权威来源），同步 package.json、Cargo.toml
#    src-tauri/tauri.conf.json → "version": "0.3.0"

# 2. 提交并打 tag
git add -A && git commit -m "chore: bump version to 0.3.0"
git tag v0.3.0
git push origin main --tags
```

CI 自动构建、签名、发布 Release。已安装旧版的用户下次启动应用即收到更新提示。

## 七、踩坑记录

| 问题 | 原因 | 解决 |
|---|---|---|
| GitHub secret 保存空值报错 | GitHub 不允许空 secret | 密钥设置非空密码 |
| CI 报 `packages field missing or empty` | workflow 装 pnpm 9，本地 pnpm 12 在 `pnpm-workspace.yaml` 存配置，旧版要求 `packages` 字段 | workflow 与本地 pnpm 版本保持一致 |
| 密钥生成到项目下 `~\` 目录 | cmd.exe 不展开 `~` | 用 Git Bash 执行，或用绝对路径 |
| main 分支的 workflow 看起来没更新 | tag 触发的构建读取的是 **tag 指向的 commit**，不是 main 最新 | tag 和 main 保持同步 |

## 八、验证与测试

1. **本地冒烟**：设置环境变量后 `pnpm tauri build`，确认 `target/release/bundle/nsis/*.exe.sig` 生成
2. **CI 产物**：Release 页面有各平台安装包 + `.sig` + `latest.json`
3. **端点可用**：`curl -L https://github.com/<owner>/<repo>/releases/latest/download/latest.json` 返回 JSON
4. **端到端**：安装 v0.2.0 → 发布 v0.3.0 → 启动旧版应用 → 出现更新横幅（UI 不阻塞）→ 下载进度 → 自动重启为新版本
5. **静默失败**：断网启动应用，无报错弹窗，正常使用

## 九、限制与注意

- **老版本无法自动更新**：不含 updater 代码的构建（本次改造前的 v0.1.0）需手动安装一次新版，之后才能自动更新
- prerelease / draft Release 不会通过 `releases/latest/download/latest.json` 下发给正式用户
- 更新必须**严格升版本号**，同版本或降版本不会触发更新
