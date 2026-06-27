# Kubernetes Tor Integration (Ingress & Egress) Notes

This document captures notes and options for serving services over Tor (inbound onion services) and piping obfuscated traffic out through the Tor network (outbound proxying) within Kubernetes.

## Status & Motivation

- **Motivation:** Explore running services over Tor for privacy/obfuscation and routing specific outbound traffic through the Tor network.
- **Current State:** The legacy [bugfest/tor-controller](https://github.com/bugfest/tor-controller) project hasn't been updated in a while.
  Newer alternatives exist, but they are relatively new or less extensively vetted in production home-cluster GitOps setups.

---

## 1. Inbound (Serving Services over Tor / Hidden Services)

Existing active options to replace `tor-controller` for publishing hidden services:

### **[tor-gateway](https://github.com/chimbosonic/tor-gateway)**

- **Type:** Kubernetes Gateway API implementation.
- **Resources:** Manages v3 Hidden Services via standard Kubernetes `Gateway` and `HTTPRoute` CRDs.
- **Features:** Native Secret management for persistent v3 keys, vanity address generation, client authorization.
- **Evaluation:** Very promising modern approach matching Kubernetes Gateway API standards, but relatively new and requires testing before adoption.

### **[tor-operator](https://github.com/agabani/tor-operator)**

- **Type:** Custom Operator written in Rust.
- **Features:** High availability focus, managing `OnionBalancedService` (Onion Balances), Onion Keys, and fault-tolerant Tor ingress.
- **Evaluation:** Useful if high availability load balancing across multiple Tor onion instances is needed, but less aligned with pure Gateway API abstractions.

---

## 2. Outbound (Routing Egress Traffic through Tor)

For routing outbound application traffic through Tor, custom controllers are generally not required. Instead, standard Kubernetes egress networking patterns apply:

### **Option A: Centralized Tor Proxy Deployment (Recommended)**

- Deploy a Tor daemon (optionally with Privoxy/Gost for HTTP proxy translation) as a standard Kubernetes `Deployment` and expose it via an in-cluster `Service`.
- Configure outbound application pods using standard environment variables:

  ```yaml
  env:
    - name: HTTP_PROXY
      value: "http://tor-proxy.networking.svc.cluster.local:8118"
    - name: ALL_PROXY
      value: "socks5://tor-proxy.networking.svc.cluster.local:9050"
  ```

### **Option B: Pod Sidecar with `iptables` Redirection**

- Run a Tor proxy container in the same pod as the application (`localhost:9050`).
- Use an `initContainer` with `NET_ADMIN` capabilities to configure `iptables` rules, intercepting outbound TCP traffic transparently.

### **Option C: Service Mesh / CNI Egress Gateway**

- Leverage Cilium or Traefik/Istio Egress Gateways to redirect traffic bound for external targets through a dedicated Tor egress proxy pod.
