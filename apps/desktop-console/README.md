# 酷太服务器控制台（桌面 UI）

这是自动回复系统的 Windows 桌面控制台源码，包含 Electron 外壳、状态面板和本地控制接口。它与仓库根目录的机器人服务配套运行。

## 本地预览

在本目录安装依赖并启动：

```powershell
pnpm install
pnpm preview
```

然后打开 `http://127.0.0.1:43118`。

运行桌面窗口：

```powershell
pnpm electron
```

## 目录与数据边界

推荐把本仓库与 `产品知识库`、`图片库` 放在同一个父目录。控制台会自动定位同级的机器人仓库和知识库。

如本机目录不同，在本目录新建不提交的 `workspace-root.txt`，第一行填写工作目录的绝对路径；也可以设置环境变量 `KUTAI_WORKSPACE_ROOT`。本文件、运行日志、`node_modules` 与打包出的 `dist` 均不会上传 GitHub。

## 打包

```powershell
pnpm dist
```

打包产物仅保留在本机 `dist/`，不会提交到源码仓库。
