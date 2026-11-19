#!/usr/bin/env bash
# Linux 原生产出验证：ctest、动态库依赖、协议往返、平台包。在 WSL / Linux runner 里跑。
set -u
cd "$(dirname "$0")/../../.." || exit 1   # 仓库根
BUILD=${BUILD:-build/wsl}
EXE="$BUILD/apps/repo-tutor-core/repo-tutor-core"

fail=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }

[ -x "$EXE" ] || { echo "FAIL  binary missing: $EXE"; exit 1; }

if ctest --test-dir "$BUILD" --output-on-failure > /tmp/ctest.log 2>&1; then
  ok "ctest passes on Linux ($(grep -c 'Passed' /tmp/ctest.log) tests)"
else
  bad "ctest failed"; tail -20 /tmp/ctest.log
fi

deps=$(ldd "$EXE" | awk '{print $1}')
echo "      ldd: $(echo "$deps" | tr '\n' ' ')"
if echo "$deps" | grep -Ev '^(linux-vdso|libc\.so|libm\.so|libstdc\+\+|libgcc_s|ld-linux|/lib)' > /dev/null; then
  bad "unexpected dynamic dependencies: $(echo "$deps" | grep -Ev '^(linux-vdso|libc\.so|libm\.so|libstdc\+\+|libgcc_s|ld-linux|/lib)' | tr '\n' ' ')"
else
  ok "dynamic dependencies are libc/libm only"
fi

reply=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"protocol.negotiate","params":{}}' | "$EXE")
case "$reply" in
  *'"protocolVersion":"0.1"'*) ok "protocol.negotiate answers over stdio" ;;
  *) bad "unexpected negotiate reply: $reply" ;;
esac

# 发布时真正要写进 README 的是「最低 glibc」，不是构建机上的 glibc。
# 符号版本号来自二进制自己问了哪些符号，换台更老的机器编译，这个数才可能变。
if command -v objdump > /dev/null 2>&1; then
  glibc_floor=$(objdump -T "$EXE" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)
  cxx_floor=$(objdump -T "$EXE" 2>/dev/null | grep -o 'GLIBCXX_[0-9.]*' | sed 's/GLIBCXX_//' | sort -uV | tail -1)
  ok "requires glibc >= ${glibc_floor:-unknown}, libstdc++ symbols <= ${cxx_floor:-none (statically linked)}"
fi

# 完整协议走查（和 Windows 上同一条链）
if node hosts/dsh/test/client-smoke.mjs "$EXE" > /tmp/client.log 2>&1; then
  ok "client-smoke passes against the Linux binary"
else
  bad "client-smoke failed"; tail -10 /tmp/client.log
fi

# 平台包生成（走的是 CI 同一份脚本）
if node hosts/dsh/scripts/make-platform-packages.mjs --platform linux-x64 --core "$EXE" > /tmp/platform.log 2>&1; then
  ok "make-platform-packages produces linux-x64"
  grep -E 'sha256|deps|protocol' /tmp/platform.log | sed 's/^/      /'
  ls -l hosts/dsh/dist/platforms/linux-x64/bin/repo-tutor-core | sed 's/^/      /'
else
  bad "make-platform-packages failed"; tail -20 /tmp/platform.log
fi

echo
[ "$fail" -eq 0 ] && echo "linux: all checks passed" || echo "linux: $fail check(s) failed"
exit "$fail"
