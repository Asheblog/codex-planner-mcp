# codex-claude-worker-mcp

[English](README.md) | 简体中文

---

让 Codex 把 Claude Code 当成可监督的后台 worker 使用。

这不是又一个"给 Claude Code 增加某个工具"的 MCP。它反过来工作：把 Claude Code 包装成一个 Codex 可调用、可轮询、可取消、可诊断的异步执行层。Codex 负责策划、拆任务、设验收、审查结果和指挥返工；Claude Code 负责在指定仓库里真正写代码、跑测试、修失败。

## 和普通 Claude Code MCP 的差别

很多 MCP 的方向是 **Claude Code 调用外部工具**。这个项目的方向是 **Codex 调用 Claude Code**。

| 对比项 | 常见 Claude Code MCP | 本项目 |
|--------|----------------------|--------|
| 主要使用者 | Claude Code | Codex |
| MCP 暴露的能力 | 数据源、浏览器、设计稿等工具 | Claude Code worker 生命周期 |
| 任务模型 | 当前 agent 自己调用工具继续干 | Codex 策划，Claude Code 后台执行 |
| 长任务处理 | 前台会话持续输出 | start 后立即返回 jobId，低频 long-poll |
| 成本控制 | 取决于前台上下文 | 默认隐藏事件明细，只返回摘要和结果 |
| 失败处理 | agent 自己判断下一步 | Codex 可外部审查 diff/测试，用 resumeSessionId 指挥返工 |

一句话：普通 MCP 是"给 Claude 一把工具"；这个 MCP 是"给 Codex 一个可管理的 Claude 工人"。

## 核心优势

- **Codex 做指挥层，Claude Code 做执行层**：策划和动手分离，长任务更稳。
- **成本更优的模型组合**：推荐栈 —— Codex 侧使用 GPT-5.5（`xhigh`）负责策划与复核（少量高价值推理）；Claude Code 侧使用 DeepSeek V4 Pro（`effort=max`）负责长时间执行。高成本模型只用在关键决策上，大量执行工作由成本更低的模型完成，整体更省成本。
- **长任务不堵前台**：`claude_worker_start` 立即返回 jobId，之后按 `pollAfterMs` 低频轮询。
- **能判断"安静但还活着"**：通过 PID、心跳、stdout/stderr 更新时间判断 worker 是否正常。
- **支持返工链路**：完成后返回 `sessionId`，Codex 可以带着 `resumeSessionId` 继续指挥返工。

## 适用 / 不适用场景

**适用**：大型重构、跨模块迁移、需 TDD 的 bugfix、Codex 先设计再委派执行的场景、需要管理 worker 状态和取消任务。

**不适用**：一两分钟的小改动、纯问答/规划/review、不信任的仓库、只想在 Claude Code 里直接接数据库/浏览器/Figma MCP。

## 安装

```bash
cd /path/to/codex-claude-worker-mcp
npm install -g .
codex-claude-worker-mcp --doctor
```

## 配置 Codex

```bash
codex mcp add claude_worker -- codex-claude-worker-mcp
```

或手动编辑 `~/.codex/config.toml`，确保 `tool_timeout_sec` 大于 poll 最大等待秒数（默认 15 分钟，对应 1200 秒）。

## 不推荐默认配给 Claude Code

默认路径是 `Codex -> claude_worker MCP -> Claude Code`，不是 `Claude Code -> claude_worker MCP -> 另一个 Claude Code`。后者会形成嵌套执行，权限、成本和状态管理更复杂。

## Prompt 模板位置

项目根目录提供了可直接复制的全局 prompt 模板：

| 文件 | 用途 | 生效位置 |
|------|------|---------|
| `AGENTS.MD` | Codex 全局指令模板 | 复制到 `~/.codex/AGENTS.md` |
| `CLAUDE.MD` | Claude Code 全局指令模板 | 复制到 `~/.claude/CLAUDE.md` |

**注意**：根目录文件不会自动生效，必须复制到对应全局目录。Linux/WSL 区分大小写，官方文件名是 `AGENTS.md` / `CLAUDE.md`（扩展名小写），与根目录大写后缀 `.MD` 不同。`examples/` 下有更细分的参考模板。

中文用户可以在复制后把模板中的 `<language>` 规则改成“默认使用中文回复，除非用户或项目另有要求”。

## 安全提醒

- 默认以 `bypassPermissions` 模式启动 worker，适合高信任本机环境，但风险更高。
- 保守模式可设置 `permissionMode: "default"`。
- 强烈建议在 `~/.codex/AGENTS.md` 和 `~/.claude/CLAUDE.md` 中写清楚：禁止危险命令、禁止提交推送发布、禁止泄露密钥/token、涉及行为变化走 TDD、完成后汇报结果和风险。

## 验证

```bash
npm run doctor      # 检查 Claude CLI、版本、权限、状态目录
npm run regression  # 使用 fake Claude，不调用真实 API
npm run smoke /path/to/test-repo  # 真实端到端测试（仅可信测试仓库）
```

更多细节（工具列表、推荐工作流、环境变量、FAQ、官方文档链接等）请查阅 [英文 README](README.md)。

## License

MIT
