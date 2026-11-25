#!/bin/bash
# 安装/卸载 九江文旅定时巡检任务（macOS launchd）
#
# 用法：
#   ./install.sh            安装并加载
#   ./install.sh status     查看状态
#   ./install.sh uninstall  卸载
#   ./install.sh test       立即跑一次（不等待调度）
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHED="$SKILL_DIR/schedule"
LOG_DIR="$SKILL_DIR/logs"
LABEL="com.jjwl.qc"
PLIST_SRC="$SCHED/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

render() {
  # 用实际路径替换模板占位符，生成可执行副本
  sed -e "s|__SKILL_DIR__|$SKILL_DIR|g" \
      -e "s|__SCRIPTS__|$SKILL_DIR/scripts|g" \
      -e "s|__LOGDIR__|$LOG_DIR|g" \
      -e "s|__RUNNER__|$SCHED/run.sh|g" "$1"
}

case "${1:-install}" in
  install)
    if [ ! -f "$SKILL_DIR/config.json" ]; then
      echo "缺少 config.json。请先：" >&2
      echo "  cp $SKILL_DIR/config.example.json $SKILL_DIR/config.json" >&2
      echo "并填写 platform.company_id / robot_ids / cookie" >&2
      exit 1
    fi
    render "$PLIST_SRC" > "$PLIST_DST"
    render "$SCHED/run.sh" > "$SCHED/run.sh.tmp" && mv "$SCHED/run.sh.tmp" "$SCHED/run.sh"
    chmod +x "$SCHED/run.sh"
    plutil -lint "$PLIST_DST" || exit 1
    launchctl unload "$PLIST_DST" 2>/dev/null
    launchctl load "$PLIST_DST" || exit 1
    echo "已安装并加载：$LABEL"
    echo "触发时刻：08:05–19:05 每小时一次，共 12 次/天"
    echo "日志目录：$LOG_DIR"
    ;;
  uninstall)
    launchctl unload "$PLIST_DST" 2>/dev/null
    rm -f "$PLIST_DST"
    echo "已卸载：$LABEL"
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "运行中："
      launchctl list | grep "$LABEL"
    else
      echo "未加载"
    fi
    echo
    echo "最近日志："
    tail -n 20 "$LOG_DIR/job.err.log" 2>/dev/null || echo "(暂无)"
    ;;
  test)
    echo "立即执行一次..."
    bash "$SCHED/run.sh"
    ;;
  *)
    echo "用法：$0 {install|uninstall|status|test}" >&2
    exit 1
    ;;
esac
