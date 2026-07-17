# 配置目录

所有配置集中在一个 TOML 文件里，再用本地文件覆盖密钥：

| 文件 | 是否提交 | 用途 |
|------|----------|------|
| `config/config.toml` | 是 | 基本配置（默认值、非密钥） |
| `config/config.local.toml` | 否 | 本地覆盖（密码、AccessKey、本机参数） |
| `config/config.toml.example` | 是 | 配置模版（复制为 local 后填写） |

规则：**local 文件存在且有实质内容时，同名字段覆盖基本配置；否则只用基本配置。**  
`[[auth.users]]`：只要 local 里写了用户列表，就整表替换基本配置中的用户列表。

## 快速开始

```bash
cp config/config.toml.example config/config.local.toml
# 编辑 config.local.toml：把 CHANGE_ME 换成真实密码 / API Key / OSS 密钥
# 按需把 database.enabled / oss.enabled 设为 true
```

## 配置段说明

### `[database]`

| 字段 | 说明 |
|------|------|
| `enabled` | 是否启用 Postgres |
| `host` / `port` / `name` / `user` / `password` | 连接信息 |
| `pool_*` / `connect_timeout` | 连接池 |

### `[oss]`

| 字段 | 说明 |
|------|------|
| `enabled` | 是否启用对象存储 |
| `provider` | 目前仅 `aliyun` |
| `endpoint` / `bucket` / `access_key_*` | 阿里云 OSS |
| `public_base_url` | 可选；空则默认 `https://<bucket>.<endpoint>` |
| `prefix` | 上传前缀 |

### `[auth]` + `[[auth.users]]`

| 字段 | 说明 |
|------|------|
| `password` | 默认密码（用户未单独设置时使用） |
| `user_id` / `display_name` / `password` | 每个登录用户 |

`password = "CHANGE_ME"` 时登录功能关闭，需在 local 中改成真实密码。

### `[agent]`

写入进程环境，供 Pi Agent / DashScope 使用：

| TOML 字段 | 环境变量 |
|-----------|----------|
| `api_key` | `HV_PI_API_KEY` |
| `base_url` | `HV_PI_BASE_URL` |
| `model` | `HV_PI_MODEL` |
| `max_tokens` | `HV_PI_MAX_TOKENS` |

也可用 shell / 旧版 `config/agent.env` 设置；**已在 shell 里的变量不会被文件覆盖**。  
别名：`DASHSCOPE_*` / `OPENAI_*`。

`max_tokens` 须为正整数；非法则回退 `16384`。

## 加载顺序

1. `config/config.toml`（基本）
2. 若 `config/config.local.toml` 非空 → 合并覆盖
3. 若统一配置缺少某段，回退到 `config/<name>.toml` + `config/<name>.local.toml`
4. `[agent]` 之外：还可被 shell 环境变量覆盖；旧版 `config/agent.env` / `.env` 仍可作为补充

`.html-video/` 只放运行时数据（projects、tmp、logs），**不再读取**其中的 `auth.toml` / `database.toml` / `oss.toml`。
