# GEMINI.md — Instructions & Invariants du Projet WinGlass

Tu es l'agent d'ingénierie logicielle sur **WinGlass** (anciennement *winglass*), un dock système macOS / iOS 26 Liquid Glass natif pour Windows 11 construit avec **Tauri v2, Rust, React 19, TypeScript et WebGL2**.

---

## 1. Chemins Locaux & Environnement (Strict)

Le projet réside exclusivement sur le disque local (hors OneDrive) :

- **Dépôt Git du projet :** `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\05 - Projects\WinGlass`
- **Coffre Obsidian :** `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE`
- **Base de connaissances Obsidian :** `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\01 - Learning\WinGlass`
- **Modèles Obsidian :** `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\05 - Projects\_Templates`
- **Cache de compilation Rust (`.cargo/config.toml`) :** `C:/BuildCache/winglass`
- **Binaire Release compilé :** `C:\BuildCache\winglass\release\winglass.exe`
- **Installateur NSIS distribuable :** `C:\BuildCache\winglass\release\bundle\nsis\`

> **Règle d'identité :** Le nom d'affichage est **WinGlass**, tandis que le nom technique du binaire/crate et du dossier utilisateur (`%APPDATA%\winglass`) reste `winglass` sauf demande explicite. Ne jamais hardcoder d'anciens chemins (`OneDrive`, `C:\Projects\winglass`, `OBSIDIAN WEBSITE`, `SITE WEB`).

---

## 2. Architecture & Stack Technique

- **Backend Rust (`src-tauri/src/`) :**
  - **Fenêtrage & Overlays Win32 :** Gestion directe des `HWND` sans bordure, transparents et toujours au premier plan (`HWND_TOPMOST`), sans vol de focus.
  - **Capture d'écran temps réel DXGI :** `IDXGIOutputDuplication` avec `WDA_EXCLUDEFROMCAPTURE`, buffer de staging sans réallocation et mise à jour conditionnée par `DirtyRects` au repos.
  - **Audio par application :** Mixeur natif **WASAPI** (`IAudioSessionManager2` / `ISimpleAudioVolume`).
  - **Barre d'état système (System Tray) :** Extraction silencieuse des icônes cachées via **Windows UI Automation** (`IUIAutomation`) et menu contextuel intégré à 5 colonnes.
  - **Lanceur & Recherche d'applications :** Indexation du Menu Démarrer et du Registre Windows + cache d'icônes LRU.
  - **Persistance & Sécurité :** Base **SQLite** locale et chiffrement des secrets/OAuth via **Windows DPAPI**.
- **Frontend React 19 + WebGL2 (`src/`) :**
  - **`LiquidGlassCanvas.tsx` :** Moteur de rendu WebGL2 physique *iOS Liquid Glass* (réfraction SDF sur biseau de `18px`, dispersion chromatique périphérique, déformation liquide au survol du curseur, synchronisation des bords avec la couleur dynamique de la musique/du thème, adaptation automatique à la luminance d'arrière-plan).
  - **`Dock.tsx` :** Gestion de la physique du curseur à 60–120 FPS via `requestAnimationFrame` (zéro re-rendu React au mouvement de la souris), magnification synchronisée des icônes et déclenchement au bord d'écran (`autoHideDock`).

---

## 3. Invariants Win32 & Windows 11 (NE JAMAIS VIOLER)

1. **Interdiction des setters `tao` après le démarrage :**
   - **NE JAMAIS** appeler `set_ignore_cursor_events`, `set_always_on_top`, `show` ou `hide` via les méthodes `tao`/Tauri après l'initialisation de la fenêtre.
   - Utiliser **exclusivement** les helpers Win32 bruts dans `src-tauri/src/window_manager.rs` : `prepare_overlay`, `show_no_activate`, `set_click_through`, `hide_overlay`.
2. **Masquage de la barre des tâches Windows 11 (`completely_hidden`) :**
   - Toujours gérer conjointement `Shell_TrayWnd` (écran principal) et `Shell_SecondaryTrayWnd` (écrans secondaires).
   - Préserver impérativement le processus gardien de récupération après crash, le watchdog et le raccourci d'urgence **`Ctrl+Alt+Shift+R`** pour restaurer la barre des tâches Windows.
3. **Détection plein écran & réveil instantané :**
   - Utiliser uniquement le hook de premier plan (`SetWinEventHook` sur `EVENT_SYSTEM_FOREGROUND`) pour masquer le dock devant les jeux/applications plein écran et garantir un réveil instantané via `Alt+Tab`.
4. **Marge verticale transparente de l'overlay :**
   - La fenêtre transparente `HWND` du dock doit toujours réserver une marge transparente d'au moins **`>= 22px`** au-dessus et au-dessous de la capsule afin que les gonflements liquides (`bulge`), ondulations réfractives et icônes agrandies ne soient jamais coupés par les bords de la fenêtre.
5. **Géométrie concentrique stricte :**
   - Respecter `innerRadius = max(8px, outerRadius - dockPadding)` entre la capsule externe du dock, les tuiles internes (lecteur musical pochette plein écran, widgets) et les popups flottants.

---

## 4. Commandes de Compilation, Vérification et Git

Toujours exécuter les commandes depuis `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\05 - Projects\WinGlass` :

```powershell
# 1. Vérification TypeScript & Build Frontend
npm run build

# 2. Compilation Rust Release (vers C:/BuildCache/winglass/release)
cargo build --release

# 3. Tests automatisés & vérification E2E
cargo test
node scripts/verify-e2e.mjs "C:/BuildCache/winglass/release"

# 4. Génération de l'installateur NSIS final
npm run tauri build
```

### Workflow Git & Documentation
- Avant toute modification majeure, lire `@CLAUDE.md` et `@SPEC.md` pour maintenir l'alignement entre Claude Code et Antigravity IDE.
- Ne jamais commiter `dist/`, `node_modules/`, ni le dossier de build.
- Toute nouvelle fonctionnalité ou découverte technique Win32/WebGL2 réutilisable doit être documentée dans `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\01 - Learning\WinGlass\`.