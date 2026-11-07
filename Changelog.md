## Speedtest edition

- 新增并发测速：默认同时测试 5 个节点，完成后立即补位，支持调整并发数及统一停止。
- 修复默认下载源返回短文本导致测速失败，支持选择下载源并用于批量和单节点测速。
- 修复下载测速将服务器返回的短网页误算为 0.01 MiB/s 的问题。
- 修复批量测速误判：区分服务器限流与连接失败，连接等待不再占用下载时长。
- 优化测速进度：开始时清空所选节点的旧结果，并显示当前测试阶段。
- 新增节点测速：筛选多选、独立延迟与下载测试、按结果升降序排列。
- 修复测速弹窗内的操作会意外展开或收起代理分组的问题。
- 新增测速记录保存与节点切换，节点卡片支持查看速度和单节点下载测速。

## v2.5.7
## v2.5.8
<!-- Release-notes skeleton. Entries accumulate in ./Changelog.md as PRs land;
     before publishing a release, distill them:
     - user-visible changes only — no dev tooling, CI fixes, or refactors whose
       effect is already covered by another entry
     - describe outcomes, not internals: no internal module names, IPC or
       protocol details, or implementation mechanics — write what the user
       observes, not how the code achieves it
     - one line per theme: merge entries that share a root cause
     - each entry fits a single readable line (about 60 CJK characters); if it
       overflows, it is packing multiple themes or detail that belongs in the
       linked issue/PR — split it or drop the detail
     - line grammar: open with a verb (修复/新增/优化), with the platform
       first (Windows/macOS/Linux) when the change is platform-specific;
       merge sub-symptoms as 主题：症状、症状; full-width punctuation,
       「」 for UI labels, backticks for config keys and commands
     - platform entries sit under their platform heading (bold, emoji
       prefixed, ordered Windows/macOS/Linux, combined for pairs like
       macOS/Linux) at the end of their section;
       scripts-workflow/group_platforms.sh regroups, --check verifies
     HTML comments are stripped by the update dialog's sanitizer and hidden on
     GitHub, so they never reach users. -->
## v2.5.10

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复全局模式缺少 `GLOBAL` 策略组，无法单独选择全局出口
- 修复服务模式下，SSH 节点的 `private-key` 使用私钥文件时内核无法启动
- 修复服务模式下，内核更新的 GEO 数据库不会同步回应用目录，导致使用新分类的规则无法通过校验
- 修复订阅的 DNS 配置变化后，「DNS 覆写」实际已关闭但开关仍显示开启且没有提示

**🖥️ Windows**

- Windows：修复安装程序重新安装或覆盖时未提示退出运行中应用，导致卸载报错或覆盖失败

</details>

<details>
<summary><strong> ✨ 新增功能 </strong></summary>


</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>


</details>
