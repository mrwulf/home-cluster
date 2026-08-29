# Standby & Spare Node Configurations

This directory contains hardware and network configuration definitions for cold standby / backup nodes.

These nodes are **not** active members of the cluster and are excluded from active cluster operations (`NODE_LIST`, `apply-all-configs`, `upgrade-all`, and `talosconfig` endpoints).

## Activating a Spare Node

In the event of hardware failure on an active node:

1. Move the standby configuration to the active nodes directory:

   ```bash
   mv talos/patches/standby/replacement.home.yaml talos/patches/nodes/
   ```

2. Regenerate machine configurations:

   ```bash
   task talos:generate-configs
   ```

3. Apply configuration and bootstrap the node into the cluster:

   ```bash
   task talos:apply-config NODE=replacement.home MODE=reboot
   ```
