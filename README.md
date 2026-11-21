[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Akbar-Lab-Droid/sokoban-solver/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Akbar-Lab-Droid/sokoban-solver/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

# Sokoban Solver

Entry for the make.fun bounty [Build the best Sokoban solver, 21 November 2026](https://make.fun/c/sokoban-solver-01-run-20261121).

`main.ts` (Node 22, no dependencies) answers a whole set of 5 Sokoban levels in one run. It reads `level.txt` under `/input/<id>/` and writes `solution.txt` under `/output/<id>/`.

## How it works

Every level is a hallway with one to four small rooms off it, and a box never leaves its room. The solver uses that structure:

1. **Decompose** — the player's row is the hallway; every connected component of floor off the hallway is one room, with a single door onto the hallway.
2. **Solve each room on its own** with a push-optimal A* search:
   - A state is the player's square and the boxes' squares; a step costs one push.
   - The heuristic is the cheapest matching of boxes to goals over precomputed box-travel distances.
   - Dead squares (a box that can never reach a goal, found by reverse box travel from the goals) and frozen 2x2 blocks are pruned.
   - A greedy best-first fallback trades optimality for a solution rather than none.
3. **Join the rooms** with hallway walks between the doors, and verify the whole move string by replaying it before writing it out.

The search is bounded by expansion caps, never by the clock, so two runs write the same bytes. The whole practice set solves in about one second.

## Results

| Set | Score (of 1,000,000) | Pushes vs optimal |
| --- | --- | --- |
| Practice set | 1,000,000 | 13/13, 16/16, 29/29, 47/47, 60/60 |
| 6 generated sets | 1,000,000 each | optimal on all 30 levels |

The house baseline (`plain-astar` 1.0.0) scores 200,000 on the practice set and 152,778–200,000 on the generated sets.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Score the output with the kit's scorer:

```sh
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=scores node <kit>/program/scorer/score.ts
```

## License

MIT — see [LICENSE](LICENSE).
