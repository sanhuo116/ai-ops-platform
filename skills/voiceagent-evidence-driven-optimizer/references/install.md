# 安装与登录

版本 1.0.1；2026-11-06。支持本次验证环境 macOS、Python 3.9+、Chrome；网络应能访问上海星球及对应 cos.byai.com。Windows 凭据库读取代码仅用于数仓适配，不代表整个 Chrome 登录流程已跨平台验证。

解压 ZIP 得到同名技能文件夹，放入 Codex 的 `~/.codex/skills/` 或当前 Agent 的技能目录。已有同名版本先备份，再替换；不要叠加两套同名入口。重启或刷新索引。

进入技能目录执行：
```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r scripts/requirements.txt
python3 scripts/planet.py auth login
python3 scripts/planet.py auth status
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

`auth login` 打开专用 Chrome，用户人工登录；程序验证授权后保存会话，不要求安装浏览器控制插件。默认状态目录 `~/.local/share/byai-planet-cli`，会话文件600、目录700，专用浏览器 profile 也含登录数据。不要发给他人或打包。过期后重登；禁止把凭据写入测试集或报告。

首次扫码流程本次未重新进行端到端人工验收；已验证当前有效会话的 HTTP 读取及真实文本会话。若专用窗口未出现，检查 Chrome 安装、网络和端口回执，不尝试读取用户其它浏览器的凭据文件。

使用指令：`使用 $voiceagent-evidence-driven-optimizer 测试BOTID，并先归档当前配置。` 将 BOTID 换为实际数字。读取和测试属于已指定范围；修改需符合当前任务授权，正式发布单独确认具体范围。
