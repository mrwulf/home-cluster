# Ceph Dashboard access

`https://rook.home.${SECRET_DOMAIN}` sits behind two auth layers:

1. **Pocket ID** (Traefik forward-auth, `middlewares.yaml`) - gates network
   access to the route.
2. **Ceph dashboard's own OAuth2 SSO** (`ceph dashboard sso enable oauth2
groups`, run once via the toolbox pod) - auto-logs the authenticated user
   in, mapping their Pocket ID `groups` claim onto Ceph's dashboard roles.
   Membership is managed via the `administrator` `PocketIDUserGroup` in
   `cluster/apps/auth/pocket-id/app/groups.yaml`.

This is not a config Rook exposes declaratively - it's stored in Ceph's own
mgr key-value store, so it doesn't survive a full `CephCluster` rebuild and
must be re-run by hand:

```sh
kubectl exec -n rook-ceph deploy/rook-ceph-tools -- \
  ceph dashboard sso enable oauth2 groups
```

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
