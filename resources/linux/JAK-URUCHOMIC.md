# Litho Studio na Linuksie — jak uruchomić

Paczka `litho-studio-<wersja>.tar.gz` to gotowa aplikacja: nic się nie instaluje,
nie potrzeba uprawnień administratora, wszystko siedzi w jednym folderze i
usuwa się przez skasowanie tego folderu.

Wymagania: 64-bitowy Linux (x86_64) ze środowiskiem graficznym — Ubuntu 20.04+,
Debian 11+, Fedora 36+, Mint, Arch i pochodne działają bez dodatkowej pracy.

---

## Szybka ścieżka

```sh
tar -xzf litho-studio-1.0.0.tar.gz
cd litho-studio-1.0.0
sh uruchom.sh
```

`uruchom.sh` nadaje potrzebne prawa i startuje aplikację. Jeśli wolisz zrobić to
ręcznie albo coś nie zadziała — niżej jest to samo rozpisane na kroki.

---

## Ręcznie, krok po kroku

### 1. Rozpakuj

```sh
tar -xzf litho-studio-1.0.0.tar.gz
cd litho-studio-1.0.0
```

### 2. Nadaj prawa do uruchamiania — tego kroku nie da się pominąć

```sh
chmod +x litho-studio chrome_crashpad_handler chrome-sandbox
```

Ta paczka jest budowana na Windowsie, a Windows nie zna linuksowego bitu
wykonywalności — w archiwum każdy plik ma więc tryb `rw-r--r--`. Bez `chmod`
zobaczysz:

```
bash: ./litho-studio: Permission denied
```

### 3. Uruchom

```sh
./litho-studio
```

---

## Jeśli aplikacja nie startuje

### „The SUID sandbox helper binary was found, but is not configured correctly"

Chromium (na którym stoi Electron) chce, żeby pomocnik `chrome-sandbox` należał
do roota i miał bit SUID. Masz dwie drogi — pierwsza jest właściwa, druga
szybsza:

```sh
# A. Poprawnie: włącz piaskownicę (wymaga hasła administratora, raz)
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
./litho-studio

# B. Na skróty: wyłącz piaskownicę
./litho-studio --no-sandbox
```

Wariant B osłabia izolację procesu renderującego. Litho Studio i tak otwiera
wyłącznie pliki, które sam wskażesz, ale jeśli możesz użyć `sudo` — wybierz A.

### „error while loading shared libraries: libXYZ.so"

Minimalne instalacje (serwerowe, kontenery, niektóre wersje Fedory) nie mają
bibliotek GTK, których wymaga Electron:

```sh
# Debian / Ubuntu / Mint
sudo apt install libgtk-3-0 libnss3 libasound2 libgbm1 libxss1

# Fedora / RHEL
sudo dnf install gtk3 nss alsa-lib mesa-libgbm libXScrnSaver

# Arch / Manjaro
sudo pacman -S gtk3 nss alsa-lib libxss
```

### Okno jest puste, rozmazane albo miga (Wayland)

```sh
./litho-studio --ozone-platform-hint=auto     # natywny Wayland
./litho-studio --disable-gpu                  # gdy problem jest w sterowniku GPU
```

---

## Skrót w menu aplikacji (opcjonalnie)

```sh
INSTALL_DIR="$(pwd)"
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/litho-studio.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Litho Studio
Comment=Wizualny edytor stron WWW
Exec=$INSTALL_DIR/litho-studio
Icon=$INSTALL_DIR/resources/icons/icon-512.png
Categories=Development;WebDevelopment;
Terminal=false
DESKTOP
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

Po tym Litho Studio pojawi się w menu obok innych programów. Skrót wskazuje na
folder, w którym aplikacja leży teraz — jeśli go przeniesiesz, popraw `Exec=`
i `Icon=` albo powtórz powyższe polecenie w nowej lokalizacji.

---

## Czym ta wersja różni się od windowsowej

**Terminal działa w trybie zastępczym.** Moduł `node-pty`, który normalnie daje
prawdziwy pseudoterminal, nie ma gotowej binarki dla Linuksa i nie da się jej
skompilować przy budowaniu paczki na Windowsie. Terminal używa więc polecenia
`script` (pakiet `util-linux`, obecny w każdej normalnej dystrybucji), które
również przydziela prawdziwe TTY — interaktywne programy, `git`, `npm` czy
`claude` działają normalnie. Jedyna różnica: **zmiana rozmiaru okna nie jest
przekazywana do powłoki**, więc programy pełnoekranowe trzymają się rozmiaru z
chwili otwarcia terminala. Aplikacja mówi o tym sama, żółtym napisem przy
starcie terminala.

Jeśli w Twojej dystrybucji terminal zachowuje się dziwnie, można wymusić inny
backend:

```sh
LITHO_TERMINAL_BACKEND=pipe ./litho-studio     # bez TTY, tylko proste polecenia
LITHO_TERMINAL_BACKEND=script ./litho-studio   # wymuś tryb script
```

**Rysowanie idzie przez procesor, nie GPU.** Sterowniki graficzne na Linuksie są
zbyt nierówne, żeby na nie liczyć: przy nieudanej inicjalizacji procesu GPU okno
zostaje puste i nie ma o tym żadnego komunikatu, bo awaria dzieje się poniżej
poziomu strony. Aplikacja z góry przechodzi więc na kompozycję programową. Na
maszynie ze sprawnym sterownikiem można to wyłączyć i zyskać płynniejsze
przewijanie oraz ostrzejszy tekst:

```sh
LITHO_ENABLE_GPU=1 ./litho-studio    # użyj GPU (Linux)
LITHO_DISABLE_GPU=1 ./litho-studio   # wymuś tryb programowy (każdy system)
```

**Nie ma Auto-Installera Narzędzi AI.** Instaluje on globalne narzędzia CLI —
na Linuksie to sprawa menedżera pakietów, nie edytora stron: domyślne `npm
install -g` trafia tam do katalogu należącego do roota, więc przycisk w
aplikacji albo padłby na uprawnieniach, albo po cichu prosiłby o sudo. Dlatego
poza Windowsem tej funkcji nie ma i nie pojawia się w menu ani w nagłówku
terminala. Narzędzia AI instaluje się na Linuksie normalnie, z wbudowanego
terminala:

```sh
npm install -g @anthropic-ai/claude-code    # Claude Code
npm install -g @github/copilot              # GitHub Copilot CLI
npm install -g @xai-official/grok           # Grok CLI
curl https://cursor.com/install -fsS | bash # Cursor Agent
```

---

## Aktualizacja i odinstalowanie

Aktualizacja: rozpakuj nowe archiwum obok i usuń stary folder. Aplikacja nie
trzyma niczego w swoim katalogu — ustawienia i lista ostatnich projektów są w
`~/.config/litho-studio`, a Twoje projekty leżą tam, gdzie je założyłeś.

Odinstalowanie: skasuj folder aplikacji, a jeśli robiłeś skrót — także
`~/.local/share/applications/litho-studio.desktop`. Żeby usunąć również
ustawienia: `rm -rf ~/.config/litho-studio`.
