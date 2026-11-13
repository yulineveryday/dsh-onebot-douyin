# onebot-douyin

NapCat 风格的 OneBot 11 桥，把 **抖音 / 多闪** 的个人号接进现成机器人框架（NoneBot2 / Koishi / AstrBot / 各类 OneBot 客户端）。

同时它也是一个 **DSH（DeepSeek Harness）插件**：装上之后，DSH 会话里直接多出 `onebot_status` / `onebot_login` / `onebot_send` / `onebot_friends` 四个工具，扫码登录、收发私聊都在对话里完成。

它本身不是机器人框架，只做协议转换：

- 对上层：一个标准 OneBot 11 服务（HTTP + 正向 WS + 反向 WS），和 NapCat 一样，框架只要填地址和 token 就能连。
- 对下层：一个可插拔的 Driver。真机接入走 `adapters/android/adapter.py`（uiautomator2 点界面），不在 JS 里猜抖音私有协议。

## 架构

```text
NoneBot2 / Koishi / AstrBot
        │  OneBot 11 (HTTP / 正向 WS / 反向 WS)
        ▼
  onebot-douyin  (Node, src/)
        │  Driver 接口: sendPrivate / listFriends / getMessage / on('message')
        ▼
  driver=douyin ──douyin-im（Node 协议客户端）──▶ 抖音 Desktop IM（扫码登录一次，之后复用会话）
  driver=http  ──HTTP──▶  adapters/android/adapter.py  ──uiautomator2──▶  抖音 / 多闪 App
  driver=mock  (离线自测，不碰手机)
```

分成两段的原因：中文输入必须走 uiautomator2 的输入法广播（`adb shell input text` 打不了中文），界面操作也天生是 Python 那边的活；Node 这边专心做 OneBot 协议、鉴权、心跳和重连。

## 安装 / 当插件用

四种用法，按需要挑一种：

**1. 装进 DSH（推荐）**

```bash
# 发布到 npm 之后
dsh plugin add dsh-onebot-douyin

# 或者直接用本地打包出来的 tarball
dsh plugin add ./dsh-onebot-douyin-0.3.0.tgz
```

装完重启 DSH（或在 插件 页面启用 / 重载），桥就会在 DSH 进程里自动起在 `127.0.0.1:5711`，第一次要扫码：

- 要二维码：工具 `onebot_login`，`action=qrcode` → 返回 PNG 路径 + `http://127.0.0.1:5711/qrcode`
- 抖音 App 扫码；若要求短信码，用 `action=sms` + `code=...`
- 之后 `onebot_status` 看状态，`onebot_friends` 看好友，`onebot_send` 发消息

登录态和会话数据放在 `$DSH_HOME/onebot-douyin/data`，重启不用重新扫码。

**2. 本地跑**

```bash
pnpm install && npm start
```

**3. 当全局命令**（会装出 `obd` 和 `onebot-douyin` 两个命令）

```bash
npm i -g dsh-onebot-douyin
obd start --config ./config.json
```

**4. 嵌进自己的 Node 程序（bridge 形式）**

```js
import { createBridge } from "dsh-onebot-douyin/bridge";

const bridge = createBridge({
  config: {
    onebot: { host: "127.0.0.1", port: 5711 },
    driver: { type: "douyin", douyin: { dataDir: "data" } },
  },
});

bridge.on("message", (msg) => {
  console.log(msg.nickname, msg.segments);
  bridge.driver.sendPrivate(msg.userId, [{ type: "text", data: { text: "在" } }]);
});

await bridge.start();
console.log(bridge.address, bridge.selfId, bridge.status());
await bridge.stop();
```

插件 API：`start()` / `stop()` / `status()` / `on()` / `off()`；属性 `selfId` `online` `address` `driver` `server` `config`。

**发布到 npm**

```bash
npm pack --dry-run                    # 先看会打包哪些文件
npm view dsh-onebot-douyin version    # 确认名字没被占
npm publish --access public           # 发布；之后 dsh plugin add dsh-onebot-douyin 就能装
```

发布到 npm 是进 DSH 插件社区的前置条件：社区索引（`dsh-plugin-catalog`）只收 npm 上已发布、且声明了 `dsh.bundle` manifest 的包。收录请提 PR 到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

**在 DSH 里能用哪些工具**

| 工具 | 作用 |
| --- | --- |
| `onebot_status` | 登录状态 / self_id / 昵称 / HTTP 地址 / 最后的错误 |
| `onebot_login` | `qrcode` 出二维码、`status` 查进度、`sms` 交短信码 |
| `onebot_send` | 发消息，`to` 是 OneBot 数字 id，`group=true` 发群 |
| `onebot_friends` | 好友列表（`groups=true` 连群一起列） |

插件配置项（`cordis.patch.yml` 或 DSH 的 插件 页面里改）：`enabled`、`autoStart`、`driver`（`douyin` | `mock`）、`host`、`port`（默认 5711）、`accessToken`、`dataDir`、`qrcodeFile`，留空即用默认值。

独立运行时的配置查找顺序：当前工作目录的 `config.local.json` → `config.json` → 包目录下的同名文件 → 内置默认值。

## 快速开始（不需要手机）

```bash
pnpm install        # ws + douyin-im 两个依赖
npm run doctor      # 自检
npm start           # mock 驱动，监听 127.0.0.1:5700
```

另开一个终端验证：

```bash
curl http://127.0.0.1:5700/get_login_info
curl -X POST http://127.0.0.1:5700/ -H 'content-type: application/json' \
  -d '{"action":"send_private_msg","params":{"user_id":10001,"message":"hi"},"echo":"e1"}'
```

框架侧按对待 NapCat 的填法：地址 `127.0.0.1:5700`，token 填配置文件里的 `access_token`（留空即不校验），反向 WS 填 `ws://127.0.0.1:5700/`。

## 接抖音（driver=douyin，推荐路线）

不用手机、不用模拟器：`douyin-im` 在 Node 里直连抖音 Desktop IM，属于 NapCat 同款「协议端」路线。你只需要在第一次登录时用手机扫码（或输一次短信码）。

```bash
pnpm add douyin-im                 # 项目已经装好，换机器时补这一步
cp config.example.json config.json # 把 driver.type 改成 "douyin"
npm start
```

启动后按提示登录，三种方式任选：

1. 二维码：日志里会打印 PNG 路径（默认 `data/login.png`），或者直接浏览器打开 `http://127.0.0.1:5700/qrcode` 看最新二维码。
2. 登录状态：`curl http://127.0.0.1:5700/login/status` 返回 `state`（`logging-in` / `waiting-qrcode` / `waiting-sms` / `waiting-verification` / `online` / `error`）。
3. 短信验证码（平台要求时）：

```bash
curl -X POST http://127.0.0.1:5700/login/sms -H 'content-type: application/json' -d '{"code":"123456"}'
```

平台要求滑块/扫码等安全验证时，日志会给出验证页 URL（`autoOpenVerification: false` 时不自动弹浏览器），在浏览器里完成即可，SDK 不绕过验证。

登录成功后会话落在 `data/` 目录，下次启动自动恢复，不需要再扫。**`data/` 等于账号密码，别提交、别外发。**

抖音的部分：

| 项目 | 说明 |
| --- | --- |
| 私聊 | ✅ 好友（friend）与陌生人（stranger）都能收，`sub_type` 区分 |
| 群聊 | ✅ `message_type=group`、`group_id` 有效；`get_group_list` / `send_group_msg` 可用 |
| 图片 | 收：转 `image` 段（带原始 URL，可能是加密资源）；发：支持 http(s) / `base64://` / `data:` / 本地文件 |
| @ | 发群消息时 `at` 段会翻成抖音的 mention |
| 语音/视频/表情 | 收：降级成文本占位（`[语音]` / `[视频]` / `[表情]`）；发：暂不支持 |

`user_id` 说明：抖音的 uid 是长字符串，OneBot 要求数字。桥里用 FNV-1a 哈希成稳定正整数，同一个人每次都是同一个 id；`get_friend_list` 会给出对应昵称。

## 接真机（抖音 / 多闪，不用协议客户端时的兜底）

1. 手机开 USB 调试，`adb devices` 能看到设备；`pip install uiautomator2 requests`。
2. 校准界面（必做，抖音改版很勤）：

```bash
python adapters/android/adapter.py probe --profile profiles/douyin.json --out dump.xml --screen shot.png
```

   打开 `dump.xml` / `shot.png`，把 `profiles/douyin.json` 里的选择器改成实际节点。先用 `--dry-run` 跑一遍，确认只「看」不「发」。

3. 起适配器（默认出站 5701，入站回调桥的 5702）：

```bash
python adapters/android/adapter.py run --profile profiles/douyin.json --dry-run
python adapters/android/adapter.py run --profile profiles/douyin.json
```

4. 桥切到 http 驱动：

```bash
cp config.example.json config.json   # 然后把 driver.type 改成 "http"
npm start
npm run doctor                       # 会去探适配器的出站端口
```

多闪把 `--profile` 换成 `profiles/duoshan.json`，并先用 `adb shell pm list packages | grep -i duoshan` 核对包名。

## 支持的动作

| 动作 | 状态 |
| --- | --- |
| `get_login_info` `get_status` `get_version_info` | ✅ |
| `get_friend_list` / `get_stranger_info` | ✅（mock 与适配器给出，抖音侧靠界面昵称） |
| `send_private_msg` / `send_msg(私聊)` | ✅ 文本 |
| `get_msg` | ✅ 进程内缓存（nativeId/自增 id） |
| `send_group_msg` / `get_group_list` | ✅ driver=douyin 时可用；http/mock 驱动返回 1400 |
| 图片 / 语音 / 视频发送 | ❌ 未实现（适配器返回 501） |
| `delete_msg` `clean_cache` `get_cookies` | ✅ 空操作 |

事件：`message`（private/friend）、`meta_event.lifecycle`、`meta_event.heartbeat`、`notice`（适配器给什么转什么）。

## 配置

`config.json`（或 `config.local.json`，后者优先）。完整示例见 `config.example.json`。

| 键 | 说明 |
| --- | --- |
| `self_id` | 上报的机器人 QQ 号，抖音没有 QQ 号，填任意稳定数字（默认 10000） |
| `onebot.host/port` | HTTP 与正向 WS 共用同一端口，默认 `127.0.0.1:5700` |
| `onebot.access_token` | 非空时校验 `Authorization: Bearer/Token <token>` 或 `?access_token=` |
| `onebot.message_format` | `array` 或 `string`（CQ 码），默认 `array` |
| `onebot.reverse_ws[]` | 反向 WS 列表（连到框架），断线指数退避重连，1s → 60s |
| `driver.type` | `mock` / `http` / `douyin` |
| `driver.douyin.dataDir` | 会话与账号存储目录，默认 `data` |
| `driver.douyin.qrcodeFile` | 二维码 PNG 落盘路径，默认 `data/login.png` |
| `driver.douyin.autoOpenVerification` | 是否需要验证时自动弹浏览器，默认 `false` |
| `driver.http.outbound.url` | 适配器出站地址，默认 `http://127.0.0.1:5701` |
| `driver.http.inbound.port` | 适配器回调端口，默认 `5702` |

环境变量覆盖：`OB11_PORT` `OB11_HOST` `OB11_TOKEN` `OB11_DRIVER` `OB11_SELF_ID` `OB11_LOG_LEVEL`。

## 目录

```text
bin/onebot-douyin.js    命令行入口（npm i -g 后的 obd 命令）
src/index.js            入口（调 cli.js）
src/cli.js              CLI 实现: start / doctor
src/plugin.js           编程接口: createBridge()（插件形式）
scripts/ctl.mjs         省 token 运维命令: status / start / stop / send / events
scripts/autostart.mjs   开机自启动（Windows 计划任务 onlogon，隐藏窗口）
src/config.js           配置合并（内置默认值 + 文件 + 环境变量）
src/logger.js           分级日志
src/onebot/segments.js  消息段 <-> CQ 码
src/onebot/events.js    OneBot 11 事件构造
src/onebot/actions.js   动作实现
src/onebot/server.js    HTTP + 正向 WS + 反向 WS + 心跳 + 事件广播
src/drivers/base.js     Driver 契约
src/drivers/mock.js     离线自测驱动
src/drivers/http.js     通用 HTTP 驱动（对接 Python 适配器）
src/drivers/douyin.js   抖音协议驱动（douyin-im：登录/收发/群聊）
adapters/android/adapter.py   uiautomator2 适配器：probe / screen / run
profiles/{douyin,duoshan}.json 包名与选择器（需真机校准）
test/                   node:test 用例（segments / server / http-driver / douyin-driver / plugin）
AGENTS.md               给 agent 的精简 runbook（省 token 读这个）
```

## 日常操作（省 token 用法）

桥本身是纯 Node 进程，接好之后**不经过任何大模型，token 消耗为零**——跟 NapCat 一样，跑起来就完事。

只有「让 agent 帮你改它」的时候才有 token 成本。为此仓库里放了 `scripts/ctl.mjs`：每条命令只输出一两行，替代去读源码/日志。

```bash
node scripts/ctl.mjs status     # state=online self=80718578848377 nick=GOwrOng
node scripts/ctl.mjs start      # 后台起（pid/log 在 data/）
node scripts/ctl.mjs qr         # 要扫码时
node scripts/ctl.mjs friends    # user_id + 昵称
node scripts/ctl.mjs send <user_id> <text>
node scripts/ctl.mjs watch      # 起事件监听
node scripts/ctl.mjs events 10  # 紧凑回放事件
```

配合 [AGENTS.md](AGENTS.md) 使用：新会话的 agent 读那 30 行就能开工，不必把 README 和源码读一遍。

## 开机自启动

桥跑起来之后就不用管了，但它不会自己开机起来。Windows 上装一个计划任务（登录时触发、隐藏窗口、不弹黑框）：

```bash
node scripts/autostart.mjs install    # 建计划任务 dsh-onebot-douyin（触发器 onlogon）
node scripts/autostart.mjs status     # state=Ready + last_result=0 就是好的
node scripts/autostart.mjs run        # 立刻跑一次（验证用）
node scripts/autostart.mjs uninstall  # 不要了
```

- 任务名 `dsh-onebot-douyin`，触发器 `onlogon`；登录后由 `data/autostart.vbs` 隐藏启动 `scripts/ctl.mjs start`。
- 启动输出在 `data/autostart.log`，桥自己的日志在 `data/bridge.log`（超过 1MB 自动轮转）。
- 用哪个 node 是在执行 install 时定下来的（记在 `data/autostart.cmd`）；换了 node 就重跑一次 install。
- 会话已经在 `data/` 里，重启机器不用重新扫码；只有登录态真失效时才要再扫一次。
- Linux / macOS 没做：systemd unit 或 launchd 直接跑 `node src/index.js start --config config.json` 就行。

## 测试

```bash
node --test --test-isolation=none "test/*.test.js"
```

注意：`node --test` 默认会给每个测试文件开子进程，某些沙箱里 spawn 被拒（EPERM），所以要加 `--test-isolation=none`（Node 22+）或在普通终端里直接跑。用例全部离线，不碰真实抖音网络。

## 限制与风险

- driver=douyin 依赖 `douyin-im`，它自己 README 就写明：默认登录仍走旧 Jumpbyte 签名分支，Desktop BDMS/Web Secure 未接入默认登录链，「已实现」不等于每个账号都验收过。抖音一改协议就可能失效，这是协议端的通病，NapCat 也一样。
- 风控是真实存在的：**用自用小号**，别拿主号试；本项目不注入、不逆向、不绕过验证，登录验证一律交给你本人在浏览器/手机上完成。
- driver=http（界面自动化）路线保留作兜底：改版后要重新 `probe` 校准选择器；好友没有稳定 uid，用昵称哈希成 `user_id`，改备注会变 id。
- 语音/视频/表情收发尚未接通；多设备/多开未处理。
