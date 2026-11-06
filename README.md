# Antumi Plugins

Antumi 官方插件仓库。按插件身份组织目录，统一开发工具和构建流程，每个插件独立版本、独立 ZIP、独立发布。当前四个插件提供任务来源能力；仓库名称和目录不限定能力类型，未来可加入其他能力的插件。当前 SDK 仍只支持任务来源，不声明尚未实现的扩展点。

| 插件 | 包名 | 插件 ID | 来源 ID | Release 标签 |
| --- | --- | --- | --- | --- |
| [GitHub](plugins/github/README.md) | antumi-plugin-github | antumi.github | github | github-vX.Y.Z |
| [Jira](plugins/jira/README.md) | antumi-plugin-jira | antumi.jira | jira | jira-vX.Y.Z |
| [Linear](plugins/linear/README.md) | antumi-plugin-linear | antumi.linear | linear | linear-vX.Y.Z |
| [禅道](plugins/zentao/README.md) | antumi-plugin-zentao | antumi.zentao | zentao | zentao-vX.Y.Z |

## 开发

需要 Node >=22.13，CI 使用 Node 24。在仓库根目录执行：

```sh
npm ci
npm run check
# 单独验证或构建一个插件
npm run check --workspace antumi-plugin-github
npm run build --workspace antumi-plugin-github
```

`npm run check` 执行所有插件的类型检查、模拟 API 测试、发布脚本测试和构建。每个插件生成 `plugins/<slug>/dist/plugin/` 和 `plugins/<slug>/dist/antumi-plugin-<slug>-<version>.zip`。ZIP 包含 SDK 和所有运行依赖，用户安装时无需安装 Node 或 npm。

依赖由根目录 package-lock.json 锁定。SDK 包集中在 vendor/；Jira 沿用 0.1.1，其他插件沿用 0.1.0，合仓不改变现有运行依赖。构建使用固定 ZIP 时间戳。

## 安装与更新

新版 Antumi 的「设置 → 插件」推荐列表按插件前缀选择本仓库中版本最高的正式 Release，不会将其他插件的 Release 当作更新。

本地安装可选择某个插件的 dist/plugin 目录或 ZIP。旧版 Antumi 手动安装时填写仓库 `flyhero/antumi-plugins`，指定标签（例如 github-v1.0.1）和该插件的 ZIP 附件；旧版检查更新不支持按前缀筛选，应继续手动指定标签安装。

插件 ID、来源 ID、现有版本、配置与凭据格式保持不变。宿主负责旧仓库更新来源迁移；合仓本身不会修改用户数据。

## 独立发布

1. 只更新目标插件的 package.json、manifest.json 版本及 CHANGELOG.md。
2. 执行 `npm run check`，提交变更。
3. 推送与插件版本匹配的标签，例如 `github-v1.0.2`。

Release 工作流先执行完整检查，再验证标签与目标插件版本一致，只上传目标插件的 ZIP 和该插件的更新日志；带预发布后缀的版本标为 prerelease，不作为正式更新。已有 Release 不覆盖。普通提交与 PR 只验证和上传 CI 产物。合仓不会自动创建 Release。

新增插件放在 plugins/<slug>，使用相同脚本，无需增加类型目录。一个插件可在未来 SDK 支持时声明多种贡献能力。

## 导入历史

四个原仓库通过 git subtree 导入，保留完整提交历史；旧仓库未删除或改写。导入起点：

- GitHub：b3fe5bf0a748ebdaa354846f4303367437359e65
- Jira：75e8d7fd1c88073cb434bec1a4db042a0d28b04d
- Linear：bde1343329f438c21d1ce2a6d4095a0aac9eb80b
- 禅道：8fedb532e6bcb951e04d25c3d5fb2045192b9028

许可证：Apache-2.0。

## New comment synchronization

The four official sources use SDK 0.1.3 and declare `commentSync: 1`. Antumi can watch imported tasks and investigation conversations, poll new comments every 15 minutes, and let the user send the new comments to the existing conversation. No Agent runs just because a comment arrives. GitHub supports ordinary Issue/PR discussion comments, not inline review comments. ZenTao requires native action IDs or an action map with stable keys; installations without them keep Markdown snapshots but cannot reliably report new comments.

The initial snapshot keeps the latest twenty comments while its checkpoint covers all identities at the newest timestamp. Incremental requests paginate beyond twenty, include the time boundary, and preserve comment IDs. Credentials and stderr handling follow the existing plugin contract.
