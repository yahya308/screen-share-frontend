#!/bin/sh
# Add only VELOSTREAM's approved TCP/TLS listener ports; never flush rules.
set -eu
if ! /usr/sbin/iptables -C INPUT -p tcp --dport 49998:49999 -m comment --comment velostream-turn -j ACCEPT 2>/dev/null; then
    /usr/sbin/iptables -I INPUT 1 -p tcp --dport 49998:49999 -m comment --comment velostream-turn -j ACCEPT
fi
