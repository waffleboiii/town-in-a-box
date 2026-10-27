# Population report — Town-in-a-Box

Generated 2026-10-26T19:34:56+00:00 by `pipeline/build_population.py` (seed 20261026).

- Residents: **2000** (1400 Paris, 600 inner suburbs) in 111 districts.
- Dataset rows used as the sampling frame: 125,211 (Paris 61,456).
- Paris rows without arrondissement: 30,693 (49.9 %). 14,523 of them nevertheless name an arrondissement in their own text (the generator invented one: 47% of those mentions are the 12e), so mentions are not used as evidence.
- Sampled residents whose own text names a different arrondissement than their home: 27.
- Text-mention pattern check on rows WITH a dataset arrondissement: 22,653 of 30,763 mention one; 96.8 % agree with the structured field.
- Residents whose district is imputed (not in the dataset row): 532 (26.6 %).
- Suburban dataset rows in communes outside the map: 4,696; unmatched commune names: none.

## Paris: occupation (PCS) before and after

| Group | Dataset Paris rows | Sample (unweighted) | Sample (weighted) | INSEE 2022 (18+) |
|---|---:|---:|---:|---:|
| agriculteurs | 0.7 | 0.1 | 0.0 | 0.0 |
| artisans | 3.5 | 3.6 | 3.5 | 3.5 |
| cadres | 9.7 | 32.9 | 33.0 | 32.9 |
| prof_inter | 15.0 | 14.0 | 14.3 | 14.3 |
| employes | 17.6 | 11.8 | 11.6 | 11.6 |
| ouvriers | 13.1 | 4.2 | 4.1 | 4.1 |
| retraites | 24.9 | 19.6 | 19.4 | 19.4 |
| sans_activite | 15.5 | 13.9 | 14.1 | 14.1 |

## Paris: age bands

| Age band | Sample (unweighted) | Sample (weighted) | INSEE 2022 |
|---|---:|---:|---:|
| 18-29 | 25.8 | 25.5 | 25.5 |
| 30-44 | 25.6 | 25.7 | 25.7 |
| 45-59 | 22.1 | 21.8 | 21.7 |
| 60-74 | 16.4 | 17.0 | 17.0 |
| 75+ | 10.1 | 10.0 | 10.0 |

## Per district: cadres / ouvriers / retirees share (%) — dataset pool → sample (weighted) vs INSEE

| District | n | pool rows | cadres pool | cadres sim | cadres INSEE | ouvriers sim | ouvriers INSEE | retraités sim | retraités INSEE | 18-29 sim | 18-29 INSEE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Paris 1er Arrondissement | 11 | 437 | 11.2 | 36.8 | 38.3 | 8.3 | 2.7 | 18.3 | 17.1 | 26.6 | 24.4 |
| Paris 2e Arrondissement | 14 | 559 | 15.2 | 43.5 | 42.9 | 6.7 | 2.9 | 14.5 | 13.3 | 35.5 | 30.2 |
| Paris 3e Arrondissement | 22 | 919 | 13.6 | 35.8 | 39.3 | 0.0 | 2.7 | 18.0 | 16.4 | 30.6 | 27.1 |
| Paris 4e Arrondissement | 19 | 828 | 12.1 | 37.6 | 36.3 | 4.7 | 3.2 | 15.6 | 18.9 | 20.7 | 26.9 |
| Paris 5e Arrondissement | 38 | 1561 | 9.6 | 33.9 | 34.8 | 3.1 | 2.2 | 18.2 | 20.0 | 36.7 | 33.0 |
| Paris 6e Arrondissement | 28 | 1191 | 8.8 | 28.5 | 31.4 | 3.3 | 1.8 | 24.7 | 24.3 | 21.3 | 28.7 |
| Paris 7e Arrondissement | 32 | 1362 | 9.8 | 34.7 | 33.4 | 2.9 | 2.0 | 21.8 | 22.9 | 30.6 | 24.9 |
| Paris 8e Arrondissement | 23 | 920 | 11.7 | 39.5 | 37.1 | 4.3 | 2.8 | 17.3 | 17.1 | 17.1 | 26.0 |
| Paris 9e Arrondissement | 39 | 1535 | 15.4 | 47.4 | 44.5 | 2.3 | 2.9 | 13.0 | 13.9 | 25.9 | 28.5 |
| Paris 10e Arrondissement | 54 | 2298 | 12.8 | 39.2 | 38.5 | 3.4 | 4.4 | 16.6 | 15.2 | 29.4 | 25.8 |
| Paris 11e Arrondissement | 96 | 3969 | 12.4 | 38.4 | 38.6 | 4.3 | 3.5 | 17.6 | 17.9 | 26.6 | 26.7 |
| Paris 12e Arrondissement | 93 | 4148 | 8.6 | 34.4 | 34.1 | 3.2 | 4.0 | 21.3 | 20.8 | 23.6 | 23.9 |
| Paris 13e Arrondissement | 118 | 5480 | 7.5 | 28.0 | 27.9 | 5.0 | 5.0 | 21.9 | 21.7 | 25.9 | 25.7 |
| Paris 14e Arrondissement | 92 | 3885 | 9.1 | 32.6 | 32.6 | 4.3 | 3.5 | 20.5 | 20.9 | 26.6 | 29.5 |
| Paris 15e Arrondissement | 152 | 6334 | 10.4 | 34.1 | 34.2 | 2.6 | 3.1 | 20.8 | 20.7 | 28.1 | 26.8 |
| Paris 16e Arrondissement | 104 | 4405 | 9.9 | 31.7 | 31.8 | 1.9 | 2.5 | 22.8 | 23.0 | 20.9 | 21.4 |
| Paris 17e Arrondissement | 105 | 4362 | 11.6 | 36.3 | 36.5 | 3.8 | 3.8 | 17.9 | 17.6 | 27.4 | 25.9 |
| Paris 18e Arrondissement | 123 | 5755 | 10.0 | 31.7 | 31.9 | 5.5 | 5.6 | 16.2 | 16.1 | 25.7 | 25.6 |
| Paris 19e Arrondissement | 114 | 5573 | 6.8 | 25.4 | 25.2 | 6.1 | 6.7 | 19.1 | 19.4 | 22.7 | 22.7 |
| Paris 20e Arrondissement | 123 | 5935 | 7.2 | 26.8 | 26.9 | 6.4 | 6.2 | 20.2 | 20.2 | 20.8 | 21.7 |
| Asnières-sur-Seine | 11 | 1208 | 10.7 | 25.2 | 32.2 | 0.0 | 5.8 | 20.7 | 15.7 | 17.6 | 22.7 |
| Bagneux | 5 | 617 | 9.4 | 16.3 | 15.9 | 21.9 | 9.8 | 0.0 | 17.4 | 43.2 | 23.3 |
| Bois-Colombes | 4 | 431 | 9.7 | 25.4 | 35.6 | 0.0 | 4.8 | 25.3 | 16.9 | 51.2 | 20.5 |
| Boulogne-Billancourt | 16 | 1627 | 10.0 | 35.6 | 36.6 | 0.0 | 2.9 | 25.1 | 20.6 | 22.4 | 20.8 |
| Bourg-la-Reine | 3 | 279 | 10.0 | 25.3 | 35.0 | 0.0 | 3.6 | 43.6 | 24.6 | 0.0 | 20.8 |
| Châtenay-Malabry | 2 | 526 | 9.3 | 46.7 | 26.4 | 0.0 | 6.4 | 0.0 | 20.5 | 0.0 | 19.6 |
| Châtillon | 5 | 495 | 10.1 | 43.1 | 32.6 | 0.0 | 4.2 | 20.6 | 22.4 | 16.0 | 19.9 |
| Chaville | 3 | 276 | 6.5 | 25.7 | 34.1 | 0.0 | 3.5 | 25.0 | 19.2 | 0.0 | 20.9 |
| Clamart | 7 | 797 | 10.2 | 35.8 | 26.8 | 0.0 | 5.7 | 25.1 | 21.4 | 0.0 | 19.5 |
| Clichy | 8 | 911 | 10.8 | 20.2 | 23.8 | 0.0 | 7.8 | 25.7 | 15.5 | 13.8 | 24.0 |
| Colombes | 11 | 1195 | 9.8 | 29.5 | 24.0 | 8.9 | 8.0 | 15.0 | 17.8 | 11.3 | 21.0 |
| Courbevoie | 11 | 1103 | 10.2 | 38.5 | 35.9 | 9.2 | 3.6 | 15.5 | 18.1 | 39.9 | 21.5 |
| Fontenay-aux-Roses | 3 | 289 | 12.8 | 35.2 | 25.1 | 0.0 | 4.4 | 31.6 | 21.7 | 68.4 | 19.6 |
| Garches | 2 | 264 | 6.4 | 42.8 | 30.2 | 0.0 | 3.3 | 0.0 | 25.6 | 0.0 | 15.6 |
| La Garenne-Colombes | 4 | 441 | 11.1 | 23.5 | 36.1 | 26.0 | 4.0 | 0.0 | 17.8 | 49.7 | 20.7 |
| Gennevilliers | 6 | 691 | 10.4 | 0.0 | 9.6 | 17.9 | 14.0 | 12.7 | 17.8 | 33.4 | 21.4 |
| Issy-les-Moulineaux | 9 | 915 | 10.5 | 33.7 | 39.2 | 0.0 | 3.0 | 20.0 | 18.4 | 0.0 | 20.2 |
| Levallois-Perret | 9 | 923 | 10.0 | 33.8 | 36.4 | 0.0 | 3.2 | 20.1 | 18.5 | 13.6 | 23.0 |
| Malakoff | 4 | 390 | 11.5 | 27.5 | 24.6 | 30.5 | 7.3 | 21.9 | 19.5 | 30.5 | 21.8 |
| Marnes-la-Coquette | 2 | 36 | 13.9 | 0.0 | 27.3 | 52.0 | 4.6 | 0.0 | 20.5 | 52.0 | 16.6 |
| Meudon | 6 | 637 | 8.2 | 32.0 | 29.8 | 0.0 | 5.0 | 14.1 | 22.7 | 16.7 | 16.9 |
| Montrouge | 6 | 642 | 10.3 | 52.0 | 34.0 | 11.2 | 4.1 | 10.5 | 20.3 | 11.2 | 22.4 |
| Nanterre | 12 | 1362 | 10.6 | 13.5 | 19.7 | 11.4 | 8.7 | 19.6 | 16.8 | 28.7 | 24.9 |
| Neuilly-sur-Seine | 8 | 872 | 9.3 | 40.6 | 34.5 | 0.0 | 1.9 | 21.0 | 24.3 | 26.1 | 17.7 |
| Le Plessis-Robinson | 4 | 381 | 11.8 | 40.0 | 28.2 | 0.0 | 4.4 | 24.7 | 21.9 | 19.6 | 16.4 |
| Puteaux | 6 | 636 | 11.0 | 32.4 | 38.2 | 0.0 | 3.5 | 19.3 | 17.9 | 19.5 | 20.9 |
| Rueil-Malmaison | 7 | 1089 | 10.5 | 23.7 | 32.6 | 17.8 | 4.0 | 16.4 | 22.0 | 46.8 | 17.3 |
| Saint-Cloud | 4 | 407 | 9.6 | 28.0 | 40.0 | 0.0 | 1.7 | 24.7 | 20.9 | 28.2 | 17.2 |
| Sceaux | 2 | 268 | 9.7 | 51.5 | 31.8 | 0.0 | 2.8 | 48.5 | 24.0 | 0.0 | 19.5 |
| Sèvres | 3 | 321 | 10.0 | 28.5 | 34.1 | 0.0 | 3.1 | 0.0 | 21.6 | 39.9 | 17.1 |
| Suresnes | 6 | 661 | 10.6 | 22.4 | 34.6 | 0.0 | 4.4 | 9.9 | 17.7 | 0.0 | 19.5 |
| Vanves | 4 | 393 | 8.9 | 26.1 | 30.7 | 0.0 | 4.3 | 31.7 | 21.1 | 0.0 | 22.0 |
| Ville-d'Avray | 2 | 151 | 12.6 | 55.4 | 35.1 | 0.0 | 3.1 | 44.6 | 22.0 | 0.0 | 14.7 |
| Villeneuve-la-Garenne | 3 | 361 | 7.8 | 25.9 | 7.8 | 0.0 | 13.3 | 44.6 | 18.3 | 0.0 | 21.5 |
| Aubervilliers | 27 | 1176 | 11.0 | 8.0 | 8.6 | 24.1 | 16.9 | 9.3 | 13.1 | 25.1 | 24.3 |
| Aulnay-sous-Bois | 5 | 1100 | 9.4 | 0.0 | 8.9 | 19.3 | 14.9 | 19.1 | 19.2 | 0.0 | 21.7 |
| Bagnolet | 5 | 583 | 10.6 | 24.0 | 16.0 | 0.0 | 11.9 | 30.6 | 16.4 | 0.0 | 21.5 |
| Le Blanc-Mesnil | 6 | 735 | 8.7 | 0.0 | 5.8 | 21.4 | 17.1 | 13.5 | 17.4 | 33.3 | 22.8 |
| Bobigny | 16 | 679 | 10.0 | 0.0 | 5.4 | 15.9 | 15.5 | 16.6 | 16.5 | 45.4 | 24.3 |
| Bondy | 6 | 651 | 9.2 | 0.0 | 7.0 | 19.6 | 14.6 | 13.8 | 19.2 | 53.7 | 20.2 |
| Le Bourget | 9 | 208 | 9.1 | 8.0 | 9.5 | 12.3 | 15.1 | 19.1 | 20.1 | 10.6 | 19.6 |
| La Courneuve | 40 | 596 | 11.6 | 5.3 | 4.7 | 23.9 | 21.5 | 13.3 | 13.5 | 24.6 | 24.6 |
| Drancy | 30 | 935 | 9.3 | 7.4 | 6.6 | 14.8 | 15.9 | 19.3 | 19.1 | 23.5 | 21.4 |
| Dugny | 2 | 161 | 8.7 | 0.0 | 4.1 | 0.0 | 15.0 | 0.0 | 12.0 | 100.0 | 26.5 |
| Épinay-sur-Seine | 2 | 710 | 8.7 | 44.2 | 9.2 | 55.8 | 13.7 | 0.0 | 16.9 | 44.2 | 23.8 |
| Gagny | 1 | 512 | 8.4 | 0.0 | 12.6 | 0.0 | 11.5 | 0.0 | 20.4 | 0.0 | 20.1 |
| L'Île-Saint-Denis | 2 | 123 | 4.1 | 0.0 | 13.0 | 0.0 | 11.7 | 0.0 | 19.8 | 100.0 | 23.5 |
| Les Lilas | 3 | 321 | 7.2 | 45.3 | 22.4 | 0.0 | 6.0 | 30.6 | 22.6 | 0.0 | 18.4 |
| Livry-Gargan | 2 | 604 | 10.1 | 0.0 | 10.1 | 0.0 | 12.1 | 48.2 | 20.8 | 0.0 | 20.3 |
| Montreuil | 14 | 1436 | 10.6 | 20.7 | 21.8 | 6.2 | 9.7 | 13.0 | 16.9 | 21.9 | 20.3 |
| Neuilly-Plaisance | 3 | 330 | 7.6 | 29.9 | 19.2 | 0.0 | 8.5 | 43.4 | 21.8 | 0.0 | 22.1 |
| Neuilly-sur-Marne | 1 | 498 | 8.8 | 0.0 | 11.5 | 0.0 | 11.6 | 0.0 | 17.3 | 0.0 | 21.0 |
| Noisy-le-Sec | 5 | 598 | 10.0 | 19.4 | 11.2 | 0.0 | 13.7 | 18.7 | 16.6 | 0.0 | 21.1 |
| Pantin | 19 | 785 | 11.2 | 17.4 | 18.4 | 12.6 | 11.0 | 13.2 | 14.7 | 16.3 | 20.8 |
| Les Pavillons-sous-Bois | 3 | 312 | 10.6 | 0.0 | 10.2 | 0.0 | 13.3 | 31.9 | 18.7 | 0.0 | 21.6 |
| Le Pré-Saint-Gervais | 2 | 215 | 7.9 | 0.0 | 22.2 | 0.0 | 9.7 | 0.0 | 17.4 | 0.0 | 19.2 |
| Le Raincy | 2 | 205 | 7.3 | 0.0 | 24.7 | 0.0 | 4.1 | 0.0 | 22.2 | 62.7 | 19.6 |
| Romainville | 4 | 451 | 9.8 | 23.9 | 16.6 | 24.2 | 9.5 | 19.8 | 16.2 | 24.2 | 19.9 |
| Rosny-sous-Bois | 6 | 647 | 11.1 | 15.5 | 14.6 | 0.0 | 9.7 | 22.4 | 18.4 | 0.0 | 21.1 |
| Saint-Denis | 36 | 1869 | 10.3 | 10.1 | 10.3 | 22.3 | 15.6 | 13.0 | 14.0 | 21.0 | 25.1 |
| Saint-Ouen-sur-Seine | 17 | 681 | 13.4 | 16.9 | 21.4 | 13.5 | 9.3 | 10.1 | 15.1 | 28.6 | 23.5 |
| Sevran | 3 | 669 | 8.8 | 34.4 | 5.9 | 0.0 | 15.9 | 40.5 | 18.6 | 34.4 | 22.5 |
| Stains | 2 | 491 | 10.4 | 0.0 | 3.4 | 0.0 | 17.0 | 0.0 | 14.7 | 41.9 | 23.8 |
| Villemomble | 4 | 427 | 10.8 | 24.5 | 16.6 | 0.0 | 10.7 | 21.4 | 19.4 | 54.1 | 19.8 |
| Alfortville | 6 | 691 | 10.4 | 15.4 | 18.0 | 0.0 | 9.1 | 25.4 | 19.5 | 27.6 | 21.3 |
| Arcueil | 3 | 327 | 6.7 | 0.0 | 23.4 | 24.3 | 8.0 | 0.0 | 17.0 | 53.1 | 25.1 |
| Bonneuil-sur-Marne | 2 | 227 | 9.7 | 0.0 | 7.0 | 0.0 | 13.2 | 0.0 | 19.4 | 0.0 | 21.5 |
| Bry-sur-Marne | 2 | 240 | 7.9 | 37.7 | 25.4 | 0.0 | 5.6 | 62.3 | 23.9 | 0.0 | 18.8 |
| Cachan | 4 | 441 | 9.3 | 23.8 | 22.6 | 19.9 | 5.4 | 0.0 | 19.0 | 44.0 | 28.4 |
| Champigny-sur-Marne | 7 | 995 | 9.7 | 19.0 | 12.9 | 8.3 | 11.3 | 15.3 | 20.4 | 22.5 | 21.1 |
| Charenton-le-Pont | 4 | 385 | 7.3 | 23.8 | 28.6 | 0.0 | 3.8 | 28.2 | 21.8 | 0.0 | 19.8 |
| Chennevières-sur-Marne | 1 | 254 | 10.6 | 0.0 | 13.2 | 0.0 | 10.4 | 0.0 | 23.9 | 0.0 | 19.4 |
| Chevilly-Larue | 1 | 272 | 12.1 | 0.0 | 13.0 | 0.0 | 10.8 | 100.0 | 23.4 | 0.0 | 20.0 |
| Choisy-le-Roi | 1 | 624 | 10.9 | 0.0 | 13.8 | 0.0 | 12.4 | 100.0 | 17.9 | 0.0 | 22.2 |
| Créteil | 11 | 1220 | 9.0 | 20.9 | 14.3 | 5.1 | 9.3 | 23.1 | 19.2 | 26.2 | 23.9 |
| Fontenay-sous-Bois | 7 | 718 | 10.4 | 12.9 | 23.4 | 0.0 | 7.1 | 27.7 | 21.3 | 30.8 | 18.4 |
| Gentilly | 2 | 254 | 15.0 | 0.0 | 21.8 | 0.0 | 7.6 | 0.0 | 16.3 | 0.0 | 27.0 |
| L'Haÿ-les-Roses | 3 | 437 | 10.5 | 33.0 | 16.3 | 0.0 | 8.8 | 29.4 | 24.4 | 0.0 | 18.3 |
| Ivry-sur-Seine | 8 | 898 | 9.7 | 27.7 | 17.8 | 6.8 | 9.7 | 12.6 | 15.6 | 52.9 | 27.5 |
| Joinville-le-Pont | 3 | 274 | 9.5 | 0.0 | 23.8 | 35.1 | 4.9 | 0.0 | 21.7 | 0.0 | 19.2 |
| Le Kremlin-Bicêtre | 3 | 331 | 9.7 | 0.0 | 23.1 | 23.5 | 5.7 | 0.0 | 19.2 | 100.0 | 26.1 |
| Maisons-Alfort | 7 | 827 | 10.4 | 28.5 | 25.9 | 0.0 | 5.3 | 13.2 | 19.6 | 24.7 | 22.5 |
| Nogent-sur-Marne | 4 | 465 | 11.0 | 56.4 | 31.3 | 0.0 | 3.9 | 21.8 | 22.0 | 0.0 | 17.3 |
| Le Perreux-sur-Marne | 4 | 500 | 12.4 | 23.8 | 28.4 | 0.0 | 5.0 | 28.2 | 23.2 | 0.0 | 17.7 |
| Saint-Mandé | 3 | 312 | 11.5 | 39.2 | 34.6 | 0.0 | 2.3 | 35.0 | 23.9 | 0.0 | 18.2 |
| Saint-Maur-des-Fossés | 10 | 1078 | 8.3 | 31.3 | 27.2 | 0.0 | 4.3 | 31.2 | 27.2 | 17.4 | 17.3 |
| Saint-Maurice | 2 | 206 | 9.2 | 41.1 | 24.9 | 0.0 | 4.7 | 58.9 | 20.7 | 0.0 | 20.5 |
| Sucy-en-Brie | 1 | 348 | 6.6 | 0.0 | 18.5 | 100.0 | 7.3 | 0.0 | 26.8 | 0.0 | 17.3 |
| Villejuif | 8 | 830 | 12.5 | 15.6 | 18.2 | 13.9 | 8.4 | 16.1 | 18.0 | 9.7 | 26.1 |
| Vincennes | 6 | 696 | 10.9 | 38.7 | 40.0 | 0.0 | 3.0 | 15.2 | 19.9 | 21.6 | 20.4 |
| Vitry-sur-Seine | 12 | 1232 | 10.2 | 8.4 | 11.1 | 10.5 | 12.8 | 20.8 | 18.9 | 19.7 | 22.7 |

Paris arrondissements: resident-weighted mean total-variation distance of the occupation mix vs INSEE — dataset pool **23.7 pts** → weighted sample **1.8 pts** (best achievable with whole residents: 1.3 pts).

suburban communes: resident-weighted mean total-variation distance of the occupation mix vs INSEE — dataset pool **15.5 pts** → weighted sample **19.7 pts** (best achievable with whole residents: 14.8 pts).

Suburban communes have 1-40 residents each, so single-commune shares are noisy; departement totals:

| Departement | n | cadres sim | cadres INSEE | ouvriers sim | ouvriers INSEE | retraités sim | retraités INSEE | dataset cadres |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Paris | 1400 | 33.0 | 32.9 | 4.1 | 4.1 | 19.4 | 19.4 | 9.7 |
| Hauts-de-Seine | 198 | 30.2 | 30.2 | 5.3 | 5.3 | 19.4 | 19.4 | 10.1 |
| Seine-Saint-Denis | 277 | 12.7 | 12.6 | 12.9 | 13.3 | 16.9 | 16.9 | 9.9 |
| Val-de-Marne | 125 | 21.9 | 21.5 | 6.1 | 7.5 | 21.0 | 20.4 | 10.2 |

## Imputed attributes vs INSEE targets (Paris and suburbs)

**Paris** (weighted): car 31.9 % (INSEE households 32.0 %), owners 34.8 % (34.8), social housing 22.0 % (22.1), foreign 14.5 % (14.7), heavy car 9.0 % of residents.

**Suburbs** (weighted): car 59.4 % (INSEE households 59.9 %), owners 42.3 % (41.5), social housing 29.0 % (29.9), foreign 18.2 % (18.6), heavy car 19.6 % of residents.

Paris eligibility: 77.3 % of simulated Paris adults are eligible (target 77.3 % = 1,375,000 registered / 1,779,906 INSEE adults).

## Commute mode of employed residents vs INSEE (walk / bike / car / public transport, %)

- Paris: simulated 12.1 / 11.5 / 9.9 / 66.4 vs INSEE 12.8 / 11.0 / 9.9 / 66.2
- Suburbs: simulated 7.3 / 5.2 / 30.1 / 57.4 vs INSEE 8.6 / 5.4 / 30.3 / 55.7
- Public transport split: metro 425, rer 287, bus 194

## Participation base

Mean participationBase 0.494; by age band: 18-29 0.29, 30-44 0.44, 45-59 0.62, 60-74 0.67, 75+ 0.57

By tenure: owner 0.65, private_renter 0.43, social_renter 0.36

## Groups

| Group | Residents | Weighted share |
|---|---:|---:|
| Young renters (18-34) (`young_renters`) | 568 | 25.9 % |
| Families with children (`families_with_kids`) | 855 | 44.0 % |
| Single parents (`single_parents`) | 158 | 8.0 % |
| Retired home-owners (`retired_owners`) | 253 | 13.1 % |
| Seniors 75+ (`seniors_75`) | 194 | 9.3 % |
| Students (18-25) (`students`) | 150 | 7.2 % |
| Managers & professionals (`professionals`) | 575 | 26.6 % |
| Service & clerical employees (`service_workers`) | 275 | 14.6 % |
| Manual workers (`manual_workers`) | 116 | 6.4 % |
| Shopkeepers, craftspeople & business owners (`shopkeepers_artisans`) | 71 | 3.3 % |
| Households without a car (`no_car`) | 1207 | 51.3 % |
| Heavy-car owners (`heavy_car_owners`) | 238 | 15.5 % |
| Social-housing tenants (`social_housing`) | 494 | 26.3 % |
| Residents who cannot vote locally (`cannot_vote`) | 253 | 13.5 % |
| Inner-suburb residents (`suburb_residents`) | 600 | 61.2 % |

## Names

Names parsed from the persona text start. Cleaned/fallback: {'name taken from another text field': 10, 'removed civil-status prefix; first name only': 1}.

## Method

- Sampling: 1400 residents in Paris allocated to the 20 arrondissements in proportion to INSEE 2022 adults (18+, min 10 each); 600 in the communes of Hauts-de-Seine, Seine-Saint-Denis and Val-de-Marne that intersect the map, in proportion to adults x share of the commune area inside the map, with the communes around the hypothetical data-centre site oversampled (La Courneuve x7, Le Bourget x5, Drancy x3.5, Dugny x3, other neighbours x2.5). Within each district, NVIDIA Nemotron-Personas-France rows are raked to INSEE marginals and drawn without replacement with probability proportional to their raking weight. Half of the dataset's Paris rows have no arrondissement: those are assigned one jointly with their occupation, age band and education (P(arr|occ,age,edu) ∝ P(arr)·P(occ|arr)·P(age|arr)·P(edu|arr), INSEE shares), never uniformly at random. Draws are systematic PPS after sorting by occupation/sex/age/education, with a 20x lower starting weight for rows whose own text names a different arrondissement (keeps texts consistent).
- Raking: Iterative proportional fitting per district on sex x occupation (8 PCS groups, 18+), sex x age band (5) and education (7 levels) from the INSEE 2022 census; rows are then drawn by systematic PPS. After sampling, a residual raking weight per departement (sex x occupation, sex x age; capped 0.33-3) corrects what the draw left. `weight` = design weight (district adults / residents drawn, undoing the unequal sampling rates between Paris, suburbs and the boosted communes) x residual raking weight, normalised to mean 1. Use `weight` for every aggregate.
- IMPUTED nationality (french / eu / non_eu): per district, the INSEE 2022 share of foreign nationals is matched exactly; who is foreign depends only on age band, occupation and education (never on names or cultural background). EU share of foreigners is an assumption: {'75': 0.3, '92': 0.3, '93': 0.15, '94': 0.25}.
- IMPUTED tenure (owner / private_renter / social_renter): per district, INSEE 2022 shares of people living in owner-occupied, privately rented and HLM dwellings are matched exactly; owners are more likely older, couples, cadres/artisans/retirees.
- IMPUTED car (household has >= 1 car): per district, INSEE 2022 share of households with a car is matched exactly; more likely for families, owners, artisans; less likely for students and under-30s.
- IMPUTED heavyCar (Paris SUV-fee definition: thermal/hybrid >= 1.6 t or EV >= 2 t): ASSUMPTION 30 % of household cars (no official estimate found), more likely for cadres, artisans, families with children and suburb residents.
- IMPUTED registration: EU nationals 25 % registered (assumption); French nationals in Paris registered so that eligible adults match the ~1,375,000 registered voters of the 2023/2024 votations (younger people less often registered); suburbs 88 % of French adults. eligibleParis = lives in Paris AND registered (French or EU).
- IMPUTED workplace: retirees and non-working adults have none; 65 % of 18-25 students get a university (Sorbonne/Jussieu, Paris Rive Gauche, Assas, Paris 8 Saint-Denis, Nanterre, Créteil, Condorcet). Workers: own district with probability INSEE 'works in commune of residence' (suburbs) or 40 % (Paris arrondissements, assumption), Paris residents keep the INSEE share working inside Paris; otherwise job hubs by occupation (8e/9e/1er-2e, La Défense, 13e, 15e, 12e, Issy/Boulogne, Saint-Denis Pleyel, Gennevilliers port, Ivry/Vitry, Créteil...) plus a population-proportional spread, with distance decay.
- IMPUTED commuteMode: a prior from distance, car and Paris/suburb geography, calibrated per home district to INSEE 2022 mode shares of employed residents (walk, bike, car, public transport; motorised two-wheelers and 'no transport' excluded), then public transport split into metro / RER / bus by geography.
- participationBase (not imputed from the LLM): turnout by 5-year age group in the 2022 legislative elections (Insee Première 1928) x diploma ratio of systematic voting (Insee Première 1929) x tenure factor (owner 1.10, private renter 0.95, social renter 0.90 — assumption); 0 for non-EU foreign nationals, who cannot vote. The scenario engine rescales to real turnout.

## Sources

- NVIDIA Nemotron-Personas-France: https://huggingface.co/datasets/nvidia/Nemotron-Personas-France (CC BY 4.0)
- INSEE — Population en 2022 (RP, base infracommunale IRIS): https://www.insee.fr/fr/statistiques/8647014 (Licence Ouverte / Etalab 2.0)
- INSEE — Diplômes - Formation en 2022 (RP, IRIS): https://www.insee.fr/fr/statistiques/8647010 (Licence Ouverte / Etalab 2.0)
- INSEE — Logement en 2022 (RP, IRIS): https://www.insee.fr/fr/statistiques/8647012 (Licence Ouverte / Etalab 2.0)
- INSEE — Activité des résidents en 2022 (RP, IRIS): https://www.insee.fr/fr/statistiques/8647006 (Licence Ouverte / Etalab 2.0)
- INSEE — Couples - Familles - Ménages en 2022 (RP, IRIS): https://www.insee.fr/fr/statistiques/8647008 (Licence Ouverte / Etalab 2.0)
- INSEE Première n°1928 — Participation électorale 2022: https://www.insee.fr/fr/statistiques/6658145 (Licence Ouverte / Etalab 2.0)
- INSEE Première n°1929 — Vingt ans de participation électorale: https://www.insee.fr/fr/statistiques/6658143 (Licence Ouverte / Etalab 2.0)
- geo.api.gouv.fr — communes and arrondissements (outlines, population): https://geo.api.gouv.fr/decoupage-administratif/communes (Licence Ouverte / Etalab 2.0)
- Download: https://www.insee.fr/fr/statistiques/fichier/8647014/base-ic-evol-struct-pop-2022_csv.zip
- Download: https://www.insee.fr/fr/statistiques/fichier/8647010/base-ic-diplomes-formation-2022_csv.zip
- Download: https://www.insee.fr/fr/statistiques/fichier/8647012/base-ic-logement-2022_csv.zip
- Download: https://www.insee.fr/fr/statistiques/fichier/8647006/base-ic-activite-residents-2022_csv.zip
- Download: https://www.insee.fr/fr/statistiques/fichier/8647008/base-ic-couples-familles-menages-2022_csv.zip
- Download (75): https://geo.api.gouv.fr/communes?codeDepartement=75&type=arrondissement-municipal&fields=nom,code,population,centre,contour&format=json&geometry=contour
- Download (92): https://geo.api.gouv.fr/departements/92/communes?fields=nom,code,population,centre,contour&format=json&geometry=contour
- Download (93): https://geo.api.gouv.fr/departements/93/communes?fields=nom,code,population,centre,contour&format=json&geometry=contour
- Download (94): https://geo.api.gouv.fr/departements/94/communes?fields=nom,code,population,centre,contour&format=json&geometry=contour