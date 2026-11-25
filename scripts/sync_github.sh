#!/usr/bin/env bash
# sync_github.sh —— 平台代码 + 依赖的 skill 快照 一键同步到 GitHub
# 用法：./scripts/sync_github.sh ["commit message"]
# 覆盖范围：regex-opt-platform 全部源码 + skills/（平台依赖的技能快照）
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_URL=$(git remote get-url origin)
WORKSPACE="$(cd .. && pwd)"          # regex-opt-platform 的上级 = 工作区
SKILLS_SRC="$WORKSPACE/.agents/skills"
MSG="${1:-}"

# 平台依赖的 skill 清单（新 skill 加入平台功能后，在这里补一行）
SKILLS=(guizeyouhua huashubao siyouhua-xunjianyouhua jjwl-ls saas-xunjian-tongyong)

echo "==> 1/4 同步 skill 快照"
mkdir -p skills
for s in "${SKILLS[@]}"; do
  if [ -d "$SKILLS_SRC/$s" ]; then
    rsync -a --delete --exclude='.DS_Store' --exclude='__pycache__' "$SKILLS_SRC/$s/" "skills/$s/"
    # 脱敏本机绝对路径（开源卫生）
    grep -rl "/Users/zhuyanzhu" "skills/$s" 2>/dev/null | xargs sed -i '' 's|/Users/zhuyanzhu/Documents/deepseek-harness/default-workspace|<WORKSPACE>|g' 2>/dev/null || true
    echo "  ✓ $s"
  else
    echo "  - $s 源目录不存在，保留仓库内快照"
  fi
done

echo "==> 2/4 变更检查"
git add -A
if git diff --cached --quiet; then
  echo "  无变更，仓库已是最新。"
  exit 0
fi
git diff --cached --stat | tail -5

echo "==> 3/4 提交"
if [ -z "$MSG" ]; then
  # 自动生成提交信息：按变更目录归纳
  MAP=(["server"]="平台代码" ["src"]="平台代码" ["scripts"]="平台脚本" ["skills"]="skill快照" ["README.md"]="文档" ["package"]="依赖")
  FIRST=$(git diff --cached --name-only | head -1)
  MSG="sync: 平台与 skill 快照更新（$(date '+%F %H:%M')）"
fi
git commit -m "$MSG" | tail -1

echo "==> 4/4 推送（走系统代理 7897）"
git -c http.proxy=http://127.0.0.1:7897 push origin HEAD 2>&1 | tail -2
echo "✅ 已同步 https://github.com/sanhuo116/ai-ops-platform"
