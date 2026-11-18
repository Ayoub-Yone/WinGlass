---
name: new-desktop-app-scaffold
description: Procédure d'initialisation d'une nouvelle application desktop Tauri v2 + React dans le coffre Obsidian (COFFRE\App Development\05 - Projects\<NomProjet>) : .cargo/config.toml vers C:/BuildCache/<projet>, CLAUDE.md, SPEC.md, GEMINI.md, .gitignore. À utiliser quand l'utilisateur démarre un nouveau projet d'app desktop.
---

# Scaffold d'une nouvelle app desktop

Modèles de référence dans le coffre : `[[Modèle - CLAUDE.md]]`, `[[Modèle - SPEC.md]]`, `[[Modèle - GEMINI.md]]`, `[[Modèle - config.toml Cargo]]` (dossier `05 - Projects\_Templates`).
Remplacer `<NomProjet>` (casse libre) et `<projet>` (minuscules, sans espace).

## Étapes
1. **Dossier** : `C:\Users\ayoub\OBSIDIAN\OBSIDIAN BIG COFFRE\COFFRE\App Development\05 - Projects\<NomProjet>`. Ne jamais écraser un dossier existant : vérifier d'abord.
2. **Squelette** : `npm create tauri-app@latest` (React + TypeScript), puis `npm install`. Versions via CLI (`cargo add`, `npm install`), jamais devinées. Remplacer le `<title>` par défaut.
3. **Cache de build** : créer `.cargo/config.toml` :
   ```toml
   [build]
   target-dir = "C:/BuildCache/<projet>"
   ```
   Un cache par projet, hors du coffre. Le binaire release est alors dans `C:/BuildCache/<projet>/release/`.
4. **`CLAUDE.md`** depuis `Modèle - CLAUDE.md` : chemins, stack, commandes, invariants, checklist de phases. Créé en premier.
5. **`SPEC.md`** depuis `Modèle - SPEC.md` : protocole zéro erreur, mutex `Global\<Nom>SingleInstanceMutex`, sécurité.
6. **`GEMINI.md`** depuis `Modèle - GEMINI.md` pour Antigravity.
7. **`.gitignore`** :
   ```
   node_modules/
   dist/
   src-tauri/target/
   *.db
   *.db-wal
   *.db-shm
   *.tsbuildinfo
   # Local uniquement : notes d'agent et brouillons
   CLAUDE.md
   SPEC.md
   *PROMPT*.md
   .claude/
   ```
   Retirer `.claude/` si les skills du projet doivent être versionnés.
8. **Skills** : copier depuis `05 - Projects\_Skills\` vers `.claude/skills/` et `.agent/skills/` ceux utiles (`win32-tauri-overlay-invariants`, `ios-liquid-glass-webgl2`, `windows-native-system-modules`).
9. **Portes** : `npm run build` et `cd src-tauri && cargo check`, 0 erreur, 0 avertissement.
10. **Archivage** : créer `01 - Learning\<NomProjet>\` avec un MOC (frontmatter `title`, `tags`, `date`, `stack`, `status`, `summary`), liens `[[...]]`, et une fiche projet `05 - Projects\<NomProjet>.md`.
11. **Git** : `git init`, premier commit. Aucun remote créé sans accord de l'utilisateur.

## Garde-fous
- Aucune clé API inventée, aucun service payant activé sans accord.
- Confirmation utilisateur avant toute action système critique (alimentation, fichiers système, registre).
- Tauri + React/TypeScript par défaut ; Electron seulement si l'intégration Windows l'exige.
