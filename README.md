# Steam Family Watchdog

一个可以一直运行的 Steam 家庭库监控工具。它会定期检查家庭库，把新增游戏或新增拥有者保存下来，再通过 HTTP 接口供其他程序读取。

可以取得游戏名称、来源成员、发现时间，以及游戏封面和图标。不同调用程序使用不同 `clientid`，各自的通知进度互不影响。

第一次扫描只记录现有游戏，不会把整库都当成新增。后续扫描和重启也不会清掉已经记录的事件。

## 需要准备什么

- **Node.js 24 LTS**，安装时会一起安装 npm。[下载 Node.js](https://nodejs.org/en/download)
- 一个属于 Steam 家庭的账号。
- 能访问 Steam 的网络。
- Git，用于下载和更新源码；也可以在 GitHub 页面选择 **Code → Download ZIP**。

Windows 和 Linux 都可以运行。不需要单独安装数据库，也不需要申请 Steam Web API Key。

## 安装和登录

下载源码：

```bash
git clone https://github.com/tianyisama/steam-family-watchdog.git
cd steam-family-watchdog
```

下面以 Windows 为例，在项目目录的终端中运行。Linux 把 `npm.cmd` 换成 `npm` 即可。

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run login
```

三个命令分别用于安装依赖、生成配置、开始登录。

登录程序启动后，在**运行程序的这台电脑**打开：

```text
http://127.0.0.1:11453
```

填写 Steam 登录账号和密码，再输入 Steam 验证码。验证码可以来自 Steam++ / Watt Toolkit 的验证器，也可以来自 Steam 手机 App 或邮箱，取决于账号的验证方式。密码和验证码不会保存。

登录成功后，登录页面服务约 10 秒后退出，然后启动接口：

```powershell
npm.cmd start
```

如果想用手机扫码登录，可以把登录命令换成：

```powershell
npm.cmd run login:qr
```

二维码需要使用 Steam 手机 App 扫描。

## 启动后怎么用

默认接口地址是：

```text
http://127.0.0.1:11452
```

如果从另一台设备访问，把 `127.0.0.1` 换成服务器的实际 IP。例如：

```text
http://192.168.1.20:11452
```

控制台会显示扫描和请求日志。看到“已建立基线”或“检查完成”说明已经成功读取家庭库。

除了检查存活的 `/health`，其他接口都需要带上请求头：

```http
Authorization: Bearer 你的接口密钥
```

接口密钥在 `setup` 生成的 `.env` 文件里，对应 `MONITOR_API_SECRET`。这与 Steam 登录凭据是两回事，调用接口时使用这个密钥即可。

## 常用接口

| 方法 | 地址 | 用途 |
|---|---|---|
| GET | `/health` | 确认程序正在运行 |
| GET | `/status` | 查看 Steam 登录、扫描时间和错误信息 |
| GET | `/games` | 查看最近扫描保存的游戏列表 |
| GET | `/changes?clientid=my_app` | 取得这个调用程序尚未确认的新增事件 |
| POST | `/changes` | 同样取得新增事件，参数放在 JSON 请求内容中 |
| POST | `/ack` | 确认这一批事件已经处理成功 |
| POST | `/clients` | 提前注册一个调用程序，并选择是否补取历史事件 |

### 查看游戏列表

例如，在 Windows 终端执行，把密钥替换成 `.env` 里的值：

```powershell
curl.exe -H "Authorization: Bearer 你的接口密钥" "http://127.0.0.1:11452/games"
```

Linux 使用 `curl` 即可。

### 读取新增事件

```http
GET /changes?clientid=my_app&limit=5
Authorization: Bearer 你的接口密钥
```

`clientid` 是自己给调用程序取的固定名称，例如 `my_app`。同一个程序重启后继续使用原名称，不同程序使用不同名称。

`limit` 表示一次最多取多少条，范围是 1～100，默认 10。

以下是返回格式示例，数据仅用于说明：

```json
{
  "success": true,
  "clientid": "my_app",
  "delivery_id": "这一批事件的编号",
  "count": 1,
  "new_games": [
    {
      "event_id": 1,
      "type": "game_added",
      "appid": 123456,
      "name": "示例游戏",
      "added_owners": [
        { "steamid": "76561198000000001", "name": "家庭成员" }
      ],
      "detected_at": "2026-10-05T01:43:56.000Z",
      "steam_acquired_at": null,
      "image_url": null
    }
  ]
}
```

没有新增时，`count` 是 0，`new_games` 是空列表，`delivery_id` 是 null。

也可以用 POST 读取，JSON 内容如下：

```json
{ "clientid": "my_app", "limit": 5 }
```

POST 请求要额外带上 `Content-Type: application/json`。

### 处理成功后确认

读取不会自动标记事件已经处理。完成自己的处理后，把刚才返回的 `delivery_id` 发送给 `/ack`：

```http
POST /ack
Authorization: Bearer 你的接口密钥
Content-Type: application/json

{
  "clientid": "my_app",
  "delivery_id": "刚才取得的批次编号"
}
```

确认前重复查询会得到同一批事件；确认后才取得下一批。这样即使调用程序中途断线，也能继续处理之前的事件。确认只影响自己的 `clientid`，不删除历史，也不影响其他程序。

新 `clientid` 第一次通过 `/changes` 查询，会分批补取监控程序已经记录的新增。如果不想补取，先调用 `/clients`，内容为：

```json
{ "clientid": "my_new_app", "start": "latest" }
```

已有 `clientid` 不会因重复注册被重置。

## 游戏信息怎么理解

- `type`：`game_added` 表示新游戏出现，`owner_added` 表示已有游戏新增拥有者。
- `name`：Steam 返回的名称。默认请求简体中文，但有些游戏的官方名称仍然是英文。
- `added_owners`：本次新增的来源成员。`owners` 则是本次返回的全部拥有者。取不到昵称时可以使用 SteamID。
- `detected_at`：程序发现变化的时间。返回时间使用 UTC，末尾的 `Z` 表示 UTC；北京时间需加 8 小时。
- `observed_after`、`observed_until`：上次成功检查到本次检查之间的时间范围。
- `rt_time_acquired`、`steam_acquired_at`：Steam 返回的取得时间。不保证对应某位成员这次购买的准确时间，也可能没有值。
- `image_url`：优先游戏库封面，没有封面时使用图标，没有图片则为 null。也可分别使用 `capsule_image_url` 和 `icon_image_url`。

新增事件表示家庭库发生变化，并不一定意味着购买，例如新成员加入家庭也可能带来游戏。游戏变化根据 AppID 和拥有者列表判断，不只是比较游戏总数。

## 修改设置

编辑 `config.json`，然后重启程序。几个常用设置如下：

| 设置 | 默认值 | 说明 |
|---|---|---|
| `port` | `11452` | 接口端口 |
| `poll_seconds` | `300` | 每隔多少秒检查 Steam，最小 60 |
| `jitter_seconds` | `10` | 每轮额外随机等待 0～10 秒 |
| `language` | `schinese` | 名称语言；`schinese` 是简体中文 |
| `member_aliases` | `{}` | 自定义成员显示名称 |

默认约每 5 分钟检查一次。需要更频繁时，可以把 `poll_seconds` 改为 60。Steam 没有公布这个接口的安全轮询频率；遇到请求限制时，程序会延长等待时间再试。

调用 `/games` 或 `/changes` 只是读取本地记录，不会额外扫描 Steam。

自定义成员名称可以这样写：

```json
"member_aliases": {
  "76561198000000001": "家庭成员A"
}
```

## 重启、更新和重新登录

平时只需启动接口，程序会自动维护 Steam 登录凭据。Steam 撤销登录或长期凭据失效时，需要停止接口，再运行 `npm.cmd run login`，登录完成后重新启动。

更新源码时，先停止接口，再运行：

```powershell
git pull
npm.cmd ci
npm.cmd start
```

**保留 `.env`、`config.json` 和整个 `data` 目录。** 它们保存接口密钥、设置、Steam 登录凭据、游戏记录和通知进度。它们已经被 Git 忽略，更新源码不会覆盖这些文件。不要删除它们来解决通知问题，也不要上传到公开仓库。

如果接口放在服务器上，而服务器无法直接打开浏览器，可以在自己的电脑上完成登录，停止程序后再把这几个运行文件复制到服务器的同一项目目录。登录页面仅允许本机访问；数据接口供其他设备访问时，建议放在自己的局域网或 VPN 内。

## 可选：Docker 运行

先按上面的方式在本机安装、生成配置并完成登录，停止本机接口后，在项目目录运行：

```bash
docker compose up -d --build
```

Docker 会继续使用本地的配置和 `data` 目录。查看日志：

```bash
docker compose logs -f
```

重新登录前先停止容器：

```bash
docker compose down
```

完成登录后再启动容器即可。

## 常见情况

- 返回 **401**：接口密钥不正确，检查请求头和 `.env` 是否一致。
- 返回 **503 / not_ready**：还没有成功建立家庭库基线，检查是否完成登录以及 Steam 网络是否正常。
- 没有新增：初次扫描不会通知已有游戏；后续可以看日志里的“本轮新增”“累计记录”和“待通知”判断情况。
- 控制台的 HTTP 时间比北京时间少 8 小时：日志使用带 `Z` 的 UTC 时间，属于正常情况。
- SQLite 的 ExperimentalWarning：这是部分 Node.js 24 版本对内置数据库的提示，不等于运行失败。

需要检查程序时，可运行 `npm.cmd test`。测试使用模拟数据，不需要购买游戏。
