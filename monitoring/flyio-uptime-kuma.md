# Fly.io Uptime Kuma

> https://noted.lol/easy-off-site-monitoring-with-fly-io-and-uptime-kuma/

# Recreate from fly.toml

In this folder (with fly.toml)

1. Create app (must be unique): `flyctl apps create`
    * Enter app name `mrwulf-kuma`
1. Create volume for uptime kuma: `fly volumes create kuma_data --region lax --size 1`
1. Deploy: `fly deploy`
1. Add cloudflare tunnel id in settings
1. Upload backup of monitors
