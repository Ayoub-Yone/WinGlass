---
name: win32-tauri-overlay-invariants
description: Règles strictes pour fenêtres overlay transparentes Win32 sous Tauri v2 (dock, toast, barre flottante). Utiliser dès qu'on masque la barre des tâches Windows 11, gère HWND_TOPMOST, click-through, plein écran, raccourci d'urgence, guardian de récupération ou SetWinEventHook. Interdit les setters tao après init.
---

# Invariants Win32 pour overlays Tauri v2

Source : WinGlass `src-tauri/src/win32/{window_manager,taskbar,guardian,sentinel}.rs`. Détails : `[[WinGlass - Invariants Win32 et Windows 11]]`.

## Règle 1 : HWND bruts uniquement après le démarrage
Sur une fenêtre overlay, jamais `set_ignore_cursor_events`, `set_always_on_top`, `show`, `hide` de tao après init : tao réécrit les styles depuis ses drapeaux et la fenêtre disparaît. Seule exception : un unique `set_ignore_cursor_events(true)` dans `prepare_overlay`, fenêtre encore cachée. Helpers autorisés :

```rust
fn set_click_through(hwnd: HWND, click_through: bool) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = overlay_ex_style(ex, click_through); // ne change que WS_EX_TRANSPARENT
        if wanted != ex { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted); }
    }
}
pub fn show_no_activate(window: &WebviewWindow) {
    if let Ok(raw) = window.hwnd() {
        let hwnd = HWND(raw.0 as *mut core::ffi::c_void);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}
fn hide_overlay(window: &WebviewWindow) { /* ShowWindow(hwnd, SW_HIDE) : seul chemin qui masque */ }
```
`prepare_overlay` : une fois avant le premier affichage, `SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)` puis click-through actif.

## Règle 2 : masquer la barre des tâches en toute sécurité
- Capturer l'état AppBar d'origine **une seule fois**, avant toute modification, dans un fichier simple (`%APPDATA%\<app>\taskbar_state.json`, sans verrou, lisible depuis un panic hook).
- Masquer `Shell_TrayWnd` **et** `Shell_SecondaryTrayWnd` (`ABS_AUTOHIDE` + `SW_HIDE`). Windows 11 les réaffiche à l'ouverture du menu Démarrer : watcher 500 ms qui re-masque.
- `restore()` idempotent : `SW_SHOW` sur toutes les barres, puis `ABM_SETSTATE` d'origine, puis suppression du fichier d'état.
- Appeler `restore()` depuis : panic hook, `SetConsoleCtrlHandler`, `WM_QUERYENDSESSION`/`WM_ENDSESSION`, `WM_CLOSE`, `RunEvent::ExitRequested`/`Exit`, menu « Restaurer et quitter », raccourci d'urgence.
- Profil release avec `panic = "unwind"` (sinon le panic hook ne peut pas restaurer).
- Instance unique : mutex nommé `Global\<App>SingleInstanceMutex`, `exit(0)` avant toute modification si `ERROR_ALREADY_EXISTS`.

## Règle 3 : guardian et watchdog
Arrêt brutal (`taskkill /F`) : copie sans fenêtre du même exe, `--<app>-guardian <pid>`, attend le handle du processus puis répare depuis le fichier d'état.
```rust
Command::new(std::env::current_exe()?)
    .arg(GUARDIAN_FLAG).arg(std::process::id().to_string())
    .creation_flags(CREATE_NO_WINDOW.0 | DETACHED_PROCESS.0).spawn()
```
Watchdog de sortie : après `restore()`, un thread dort `EXIT_GRACE` puis `TerminateProcess` (un process qui traîne garde le mutex et bloque le lancement suivant).

## Règle 4 : raccourci d'urgence et plein écran
Fenêtre sentinelle (`win32/sentinel.rs`) :
```rust
RegisterHotKey(Some(hwnd), HOTKEY_RESTORE_ID, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, u32::from(b'R'))
SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(foreground_hook), 0, 0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
```
Le raccourci appelle `restore()` et persiste le mode `native`. Le hook réveille le watcher plein écran (repli : poll 150 ms). Règle : masquer l'overlay **seulement** si la fenêtre au premier plan actuelle est plein écran sur son moniteur ; ignorer les classes shell (`Progman`, `WorkerW`, trays, `XamlExplorerHostIslandWindow`, `MultitaskingViewFrame`) et soi-même. Fonction pure, testée (`should_hide_for`).

## Règle 5 : COM
Chaque thread appelle `CoInitializeEx`/`RoInitialize` lui-même. Aucun objet COM/WinRT ne traverse un thread non initialisé pour lui.

## Garde
Toute action système critique (alimentation, registre, fichiers système) exige une confirmation utilisateur. Ne jamais afficher, cliquer ni révéler la barre native pour agir.
