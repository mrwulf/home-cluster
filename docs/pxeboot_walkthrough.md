# OPNsense PXE Boot Configuration Setup

This walkthrough summarizes the actions taken to set up PXE booting for your Talos cluster on your native network.

We have prepared all the necessary files in your local workspace: `/home/bwulf/myhome/GitRoot/home-cluster/pxe-files/`
This includes:

- `vmlinuz-v1.12.4` and `initramfs-v1.12.4.xz` for Talos Linux `v1.12.4`
- Standard `ipxe.efi` binary
- `boot.ipxe` network boot script
- `boot.conf` ISC DHCP snippet

## Step-by-Step Execution Guide

### 1. Copy the prepared files to OPNsense

Since we don't have the IP of your OPNsense firewall, you will need to replace `<OPNsense-IP>` below with your gateway's actual IP (e.g., 10.0.0.1) and run these commands from your local Linux machine terminal:

```bash
# SSH into OPNsense and prepare the directories
ssh root@<OPNsense-IP> "mkdir -p /usr/local/tftp/talos /usr/local/etc/dhcpd.opnsense.d"

# Copy the TFTP files
scp /home/bwulf/myhome/GitRoot/home-cluster/pxe-files/ipxe.efi root@<OPNsense-IP>:/usr/local/tftp/
scp /home/bwulf/myhome/GitRoot/home-cluster/pxe-files/boot.ipxe root@<OPNsense-IP>:/usr/local/tftp/
scp /home/bwulf/myhome/GitRoot/home-cluster/pxe-files/vmlinuz-v1.12.4 root@<OPNsense-IP>:/usr/local/tftp/talos/
scp /home/bwulf/myhome/GitRoot/home-cluster/pxe-files/initramfs-v1.12.4.xz root@<OPNsense-IP>:/usr/local/tftp/talos/

# Copy the DHCP custom configuration
scp /home/bwulf/myhome/GitRoot/home-cluster/pxe-files/boot.conf root@<OPNsense-IP>:/usr/local/etc/dhcpd.opnsense.d/
```

### 2. Configure OPNsense GUI

#### A. TFTP Server & Firewall

1. Access OPNsense via your web browser.
2. Ensure you have the plugin `os-tftp` installed from **System** -> **Firmware** -> **Plugins**.
3. Go to **Services** -> **TFTP**, check **Enable**, and set **TFTP Directory** to `/usr/local/tftp`. Click **Apply**.
4. Go to **Firewall** -> **Rules** -> **LAN** (or relevant interface) and ensure UDP port 69 is permitted to the firewall.

#### B. ISC DHCP Network Boot

1. Navigate to **Services** -> **ISC DHCPv4** -> **[Your Interface/LAN]**.
2. Under the **Network Booting** section, click **Display Advanced**.
3. Check **Enable Network Booting**.
4. Important: Ensure the **Next Server** is filled in with your OPNsense's IP Address on that interface.
5. Leave **Default BIOS file name** and **Default UEFI file name** fields **BLANK**. _(We are using our custom `boot.conf` instead so `iPXE` doesn't get into an infinite loop)_.
6. Click **Save** at the bottom, which will restart the DHCP server.

### 3. Verify on MS-01

1. Power on your MS-01 host and tap `F7` or `Delete` to enter the boot menu.
2. Select your native network adapter for UEFI PXE boot.
3. You should see iPXE load immediately and then present you with the menu:
   - _Boot from Local Disk (Default) [30 sec countdown]_
   - _Boot Talos Linux (Metal)_

Select Talos to verify the image boots!
