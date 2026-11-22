---
name: kill
description: "End the Swarm run this conversation drives: retire every member, close the run, and go back to being an ordinary assistant. Commits and reverts nothing. /swarm-kill does the same at once, even mid-turn. Usage: /swarm:kill [reason]."
argument-hint: "[reason]"
disable-model-invocation: true
---

The Swarm hooks did not answer this command, so do it by hand, briefly:

1. Run `python3 <board.py> <run> kill` for the run this conversation drives (`<board.py>` and `<run>` are the ones its board commands used), with the user's reason, if they gave one, as one quoted argument after `kill`.
2. Stop each member agent it lists that is still running.
3. Tell the user the run is closed, that nothing was committed or reverted, and to run /compact. Run no other board command and start no member from now on.
