# Font licenses

Both fonts are licensed under the SIL Open Font License 1.1 (OFL). They are committed here so the build and the site never fetch fonts from Google.

| Font | Files | Source | License text |
|---|---|---|---|
| Vazirmatn | `Vazirmatn-Variable.woff2` (variable weight 200 to 700, Arabic and Latin) | npm package `vazirmatn` 33.0.3 (https://github.com/rastikerdar/vazirmatn), file `fonts/webfonts/Vazirmatn[wght].woff2`, unmodified | `OFL-Vazirmatn.txt` |
| Markazi Text | `MarkaziText-500.woff2`, `MarkaziText-600.woff2` (Arabic and Latin) | npm package `@expo-google-fonts/markazi-text` 0.4.1, from the original Google Fonts TTFs of https://github.com/BornaIz/markazitext, subset to the Arabic and Latin Unicode ranges and converted to woff2 with fonttools (`pyftsubset`, all layout features kept) | `OFL-MarkaziText.txt` |

Only the weights the site uses are included: Vazirmatn 200 to 700, Markazi Text 500 and 600 (same as before).
