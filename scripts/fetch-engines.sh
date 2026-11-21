#!/usr/bin/env bash
# 앱에 넣을 엔진 두 가지를 npm 에서 받아 assets/www/ 에 넣는다. 버전과 무결성(sha512)을 고정해 바뀐 파일은 거부한다.
# - HWP: @rhwp/core (MIT)  → assets/www/engine/
# - PDF: pdfjs-dist (Apache-2.0, Mozilla pdf.js) → assets/www/pdfjs/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="$ROOT/app/src/main/assets/www"

fetch() { # 이름 버전 무결성 → 풀린 폴더 경로를 출력
  local name="$1" version="$2" integrity="$3" tmp
  tmp="$(mktemp -d)"
  ( cd "$tmp" && npm pack "$name@$version" --silent >/dev/null )
  local tgz; tgz="$(ls "$tmp"/*.tgz)"
  local actual="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 | tr -d '\n')"
  if [ "$actual" != "$integrity" ]; then echo "integrity mismatch for $name: $actual" >&2; exit 1; fi
  mkdir -p "$tmp/x" && tar xzf "$tgz" -C "$tmp/x" --strip-components=1
  echo "$tmp/x"
}

RHWP_VERSION="0.9.0"
RHWP_INTEGRITY="sha512-dEe9gtEM5QXAoJjX+fwgbN5KIo0a6X/wgwEg0LDcq9oY1ga5lD5vNkediFSSX4Xxs8VfFk//dbk71aMQ8J1uAQ=="
if [ -f "$WWW/engine/rhwp_bg.wasm" ] && [ "$(cat "$WWW/engine/VERSION" 2>/dev/null)" = "$RHWP_VERSION" ]; then
  echo "rhwp $RHWP_VERSION already in place"
else
  src="$(fetch @rhwp/core "$RHWP_VERSION" "$RHWP_INTEGRITY")"
  rm -rf "$WWW/engine" && mkdir -p "$WWW/engine"
  cp "$src/rhwp.js" "$src/rhwp_bg.wasm" "$src/LICENSE" "$WWW/engine/"
  cp -r "$src/notices" "$WWW/engine/notices"
  echo "$RHWP_VERSION" > "$WWW/engine/VERSION"
  echo "rhwp $RHWP_VERSION -> $WWW/engine"
fi

PDFJS_VERSION="5.4.449"
PDFJS_INTEGRITY="sha512-CegnUaT0QwAyQMS+7o2POr4wWUNNe8VaKKlcuoRHeYo98cVnqPpwOXNSx6Trl6szH02JrRcsPgletV6GmF3LtQ=="
if [ -f "$WWW/pdfjs/pdf.min.js" ] && [ "$(cat "$WWW/pdfjs/VERSION" 2>/dev/null)" = "$PDFJS_VERSION" ]; then
  echo "pdf.js $PDFJS_VERSION already in place"
else
  src="$(fetch pdfjs-dist "$PDFJS_VERSION" "$PDFJS_INTEGRITY")"
  rm -rf "$WWW/pdfjs" && mkdir -p "$WWW/pdfjs"
  # .mjs 는 안드로이드 WebView 가 JS 로 알아보지 못해 모듈로 못 읽으므로 .js 이름으로 넣음
  cp "$src/build/pdf.min.mjs" "$WWW/pdfjs/pdf.min.js"
  cp "$src/build/pdf.worker.min.mjs" "$WWW/pdfjs/pdf.worker.min.js"
  cp "$src/LICENSE" "$WWW/pdfjs/"
  cp -r "$src/cmaps" "$src/standard_fonts" "$WWW/pdfjs/"   # 한글 PDF 글꼴 정보(CMap)와 기본 글꼴
  echo "$PDFJS_VERSION" > "$WWW/pdfjs/VERSION"
  echo "pdf.js $PDFJS_VERSION -> $WWW/pdfjs"
fi
