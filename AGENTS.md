# 给未来 agent 的 runbook（读这个，别读整个仓库）

这个仓库是一个 OneBot 11 桥，driver=douyin 走 douyin-im 协议客户端。日常操作全部走 `node scripts/ctl.mjs`，**不要**为了看一眼状态去读 src/。

```bash
node scripts/ctl.mjs status     # 一行：state/self/nick
node scripts/ctl.mjs start      # 后台起，写 data/bridge.pid 与 data/bridge.log
node scripts/ctl.mjs stop
node scripts/ctl.mjs qr         # 需要扫码时：URL + 文件路径
node scripts/ctl.mjs sms 123456
node scripts/ctl.mjs friends    # user_id + 昵称，一行一个
node scripts/ctl.mjs send <user_id> <text>
node scripts/ctl.mjs watch      # 起一个 WS 监听，事件写 data/events.log
node scripts/ctl.mjs events 10  # 紧凑回放最近 10 条事件
node scripts/ctl.mjs doctor     # 只输出 PASS/FAIL 行
node scripts/autostart.mjs status|install|uninstall|run   # 开机自启动（Windows 计划任务 onlogon，隐藏窗口启动）
```

规矩：

- 命令输出已经压过，**别再加 tail/cat 去补全输出**；要更多细节才读 data/bridge.log，且只读尾部。
- 改完代码跑 `node --test --test-isolation=none "test/*.test.js"`，只关心最后的 tests/pass/fail 三行。
- 不读 node_modules；不整文件打印 README。
- 会话凭据在 data/（已 gitignore），任何情况下不要外发。
- 这个包同时是 DSH 插件（src/dsh-plugin.js + cordis.patch.yml）。验证安装：`node 
  "C:/Users/17445/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" pack` 出 tgz，
  再 `dsh plugin --profile <tmp> add <tgz>` + `dsh --profile <tmp> --dump-config | grep onebot`，完事删掉 tmp profile。
  注意：装 profile、dump-config、删 profile 都要 ~/.dsh 写权限，沙箱里得 escalation。