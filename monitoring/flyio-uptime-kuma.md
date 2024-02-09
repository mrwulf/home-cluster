# Fly.io Uptime Kuma

https://web.archive.org/web/20230528055235/https://noted.lol/easy-off-site-monitoring-with-fly-io-and-uptime-kuma/

> https://noted.lol/easy-off-site-monitoring-with-fly-io-and-uptime-kuma/

# Recreate from fly.toml
1. `fly app destroy mrwulf-kuma`
1. `task task monitoring:update-uptime-kuma`
1. Add cloudflare tunnel id in settings
1. Upload backup of monitors
1. Reconfigure status page

# Update
```
task monitoring:update-uptime-kuma
```
