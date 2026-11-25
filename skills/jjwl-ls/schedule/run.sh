#!/bin/bash
# 九江文旅定时巡检 —— launchd 调用的入口脚本
# 由 install.sh 生成，勿手改路径部分。
set -uo pipefail

SKILL_DIR="<WORKSPACE>/.agents/skills/jjwl-ls"
SCRIPTS="$SKILL_DIR/scripts"
CONFIG="$SKILL_DIR/config.json"
LOG_DIR="$SKILL_DIR/logs"

mkdir -p "$LOG_DIR"

PY="$(command -v python3 || echo /usr/bin/python3)"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

echo "===== [$STAMP] 定时巡检开始 ====="
cd "$SCRIPTS" || exit 1

"$PY" -m jjwl_qc.job --config "$CONFIG" --run-now
RC=$?

if [ $RC -ne 0 ]; then
  echo "[$STAMP] 巡检失败，退出码 $RC" >&2
fi
echo "===== [$STAMP] 结束，退出码 $RC ====="
exit $RC
