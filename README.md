# Swarm

Swarm is a Claude Code plugin for running a team of agents on one task. Workers coordinate on a shared board, and a verifier reviews and tests the combined changes.

## Install

```sh
claude plugin marketplace add marspater/claude-swarm
claude plugin install swarm@swarm-local
```

Start a run with `/swarm:swarm` followed by the task and how to verify it.

See the [Swarm user guide](plugins/swarm/README.md) for examples, board controls, and verification details.

[License](LICENSE)
