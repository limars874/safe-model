# safe-model

[Pi](https://github.com/earendil-works/pi-coding-agent) 扩展：切换模型前先做真实探测，探测成功才切换，避免切到一个不可用（欠费、无权限、已下线）的模型。

## 安装

```bash
pi install git:github.com/limars874/safe-model
```

或锁定到某个 commit：

```bash
pi install git:github.com/limars874/safe-model@<commit-hash>
```

## 用法

```
/safe-model                    弹出可搜索列表，选择后探测并切换
/safe-model .                  跳过列表，直接探测当前模型
/safe-model <provider/model>   直接探测指定模型，例如 /safe-model cii/gpt-5.6-terra
```

## 行为

1. 每次执行前调用 `modelRegistry.refresh()` 重载 `models.json`，始终基于最新配置展示已配置凭据的模型列表。
2. 向所选模型发送一条最小真实请求（无工具、无文件上下文，最多 64 个输出 token），要求返回确认标记。
3. 仅在模型以正常状态返回确认标记后调用 `pi.setModel` 切换。
4. 探测失败（凭据错误、网络超时、HTTP 4xx/5xx、模型返回异常）时保留当前模型，并显示结构化诊断面板。

探测不写入当前 session tree。

## 失败诊断

失败面板展示模型、HTTP 状态、中文原因和 provider 返回的摘要；错误详情最多显示 400 个字符，避免异常响应占满终端。

| 状态 | 中文原因 |
|---|---|
| `401` | 认证失败或凭据已失效 |
| `402` | 余额不足 |
| `403` | 无权访问该模型 |
| `404` | 模型或接口不存在 |
| `429` | 请求频率或额度受限 |
| `500` / `502` / `503` / `504` | provider 服务端或网关错误 |

当 HTTP 请求成功但模型未返回确认标记时，面板显示实际文本摘要；按 Enter 或 Esc 关闭面板。

## 文件结构

```
extensions/safe-model.ts   扩展主文件
```
