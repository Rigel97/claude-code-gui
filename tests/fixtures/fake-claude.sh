#!/usr/bin/env bash
# 测试用假 claude CLI：模拟 stream-json 输出。
# 用法: fake-claude.sh [normal|stubborn]
#   normal   - init → hello → result 后退出，可被 SIGTERM 正常杀死
#   stubborn - 忽略 SIGTERM 持续输出（用于验证 SIGKILL 兜底）
mode="${1:-normal}"
if [ "$mode" = "stubborn" ]; then
  trap '' TERM
  echo "{\"type\":\"system\",\"subtype\":\"init\",\"pid\":$$,\"mode\":\"stubborn\"}"
  while true; do
    echo "{\"type\":\"assistant\",\"message\":{\"id\":\"stubborn-$RANDOM\",\"content\":[{\"type\":\"text\",\"text\":\"STUBBORN-LINE\"}]}}"
    sleep 0.15
  done
else
  echo "{\"type\":\"system\",\"subtype\":\"init\",\"pid\":$$,\"mode\":\"normal\"}"
  sleep 0.3
  echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"text\",\"text\":\"hello-from-$$\"}]}}"
  sleep 0.2
  echo "{\"type\":\"result\",\"is_error\":false}"
fi
