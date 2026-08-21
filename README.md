# Litho Studio

Wizualny edytor stron, który **edytuje prawdziwe pliki HTML, CSS i JS na dysku**. Nie ma formatu projektu, nie ma kroku eksportu, nie ma bazy danych z układem strony - otwierasz katalog ze stroną, klikasz w elementy, a zmiany lądują z powrotem w tych samych plikach. Możesz w każdej chwili przestać używać Litho i pracować dalej w zwykłym edytorze tekstu.

Aplikacja desktopowa na Electronie (Windows, Linux, macOS).

## Główna idea

Większość edytorów WYSIWYG trzyma stronę we własnym formacie i generuje HTML dopiero przy eksporcie - efekt jest taki, że kod wyjściowy jest nieczytelny, a powrót do ręcznej edycji oznacza koniec pracy z edytorem. Litho działa odwrotnie: **plik na dysku jest jedynym źródłem prawdy.** Parser (`htmlParser.ts`) czyta istniejący dokument, edytor operuje na jego strukturze, a generatory (`htmlGenerator.ts`, `cssGenerator.ts`, `jsGenerator.ts`) zapisują wynik z powrotem, zachowując formatowanie.

## Funkcje

**Kanwa i edycja wizualna**
- Bezpośrednia manipulacja elementami z uchwytami transformacji (`TransformControls.tsx`)
- Menu kontekstowe na elementach, edycja tekstu na miejscu (`richTextEditor.ts`)
- Przeciąganie i upuszczanie z kontrolą miejsca wstawienia (`insertionTarget.ts`, `canvasDrop.ts`)
- Kontrola powiększenia i podgląd na żywo w osobnym panelu

**Panele robocze**

| Panel | Rola |
|---|---|
| Elements / Layers | Drzewo dokumentu i warstwy |
| Properties / Styles | Edycja atrybutów i CSS-a wybranego elementu |
| StyleSheets | Zarządzanie arkuszami stylów |
| Components | Komponenty wielokrotnego użytku |
| Assets | Grafiki i zasoby projektu |
| Icons | Google Material Symbols (`materialSymbolIcons.ts`) |
| Console | Wyjście konsoli podglądanej strony |
| Terminal | Pełny terminal w oknie edytora (`node-pty` + xterm.js) |
| Audit | Kontrola jakości strony (`pageAudit.ts`) |

**Praca z projektem**
- **Responsywność** - pasek punktów granicznych (`BreakpointBar.tsx`) do sprawdzania układu na różnych szerokościach
- **Wiele podstron** - przełącznik stron i wspólne sekcje współdzielone między nimi (`sharedSections.ts`)
- **Meta i SEO** - edycja zawartości `<head>` (`headMeta.ts`)
- **Skrypty na elemencie** - podpinanie kodu JS pod konkretny element (`elementScripts.ts`)
- **Animacje pojawiania** - `revealHooks.ts`
- **Google Fonts** - wbudowana przeglądarka krojów
- **Historia zmian** - cofanie i ponawianie (`historyStore.ts`)
- **Obserwowanie plików** - `chokidar` wychwytuje zmiany zrobione poza edytorem i synchronizuje je z kanwą
- **Wykrywanie brakujących odwołań** - baner ostrzega, gdy strona linkuje do nieistniejącego pliku
- **Instalator narzędzi AI** - dialog pobierający CLI dostawców AI (tylko Windows - uzasadnienie decyzji jest opisane w komentarzu w `shared/aiTools.ts`)
- **Aktualizacje** - przy starcie aplikacja pyta serwer o najnowszą wersję i pokazuje baner; „Pobierz" otwiera stronę pobierania w przeglądarce, nie ściąga nic w tle

## Architektura

```
electron/           proces główny
  main.ts           okno, cykl życia aplikacji
  preload.ts        most do renderera (window.litho)
  menu.ts           menu aplikacji
  ipc/              usługi wystawiane przez IPC:
                    pliki, projekt, zasoby, podgląd, terminal,
                    watcher, formatter, aktualizacje, narzędzia AI
  ipc/pathGuard.ts  kontrola, że operacje nie wychodzą poza katalog projektu

src/                renderer (React + TypeScript)
  engine/           parsery i generatory HTML/CSS/JS, synchronizacja DOM
  components/       kanwa, panele, dialogi, pasek narzędzi
  state/            editorStore, historyStore, uiStore, aiToolsStore
  lib/              pomocniki: ikony, fonty, drag&drop, platforma

shared/             typy i kontrakty wspólne dla obu procesów
  ipc.ts            definicje kanałów IPC
  document.ts       model dokumentu
  aiTools.ts        katalog narzędzi AI
```

Podział jest ścisły: proces główny odpowiada za dysk i system, renderer za interfejs, a `shared/` trzyma kontrakt między nimi w jednym miejscu, żeby obie strony nie rozjechały się w definicjach. `pathGuard.ts` pilnuje, żeby żadna operacja plikowa nie wyszła poza otwarty katalog projektu.

## Stos

Electron · React 18 · TypeScript · Vite · esbuild · chokidar · node-pty + xterm.js · Prettier (formatowanie generowanego kodu) · electron-log

Kontrola jakości: ESLint, Prettier, Vitest (testy jednostkowe z pokryciem), Playwright (testy e2e).

## Uruchomienie

```bash
npm install
npm run dev
```

## Skrypty

| Polecenie | Działanie |
|---|---|
| `npm run dev` | Tryb deweloperski |
| `npm run build` | Build produkcyjny (renderer + electron) |
| `npm run typecheck` | Kontrola typów |
| `npm run lint` / `lint:fix` | ESLint |
| `npm test` / `test:watch` / `test:coverage` | Vitest |
| `npm run test:e2e` | Playwright |
| `npm run package:win` | Instalator Windows (NSIS + wersja portable) |
| `npm run package:linux:appimage` | AppImage |
| `npm run package:linux:deb` | Pakiet `.deb` |
| `npm run version:set 1.0.7` | Podbicie wersji |

## Wersjonowanie

Numer wersji jest zapisany **wyłącznie** w `package.json`. Wszystko inne bierze go stamtąd automatycznie: electron-builder do nazw plików wyjściowych, `app.getVersion()` do sprawdzania aktualizacji, a pasek stanu przez `window.litho.appVersion` z preloadu. Jedno miejsce, żadnej ręcznej synchronizacji.

## Czego nie ma w repozytorium

- **`release/`** - zbudowane instalatory i rozpakowana aplikacja (618 MB)
- **`dist/`** - artefakty kompilacji, odtwarzane przez `npm run build`
- **`certs/`** - certyfikat i klucz prywatny do podpisywania instalatorów; zostają wyłącznie lokalnie
