# Outline Config
# OPNSense Config
# Grafana Config

# [Minio Config](https://version-2023-1.goauthentik.io/integrations/services/minio/)
## In Authentik, Create customization -> policy mapping:
```

```
## Add authentik app, provider

## Set up minio

```
mc alias set minio https://<minio ingress> <AccessKey> <SecretKey>

mc admin config set minio identity_openid \
  config_url="https://<authentik ingress>/application/o/<applicaiton-slug>/.well-known/openid-configuration" \
  client_id="<client id authentik provider>" \
  client_secret="<secret authentik provider>" \
  scopes="openid,profile,email,minio"

mc admin service restart minio
```
