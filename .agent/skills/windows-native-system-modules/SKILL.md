---
name: windows-native-system-modules
description: Recettes Rust prêtes à l'emploi pour Windows 11 dans une app Tauri : mixeur audio WASAPI par application (IAudioSessionManager2), icônes de la zone de notification via IUIAutomation sans afficher la barre, lanceur d'applications avec cache LRU, détection Ethernet/Wi-Fi, stockage SQLite chiffré par DPAPI. À utiliser pour tout module système natif.
---

# Modules natifs Windows (Rust, crate `windows`)

Source : WinGlass `src-tauri/src/win32/*`. Détails : `[[WinGlass - Modules natifs Windows]]`.

## Mixeur audio WASAPI par application (`audio.rs`)
- Un seul thread COM-MTA reçoit les commandes par canal (`CoInitializeEx` dans ce thread).
- `IAudioEndpointVolumeCallback` pousse l'état (événement `audio:state`, aucun polling). `IMMNotificationClient` rebranche sur changement d'appareil par défaut.
- `IAudioSessionManager2` liste les sessions ; regrouper par exécutable avec une fonction pure testée :
```rust
for r in raw.iter().filter(|r| !r.expired) {
    let key = group_key(r);
    // fusionner : pids, active |= , muted &= (muet seulement si toutes le sont), volume = max
}
```
- Changer d'appareil par défaut : `IPolicyConfig` non documenté, pour les trois rôles.
- UI : la molette ne change un volume que sur un curseur (écouteur natif non passif).

## Barre d'état silencieuse via `IUIAutomation` (`tray_icons.rs`)
Règle : ne jamais afficher, cibler ni cliquer la zone de notification Windows.
1. Liste : `HKCU\Control Panel\NotifyIconSettings` filtré sur les processus actifs (chemins Known-Folder GUID développés).
2. Noms UIA seulement si Windows expose déjà la zone ; Windows 10 : `ToolbarWindow32` + `TRAYDATA`.
3. Action : restaurer + focus, puis `Invoke` UIA silencieux, puis rappel Win10, puis relance de l'exe ; Quitter = `WM_CLOSE` puis terminaison des restes.
```rust
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationInvokePattern};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
```

## Lanceur d'applications + cache LRU (`app_search.rs`, `lru.rs`)
Index : Menu Démarrer ×2, Bureau ×2, tous les éléments `AppsFolder` (MSIX/Store, cible `shell:AppsFolder\<AUMID>`), App Paths HKCU/HKLM. TTL 60 s, revalidation en arrière-plan. Recherche floue, préfixe, initiales. Jamais Win+S ni SearchHost. Chemins tapés (`C:\…`, `%VAR%`, `~`, jamais `\\serveur`) : `complete_path` ; un dossier s'ouvre dans Explorer, un fichier est sélectionné, jamais exécuté.
```rust
pub struct LruCache<V> { capacity: usize, tick: u64, entries: HashMap<String, (V, u64)> }
// get : met à jour le tick ; insert : si plein, évince l'entrée au tick minimal
```
Cache d'icônes `HICON→PNG` : LRU de 64 entrées.

## Réseau Ethernet / Wi-Fi (`telemetry.rs`)
`GetBestInterface` vers une adresse publique (lecture de la table de routage, aucun paquet envoyé), puis `GetAdaptersAddresses`. Derrière un VPN : adaptateur physique actif avec passerelle, filaire d'abord. `classify` est pure et testée, retourne `ethernet` / `wifi` / `disconnected`.

## SQLite + DPAPI (`storage/db.rs`, `dpapi.rs`)
- Base : `%APPDATA%\<app>\<app>.db`, `rusqlite` en `bundled`.
- Secrets (clés API, URL, jetons) : uniquement blobs DPAPI en base64 dans une table `secrets`.
```rust
CryptProtectData(&input, w!("<app> secret"), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
```
- Aucune clé inventée, aucune télémétrie externe. Les jetons OAuth viennent des fichiers des CLI officiels, ne quittent pas le processus ; refresh token à usage unique : rafraîchissements sérialisés, réécriture atomique.

## Tests
Logique de décision en fonctions pures (`group_sessions`, `classify`, LRU) : `cd src-tauri && cargo test --lib`.
