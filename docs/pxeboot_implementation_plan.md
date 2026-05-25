# PXE Booting Talos Linux via OPNsense

This document outlines the step-by-step implementation plan to configure your OPNsense router for PXE booting your MS-01 hosts.
The plan covers installing the TFTP plugin, configuring ISC DHCPd, creating an iPXE boot menu with a 30-second local-disk fallback, and setting up the firewall.

## User Review Required

> [!IMPORTANT]
> Please review this plan. To implement it, you will need SSH access to your OPNsense machine to upload the `ipxe.efi` and Talos Linux files, as the OPNsense web UI does not have a comprehensive file manager for the TFTP root directory.

<!-- -->

> [!NOTE]
> Since standard UEFI PXE clients can't inherently display a complex boot menu or fetch HTTP files on their own, we will use **iPXE**.
> The flow will be: `MS-01 UEFI PXE` -> `OPNsense DHCP` -> `Download ipxe.efi via TFTP` -> `Execute ipxe.efi` -> `Fetch iPXE config with menu via TFTP` -> `Boot Talos or Exit to Local Disk`.

## Proposed Steps

### 1. Install & Configure OPNsense TFTP Plugin

1. Go to **System** -> **Firmware** -> **Plugins**.
2. Search for `os-tftp` and install it.
3. Once completed, navigate to **Services** -> **TFTP**.
4. Check **Enable**, and set the **TFTP Directory** (usually `/tftpboot` or `/var/tftp`).
5. Click **Apply** and wait for the service to start.

### 2. Configure Firewall Rules

The host machines need to be able to talk to the OPNsense TFTP server.

1. Go to **Firewall** -> **Rules** -> **LAN** (or the specific interface/VLAN where the MS-01 hosts reside).
2. Add a rule:
   - **Action**: Pass
   - **Protocol**: UDP
   - **Source**: `<MS-01 Subnet>`
   - **Destination**: `This Firewall`
   - **Destination Port Range**: `TFTP (69)`
   - **Description**: Allow PXE (TFTP) from LAN to Firewall.
3. Apply changes.

### 3. File Preparation & Upload (via SSH to OPNsense)

You will need to SSH into your OPNsense box and place specific files in the TFTP directory (`/usr/local/tftp` or whatever you configured). We will need:

- standard `ipxe.efi` (compiled iPXE binary for UEFI)
- Talos `vmlinuz` and `initramfs.xz` for your specific Talos version.
- `boot.ipxe` (Our boot menu script)

Here is the proposed `boot.ipxe` script content:

```ipxe
#!ipxe

# 30 second timeout (30000 ms)
set timeout 30000

:menu
menu PXE Boot Options
item --key l local       Boot from Local Disk (Default)
item --key t talos       Boot Talos Linux (Metal)
choose --timeout ${timeout} --default local target && goto ${target} || goto local

:local
echo Booting from local hard drive...
exit

:talos
echo Booting Talos Linux...
kernel /talos/vmlinuz initrd=initramfs.xz talos.platform=metal \
    console=tty0 console=ttyS0,115200n8 pti=on
initrd /talos/initramfs.xz
boot
```

### 4. Configure ISC DHCPd

1. Go to **Services** -> **ISC DHCPv4** -> **[Your Interface]**.
2. Scroll down to the **Network Booting** section.
3. Click **Display Advanced** (if not already expanded).
4. **Enable Network Booting**: Check.
5. **Next Server**: Enter the IP address of your OPNsense box on this interface.
6. **Default BIOS file name**: `undionly.kpxe` (If you have legacy BIOS devices, optional).
7. **Default UEFI file name**: `ipxe.efi`
8. **Root path**: Leave blank.
9. _Crucial Step_: To make iPXE load the `boot.ipxe` script after it boots, we need to pass a DHCP option or rely on chainloading. In the **Additional Options** of ISC DHCPd, we can set up chainloading:
   - When the client identifier is _not_ iPXE, serve `ipxe.efi`.
   - When the client identifier _is_ iPXE, serve `boot.ipxe`.
   - _Alternatively_, we can just use a pre-compiled `ipxe.efi` that defaults to loading `boot.ipxe`.

## Open Questions

> [!WARNING]
>
> 1. Do you already have SSH root access enabled on your OPNsense installation to transfer the boot files?
> 2. Do you have a specific Talos Linux version you'd like to use?
> 3. For the DHCP chainloading, the simplest method requires placing an `autoexec.ipxe` file, or doing custom advanced DHCP configuration.
>    Are you comfortable editing `/usr/local/etc/dhcpd.conf` on OPNsense, or would you prefer a strategy using only the Web UI with advanced DHCP options?

## Verification Plan

1. Turn on one of the MS-01 hosts.
2. Enter the BIOS to prioritize Network (PXE) Boot or press the boot menu key and select the NIC.
3. The system should acquire an IP, download iPXE, and present the menu.
4. Wait 30 seconds; it should fall back to loading whatever is on the NVMe/SSD.
5. Reboot, select PXE again, and explicitly choose "Boot Talos Linux" to verify the node boots into maintenance mode.
