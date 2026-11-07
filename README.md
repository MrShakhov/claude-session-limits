# session-limits

A Claude Code mod that shows, in a side pane, how much of the 5-hour and weekly
plan limits the current session uses.

The plan meter is account-wide, so the session's share is estimated: every
session with the mod records its API-priced cost (which already accounts for
cache reads and writes and for the model) and the meter readings its responses
carry, each in its own file under `~/.claude/session-limits/sessions/`. The
pane calibrates meter points per USD from the meter's growth over the cost all
tracked sessions spent, then shows each session's share of the current windows.
Growth with no tracked spend (claude.ai, sessions without the mod) shows as
untracked.

Open the pane with `/session-limits`; it also opens at session start.

The meter arrives in whole percents, so a calibration is only as good as the
meter growth it rests on; the pane shows the estimate's error (±) next to it.
Install the mod in every session you run (user scope) so parallel sessions
are counted.

## Install

At the prompt of a terminal session:

```
/plugin install session-limits --marketplace MrShakhov/claude-session-limits
```

From a shell:

```bash
claude plugin install session-limits --marketplace MrShakhov/claude-session-limits
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `MrShakhov/claude-session-limits`,
then Add plugin.

## Install from a local clone

```bash
claude plugin marketplace add ~/Dev/claude-session-limits
```

```bash
claude plugin install session-limits@claude-session-limits --scope user
```

Edits to this folder reach running sessions through `/reload-plugins`.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
