# 更新日志

## 1.4.2

- 将数据校验依赖 Zod 升级至 4.6.7，减少校验超出数量上限的数据时的内存占用。

## 1.4.1

- 随 Antumi 0.22.1 正式版重新打包，来源功能保持不变。

## 1.4.0

- 按规则回写只写分配给你的 Issue，有多位处理人时只发评论；Pull Request 默认不回写。要配合更新后的 Antumi 才生效。
- 「提交验收」不再提供关闭 Issue 的选项：在 Pull Request 里写 Fixes #n，合并时由 GitHub 关闭。

## 1.3.0

- 用上 GitHub Issue 状态（预览）的仓库，回写可以把 Issue 改为 In progress、In review、Done 等状态。
- 「设置 → 集成 → GitHub → 回写」改为从下拉框选状态：In progress、In review、完成。
- 要配合更新后的 Antumi 才按平台显示；旧版 Antumi 照旧是三个文本框，规则照常生效。

## 1.2.1

- Antumi 里不再看不到 GitHub 的回写设置和任务详情里的回写区块（1.2.0 的安装包漏了回写声明）。

## 1.2.0

- 支持回写：在 Antumi 里关闭或重新打开 Issue / Pull Request、发评论（需要有写权限的 Token）。
- 导入或排查 GitHub Issues / Pull Requests 时，可下载正文和最近评论里的图片；新增评论的图片也可交给 Agent 查看。
- 图片慢时先读取文字、下载后补发；图片无法下载时保留原文并说明结果。

## 1.0.1

- 插件独立到自己的仓库，使用 Antumi Plugin SDK，原有登录、筛选和导入记录继续保留。

## 1.0.0

- 支持 GitHub Issues 和 Pull Requests 的收件箱同步、任务导入和原文快照。
