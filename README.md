# Critter Crew

A Claude Code mod that turns your subagents into animated critters in the sidebar.

**Critter Crew** gives Claude Code a sidebar pane where every subagent hatches as its own little creature. Each critter gets a name and color, and a species based on its agent type: Explore subagents are frogs, Plan subagents are owls, and general-purpose ones are blobs. It shows its status through animation: bouncing while it works, snoozing while it waits, throwing confetti when it finishes, and wearing a halo if it fails or is stopped.

Each card shows the subagent's task, its model (with a badge for Opus, Sonnet, Haiku or Fable), the number of tools it has used, the tool it last used, and how long it has been running. Click **peek ›** to open that subagent's transcript, and clear finished critters with one button.

It works in the Claude Code desktop app, VS Code, mobile and the terminal, where the critters appear as text faces. It also follows light and dark mode.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install critter-crew --marketplace GingerVitas/critter-crew
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install critter-crew --marketplace GingerVitas/critter-crew
```

In the Claude Code desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GingerVitas/critter-crew`, then **Add plugin**.

## Use

The pane opens on its own when a session starts. Reopen it anytime with `/crew`.

Subagents started before the mod loaded still appear, but without a model badge, and their tool counts start at zero.

## License

MIT, see [LICENSE](LICENSE).
