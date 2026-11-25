# shellcheck shell=bash
# Sourced by the entrypoints: hands git the Forgejo token for that server only.
: "${FORGEJO_URL:?}" "${FORGEJO_USER:?}" "${FORGEJO_TOKEN:?}" "${VAULT_REPO:?}"
# The helper expands the variables when git calls it, so the token is never stored.
git config --global "credential.$FORGEJO_URL.helper" \
  '!f() { test "$1" = get && printf "username=%s\npassword=%s\n" "$FORGEJO_USER" "$FORGEJO_TOKEN"; }; f'
export VAULT_REPO_URL="$FORGEJO_URL/$VAULT_REPO.git"
