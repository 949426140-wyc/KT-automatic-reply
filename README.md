# KT automatic reply

酷太钉钉群产品问题自动回复服务。它通过钉钉 Stream 接收消息，先完成员工、订单/物流/售后等业务过滤和上下文判定，再以结构化产品知识与 LLM Wiki 生成或审核产品回复。

## 仓库边界

此仓库只保存源码、测试、部署配置和运行文档。下列数据位于仓库同级目录，且不会提交至 GitHub：

- `../产品知识库`：Obsidian 产品事实、结构化产品卡、客服规则、LLM Wiki。
- `../图片库`：产品原图与图片索引。
- `.env`、`data/`、`runtime/`、日志和审计结果：本机机密或运行状态。

更详细的路径说明见 [目录说明.md](目录说明.md)。

## 本地运行

1. 复制 `.env.example` 为 `.env`，填入钉钉和模型配置。
2. 保持本仓库与 `产品知识库`、`图片库` 位于同一父目录。
3. 运行：

```powershell
docker compose up -d --build
docker compose ps
```

## 桌面控制台 UI

桌面控制台源码位于 [`apps/desktop-console`](apps/desktop-console/README.md)。它用于查看机器人、LLM Wiki 索引和待审核队列，并在本机执行启动、停止和自测操作；打包后的 Windows 可执行文件不提交到 GitHub。

## 验证

基础测试：

```powershell
npm test
```

容器内规则回归：

```powershell
docker compose exec -T kutai-dingtalk-bot node tools/test-llm-wiki-safeguards.js
docker compose exec -T kutai-dingtalk-bot node tools/test-drawer-customization-replies.js
```

产品事实、尺寸公式、安装边界必须维护在 `../产品知识库`；本地程序只维护消息过滤、队列、平台连接、上下文和回复质量控制。
