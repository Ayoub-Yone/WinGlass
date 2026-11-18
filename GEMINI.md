# WinGlass (C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\05 - Projects\WinGlass) — Contexte & Règles Antigravity

## 1. Identité & Stack
- **Application :** WinGlass (remplacement natif de la barre des tâches Windows 11, anciennement `lumabar`).
- **Binaire & Packaging :** L'application installée s'appelle `WinGlass` (`WinGlass.exe`), tandis que le binaire Rust release reste `lumabar.exe` (`src-tauri/target/release/lumabar.exe`) pour préserver le démarrage automatique et le watchdog de restauration.
- **Stack :** Rust + Tauri v2 + React 19 + TypeScript + WebGL2 + SQLite / DPAPI.

## 2. Invariants Win32 Critiques (NE JAMAIS VIOLER)
1. **Fenêtre Overlay (`tao`) :** Ne jamais appeler les méthodes de fenêtre `tao` (`set_ignore_cursor_events`, `set_always_on_top`, `show`, `hide`) après le démarrage. Utiliser exclusivement les helpers Win32 bruts (`prepare_overlay`, `show_no_activate`, `set_click_through`, `hide_overlay`, `HWND_TOPMOST`).
2. **Barre des tâches native :** Masquer `Shell_TrayWnd` et `Shell_SecondaryTrayWnd` via le mode `completely_hidden` avec fichier d'état crash-recovery, panic hook, processus watchdog externe et raccourci d'urgence `Ctrl + Alt + Shift + R`.
3. **Capture DXGI Live :** Utiliser `IDXGIOutputDuplication` avec `WDA_EXCLUDEFROMCAPTURE` et gating `DirtyRects` (0 % CPU/GPU au repos).
4. **Détection Plein Écran / Jeux :** Vérifier uniquement la fenêtre au premier plan via `SetWinEventHook` (`EVENT_SYSTEM_FOREGROUND`) pour réafficher instantanément le dock lors d'un `Alt+Tab` ou appui sur la touche `Win`.

## 3. Fonctionnalités Déjà Implémentées
- **Shader iOS Liquid Glass (`src/components/LiquidGlassCanvas.tsx`) :** Biseau optique périphérique de 18 px avec dispersion chromatique, déformation liquide dynamique de 8,5 px sous le curseur (plafonnée à ~2,7 px côté bord d'écran), boost de saturation ×1,32, adaptation à la luminance de l'arrière-plan (lissage 300 ms), curseur continu `Clair ↔ Givré` (`glassFrostLevel` 0–100) et 5 thèmes (`iOS Liquid Glass`, `Matte Liquid Glass`, `Midnight Obsidian`, `Frost White`, `Pure OLED Black`) avec rayons concentriques.
- **Magnification :** Zoom icônes à 1,34×, compression des voisines à 0,84× / 0,92×, marge verticale de 22 px.
- **Mini Lecteur Musical Style iPhone :** Pochette d'album plein écran avec fondu enchaîné, scrim sombre adaptatif, bordure spéculaire 1 px, synchronisation SMTC / Liner.
- **Widgets & Système :** Icône réseau Ethernet filaire vs Wi-Fi (`GetBestInterface` / `GetAdaptersAddresses`), aperçus de fenêtres en direct au survol (`PrintWindow` + `PW_RENDERFULLCONTENT`), grille 5 colonnes des icônes cachées (`^`) via `IUIAutomation` silencieux avec menu contextuel intégré (sans jamais révéler la zone de notification Windows native), mixeur audio WASAPI par application, recherche locale d'applications (`Win+S`), et option de masquage automatique du dock (disparition quand le curseur s'éloigne de plus de 24 px, réapparition à moins de 3 px du bord de l'écran).

## 4. Tâches Restantes / Priorités
1. **Liquid Glass Ultra-Clair & Synchronisation Couleur Globale :** Réduire encore `tintAlpha` (0,02–0,14) et le flou par défaut pour un rendu beaucoup plus clair et vitré sur toute la longueur du dock, et synchroniser les reflets/courbures des bords avec la couleur dynamique de la musique en cours.
2. **Démarrage Automatique Autonome (Release GitHub) :** Vérifier/activer l'enregistrement automatique au démarrage Windows dans le code Rust au premier lancement + ajouter la case à cocher dans le panneau Paramètres + générer l'installateur NSIS (`npm run tauri build`).
3. **Archivage Obsidian :** Détecter le coffre via `%APPDATA%\obsidian\obsidian.json` et sauvegarder l'architecture, les invariants Win32 et les templates dans `01 - Learning/WinGlass/` et `05 - Projects/_Templates/` (coffre `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE`).
