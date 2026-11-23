#!/bin/bash
# 兼容原来的本机命令；单独分发请使用 start-mac.command。
exec /bin/bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start-mac.command" "$@"
