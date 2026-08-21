; ============================================================================
; Litho Studio - wygląd kreatora instalacji i dezinstalacji (NSIS / MUI2)
; ============================================================================
;
; Domyślny kreator NSIS jest szary i systemowy, a Litho jest ciemne i fioletowe.
; Pierwsze, co użytkownik widzi po pobraniu, to instalator - więc ubieramy go
; w tę samą paletę co aplikację (`src/styles/app.css`).
;
; Trzy rzeczy warto wiedzieć, zanim się tu coś zmieni:
;
;  1. **Ten plik trafia PRZED szablon electron-buildera.** `NsisTarget` skleja
;     skrypt jako `wygenerowane definicje + ten plik + installer.nsi`, więc
;     `!define MUI_*` na górze zdąży zadziałać, zanim MUI wstawi strony. Makra
;     `custom*` są tylko definiowane - szablon wstawia je później, już po
;     `!include MUI2.nsh`.
;
;  2. **MUI koloruje tylko nagłówek oraz strony powitania i zakończenia**
;     (`MUI_BGCOLOR`/`MUI_TEXTCOLOR`). Wnętrza pozostałych stron to zwykłe
;     dialogi Windows - trzeba je pomalować ręcznie, kontrolka po kontrolce,
;     w callbacku `MUI_PAGE_CUSTOMFUNCTION_SHOW`. Ten callback jest jeden na
;     stronę i MUI kasuje go zaraz po wstawieniu strony, dlatego definiujemy go
;     na nowo w każdym miejscu, w które szablon pozwala się wpiąć
;     (`customWelcomePage`, `customPageAfterChangeDir`).
;
;  3. **`SetCtlColors` nie wystarcza - kolor kontrolki bierze się z motywu.**
;     Sam kolor tła i tekstu ustawiamy przez `SetCtlColors`, ale przycisk czy
;     przełącznik rysuje się w całości motywem i te ustawienia zignoruje. Dlatego
;     najpierw włączamy w procesie systemowy tryb ciemny (`lithoEnableDarkMode`)
;     i przełączamy każdą kontrolkę na ciemny wariant klasy motywu
;     (`lithoThemeControl`) - dopiero wtedy przyciski, pola i przełączniki są
;     ciemne. Dwa wyjątki opisane przy kodzie: pasek postępu musi zostać *bez*
;     motywu (inaczej ignoruje nasze kolory), a podpisy przełączników trzeba
;     przenieść do własnych etykiet (`lithoRelabelToggle`), bo motyw maluje je
;     na czarno. Nie do przemalowania zostaje trójwymiarowa oprawa rysowana
;     kolorami systemowymi: rowki linii rozdzielających, wklęsłe ramki pól
;     i wytłoczona ramka grupy - tej nie kolorujemy, tylko ją zdejmujemy
;     (`lithoFlattenChrome`).
;
; Strona wyboru katalogu jest wstawiana tutaj, a nie przez szablon
; (`allowToChangeInstallationDirectory: false` w electron-builder.yml) -
; tylko wtedy da się jej podpiąć malowanie. Wraz z nią przejmujemy jedyną
; rzecz, którą szablon przy tej stronie robił: dopisanie nazwy aplikacji do
; wybranego katalogu (`lithoInstFilesPre`). Z tego samego powodu przejmujemy
; kasowanie plików przy deinstalacji (`customRemoveFiles`) - to jedyne miejsce,
; z którego da się sięgnąć do strony postępu dezinstalatora.
;
; Poza kolorami poprawiamy jeszcze rozkład dwóch stron, na których po zdjęciu
; systemowej oprawy zostawała dziura: wyboru katalogu i postępu. Wszystkie
; odstępy liczymy tam w wysokości wiersza tekstu, więc skalują się razem
; z czcionką systemową i powiększeniem ekranu.
; ============================================================================

!include LogicLib.nsh
!include WinMessages.nsh

; --- paleta: ciemny motyw z :root w src/styles/app.css ----------------------
!define LITHO_SURFACE "15161D" ; --surface-1: tło stron kreatora
!define LITHO_CHROME "1C1E27" ; --surface-2: okno zewnętrzne, czyli pasek przycisków
!define LITHO_INPUT "0E0F14" ; --surface-0: wpuszczone pola, tak jak inputy w aplikacji
!define LITHO_INK "F0F2F8" ; --ink-1
!define LITHO_INK_DIM "A8ADC0" ; --ink-2

; Pasek postępu rysujemy sami (PBM_SET*COLOR pochodzi z WinMessages.nsh),
; a te komunikaty przyjmują COLORREF, czyli 0x00BBGGRR - bajty odwrotnie niż w CSS.
!define LITHO_PROGRESS_BG 0x140F0E ; --surface-0 #0e0f14
!define LITHO_PROGRESS_BAR 0xFF7B8F ; --accent #8f7bff

; MUI maluje pasek nagłówka oraz strony powitania i zakończenia. Dostają ton
; chromu, tak jak pasek narzędzi w aplikacji - wnętrza pozostałych stron
; malujemy niżej na ciemniejsze `--surface-1`, żeby treść była wyraźnie wpuszczona
; między nagłówek a pasek przycisków. Tło header.bmp musi trzymać się tej wartości.
!define MUI_BGCOLOR "${LITHO_CHROME}"
!define MUI_TEXTCOLOR "${LITHO_INK}"
; Lista szczegółów na stronie postępu. Domyślnie jest schowana (`ShowInstDetails
; nevershow` w szablonie), ale gdyby ktoś ją kiedyś odsłonił, ma wyglądać jak
; konsola w aplikacji, a nie jak biała kartka.
!define MUI_INSTFILESPAGE_COLORS "${LITHO_INK} ${LITHO_INPUT}"

!define MUI_WELCOMEPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TITLE_3LINES

; ----------------------------------------------------------------------------
; Teksty
;
; electron-builder tłumaczy własne komunikaty przez messages.yml; nasze wpisujemy
; wprost. Identyfikatory to LCID: 1045 = polski, 1033 = angielski. Lista języków
; instalatora jest zawężona do tych dwóch w electron-builder.yml - gdyby doszedł
; trzeci, trzeba go tu dopisać, inaczej NSIS pokaże pusty napis.
; ----------------------------------------------------------------------------

!ifdef BUILD_UNINSTALLER

  LangString lithoWelcomeTitle 1045 "Dezinstalacja $(^NameDA)"
  LangString lithoWelcomeTitle 1033 "Uninstall $(^NameDA)"

  LangString lithoWelcomeText 1045 "Kreator usunie $(^NameDA) z tego komputera.$\r$\n$\r$\nTwoje strony zostaną nietknięte - Litho edytuje pliki HTML, CSS i JS w miejscu i nigdy nie trzyma ich u siebie. Usuwamy wyłącznie samą aplikację.$\r$\n$\r$\nKliknij Dalej, aby kontynuować."
  LangString lithoWelcomeText 1033 "This wizard will remove $(^NameDA) from your computer.$\r$\n$\r$\nYour sites are left untouched - Litho edits HTML, CSS and JS files in place and never keeps a copy of its own. Only the application itself is removed.$\r$\n$\r$\nClick Next to continue."

  LangString lithoFinishTitle 1045 "$(^NameDA) zostało usunięte"
  LangString lithoFinishTitle 1033 "$(^NameDA) has been removed"

  LangString lithoFinishText 1045 "Aplikacja zniknęła z tego komputera. Pliki Twoich stron zostały na swoim miejscu - otworzysz je dowolnym edytorem albo ponownie w Litho, jeśli kiedyś wrócisz."
  LangString lithoFinishText 1033 "The application is gone from this computer. Your site files stayed where they were - open them in any editor, or in Litho again if you ever come back."

  !define MUI_WELCOMEPAGE_TITLE "$(lithoWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(lithoWelcomeText)"
  !define MUI_FINISHPAGE_TITLE "$(lithoFinishTitle)"
  !define MUI_FINISHPAGE_TEXT "$(lithoFinishText)"

!else

  LangString lithoWelcomeTitle 1045 "Instalacja $(^NameDA)"
  LangString lithoWelcomeTitle 1033 "Install $(^NameDA)"

  LangString lithoWelcomeText 1045 "$(^NameDA) to wizualny edytor stron WWW, który pracuje bezpośrednio na plikach HTML, CSS i JS - bez formatu projektu i bez eksportowania czegokolwiek.$\r$\n$\r$\nInstalacja zajmuje kilkanaście sekund i nie wymaga uprawnień administratora, jeśli wybierzesz instalację tylko dla siebie.$\r$\n$\r$\nKliknij Dalej, aby kontynuować."
  LangString lithoWelcomeText 1033 "$(^NameDA) is a visual website editor that works straight on your HTML, CSS and JS files - no project format, no export step.$\r$\n$\r$\nSetup takes a few seconds and needs no administrator rights if you install it just for yourself.$\r$\n$\r$\nClick Next to continue."

  LangString lithoDirectoryText 1045 "$(^NameDA) zostanie zainstalowane w poniższym folderze. Aby wybrać inny, kliknij Przeglądaj."
  LangString lithoDirectoryText 1033 "$(^NameDA) will be installed in the folder below. To pick another one, click Browse."

  LangString lithoFinishTitle 1045 "$(^NameDA) jest gotowe"
  LangString lithoFinishTitle 1033 "$(^NameDA) is ready"

  LangString lithoFinishText 1045 "Wszystko zainstalowane. Otwórz folder ze stroną - Litho pokaże ją tak, jak zobaczy ją przeglądarka, a każda zmiana trafi prosto do plików na dysku."
  LangString lithoFinishText 1033 "Everything is installed. Open a folder with a site - Litho shows it the way a browser will, and every change goes straight into the files on disk."

  LangString lithoRunText 1045 "Uruchom $(^NameDA)"
  LangString lithoRunText 1033 "Launch $(^NameDA)"

  !define MUI_WELCOMEPAGE_TITLE "$(lithoWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(lithoWelcomeText)"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "$(lithoDirectoryText)"
  !define MUI_FINISHPAGE_TITLE "$(lithoFinishTitle)"
  !define MUI_FINISHPAGE_TEXT "$(lithoFinishText)"
  !define MUI_FINISHPAGE_RUN_TEXT "$(lithoRunText)"

!endif

; ----------------------------------------------------------------------------
; Malowanie
;
; Instalator i dezinstalator to dwa osobne przebiegi kompilacji tego samego
; skryptu (`BUILD_UNINSTALLER`), a funkcje dezinstalatora muszą mieć przedrostek
; `un.` - stąd jedno makro i dwa warianty tych samych funkcji.
; ----------------------------------------------------------------------------

!macro LITHO_STYLE_FUNCTIONS UN

  ; Włącza w procesie tryb ciemny powłoki. Te trzy funkcje uxtheme nie mają nazw
  ; w tablicy eksportów ani nagłówka w SDK - woła się je po numerach porządkowych
  ; i tylko dzięki nim standardowe przyciski, pola wyboru i suwaki dostają ciemny
  ; wariant motywu zamiast szarego (patrz lithoThemeControl).
  ;   135 = SetPreferredAppMode (Windows 10 1903+; w 1809 AllowDarkModeForApp,
  ;         które przyjmuje BOOL - 2 jest różne od zera, więc też włącza)
  ;   104 = RefreshImmersiveColorPolicyState
  ; Na starszym Windowsie GetProcAddress zwróci zero i System::Call nic nie zrobi.
  Function ${UN}lithoEnableDarkMode
    System::Call 'uxtheme::#135(i 2)'
    System::Call 'uxtheme::#104()'
  FunctionEnd

  ; Przełącza pojedynczą kontrolkę (uchwyt w $1) na ciemny wariant motywu.
  ; 133 = AllowDarkModeForWindow - bez niego uxtheme dalej wyda jasną klasę.
  ;
  ; Etykiet (klasa „Static”) NIE motywujemy. Umotywowana etykieta przestaje
  ; rysować napis zwykłym DrawText na tle z SetCtlColors i przechodzi na
  ; DrawThemeText - a ten pisze w trybie przezroczystym, zakładając, że tło pod
  ; napisem odświeży rodzic. Rodzic z WS_CLIPCHILDREN (niżej) obszaru dziecka nie
  ; rusza, więc każde kolejne malowanie kładło litery na poprzednich: przy ruchu
  ; myszą tekst „gęstniał” i rozmazywał się w nieczytelną plamę. Etykiety i tak
  ; biorą kolory z SetCtlColors, więc motyw nie jest im do niczego potrzebny.
  Function ${UN}lithoThemeControl
    Push $R8
    System::Call 'user32::GetClassName(p $1, t .R8, i ${NSIS_MAX_STRLEN})'
    StrCmp $R8 "Static" done
    System::Call 'uxtheme::#133(p $1, i 1)'
    System::Call 'uxtheme::SetWindowTheme(p $1, w "DarkMode_Explorer", p 0)'
    done:
    Pop $R8
  FunctionEnd

  ; Ciemny motyw daje przełącznikom ładny znacznik (ciemne kółko z akcentem),
  ; ale ich podpis rysuje dalej prawie czarnym atramentem - kolor bierze z klasy
  ; „Button”, do której SetCtlColors nie sięga. Zdejmujemy więc przyciskowi tekst
  ; (zostaje sam znacznik) i kładziemy obok zwykłą etykietę, którą malujemy sami.
  ; Etykieta bez SS_NOTIFY jest przezroczysta dla myszy, więc kliknięcie w napis
  ; nadal trafia w przełącznik pod spodem.
  ;
  ; Uchwyt kontrolki w $1, dialog strony w $0 - jak w lithoStyleInnerPage.
  Function ${UN}lithoRelabelToggle
    Push $R0 ; podpis, potem uchwyt czcionki
    Push $R1 ; struktura RECT, potem DPI i uchwyt etykiety
    Push $R2 ; lewa krawędź
    Push $R3 ; górna krawędź
    Push $R4 ; prawa krawędź, potem szerokość
    Push $R5 ; dolna krawędź, potem wysokość

    System::Call 'user32::GetWindowText(p $1, t .R0, i ${NSIS_MAX_STRLEN})'
    StrCmp $R0 "" done ; już przerobiony (np. powrót na tę samą stronę)

    System::Call '*(i, i, i, i) p .R1'
    StrCmp $R1 0 done
    System::Call 'user32::GetWindowRect(p $1, p $R1)'
    ; 2 = liczba punktów w RECT; przelicza ekran → współrzędne dialogu
    System::Call 'user32::MapWindowPoints(p 0, p $0, p $R1, i 2)'
    System::Call '*$R1(i .R2, i .R3, i .R4, i .R5)'
    System::Free $R1

    ; Znacznik ma 13 pikseli przy 96 DPI plus kilka na odstęp; przy innym
    ; powiększeniu rośnie proporcjonalnie. GetDpiForWindow jest od Windows 10
    ; 1607 - starszy system zostawi $R1 zerem i wtedy liczymy jak dla 96.
    StrCpy $R1 0
    System::Call 'user32::GetDpiForWindow(p $0) i .R1'
    ${If} $R1 < 48
      StrCpy $R1 96
    ${EndIf}
    IntOp $R1 $R1 * 17
    IntOp $R1 $R1 / 96
    IntOp $R2 $R2 + $R1
    IntOp $R4 $R4 - $R2
    IntOp $R5 $R5 - $R3

    ; WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | SS_LEFT, a do tego SS_CENTERIMAGE
    ; (0x200), bo
    ; przycisk trzyma swój znacznik w pionowej osi kontrolki, a nie przy górnej
    ; krawędzi. SS_CENTERIMAGE ścina jednak tekst do jednego wiersza, więc gdyby
    ; kontrolka była na tyle wysoka, że podpis ma prawo się zawinąć, zostajemy
    ; przy zwykłym wyrównaniu do góry.
    IntOp $R0 $R1 * 5
    IntOp $R0 $R0 / 2
    ${If} $R5 > $R0
      StrCpy $R0 0x54000000
    ${Else}
      StrCpy $R0 0x54000200
    ${EndIf}
    IntOp $R1 $R0 + 0 ; styl przenosimy do $R1, bo $R0 wraca po tekst
    System::Call 'user32::GetWindowText(p $1, t .R0, i ${NSIS_MAX_STRLEN})'

    System::Call 'user32::CreateWindowEx(i 0, w "STATIC", w R0, i R1, \
      i R2, i R3, i R4, i R5, p $0, p 0, p 0, p 0) p .R1'
    StrCmp $R1 0 done

    SendMessage $1 ${WM_GETFONT} 0 0 $R0
    SendMessage $R1 ${WM_SETFONT} $R0 1
    SetCtlColors $R1 "${LITHO_INK}" "${LITHO_SURFACE}"
    SendMessage $1 ${WM_SETTEXT} 0 "STR:"

    ; Etykieta leży na przycisku, a kontrolki w dialogu domyślnie nie wycinają
    ; rodzeństwa - przełącznik przemalowywałby ją przy każdym najechaniu myszą
    ; i podpis znikałby do następnego odświeżenia. WS_CLIPSIBLINGS (0x04000000)
    ; na przycisku każe mu omijać to, co leży nad nim.
    System::Call 'user32::GetWindowLong(p $1, i -16) i .s'
    Pop $R0
    IntOp $R0 $R0 | 0x04000000
    System::Call 'user32::SetWindowLong(p $1, i -16, i R0)'

    ; …ale „nad nim” trzeba wziąć dosłownie: WS_CLIPSIBLINGS wycina wyłącznie
    ; rodzeństwo stojące WYŻEJ w kolejności Z, a świeżo utworzone dziecko dialogu
    ; ląduje na jej końcu, czyli POD przyciskiem. Dlatego sam styl nic nie dawał
    ; i to jest źródło zgłaszanego glitcha: przy najeździe myszą motyw odrysowywał
    ; przycisk razem z obszarem podpisu, a podpis - nieświadomy, że go zamazano -
    ; nie dostawał WM_PAINT i znikał albo zostawał w połowie. Wynosimy więc
    ; etykietę na wierzch (HWND_TOP = 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
    ; = 0x13); dopiero wtedy wycinanie działa i napis stoi w miejscu.
    System::Call 'user32::SetWindowPos(p $R1, p 0, i 0, i 0, i 0, i 0, i 0x13)'

    done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  ; Okno zewnętrzne: pasek tytułu, tło pod przyciskami i stopka z nazwą wersji.
  ; Wołane raz, z .onGUIInit - te kontrolki żyją tak długo jak kreator.
  Function ${UN}lithoStyleWindow
    Push $0
    Push $1
    Push $2

    ; Ciemny pasek tytułu. 20 to DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+),
    ; 19 to jego numer z wcześniejszych kompilacji. Na starszym systemie oba
    ; wywołania po prostu nic nie robią.
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'

    Call ${UN}lithoEnableDarkMode
    System::Call 'uxtheme::#133(p $HWNDPARENT, i 1)'

    SetCtlColors $HWNDPARENT "${LITHO_INK}" "${LITHO_CHROME}"

    ; Uwaga: oknu zewnętrznemu NIE nadajemy WS_CLIPCHILDREN, choć dialogi stron
    ; go dostają (patrz lithoStyleDialog). Nagłówek jest tu tłem, po którym MUI
    ; przy każdej zmianie strony przesuwa i przepisuje etykiety tytułu - bez
    ; malowania obszaru pod nimi zostają na ekranie napisy z poprzedniej strony,
    ; a razem z nimi znika grafika nagłówka i stopka z wersją.

    ; Kontrolki bez własnych kolorów NSIS maluje na biało - a paski rozdzielające
    ; to właśnie takie puste, dwupikselowe etykiety, które bez tego zostają jasną
    ; kreską pod nagłówkiem i nad przyciskami. Zamiast je chować (MUI i tak
    ; pokazuje je z powrotem na każdej stronie pełnoekranowej) po prostu
    ; malujemy je kolorem chromu, w którym mają zniknąć.
    StrCpy $1 0
    chrome:
      FindWindow $1 "" "" $HWNDPARENT $1
      StrCmp $1 0 branding
      Call ${UN}lithoThemeControl
      Call ${UN}lithoFlattenChrome
      SetCtlColors $1 "${LITHO_INK}" "${LITHO_CHROME}"
      Goto chrome

    branding:
    Call ${UN}lithoStyleFooter

    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; Stopka z nazwą i wersją („Litho Studio 1.0.0”).
  ;
  ; NSIS trzyma ją w dwóch nałożonych na siebie etykietach o tym samym napisie:
  ; 1028 jest wyłączona, więc Windows maluje ją systemową szarością „tekstu
  ; nieaktywnego”, do której SetCtlColors nie sięga - i to ona daje ten przygaszony,
  ; ledwo czytelny napis. Czyścimy jej tekst i zostawiamy samą 1256.
  ;
  ; Domyślnie napis wisi tuż nad kreską rozdzielającą, wcięty inaczej niż treść
  ; strony i inaczej niż przyciski - czyli w niczyim pasie. Przenosimy go do paska
  ; przycisków: lewa krawędź równo z treścią, wysokość równa przyciskom, a pion
  ; wyrównuje SS_CENTERIMAGE.
  Function ${UN}lithoStyleFooter
    Push $0
    Push $R0 ; struktura RECT
    Push $R1 ; lewa krawędź treści
    Push $R2 ; górna krawędź paska przycisków
    Push $R3 ; wysokość przycisku
    Push $R4 ; szerokość napisu

    GetDlgItem $0 $HWNDPARENT 1028
    SendMessage $0 ${WM_SETTEXT} 0 "STR:"

    GetDlgItem $0 $HWNDPARENT 1256
    SetCtlColors $0 "${LITHO_INK_DIM}" "${LITHO_CHROME}"

    System::Call '*(i, i, i, i) p .R0'
    StrCmp $R0 0 done

    ; Lewa krawędź treści: miejsce na strony ma w oknie numer 1018.
    GetDlgItem $0 $HWNDPARENT 1018
    Call ${UN}lithoClientRect
    System::Call '*$R0(i .R1)'

    ; Pion i wysokość bierzemy z przycisku „Dalej” (1), prawą granicę napisu
    ; z lewej krawędzi „Wstecz” (3) - tak napis nigdy nie wejdzie pod przyciski.
    GetDlgItem $0 $HWNDPARENT 1
    Call ${UN}lithoClientRect
    System::Call '*$R0(i, i .R2, i, i .R3)'
    IntOp $R3 $R3 - $R2

    GetDlgItem $0 $HWNDPARENT 3
    Call ${UN}lithoClientRect
    System::Call '*$R0(i .R4)'
    IntOp $R4 $R4 - $R1
    IntOp $R4 $R4 - $R3 ; odstęp od przycisków, skalowany razem z nimi

    System::Free $R0

    GetDlgItem $0 $HWNDPARENT 1256
    System::Call 'user32::GetWindowLong(p $0, i -16) i .s'
    Pop $R0
    IntOp $R0 $R0 | 0x200 ; SS_CENTERIMAGE
    System::Call 'user32::SetWindowLong(p $0, i -16, i R0)'
    System::Call 'user32::MoveWindow(p $0, i R1, i R2, i R4, i R3, i 1)'

    done:
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $0
  FunctionEnd

  ; Wypełnia strukturę RECT spod $R0 położeniem kontrolki $0 względem obszaru
  ; roboczego okna kreatora. GetWindowRect podaje ekran, MapWindowPoints przelicza
  ; (2 = liczba punktów w RECT).
  Function ${UN}lithoClientRect
    System::Call 'user32::GetWindowRect(p $0, p $R0)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p $R0, i 2)'
  FunctionEnd

  ; Zdejmuje z kontrolki (uchwyt w $1) całą trójwymiarową oprawę, którą Windows
  ; rysuje kolorami systemowymi i której żadne `SetCtlColors` nie dosięgnie: linie
  ; rozdzielające zostawiają wtedy biały rowek na ciemnym tle, a pola edycyjne
  ; jasną, wklęsłą ramkę. Strukturę i tak niesie u nas kolor tła, nie krawędzie.
  ;
  ; Wytłoczenie siedzi w SS_TYPEMASK zwykłego stylu, ale sam rowek bierze się
  ; z WS_EX_STATICEDGE w stylu rozszerzonym - trzeba zdjąć jedno i drugie.
  ; Odejmowanie zamiast maski `& 0xFFFFFFE0`, bo taka stała nie mieści się
  ; w zakresie IntOp i po cichu przestaje cokolwiek maskować.
  Function ${UN}lithoFlattenChrome
    Push $2
    Push $3

    System::Call 'user32::GetWindowLong(p $1, i -16) i .r2'
    IntOp $3 $2 & 31
    ${If} $3 >= 16 ; SS_ETCHEDHORZ … SS_ETCHEDFRAME
    ${AndIf} $3 <= 18
      IntOp $2 $2 - $3
      System::Call 'user32::SetWindowLong(p $1, i -16, i r2)'
    ${EndIf}

    System::Call 'user32::GetWindowLong(p $1, i -20) i .r2'
    IntOp $3 $2 & 0x20000 ; WS_EX_STATICEDGE
    IntOp $2 $2 - $3
    IntOp $3 $2 & 0x200 ; WS_EX_CLIENTEDGE
    IntOp $2 $2 - $3
    System::Call 'user32::SetWindowLong(p $1, i -20, i r2)'
    ; SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED - sama zmiana
    ; stylu nie przelicza obszaru nieklienckiego, dopóki okno o to nie poprosi.
    System::Call 'user32::SetWindowPos(p $1, p 0, i 0, i 0, i 0, i 0, i 39)'

    Pop $3
    Pop $2
  FunctionEnd

  ; Wnętrze strony kreatora. Wołane z callbacku SHOW, czyli po utworzeniu dialogu
  ; strony, a przed pokazaniem go użytkownikowi.
  ;
  ; Malujemy WSZYSTKIE dialogi stron, jakie w tej chwili wiszą pod oknem, a nie
  ; „ten pierwszy z brzegu”: przy powrocie na stronę dialog poprzedniej jeszcze
  ; żyje przez moment i potrafi trafić się jako pierwszy - wtedy pomalowaliśmy
  ; jego, a nowa strona zostawała biała (widać to było po kliknięciu Wstecz).
  ; Pomalowanie dialogu, który zaraz zniknie, nic nie kosztuje.
  Function ${UN}lithoStyleInnerPage
    Push $0
    StrCpy $0 0
    pages:
      FindWindow $0 "#32770" "" $HWNDPARENT $0
      StrCmp $0 0 done
      Call ${UN}lithoStyleDialog
      Goto pages

    done:
    Pop $0
  FunctionEnd

  ; To samo dla konkretnego dialogu (uchwyt w $0), gdy strony nie szukamy „tej
  ; pierwszej z brzegu” - patrz lithoStyleProgressPage.
  Function ${UN}lithoStyleDialog
    Push $1
    Push $2
    Push $3
    Push $4

    StrCmp $0 0 abort
    ; Uwaga: dialogu strony NIE zgłaszamy do trybu ciemnego (uxtheme #133).
    ; Etykiety pytają rodzica o kolor tekstu i po takim zgłoszeniu dostają
    ; ciemny atrament, którego nasze SetCtlColors już nie nadpisze - cała treść
    ; strony robi się wtedy czarna na czarnym. Kontrolkom flagę nadajemy
    ; pojedynczo, w pętli niżej.
    SetCtlColors $0 "${LITHO_INK}" "${LITHO_SURFACE}"

    ; Bez WS_CLIPCHILDREN najazd myszą na przycisk/przełącznik/radiobutton każe
    ; motywowi odświeżyć tło przez rodzica (DrawThemeParentBackground), a ten
    ; maluje całym obszarem klienckim strony - łącznie z miejscem pod sąsiednimi
    ; etykietami, które nie odświeżają się same i znikają aż do następnego
    ; przemalowania. Styl każe rodzicowi omijać przy malowaniu obszar zajęty
    ; przez dzieci, więc hover przestaje zamazywać tekst obok.
    System::Call 'user32::GetWindowLong(p $0, i -16) i .r3'
    IntOp $3 $3 | 0x02000000 ; WS_CLIPCHILDREN
    System::Call 'user32::SetWindowLong(p $0, i -16, i r3)'

    StrCpy $1 0
    loop:
      FindWindow $1 "" "" $0 $1
      StrCmp $1 0 repaint
      System::Call 'user32::GetClassName(p $1, t .r2, i ${NSIS_MAX_STRLEN})'

      Call ${UN}lithoFlattenChrome

      ${If} $2 == "msctls_progress32"
        ; Pasek postępu musi zostać bez motywu: umotywowany rysuje się sam,
        ; zielono, i ignoruje PBM_SETBKCOLOR/PBM_SETBARCOLOR.
        System::Call 'uxtheme::SetWindowTheme(p $1, w " ", w " ")'
        SendMessage $1 ${PBM_SETBKCOLOR} 0 ${LITHO_PROGRESS_BG}
        SendMessage $1 ${PBM_SETBARCOLOR} 0 ${LITHO_PROGRESS_BAR}
      ${ElseIf} $2 == "Edit"
        ; Ścieżka instalacji to pole edycyjne - w aplikacji inputy są wpuszczone
        ; o ton głębiej niż tło panelu, więc tutaj też. DarkMode_CFD to wariant
        ; klasy z okna „Otwórz plik”: cienka ramka zamiast jasnego wgłębienia.
        System::Call 'uxtheme::#133(p $1, i 1)'
        System::Call 'uxtheme::SetWindowTheme(p $1, w "DarkMode_CFD", p 0)'
        SetCtlColors $1 "${LITHO_INK}" "${LITHO_INPUT}"
      ${Else}
        Call ${UN}lithoThemeControl
        SetCtlColors $1 "${LITHO_INK}" "${LITHO_SURFACE}"

        ; Rodzaj przycisku siedzi w czterech młodszych bitach stylu.
        ${If} $2 == "Button"
          System::Call 'user32::GetWindowLong(p $1, i -16) i .r3'
          IntOp $4 $3 & 0xF
          ${If} $4 == 7 ; BS_GROUPBOX
            ; Ramkę grupy Windows rysuje kolorami systemowymi i nie da się jej
            ; przyciemnić, więc chowamy ją w całości. Jej podpis („Folder
            ; docelowy") nic nie wnosi ponad tekst nad polem, a samo pole
            ; i przycisk to osobne kontrolki i zostają na miejscu.
            ShowWindow $1 ${SW_HIDE}
          ${ElseIf} $4 >= 2 ; BS_CHECKBOX … BS_AUTO3STATE
          ${AndIf} $4 <= 6
            Call ${UN}lithoRelabelToggle
          ${ElseIf} $4 == 9 ; BS_AUTORADIOBUTTON
            Call ${UN}lithoRelabelToggle
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Goto loop

    ; Nowe kolory obowiązują dopiero przy kolejnym malowaniu. Z callbacku SHOW
    ; strona i tak jest jeszcze niewidoczna, ale stronę postępu dezinstalatora
    ; malujemy, gdy stoi już na ekranie - bez tego zostałaby jasna do pierwszego
    ; odsłonięcia okna.
    repaint:
    System::Call 'user32::InvalidateRect(p $0, p 0, i 1)'

    abort:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
  FunctionEnd

  ; Wypełnia strukturę RECT spod $R0 położeniem kontrolki $1 względem strony $0.
  Function ${UN}lithoPageRect
    System::Call 'user32::GetWindowRect(p $1, p $R0)'
    System::Call 'user32::MapWindowPoints(p 0, p $0, p $R0, i 2)'
  FunctionEnd

  ; Strona postępu.
  ;
  ; Lista szczegółów jest schowana (`ShowInstDetails nevershow`), więc zostaje
  ; sam pasek tuż pod nagłówkiem i pod nim dwieście pikseli pustki. Zsuwamy pasek
  ; razem z napisem o postępie na środek strony - wtedy pusty obszar czyta się
  ; jak marginesy, a nie jak coś, co się nie dorysowało.
  Function ${UN}lithoStyleProgressPage
    Push $0
    Push $1
    Push $R0 ; struktura RECT
    Push $R1 ; szerokość strony
    Push $R2 ; wysokość strony
    Push $R3 ; wysokość paska
    Push $R4 ; wysokość napisu
    Push $R5 ; górna krawędź paska

    ; Strony szukamy po pasku postępu (kontrolka 1004), a nie biorąc pierwszy
    ; dialog z brzegu - przed nią potrafi jeszcze stać w kolejce dialog poprzedniej
    ; strony. I czekamy, aż w ogóle powstanie: w dezinstalatorze wchodzimy tu
    ; z sekcji, a sekcje NSIS wykonuje w osobnym wątku, który startuje szybciej,
    ; niż wątek okna zdąży zbudować stronę postępu. Bez tego czekania malowanie
    ; wypadało w próżnię i strona zostawała biała.
    StrCpy $R5 40 ; ~2 sekundy, potem odpuszczamy
    waitPage:
      StrCpy $0 0
      findPage:
        FindWindow $0 "#32770" "" $HWNDPARENT $0
        StrCmp $0 0 pageMissing
        GetDlgItem $1 $0 1004
        StrCmp $1 0 findPage
        Goto pageReady

      pageMissing:
      IntOp $R5 $R5 - 1
      IntCmp $R5 0 done done 0
      Sleep 50
      Goto waitPage

    pageReady:
    Call ${UN}lithoStyleDialog

    System::Call '*(i, i, i, i) p .R0'
    StrCmp $R0 0 done

    System::Call 'user32::GetClientRect(p $0, p $R0)'
    System::Call '*$R0(i, i, i .R1, i .R2)'

    Call ${UN}lithoPageRect
    System::Call '*$R0(i, i .R3, i, i .R5)'
    IntOp $R3 $R5 - $R3

    GetDlgItem $1 $0 1006 ; napis o bieżącym pliku
    Call ${UN}lithoPageRect
    System::Call '*$R0(i, i .R4, i, i .R5)'
    IntOp $R4 $R5 - $R4

    System::Free $R0

    IntOp $R5 $R2 - $R3
    IntOp $R5 $R5 / 2

    GetDlgItem $1 $0 1004
    System::Call 'user32::MoveWindow(p $1, i 0, i R5, i R1, i R3, i 1)'

    ; napis siada nad paskiem, w odstępie równym jego własnej wysokości
    IntOp $R5 $R5 - $R4
    IntOp $R5 $R5 - $R4
    GetDlgItem $1 $0 1006
    System::Call 'user32::MoveWindow(p $1, i 0, i R5, i R1, i R4, i 1)'

    done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $1
    Pop $0
  FunctionEnd

  !if "${UN}" == ""
    ; Strona zakończenia.
    ;
    ; Układ i kolory tła robi tu MUI (MUI_BGCOLOR), więc zostaje jedno: pole
    ; wyboru „Uruchom …”. Włączony w procesie tryb ciemny sprawia, że motyw rysuje
    ; jego podpis prawie czarnym atramentem. W przeciwieństwie do przełączników na
    ; stronie trybu instalacji wystarczy tu zdjąć motyw - znacznik narysuje się
    ; klasycznie, ale napis weźmie kolor z SetCtlColors i będzie czytelny.
    Function lithoStyleFinishPage
      Push $0
      Push $1
      Push $2

      StrCpy $0 0
      pages:
        FindWindow $0 "#32770" "" $HWNDPARENT $0
        StrCmp $0 0 done

        StrCpy $1 0
        controls:
          FindWindow $1 "" "" $0 $1
          StrCmp $1 0 pages
          System::Call 'user32::GetClassName(p $1, t .r2, i ${NSIS_MAX_STRLEN})'
          ${If} $2 == "Button"
            System::Call 'uxtheme::SetWindowTheme(p $1, w " ", w " ")'
            SetCtlColors $1 "${LITHO_INK}" "${LITHO_CHROME}"
          ${EndIf}
          Goto controls

      done:
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd

    ; Strona wyboru katalogu.
    ;
    ; Układ z NSIS-a zakłada ramkę grupy „Folder docelowy”, która u nas znika
    ; (rysuje się kolorami systemowymi) - a wraz z nią sens odstępu, jaki po niej
    ; zostaje: opis u góry, potem sto pikseli niczego, a pole ze ścieżką dopiero
    ; przy dolnej krawędzi. Zsuwamy więc pole pod opis i wyrównujemy je z lewą
    ; krawędzią treści, tak jak resztę strony.
    ;
    ; Wszystkie odstępy liczymy w wysokościach wiersza tekstu (odległość między
    ; napisami o miejscu na dysku), więc układ skaluje się razem z czcionką
    ; systemową i powiększeniem ekranu.
    Function lithoStyleDirPage
      Call lithoStyleInnerPage

      Push $0
      Push $1
      Push $R0 ; struktura RECT
      Push $R1 ; wysokość wiersza
      Push $R2 ; szerokość strony
      Push $R3 ; górna krawędź pola ze ścieżką
      Push $R4 ; szerokość przycisku „Przeglądaj”
      Push $R5 ; wysokość przycisku „Przeglądaj”
      Push $R6 ; wysokość pola ze ścieżką
      Push $R7 ; obliczenia pomocnicze

      ; Stronę poznajemy po polu ze ścieżką (1019) - tak jak przy stronie postępu,
      ; bo przy powrocie na tę stronę dialog poprzedniej jeszcze przez chwilę żyje.
      StrCpy $0 0
      findPage:
        FindWindow $0 "#32770" "" $HWNDPARENT $0
        StrCmp $0 0 done
        GetDlgItem $1 $0 1019
        StrCmp $1 0 findPage

      System::Call '*(i, i, i, i) p .R0'
      StrCmp $R0 0 done

      System::Call 'user32::GetClientRect(p $0, p $R0)'
      System::Call '*$R0(i, i, i .R2)'

      GetDlgItem $1 $0 1023 ; „Wymagane miejsce”
      Call lithoPageRect
      System::Call '*$R0(i, i .R1)'
      GetDlgItem $1 $0 1024 ; „Dostępne miejsce”
      Call lithoPageRect
      System::Call '*$R0(i, i .R7)'
      IntOp $R1 $R7 - $R1
      ${If} $R1 < 8 ; gdyby NSIS kiedyś przestawił te napisy
        StrCpy $R1 16
      ${EndIf}

      GetDlgItem $1 $0 1001 ; „Przeglądaj”
      Call lithoPageRect
      System::Call '*$R0(i .R6, i .R7, i .R4, i .R5)'
      IntOp $R4 $R4 - $R6
      IntOp $R5 $R5 - $R7

      GetDlgItem $1 $0 1019
      Call lithoPageRect
      System::Call '*$R0(i, i .R6, i, i .R7)'
      IntOp $R6 $R7 - $R6

      System::Free $R0

      IntOp $R3 $R1 * 3 ; opis mieści się w trzech wierszach

      GetDlgItem $1 $0 1006 ; opis nad polem
      System::Call 'user32::MoveWindow(p $1, i 0, i 0, i R2, i R3, i 1)'

      ; Wiersz zaczyna się dokładnie tam, gdzie kończy się opis: to przycisk jest
      ; wyższy od pola, więc on wyznacza górę wiersza, a pole schodzi na jego oś.
      ; Odwrotnie (pole na górze wiersza) przycisk wystawałby ponad wiersz i opis
      ; przycinałby mu górną krawędź.
      IntOp $R7 $R2 - $R4 ; przycisk równo z prawą krawędzią treści
      GetDlgItem $1 $0 1001
      System::Call 'user32::MoveWindow(p $1, i R7, i R3, i R4, i R5, i 1)'

      IntOp $R0 $R5 - $R6
      IntOp $R0 $R0 / 2
      IntOp $R0 $R3 + $R0 ; pole w jednej osi z przyciskiem
      IntOp $R7 $R7 - $R1 ; odstęp między polem a przyciskiem
      GetDlgItem $1 $0 1019
      System::Call 'user32::MoveWindow(p $1, i 0, i R0, i R7, i R6, i 1)'

      IntOp $R7 $R3 + $R5
      IntOp $R7 $R7 + $R1
      GetDlgItem $1 $0 1023
      System::Call 'user32::MoveWindow(p $1, i 0, i R7, i R2, i R1, i 1)'
      IntOp $R7 $R7 + $R1
      GetDlgItem $1 $0 1024
      System::Call 'user32::MoveWindow(p $1, i 0, i R7, i R2, i R1, i 1)'

      done:
      Pop $R7
      Pop $R6
      Pop $R5
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
      Pop $1
      Pop $0
    FunctionEnd
  !endif

!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro LITHO_STYLE_FUNCTIONS "un."
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.lithoStyleWindow
!else
  !insertmacro LITHO_STYLE_FUNCTIONS ""
  !define MUI_CUSTOMFUNCTION_GUIINIT lithoStyleWindow

  !include StrContains.nsh

  ; Odpowiednik `instFilesPre` z szablonu electron-buildera: katalog wskazany
  ; przez użytkownika dostaje podfolder z nazwą aplikacji, żeby deinstalacja
  ; nigdy nie kasowała czegoś w rodzaju C:\Program Files.
  Function lithoInstFilesPre
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  FunctionEnd
!endif

; ----------------------------------------------------------------------------
; Strony
;
; Każde `!define MUI_PAGE_CUSTOMFUNCTION_SHOW` obowiązuje dla najbliższej
; wstawianej strony i znika po niej - kolejność poniżej odwzorowuje kolejność
; z assistedInstaller.nsh i nie da się jej przestawić.
; ----------------------------------------------------------------------------

!macro customWelcomePage
  ; Powitanie: pełnoekranowa strona z grafiką boczną, kolory od MUI.
  !insertmacro MUI_PAGE_WELCOME
  ; Następna w kolejce jest strona wyboru trybu instalacji (dla kogo instalujemy).
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW lithoStyleInnerPage
!macroend

!macro customPageAfterChangeDir
  !insertmacro skipPageIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW lithoStyleDirPage
  !insertmacro MUI_PAGE_DIRECTORY

  ; Następna w kolejce jest strona postępu instalacji.
  !define MUI_PAGE_CUSTOMFUNCTION_PRE lithoInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW lithoStyleProgressPage
!macroend

; Strona zakończenia. Przejmujemy ją tylko po to, żeby podpiąć malowanie - reszta
; jest jeden do jednego tym, co robi szablon (assistedInstaller.nsh) w gałęzi bez
; tego makra: uruchomieniem aplikacji po instalacji zajmuje się StartApp.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW lithoStyleFinishPage
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.lithoStyleInnerPage
!macroend

; Strona postępu dezinstalacji.
;
; Jako jedyna nie ma wolnego callbacku SHOW: ten sprzed niej zjada strona wyboru
; trybu deinstalacji, a szablon nie zostawia między nimi miejsca na wpięcie się.
; Zostaje jedyne wejście, jakie tam sięga - makro kasujące pliki, wstawiane na
; początku sekcji `un.install`, czyli już przy widocznej stronie postępu.
; Malujemy ją i oddajemy sterowanie: poniżej jest dokładnie to, co robi szablon
; (uninstaller.nsh) w gałęzi bez tego makra, i tylko tyle.
!macro customRemoveFiles
  Call un.lithoStyleProgressPage

  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  RMDir /r $INSTDIR
!macroend
