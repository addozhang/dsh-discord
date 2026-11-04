# Discord 适配器 · 把 Discord 变成 DeepSeek Harness 的驾驶舱

在频道里 @bot 直接开聊：回复流式渲染成消息线程，工具调用实时可见；宿主的审批与提问以 Discord 按钮出现，点一下就继续干活；`/permission`、`/model` 等斜杠命令随时收紧或放宽控制——不用切回浏览器。

[![GitHub stars](https://img.shields.io/github/stars/addozhang/dsh-discord?style=social)](https://github.com/addozhang/dsh-discord)

**好用的话，欢迎去 [GitHub 仓库](https://github.com/addozhang/dsh-discord) 点个 ⭐ Star**——这直接决定这个插件的迭代速度。

## 亮点

- **@mention 即会话** — 频道或线程里 mention bot 立刻起 turn；流式渲染、工具行、成文归档，宿主重启零重放
- **审批 / 提问按钮流** — 宿主审批卡同步进 Discord，按钮裁决；Web 与 Discord 两端先答先得
- **9 个斜杠命令** — `/project bind`、`/permission set`、`/model select`、`/stop`、`/steer`、`/queue remove`、`/session resume`、`/guild forget`、`/info`
- **deny-first 三级授权** — guild 白名单是外层边界，member < workspace-admin < host-operator 逐级收紧
- **Web 设置卡片** — Settings → Discord：token、guild 白名单、Bot 语言、自动归档，一处配齐

## 快速开始

1. 安装：`dsh plugin --profile <profile> add @addozhang/dsh-discord`
2. Web GUI → Settings → Discord，粘贴 bot token 并保存
3. Discord 里 `/project bind` 绑定频道，然后 @bot 开聊

## 兼容性

dsh ≥ 0.2.1（适配器 0.6.x 线）。宿主与适配器的版本配对表见仓库 README。

## 链接

- 源码与文档：<https://github.com/addozhang/dsh-discord>
- 问题反馈：<https://github.com/addozhang/dsh-discord/issues>
- npm 包：<https://www.npmjs.com/package/@addozhang/dsh-discord>

---

喜欢这个插件？[点个 Star](https://github.com/addozhang/dsh-discord/stargazers) 让我知道它帮到了你 🙌
