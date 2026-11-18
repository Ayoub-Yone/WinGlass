# lumabar

Dock flottant de widgets qui remplace la barre des tâches de Windows 10/11 (x64).

## Installer

Télécharge `lumabar_<version>_x64-setup.exe` dans la dernière [release](https://github.com/Ayoub-Yone/lumabar/releases/latest).
L'application n'est pas signée : à l'avertissement SmartScreen, clique sur **Informations complémentaires**, puis **Exécuter quand même**.

## Bon à savoir

- **Ctrl + Alt + Shift + R** restaure la barre des tâches de Windows à tout moment (aussi : clic droit sur le dock › « Restaurer et quitter »).
- Aucune télémétrie. Les données restent dans `%APPDATA%\lumabar`.

## Développer

Prérequis : Node 20+, Rust stable, WebView2.

```bash
npm install
npm run tauri dev       # lancer en développement
npm run tauri build     # installeurs NSIS + MSI
cd src-tauri && cargo test --lib
```

Stack : Tauri v2 (Rust, `windows` crate), React 19, TypeScript, Tailwind CSS v4, WebGL2.
