#!/bin/bash
# Ad-hoc 重签名
# electron-builder 在找不到开发者证书时会跳过 macOS 签名，
# 仅有链接器签名的包会被 Gatekeeper 拒绝（"code has no resources but signature..."），
# 导致 `open` 无法启动。此脚本从最内层到外层对整个 .app 重新做 ad-hoc 签名。
set -euo pipefail
APP="release/mac-arm64/Claude GUI.app"

# 收集所有需要签名的内层组件，按路径深度从深到浅排序（先签内层再签外层）
find "$APP/Contents/Frameworks" \( -name "*.framework" -o -name "*.app" -o -name "*.xpc" \) \
  | awk -F'/' '{print NF "\t" $0}' | sort -rn | cut -f2- \
  | while IFS= read -r item; do
      codesign --force --sign - --timestamp=none "$item" > /dev/null
    done

codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"
echo "✓ ad-hoc resign OK: $APP"
