# 更新日志

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
