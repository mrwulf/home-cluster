# Ceph Dashboard access

`https://rook.home.${SECRET_DOMAIN}` sits behind two auth layers:

1. **Pocket ID** (Traefik forward-auth, `middlewares.yaml`) - gates network
   access to the route.
2. **Ceph dashboard's own OAuth2 SSO** (`ceph dashboard sso enable oauth2
groups`, applied by a Job) - auto-logs the authenticated user
   in, mapping their Pocket ID `groups` claim onto Ceph's dashboard roles.
   Membership is managed via the `administrator` `PocketIDUserGroup` in
   `cluster/apps/auth/pocket-id/app/groups.yaml`.

This is not a config Rook exposes declaratively - it's stored in Ceph's own
mgr key-value store. The `ceph-dashboard-config` Job
(`cluster/dashboard-config-job.yaml`) applies it, and is idempotent: Flux
recreates it on each reconcile (after its TTL), and it only acts when the
stored value is missing, so a full `CephCluster` rebuild or mgr restart is
healed on the next reconcile. To apply it immediately, re-run the Job:

```sh
kubectl delete job -n rook-ceph ceph-dashboard-config --ignore-not-found
flux reconcile kustomization rook-ceph-cluster --with-source
```

Verify the roles path was persisted (should show `"oauth2": {"roles_path": "groups"}`):

```sh
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph config-key get mgr/dashboard/ssodb_v1
```

If it shows `{"onelogin_settings": {}}` instead, login loops back to
`/#/login?returnUrl=%2Ferror` because `POST /api/auth/check` returns 403 (no roles
claim mapping). On a mgr that has not yet loaded the SSO DB as OAuth2, the first
`ceph dashboard sso enable oauth2 groups` only sets `roles_path` in memory, so a
mgr restart drops it; a second run persists it. The Job retries for this reason.

## Session lifetimes (keep ordered)

Pocket ID's id_token lives a fixed 1h (no setting; the per-client durations
only cover access/refresh tokens). oauth2-proxy relays that id_token to Ceph,
which checks its `exp` in the browser and never receives a fresh one, so a
proxy session outliving the id_token gives a blank `/#/login?access_token=...`
redirect loop that only clearing cookies fixed. Keep this order:

- Ceph dashboard session 45m: `ceph dashboard set-jwt-token-ttl 2700` (the Job)
- oauth2-proxy session 50m: `OAUTH2_PROXY_COOKIE_EXPIRE` (`cluster/apps/auth/oauth2-proxy/app/helm-release.yaml`)
- Pocket ID client `accessTokenDurationMinutes: 50` (`cluster/apps/auth/oauth2-proxy/app/oidc-client.yaml`)
- Pocket ID id_token 60m (fixed)

Ceph expires first and logs out through `/oauth2/sign_out`, then the proxy
re-authenticates silently. Expect a re-login about hourly.

## Local admin login (last resort)

Enabling SSO makes Ceph's frontend hard-redirect to the OAuth2 flow - there is no
button or link back to the local username/password form in the browser. The
`rook-ceph-dashboard-password` Secret (Rook-managed, untouched by any of this)
still authenticates against the dashboard's own `/api/auth` endpoint regardless
of the SSO flag, so if Pocket ID or oauth2-proxy is down:

```sh
# read the admin password
kubectl get secret rook-ceph-dashboard-password -n rook-ceph \
  -o jsonpath='{.data.password}' | base64 -d; echo

# temporarily disable SSO to get the local login form back in a browser
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- ceph dashboard sso disable

# ...log in as `admin` with the password above, then re-enable SSO when done
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph dashboard sso enable oauth2 groups
```

Or skip the browser entirely and hit the API directly with the same password:

```sh
curl -s -X POST https://rook.home.${SECRET_DOMAIN}/api/auth \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<password from above>"}'
```
