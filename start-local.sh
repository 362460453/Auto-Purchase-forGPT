#!/bin/bash
# 本机项目启动入口；对外分发 Mac 时只需 start-mac.command。
exec /bin/bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start-mac.command" "$@"
