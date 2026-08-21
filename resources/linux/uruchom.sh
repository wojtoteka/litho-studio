#!/bin/sh
#
# Uruchamia Litho Studio z rozpakowanego folderu.
#
# Istnieje, bo paczka .tar.gz powstaje na Windowsie, który nie zna linuksowego
# bitu wykonywalności - po rozpakowaniu żaden plik nie jest wykonywalny i samo
# `./litho-studio` kończy się „Permission denied”. Ten skrypt nadaje brakujące
# prawa (idempotentnie) i startuje aplikację.
#
# Sam też przyjeżdża bez prawa do wykonywania, więc uruchamia się go przez
# interpreter: `sh uruchom.sh`. Wszystkie argumenty są przekazywane dalej, np.
# `sh uruchom.sh --no-sandbox`.

set -eu

cd "$(dirname "$0")"

if [ ! -f ./litho-studio ]; then
  echo "Nie znalazłem pliku ./litho-studio - uruchom ten skrypt z folderu rozpakowanej aplikacji." >&2
  exit 1
fi

chmod +x ./litho-studio ./chrome_crashpad_handler 2>/dev/null || true
[ -f ./chrome-sandbox ] && chmod +x ./chrome-sandbox 2>/dev/null || true

# Windows nie zna bitu wykonywalności, więc biblioteki .so (libGLESv2.so,
# libEGL.so, SwiftShader/Vulkan) też przyjeżdżają bez niego. libGLESv2.so to
# jednocześnie programowy fallback GL Chromium - bez prawa do niego proces GPU
# wchodzi w pętlę restartów i okno nigdy nie dostaje poprawnych atrybutów X11.
find . -name '*.so*' -type f -exec chmod +x {} + 2>/dev/null || true

# Piaskownica Chromium wymaga, żeby chrome-sandbox należał do roota i miał bit
# SUID. Nadanie tego wymaga hasła administratora, więc skrypt tego NIE robi za
# użytkownika - zamiast tego wykrywa brak i dokłada --no-sandbox, żeby aplikacja
# w ogóle wstała. Jak włączyć piaskownicę na stałe, opisuje JAK-URUCHOMIC.md.
SANDBOX_ARGS=""
if [ ! -u ./chrome-sandbox ]; then
  echo "[uruchom.sh] chrome-sandbox nie ma bitu SUID - startuję z --no-sandbox."
  echo "[uruchom.sh] Aby włączyć piaskownicę: sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox"
  SANDBOX_ARGS="--no-sandbox"
fi

exec ./litho-studio $SANDBOX_ARGS "$@"
