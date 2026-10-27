# Ground truth and scenario facts — sources

This page explains where every real-world number in Town-in-a-Box comes from: the official results of the Paris
votes we use as backtests, the real context behind the **hypothetical** data-centre scenario, and the training
cutoffs of the NVIDIA Nemotron models (to judge data leakage).

Everything here is real and sourced, except the items explicitly labelled **hypothetical** or **assumption**.
Simulation outputs compared with these numbers are hypotheses produced by simulated voices, not evidence of public opinion.

## Files

| File | What it holds |
|---|---|
| `pipeline/data/ground_truth/votations.json` | Three Paris votations: exact question, what "Pour" means, eligibility, polling stations, rules of the measure, totals, results for the 17 sectors (and the 20 arrondissements where published), pre-vote polls, automatic consistency checks, sources |
| `pipeline/data/ground_truth/datacenter_context.json` | Real context on data centres in Seine-Saint-Denis, real comparable projects, the French consultation procedure, and the hypothetical site + proposal (FR/EN) |
| `pipeline/data/ground_truth/leakage_notes.json` | Nemotron 3 Nano / Super / Ultra training cutoffs, a per-vote verdict, probe prompts, and out-of-sample candidates |
| `pipeline/fetch_ground_truth.py` | Rebuilds the three files from cached official downloads |

To rebuild (no API key needed):

```
pipeline/.venv/Scripts/python.exe pipeline/fetch_ground_truth.py            # downloads into pipeline/data/raw/ground_truth/ if needed
pipeline/.venv/Scripts/python.exe pipeline/fetch_ground_truth.py --offline  # cache only
```

The script prints one line per vote with the number of passed checks. It returns an error code if any check fails.

### How the results were checked

The results by sector are **not** typed by hand. The script reads the City's own open-data files
(results by sector for 2023 and 2024, and by polling station for 2024 and 2025), adds them up and checks that:

- Pour + Contre = votes expressed, in every sector;
- the sectors add up to the proclaimed Pour, Contre, voters, and blank + null totals;
- the Paris-wide Pour share equals the proclaimed share (to 2 decimals);
- every sector's Pour % equals the figure printed on the paris.fr results page (to 2 decimals);
- for 2024, the polling-station file adds up to the sector file.

All 26 checks pass. The only difference found: in 2024 the open-data file has 1,374,531 registered voters and the
paris.fr page says 1,374,532, a difference of one. Press figures from AFP (via Maire-info and L'Info Durable) agree:
89.03 % against with 7.46 % turnout in 2023, and 54.55 % for with 5.68 % turnout in 2024.

Definitions: **shares are of expressed votes** (Pour + Contre, blank and null excluded), the City's convention.
**Turnout = voters / registered.** Sectors: "Paris Centre" (1er–4e merged since 2020) and "5e" to "20e".

## Results by sector

| Sector | Scooters 2023 Pour | Turnout | SUV 2024 Pour | Turnout | Streets 2025 Pour | Turnout |
|---|---:|---:|---:|---:|---:|---:|
| Paris Centre | 14.23 % | 10.61 % | 62.67 % | 6.65 % | 69.67 % | 4.34 % |
| 5e | 12.06 % | 9.43 % | 60.18 % | 7.09 % | 66.90 % | 4.38 % |
| 6e | 11.20 % | 11.35 % | 47.38 % | 6.77 % | 52.93 % | 4.72 % |
| 7e | 11.36 % | 9.70 % | 25.95 % | 7.23 % | 33.72 % | 3.51 % |
| 8e | 11.28 % | 10.45 % | 26.95 % | 8.82 % | 38.70 % | 4.19 % |
| 9e | 12.44 % | 8.81 % | 61.34 % | 5.32 % | 69.59 % | 3.85 % |
| 10e | 12.63 % | 7.59 % | 76.79 % | 6.86 % | 82.95 % | 5.67 % |
| 11e | 11.67 % | 6.48 % | 71.54 % | 5.56 % | 79.42 % | 4.64 % |
| 12e | 10.75 % | 7.91 % | 60.07 % | 6.27 % | 69.99 % | 4.36 % |
| 13e | 10.00 % | 6.62 % | 63.66 % | 4.77 % | 69.55 % | 4.00 % |
| 14e | 11.70 % | 8.26 % | 59.20 % | 5.71 % | 67.31 % | 4.68 % |
| 15e | 9.24 % | 7.75 % | 40.36 % | 5.75 % | 59.12 % | 3.53 % |
| 16e | 8.23 % | 6.50 % | 18.05 % | 6.99 % | 26.52 % | 3.06 % |
| 17e | 11.91 % | 6.48 % | 37.63 % | 5.82 % | 55.38 % | 3.54 % |
| 18e | 11.15 % | 6.79 % | 71.99 % | 4.46 % | 72.95 % | 4.35 % |
| 19e | 10.33 % | 5.86 % | 73.12 % | 4.27 % | 71.67 % | 4.33 % |
| 20e | 9.66 % | 6.37 % | 73.57 % | 4.52 % | 77.54 % | 3.40 % |
| **Paris** | **10.97 %** | **7.46 %** | **54.55 %** | **5.68 %** | **65.96 %** | **4.06 %** |

Turnout per sector is not printed on the paris.fr pages; we compute it from the official open-data counts.

| Totals | Registered | Voters | Blank | Null | Expressed | Pour | Contre |
|---|---:|---:|---:|---:|---:|---:|---:|
| Scooters, 2 Apr 2023 | 1,382,322 | 103,084 | 139 | 304 | 102,641 | 11,256 | 91,385 |
| SUV fee, 4 Feb 2024 | 1,374,531 | 78,121 | 110 | 256 | 77,755 | 42,415 | 35,340 |
| 500 streets, 23 Mar 2025 | 1,391,369 | 56,489 | 88 | 226 | 56,175 | 37,054 | 19,121 |

## 1. Rental e-scooters — 2 April 2023 (`paris_scooters_2023`)

- **Question:** « Pour ou contre les trottinettes en libre-service à Paris ? » Ballots: "Pour les trottinettes en libre-service à Paris" / "Contre les trottinettes en libre-service à Paris".
- **What "Pour" means:** keep rental (self-service) e-scooters, i.e. renew or re-tender the City's agreements with the operators. "Contre" ends them when the agreements expired on 31 Aug 2023. Contre won, and the scooters left on 31 Aug 2023.
- **The measure:** three operators (Dott, Lime, Tier), each allowed at most 5,000 vehicles (about 15,000 in total), under public-space agreements ending 31 Aug 2023 (Mayor's speech to the Conseil de Paris, 14 Mar 2023).
- **Who could vote:** people on the Paris electoral lists by 3 Mar 2023, **including EU nationals on the complementary list for municipal elections** (rules, art. 7). Young people turning 18 by 1 Apr 2023 and newly naturalised citizens could vote once INSEE had registered them (art. 10). Voters living abroad are attached to the 4e list, which adds to "Paris Centre" registrations.
- **How:** 203 polling stations at 21 sites, 9:00–19:00, in person only; no proxy (art. 13) and no e-voting. The vote fell on the same day as the Paris Marathon. The legal form was a consultative "consultation facultative ouverte".
- **Campaign notes:** the control commission criticised the operators' use of paid influencers (report, p. 18). AFP reports the operators offered a free ride on voting day. Cost: about €390,692 (City Hall to AFP; secondary source).
- **Poll:** Ifop-Fiducial for Le Figaro and Sud Radio, 7–13 Mar 2023, n = 1,002 Parisians aged 18+ (online, quotas, stratified by arrondissement). Voting intention on the same question: **Pour 30 % / Contre 70 %** of expressed. 85 % said organising the vote was a good thing.
- **Sources:** [paris.fr results page](https://www.paris.fr/pages/pour-ou-contre-les-trottinettes-en-libre-service-23231) ·
  [proclamation (PDF)](https://cdn.paris.fr/paris/2023/04/03/proclamation2avril2023def-PySW.pdf) ·
  [control commission report (PDF)](https://cdn.paris.fr/paris/2023/04/14/rapport-votation-du-2-avril-2023-def-FyKO.pdf) ·
  [rules (PDF, scanned)](https://cdn.paris.fr/paris/2023/03/13/reglement-votation-du-2-avril-2023-OroB.pdf) ·
  [Mayor's speech (PDF)](https://cdn.paris.fr/paris/2023/05/31/pour-contre-trottinettes-a-paris-OST8.pdf) ·
  [open data](https://opendata.paris.fr/explore/dataset/votation-trottinette-2023/information/) ·
  [Ifop poll (PDF, p. 21)](https://www.ifop.com/wp-content/uploads/2023/03/119819-resultats-ensemble.pdf) ·
  [AFP via L'Info Durable](https://www.linfodurable.fr/vie-quotidienne/abstention-mais-paris-dit-non-aux-trottinettes-en-libre-service-37765)

## 2. Parking fee for heavy cars ("SUV") — 4 February 2024 (`paris_suv_2024`)

- **Question:** « Pour ou contre la création d'un tarif spécifique pour le stationnement des voitures individuelles lourdes, encombrantes, polluantes ? » (campaign title "Plus ou moins de SUV à Paris ?"). Ballots: "Pour" / "Contre".
- **What "Pour" means:** create the tripled visitor parking rate for heavy cars.
- **Who could vote:** people on the Paris electoral lists on 8 Jan 2024. *"S'agissant des ressortissants communautaires, seuls ceux inscrits sur la liste complémentaire pour les élections municipales pouvaient participer à cette votation."*
- **How:** 222 polling stations at 38 sites, 9:00–19:00, in person. Five sectors held a **local question on the same day** (Paris Centre, 8e, 10e, 12e, 20e), which may have raised turnout there. Their results are in the JSON. Cost: about €400,000 (deputy mayor E. Grégoire to AFP; secondary source).
- **Rules (in force from 1 Oct 2024; adopted by the Conseil de Paris in May 2024):**
  - concerns **visitors** parking a car of **≥ 1.6 t (petrol, diesel or plug-in hybrid)** or **≥ 2 t (electric)**;
  - hourly visitor rate tripled: **1er–11e: €6 → €18/h; 12e–20e: €4 → €12/h**. Six hours costs €225 instead of €75 in the centre, and €150 instead of €50 further out. Charged in 15-minute steps;
  - **exempt:** residents and sedentary professionals parked in their own residential zone; taxis at ranks; craftspeople, health professionals and others on the professional rate; disabled people (PMR) and holders of the *carte mobilité inclusion – stationnement*.
- **Poll:** OpinionWay for Respire and Clean Cities, two groups campaigning **for** the measure. Fieldwork 2–9 Jan 2024, published 17 Jan 2024, n = 1,019 aged 18+, online. 61 % support parking charges based on vehicle weight, 70 % with conditions attached, and 56 % have a bad opinion of SUVs. **This is not the ballot question.** We found no independent voting-intention poll on the exact question, so `pollGap.comparable` is `false` for this vote.
- **Sources:** [paris.fr results page](https://www.paris.fr/pages/plus-ou-moins-de-suv-les-parisiens-et-parisiennes-sont-invites-a-voter-le-4-fevrier-25381) ·
  [rate infographic (PDF)](https://cdn.paris.fr/paris/2023/12/19/suv_infog_1200x1200_24-7dB3.pdf) ·
  [control commission report (PDF)](https://cdn.paris.fr/paris/2024/03/01/rapport-votation-du-4-fevrier-2024-version-finale-XWBe.pdf) ·
  [open data by sector](https://opendata.paris.fr/explore/dataset/votation_suv_2024/information/) and [by polling station](https://opendata.paris.fr/explore/dataset/votation_suv_2024_bv/information/) ·
  [Conseil de Paris, May 2024](https://www.paris.fr/pages/les-temps-forts-du-conseil-de-paris-de-mai-2024-27168#l-entree-en-vigueur-de-l-augmentation-du-tarif-du-stationnement-des-suv) ·
  [OpinionWay poll (Clean Cities)](https://cleancitiescampaign.org/?p=18051) ·
  [AFP via Maire-info](https://www.maire-info.com/transports/paris-la-tarification-du-stationnement-speciale-suv-approuvee-pres-55--article-28273)

## 3. Optional: 500 green, pedestrian streets — 23 March 2025 (`paris_streets_2025`)

- **Question:** « Pour ou contre végétaliser et rendre piétonnes 500 nouvelles rues dans Paris, réparties dans tous les quartiers ? »
- **Measure:** 5 to 8 streets per neighbourhood, within about 300 m of voters' homes. Residents help choose the streets from April 2025, followed by about 3 years of works.
- **Who could vote:** people on the electoral lists by 26 Feb 2025, including EU nationals on the municipal complementary list and, **for the first time, 16- and 17-year-olds** (French or EU). Nine EU citizens registered only on the European list were let in by the commission.
- **How:** 218 polling stations at 34 sites, in person, no proxy. Seven sectors held a local question on the same day.
- **Poll:** OpinionWay for Clean Cities (which campaigned **for** the measure), 21–27 Feb 2025, 1,008 Parisians aged 16+, of whom 903 were registered. Voting intention: **Pour 56 %, Contre 31 %, abstain/blank/don't know 13 %**, which is 64.4 % Pour among those expressing a choice. The actual result was 65.96 %. Note: the paris.fr page prints "69,99 % / 31,01 %" for the 12e; the open data gives 30.01 % (a typo on the page).
- **Sources:** [paris.fr results page](https://www.paris.fr/pages/nouvelle-votation-rendez-vous-aux-urnes-le-23-mars-2025-29900) ·
  [control commission report (PDF)](https://cdn.paris.fr/paris/2025/06/16/20250705-rapport-cc-votation-2025-v3-couv-corrigee-def-HOEi.pdf) ·
  [rules (PDF)](https://cdn.paris.fr/paris/2025/02/06/reglement-de-la-votation-du-23-mars-2025-xV6U.pdf) ·
  [open data](https://opendata.paris.fr/explore/dataset/votation-donnees-votation-mars2025-pour-ou-contre-vegetaliser-rues/information/) ·
  [poll notice, Commission des sondages (PDF)](https://www.commission-des-sondages.fr/notices/files/notices/2025/mars/9907-opinionway-pour-clean-cities-les-parisiens-et-la-pietonnisation-de-la-ville-notice-a-la-commission-des-sondages-mars-2025.pdf) ·
  [Clean Cities note (PDF)](https://cleancitiescampaign.org/wp-content/uploads/2025/03/Paris_leader-sur-les-rues-scolaires-en-retard-sur-la-marche-et-les-espaces-verts.pdf)

### Polls versus votes

| Vote | Poll (≈ "everyone") | Vote (≈ "who turned up") | Gap | Same question? |
|---|---:|---:|---:|---|
| Scooters 2023 | 30 % Pour | 10.97 % | −19.0 pts | yes |
| SUV 2024 | 61 % support weight-based fees | 54.55 % | −6.5 pts | **no** |
| Streets 2025 | 64.4 % Pour | 65.96 % | +1.6 pts | yes |

The scooter vote is the clearest case of a consultation that did not mirror the wider population: low turnout,
older and more central voters. It is the key example for the "who would a consultation miss?" story.

### Useful facts for the simulation

- Turnout is very low and uneven: 5.9 % (19e) to 11.4 % (6e) in 2023, 4.3 % (19e) to 8.8 % (8e) in 2024. Wealthier western and central sectors vote more.
- Voting meant going in person to a few sites (21 to 38 sites for all of Paris). There was no proxy and no e-voting, which affects older and disabled people.
- The electorate is French plus EU citizens on the municipal complementary list (plus 16–17-year-olds in 2025). Non-EU residents cannot vote.

## 4. Hypothetical scenario: an AI data-centre campus in Seine-Saint-Denis

### Real context (sourced)

- **Concentration:** Île-de-France has 44 % of France's 322 data centres (31 Dec 2024) and about 65–70 % of installed power ([Région IdF, CR 2026-039, June 2026](https://www.iledefrance.fr/sites/default/files/2026-06/cr2026-039.pdf)). In 2024 the data centres of Seine-Saint-Denis used **0.8 TWh**, the most of any département, ahead of Seine-et-Marne and Hauts-de-Seine at 0.3 TWh each ([Enedis observatory, 29 Oct 2025](https://observatoire.enedis.fr/article/la-france-attractive-pour-les-data-centers-2); Enedis-network figure). The département counts 23 data centres in operation ([CD93, Jul 2024](https://seinesaintdenis.fr/actualite/emploi-entrepreneuriat/Le-plus-grand-data-center-de-France/)). Plaine Commune received about fifteen large data centres between 2000 and 2015, more than half of the regional total at the time (Saint-Denis mayor, [Choose Paris Region 2022](https://www.chooseparisregion.org/sites/default/files/pdf/datacenters/Datacenters-Paris-Region-2022.pdf)). OpenStreetMap shows 88 mapped data-centre objects in our map area, including Aubervilliers (10), Saint-Denis (8) and La Courneuve (6). Operators include Equinix and Digital Realty (ex-Interxion).
- **Documented concerns:**
  - **Grid:** connection is now "the main limiting factor", with growing RTE queues, and could crowd out industry, mobility and housing (Région 2026). Congestion risk in La Plaine Saint-Denis ([Novethic](https://grandformat.novethic.fr/data-centers/)). Reinforcement costs are shared by all consumers through the TURPE tariff (Région 2026).
  - **Land:** data centres compete for industrial land, and their new substations take more land (Région 2026).
  - **Heat island, noise, generator pollution:** generators are tested monthly; Dugny's site would have 108 generators ([Ae opinion 2024-08](https://www.igedd.developpement-durable.gouv.fr/IMG/pdf/240411_centre_donnees_dugny_digital_hub_93_debattu_corrige_cle565e1b.pdf)).
  - **Water:** in heatwaves water-cooled designs use more water ([AN written question 14126](https://questions.assemblee-nationale.fr/dyn/17/questions/QANR5L17QE14126.pdf)).
  - **Few jobs:** opponents in Dugny call the jobs "mostly low-skilled" ([France 3, May 2025](https://france3-regions.franceinfo.fr/paris-ile-de-france/seine-saint-denis/pourquoi-le-plus-grand-data-center-de-france-bientot-installe-a-dugny-inquiete-les-riverains-3157335.html)).
  - **Fire, batteries, PFAS refrigerant, cumulative generators** (more than 200 across La Courneuve and Dugny) ([France 3, Nov 2025](https://france3-regions.franceinfo.fr/paris-ile-de-france/seine-saint-denis/des-habitants-s-elevent-contre-le-projet-d-un-nouveau-data-center-en-seine-saint-denis-3257029.html)).
- **Documented benefits:**
  - **Local taxes:** Equinix PA8 (14 MW, Pantin/Bobigny) paid €2.4 M over 3 years. A rule of thumb after the 2022 change is €2–3 M a year per €300 M of investment (Choose Paris Region 2022, a promotional source).
  - **Waste heat:** Equinix PA10 in Saint-Denis supplies up to 6.6 MW (about 10,800 MWh a year) to the Plaine Commune Énergie / SMIREC network for the ZAC Plaine Saulnier and the Olympic Aquatics Centre. The heat is given free for 15 years, and the network was extended by 2,610 m ([Région](https://www.iledefrance.fr/tous-les-services/ma-region-pres-de-chez-moi/environnement/energie/184193-recuperation-de-chaleur-fatale-du-data-center-equinix-et-extension-du-reseau-de-chaleur-plaine-commune-energie); the MW and MWh figures come from ENGIE press releases we could only read through secondary summaries). The Region co-funded three such heat projects in Saint-Denis and La Courneuve.
  - **Limits of heat reuse:** at Dugny only about 1 % of roughly 100 MWth of recoverable heat was planned for reuse. At Le Bourget, 12 MW of 75 MW, in winter only.
  - **Local conditions:** Plaine Commune asks developers for local hiring, a grid study, a district-heating connection and more greenery.

### Real comparable projects (not ours)

| Project | Key facts | Sources |
|---|---|---|
| Paris Digital Park, La Courneuve (Digital Realty) | ≈130 MW, 40,000 m² server halls, €1.15 bn, 80–90 staff + ≈300 client staff, former Eurocopter site; heat offered free but not connected (Jul 2024) | [CD93](https://seinesaintdenis.fr/actualite/emploi-entrepreneuriat/Le-plus-grand-data-center-de-France/) |
| Dugny Digital Hub (Digital Realty), under construction | 3 buildings, 41,500 m² footprint on 9.5 ha of former military land; 200 MW, 1,930 GWh/yr at full load (12 times the commune's use); 108 HVO generators; 5,090 m³ water/yr; about 110 people on site per day; works late 2024 to early 2030; ≈100 m from homes and a crèche | [Ae 2024-08](https://www.igedd.developpement-durable.gouv.fr/IMG/pdf/240411_centre_donnees_dugny_digital_hub_93_debattu_corrige_cle565e1b.pdf), [France 3](https://france3-regions.franceinfo.fr/paris-ile-de-france/seine-saint-denis/pourquoi-le-plus-grand-data-center-de-france-bientot-installe-a-dugny-inquiete-les-riverains-3157335.html) |
| Le Bourget (Segro), contested | 3.7 ha former logistics site, 75 MW, 526 GWh/yr (twice the town's use), 33 generators, 12 MW heat recovery. Petition of more than 18,000 signatures; permit granted 13 Mar 2026 and withdrawn 12 Jun 2026 by the new mayor; the withdrawal was upheld by the Montreuil administrative court on 28 Jul 2026 | [MRAe APJIF-2025-056](https://www.mrae.developpement-durable.gouv.fr/IMG/pdf/2025_06_30_bourget_centre_de_donnees_segro_avis_signe.pdf), [France 3](https://france3-regions.franceinfo.fr/paris-ile-de-france/seine-saint-denis/des-habitants-s-elevent-contre-le-projet-d-un-nouveau-data-center-en-seine-saint-denis-3257029.html), [Banque des Territoires](https://www.banquedesterritoires.fr/datacenters-les-projets-dimplantation-dans-la-drome-et-au-bourget-contestes) |
| Brétigny-sur-Orge (Essonne) | refused by the regional prefect because no waste heat would be recovered | [AN Q 14126](https://questions.assemblee-nationale.fr/dyn/17/questions/QANR5L17QE14126.pdf) |

### How the French public is consulted on such a project

1. **CNDP:** an industrial facility whose buildings and infrastructure cost more than €300 M must be referred to the CNDP, which chooses between a public debate and a prior consultation with a guarantor. Between €150 M and €300 M, the project must be published and referral is optional (Code de l'environnement R.121-2, as described in parliamentary answers). *Partly verified:* 2025–2026 simplification laws targeted the CNDP's scope, so check Légifrance before quoting.
2. **Environmental authority opinion** (Ae / MRAe), published and answered by the developer.
3. **Environmental authorisation** (classified installation) with a **public consultation run by a commissaire enquêteur**. Since the 2023 *industrie verte* law (decree 2024-742), this consultation runs in parallel with the review (L.181-10-1).
4. **Building permit.** Since law 2026-403 of 26 May 2026 (art. 35), a data centre can be declared a *projet d'intérêt national majeur*. The prefect then issues the permit, and a permit can be refused where water is scarce ([Gossement Avocats commentary](https://www.gossement-avocats.com/blog/centres-de-donnees-data-centers-ce-que-change-la-loi-de-simplification-de-la-vie-economique/)).
5. **Regional rule SDRIF-E OR 126** (approved 10 Jun 2025): use existing business sites first, take local grid capacity into account, and recover waste heat.

### The hypothetical site and proposal (invented for the simulation)

- **Site:** lon **2.4125**, lat **48.9265** (tile x ≈ 177.8, y ≈ 26.1), in the **Zone Industrielle Rateau, La Courneuve**. This is OSM `landuse=industrial`, [way 47028132](https://www.openstreetmap.org/way/47028132), about 28 ha. The script confirms the point is inside it.
- **Surroundings** (straight-line, from OSM): A86 motorway ≈180 m; Grand Paris Express worksite ≈390 m; nearest school ≈470 m; nearest crèche ≈660 m; nearest mapped data centre ≈770 m; RTE 225 kV substations at ≈1.2, 1.7 and 2.1 km.
- **Why here:** it is existing industrial land (the SDRIF-E rule), next to the region's densest data-centre cluster with fibre and 225 kV substations nearby, and close to dense housing, so the consultation questions are realistic. It sits about 4 km east of the Stade de France on our map.
- **Caveats:** this is an indicative point with no parcel study. The zone today hosts warehouses, depots and active industry. **This is not a real project.** It is only *inspired by* Dugny, Paris Digital Park and Le Bourget.
- **Parameters** (each has a stated basis in the JSON): 200 MW grid connection, 8 ha, 3 buildings up to 28 m, about 4 years of works in 3 phases, about 100 backup generators, closed-loop cooling using about 5,000 m³ of water a year, about 1,050 GWh a year, up to 15 MW of heat delivered (about 50 GWh/yr, roughly 5,000 homes), about 600 construction jobs at peak (**assumption**), 120 permanent jobs on site, €6–9 M a year in local taxes (**rough estimate**), and two underground 225 kV lines dug under the streets.

**Proposal (FR):**
> PROJET HYPOTHÉTIQUE — avis de concertation préalable (exercice de simulation). Un opérateur propose de construire un campus de calcul pour l'intelligence artificielle dans la zone industrielle Rateau, à La Courneuve. Le site d'environ 8 hectares, aujourd'hui occupé par des entrepôts et ateliers, accueillerait trois bâtiments de 28 m de haut au maximum, pour une puissance électrique de 200 mégawatts. Le chantier durerait environ quatre ans, en trois phases, avec un poste électrique sur le site et deux lignes souterraines de 225 000 volts creusées sous la voirie jusqu'aux postes voisins. Le refroidissement fonctionnerait en circuit fermé (environ 5 000 m³ d'eau par an). Une centaine de groupes électrogènes de secours seraient testés chaque mois. L'opérateur s'engagerait à livrer jusqu'à 15 MW de chaleur au réseau de chauffage urbain, soit l'équivalent d'environ 5 000 logements. Il annonce environ 600 emplois au pic du chantier et 120 emplois permanents sur le site. Les recettes fiscales locales sont estimées entre 6 et 9 millions d'euros par an. Votre avis est sollicité.

**Proposal (EN):**
> HYPOTHETICAL PROJECT — notice of prior public consultation (simulation exercise). An operator proposes to build an artificial-intelligence computing campus in the Rateau industrial zone in La Courneuve. The site of about 8 hectares, now used by warehouses and workshops, would host three buildings up to 28 m high, drawing 200 megawatts of electricity. Construction would take about four years in three phases, with an on-site substation and two underground 225,000-volt lines dug under the streets to nearby substations. Cooling would run in a closed loop (about 5,000 m³ of water a year). Around a hundred backup generators would be tested every month. The operator would commit to supply up to 15 MW of heat to the district-heating network, roughly the needs of 5,000 homes. It announces about 600 jobs at the peak of construction and 120 permanent jobs on site. Local tax revenue is estimated at 6 to 9 million euros a year. Your opinion is invited.

## 5. Data leakage: model training cutoffs

| Model (Hugging Face card) | Pre-training cutoff | Post-training cutoff | Released |
|---|---|---|---|
| [Nemotron 3 Nano 30B-A3B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16) | 25 Jun 2025 | 28 Nov 2025 | 15 Dec 2025 |
| [Nemotron 3 Super 120B-A12B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16) | Jun 2025 | Feb 2026 | 11 Mar 2026 |
| [Nemotron 3 Ultra 550B-A55B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16) | Sep 2025 | May 2026 | 4 Jun 2026 |

**Verdict:** all three votes (Apr 2023, Feb 2024 and Mar 2025) took place **before every pre-training cutoff**, so all
are **in-sample**: a model may simply remember "89 % against scooters". The leakage probe
(`pipeline/leakage_probe.py`) must be run once the API key exists, and its answer shown next to each backtest.
`leakage_notes.json` adds probe prompts for the 2025 vote.

**Out-of-sample candidates after June 2025:**

- **Paris municipal elections, 15/22 March 2026** ([results by arrondissement](https://www.paris.fr/pages/elections-municipales-2026-tous-les-resultats-en-cartes-34272)). These are after both cutoffs for Nano and Super, and after Ultra's pre-training cutoff. It is a candidate election, not a yes/no question, so it can only test political geography. The press reports E. Grégoire elected mayor with 50.52 %; we did not check this against official files.
- **The Le Bourget data-centre controversy** (Oct 2025 – Jul 2026). This is a qualitative check: do the simulated objections to our hypothetical campus match what real residents argued after the cutoff (fire risk, generators, noise, heat, grid, PFAS, jobs)?
- **No Paris votation since 23 March 2025** was found (search on 26 Oct 2026). Paris polls after June 2025 (e.g. Elabe, Jan 2026) rank priorities but have no comparable yes/no question.

## What is verified and what is not

- **Verified from primary sources:**
  - all vote totals, sector results, polling stations, sites and hours;
  - eligibility rules: 2023 rules art. 7, read from the scanned PDF; 2024 paris.fr text; 2025 commission report;
  - SUV rates and exemptions;
  - poll figures (Ifop PDF; Commission des sondages notice; Clean Cities pages);
  - the Dugny and Le Bourget environmental opinions;
  - the regional strategy;
  - the Enedis figure;
  - the model cards.
- **Secondary sources only** (marked in the JSON):
  - cost of the votes (AFP);
  - Equinix PA10 MW/MWh figures (ENGIE press-release PDFs were blocked from our machine);
  - the 2026 municipal result;
  - the law-firm reading of law 2026-403;
  - CNDP thresholds.
- **Assumptions** (hypothetical scenario only): construction jobs, heat commitment, homes heated, tax estimate, and the exact site point.
