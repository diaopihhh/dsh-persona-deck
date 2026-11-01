# dsh-persona-deck（人设卡组）

主要负责生成角色人设提示词。在会话里说一句「生成亚丝娜的人设」就行。

- **一键导入角色**：输入想获取的角色名后，会按 14 段结构写卡——人设定位、印象、外表、气质、说话方式、说话习惯、聊天方式、脾气与偏好、和你相处、背景与来历、会和你说起的事、人际关系、称呼、边界。语气、习惯、雷区分开写，生成的提示词更贴角色。
- **人设更新**：可联网查角色最新资讯，用于后续人设的更新。
- **soul-md 同步**：导入后自动同步进 soul-md 的人设设置，切卡就能用。
- **speak-up 同步**：不同角色的活跃度还会影响 speak-up 的搭话频率：话痨型更勤，寡言型不压。

## 依赖

- **必需**：无。
- **可选**：`dsh-soul-md`（装了才有聊天框「人设」下拉，卡会同步进它的 cards）、`dsh-speak-up`（装了才有活跃度联动）。

## 安装

```bash
dsh plugin --profile desktop add dsh-persona-deck
```

装完重启一次宿主。之后插件列表里能看到它，工具列表里多出 `persona_*`。

## 用法

直接说：

> 导入《代号鸢》里的荀彧

或者：

> 帮我做个《一拳超人》的埼玉，先给我看看

agent 会搜资料、按 14 段写卡、贴出来等你确认。确认后卡会落库；装了 soul-md 的话，聊天框「人设」下拉里立刻就能选。

也可以直接用工具：

| 工具 | 作用 |
| --- | --- |
| `persona_import` | 导入一张卡（name / content 必填，role、source、variant、traits 可选） |
| `persona_meta` | 补或改某张卡的元数据 |
| `persona_list` | 列出所有卡、角色、出处、版本，并说明当前写到了哪个容器 |
| `persona_search` | 按卡名、角色、出处、版本、标签搜 |
| `persona_show` | 取出某张卡的全文（没容器时用它贴出来复制） |
| `persona_check` | 自检：探测到的人设容器、本地卡库位置、卡数量 |
| `persona_delete` | 删卡（本地和容器里都删，连同元数据） |

## 卡长什么样

每张卡是一段 Markdown，14 个 `##` 小节。规范本身在 `index.js` 的 `GUIDE` 常量里，想改直接改那段文字，重启生效。

## 数据放在哪

- 卡正文：本机卡库 `~/.dsh/persona-deck/cards/<卡名>.md`；探测到人设容器时同步一份进它的 settings。
- 元数据：`~/.dsh/persona-deck/meta.json`。
- speak-up 联动的基准值：`~/.dsh/persona-deck/speakup-base.json`（第一次运行时记下原始的峰/谷命中线，之后按倍率算）。

## 限制

- 只做 host 半边，没有界面。卡的切换走 soul-md 自带的「人设」下拉。
- 活跃度联动会改写 `~/.dsh/speak-up-config.json` 里「峰时命中线」「谷时命中线」两项。如果你习惯手动调这两项，别和它抢。
- 探测靠数据形状（`cards` / `active` / `sessions`）。如果哪天人设容器把结构整个换了，`persona_check` 会报「没探测到」，这时卡仍在本地，`persona_show` 能取出来。

## License

MIT
