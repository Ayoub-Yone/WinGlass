---
name: ios-liquid-glass-webgl2
description: Implémente un shader WebGL2 « iOS Liquid Glass » (SDF de rounded box, réfraction sur ménisque de 18 px, dispersion chromatique, déformation liquide au curseur en requestAnimationFrame sans re-rendu React, voile adaptatif, couleurs musicales) alimenté par la capture DXGI du bureau avec WDA_EXCLUDEFROMCAPTURE. À utiliser pour tout dock, barre ou panneau en verre sous Tauri.
---

# iOS Liquid Glass en WebGL2

Source : WinGlass `src/components/LiquidGlassCanvas.tsx`, `src-tauri/src/graphics/dxgi_capture.rs`. Détails : `[[WinGlass - Shader Liquid Glass et capture DXGI]]`.

## Architecture
1. Rust capture le bureau derrière la fenêtre (DXGI) et sert des trames BGRA brutes via un schéma `glass://capture` (en-tête `X-Inner` = rect de la pilule dans la trame).
2. Le canvas WebGL2 charge la trame en texture, construit une pyramide de flou, puis dessine une passe composite par frame.
3. Le curseur et les ressorts vivent hors React : une boucle `requestAnimationFrame` écrit des uniforms et variables CSS. Zéro `setState` par pixel.

## Optique (GLSL)
```glsl
// d = SDF signée de la rounded box (négative à l'intérieur)
float s = clamp(-d / (18.0 * u_dpr), 0.0, 1.0);          // ménisque convexe de 18 px
float h = sqrt(max(0.0, 1.0 - (1.0 - s) * (1.0 - s)));
float rimF = 1.0 - h;
float bend = pow(rimF, 1.85);
vec2 uv = puv - n * bend * u_refract * (1.0 + 0.35 * prox) / pill_size + scatter; // réfraction vers l'intérieur

// dispersion chromatique : R et B écartés le long de la normale, ménisque seulement
vec2 disp = n * mix(0.0024, 0.0040, prox) * rimF * vec2(1.0, pill_size.x / pill_size.y);
float sharpMix = u_clarity * pow(rimF, 0.8);
col.r = mix(frost(uv + disp).r, clear(uv + disp).r, sharpMix);
col.g = mix(frost(uv).g,        clear(uv).g,        sharpMix);
col.b = mix(frost(uv - disp).b, clear(uv - disp).b, sharpMix);

// vibrance à luminance préservée
float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
col = max(mix(vec3(luma), col, u_vibrancy), 0.0);        // vibrancy ≈ 1.32
```
Ajouter : liseré Fresnel de 1 px, biseau de lèvre haute, éclat sous le curseur, ombre portée dérivée de la SDF (couper l'ombre CSS quand le shader est actif).

## Déformation liquide au curseur
- X du curseur via ressort critiquement amorti (`springStep`), plus vitesse, Y et enveloppe.
- La SDF déformée sert à tout : gonflement ≈ +8,5 px au centre (gaussienne), pincements capillaires ≈ −1,8 px, inclinaison avec le mouvement, ≤ 2,7 px près du bord d'écran, extrémités étirées de 3 px.
- Redessins composite seulement ; pyramide de flou mise en cache ; marge de 22 px autour de la pilule dans le canvas.

## Voile et couleur dynamiques
- Voile adaptatif : luminance moyenne du niveau le plus profond de la pyramide (petite relecture GPU par nouvelle trame), lissée sur 300 ms, exposée en `--lb-glass-lum` / `data-glass-bright` pour les ombres de premier plan.
- Reflets et lueur du ménisque prennent la couleur de la musique (prop `ambient`, lissage ≈ 0,6 s, blanc si désactivé).
- Curseur `Clair ↔ Givré` : `frostPreset(theme, level)`, 0 à 1, défaut 0,32.

## Capture DXGI
```rust
let duplication = output.DuplicateOutput(&device)?;
// exclure sa propre fenêtre pour voir ce qui est derrière
SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE); // revérifier toutes les 500 ms
```
- Zone = rect de la pilule + 64 px de marge de flou. Une texture de staging réutilisée.
- Gating `GetFrameDirtyRects` : ne publier que si un rect sale intersecte la zone, et rejeter les trames identiques à la précédente (sinon boucle à 30 fps car l'overlay salit son propre rect). Résultat : 0 % CPU/GPU au repos.
- Pause totale (aucun device, aucune duplication) quand le thème n'est pas en verre ou que l'overlay est caché en plein écran.
- Conséquence : l'overlay est invisible aux captures d'écran dans ce mode. Prévoir un repli fond d'écran (`PrintWindow(PW_RENDERFULLCONTENT)` sur `Progman`, toutes les 2 s).

## Vérification
Script de maths : `node scripts/check-glass.mjs`. Accessibilité : repli sans WebGL (fond uni translucide) et `prefers-reduced-motion` coupe la déformation.
