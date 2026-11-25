# LifeOS agent

[LifeOS](https://github.com/danielmiessler/LifeOS) on Claude Code in a pod
([manifests](../../cluster/apps/ai/lifeos-agent/app/)), answering mentions in
Rowboat Spaces on a Claude subscription.

## How it works

- **Connector:** Rowboat's agent worker
  ([rowboat#1317](https://github.com/rowboatlabs/rowboat/pull/1317), unmerged)
  holds the agent key, listens for mentions and runs the turns. The
  [Claude runtime](https://github.com/mrwulf/rowboat/blob/claude-worker/apps/harbor/packages/worker/src/claude/runtime.ts)
  lives on the fork's `claude-worker` branch. It runs `claude --print`, one turn
  at a time, and resumes one session per thread. An idle agent makes no model
  calls.
- **Memory:** `$LIFEOS_CONFIG_DIR/USER` is a clone of a Forgejo repository, synced
  by a sidecar every two minutes. Open it in Obsidian with the Git plugin. On a
  conflicting edit the agent's side is pushed to `agent-conflict`; merge that
  branch in Forgejo and syncing resumes.
- **Persona:** the agent's instructions in the Rowboat UI arrive with each mention.
- **Image:** [`lifeos-agent-image.yaml`](../workflows/lifeos-agent-image.yaml)
  builds it and pushes a new `0.1.<run>` tag. The build runs the worker's tests,
  then [a smoke test](image/smoke-test.sh) in the built image. Pull requests do
  both without pushing, so tag numbers have gaps.

## Following upstream

The workflow pins the fork commit it builds and the upstream commit that commit
must contain. When Renovate moves the upstream pin, the build fails until
`claude-worker` is rebased onto it:

1. In a clone of the fork, fetch upstream and rebase `claude-worker` onto the new
   commit.
2. Run the worker's tests, then push the branch with `--force-with-lease`.
3. Set `ROWBOAT_WORKER_COMMIT` to the new head in the same pull request as the
   upstream pin.

## Setup

1. In Rowboat, add a custom agent ("one you already run") and add it to a space.
   Let everyone in the space invoke it if other agents should reach it.
2. Create an empty `agent-vault` repository in Forgejo, and a bot user whose
   token can write to it and open issues and pull requests.
3. Run `claude setup-token`. Turn off extra usage on the Claude account so a spent
   limit cannot turn into charges.
4. Create the Bitwarden item `LifeOS Agent Credentials` with the custom fields
   `rowboat-agent-key`, `claude-oauth-token`, `forgejo-user`, `forgejo-token`
   and `vault-repo` (`owner/name`).
5. Mention the agent and ask it to run the LifeOS interview.

## Limits

- LifeOS treats print mode as a remote channel and leaves its dynamic context
  (relationship notes, active work) out. Identity and goals files still load, so
  anyone who can invoke the agent can ask about them.
- The agent runs with permission prompts off. Whoever can mention it can run
  commands in the pod, which holds its three tokens and can reach public HTTPS.
- LifeOS's background services (Pulse and its jobs) are not installed.
- LifeOS installs its JavaScript dependencies at first start and on upgrade;
  Renovate does not track those.
- Claude Code takes no input mid-turn here, so a follow-up waits its turn.
- LifeOS hooks make their own model calls, so a mention costs more of the
  subscription's limit than the reply alone.
