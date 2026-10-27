# How Town-in-a-Box works (plain English)

A one-page explanation you can use when recording the video.

## The idea in one sentence

Before a city asks the public about a project, it can try the project on a **simulated town** first and see who is affected, what they would say, who would actually turn up to the consultation, and who would be missed.

## Why it matters

Only a few people take part in consultations. In Paris, 5–7% of voters took part in the 2023 scooter vote and the 2024 SUV vote. Studies of public meetings show that the people who speak are older, more often homeowners and more likely to vote than everyone else. So a consultation can hear a very different town from the real one.

## What happens, step by step

1. **A real map.** We drew Paris and its neighbouring suburbs from official boundaries and OpenStreetMap: the Seine, the woods, the ring road, the railways, and each arrondissement and town. It is cut into squares of 100 m. Each square has a type: Paris building, suburban house, tower block, park, water and so on. The pixel art is drawn by our own code.
2. **2,000 residents.** NVIDIA published a dataset of synthetic French people, called Nemotron-Personas-France. Each one has an age, a job, a level of education, a household and a short life description. We picked 2,000 of them living in Paris and the inner suburbs.
3. **Making them look like the real population.** The dataset has far too few managers and professionals for Paris (about 10% instead of about 33%). Half of its Parisians have no arrondissement. We corrected both with official INSEE statistics, so each arrondissement has the right mix of jobs, ages and education.
4. **Filling the gaps, honestly.** The dataset does not say whether someone has a car, rents or owns, or what nationality they are. We filled these in from INSEE statistics, district by district, and label them **"imputed"** everywhere in the app. Each resident then gets a home on a building square and a workplace.
5. **What changes for each person: computed, not AI.** For each proposal, plain rules work out how it touches each resident. Examples: "lives 800 m from the site, so construction trucks pass their home", or "owns a heavy car and drives to work outside their parking zone, so they pay the higher rate". The AI does not decide this. This is what you see when you click a resident: their home, their commute and markers where the proposal touches them.
6. **Their reaction: written by the AI.** Each resident's profile, their computed facts and the official French text of the proposal are sent to an NVIDIA Nemotron model on Nebius Token Factory. The model answers in that person's voice: for or against, why, and what they would do. In the app this is always labelled a **"simulated voice"**.
7. **Who would show up.** We do not trust the AI to say who takes part. We use real turnout patterns: older people, graduates and owners vote more. People who are strongly affected are a bit more likely to come, and for a public meeting, people who live close by are too. The number of "likely participants" is set to the real turnout (for example 5.68% for the SUV vote).
8. **Neighbours talk.** 280 random pairs of neighbours have a short conversation, written by a bigger Nemotron model. We see which arguments spread and whether anyone changes their mind.
9. **The results.**
   - **The gap**: support among everyone vs among likely participants.
   - **Themes**: the main arguments, and which of them you would only hear from people who don't come.
   - **Who to consult**: groups that carry more of the impact than they would have voices in the room, with where they live and how to reach them.
10. **Checking against reality (the backtest).** For the two real Paris votes, we compare the simulated "likely voters" with the official results in each of 17 areas of Paris, and against simple methods that use no AI. The models may already have read about these votes, because their training data goes up to mid-2025. A "leakage probe" asks them directly what the result was, so we can show whether they simply remember it.

## The three things to say clearly on camera

- **Computed vs AI.** Where and how a project touches someone is calculated by code from the map. The AI only writes how they react.
- **Imputed.** Car, housing and nationality are statistical estimates, and the app labels them as such.
- **Simulated.** Every resident is synthetic. The results are hypotheses that help plan a real consultation, **not evidence of public opinion**.

## Which NVIDIA and Nebius pieces do what

- **Nemotron-Personas-France**: the people.
- **Nemotron 3 Nano** (small, fast): 2,000 reactions per scenario, the answers to "ask them a question", and the live "your proposal" runs.
- **Nemotron 3 Super** (medium): the neighbour conversations, and a second opinion for the uncertainty ranges.
- **Nemotron 3 Ultra** (large): finds the themes across all the answers.
- **Nebius Token Factory**: runs all three models through one API, thousands of calls per scenario in parallel.

## Right now

There is no API key yet, so every answer in the app comes from a simple placeholder rule. It is marked **"[demo]"**, and a ribbon says "Demo data — real Nemotron results pending". When the key is added and the pipeline is run (see `docs/RUNBOOK.md`), the real Nemotron answers replace them and the ribbon disappears by itself.
