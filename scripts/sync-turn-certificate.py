#!/usr/bin/env python3
"""Copy ONLY VELOSTREAM's certificate from the proxy store, without editing it.

Run as root on the Oracle host. Existing TURN allocations survive SIGUSR2.
The source file contains other domains: their keys are never copied or printed.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile

DOMAIN = 'yahya-oracle.duckdns.org'
SOURCE = Path('/data/coolify/proxy/acme.json')
DESTINATION = Path('/opt/screen-share/.turn/certs')


def sync():
    data = json.loads(SOURCE.read_text())
    certificate = None
    for resolver in data.values():
        for entry in resolver.get('Certificates', []):
            domain = entry.get('domain', {})
            if domain.get('main') == DOMAIN and not domain.get('sans'):
                certificate = entry
                break
    if certificate is None:
        raise RuntimeError('The dedicated VELOSTREAM certificate was not found')
    content = {
        'fullchain.pem': base64.b64decode(certificate['certificate']),
        'privkey.pem': base64.b64decode(certificate['key']),
    }
    DESTINATION.mkdir(parents=True, exist_ok=True, mode=0o750)
    if all((DESTINATION / name).exists() and (DESTINATION / name).read_bytes() == value for name, value in content.items()):
        print('VELOSTREAM certificate is current')
        return
    # Validate before replacing the currently usable pair.
    with tempfile.TemporaryDirectory(dir=DESTINATION) as temporary:
        for name, value in content.items():
            target = Path(temporary) / name
            target.write_bytes(value)
            target.chmod(0o640)
        cert = str(Path(temporary) / 'fullchain.pem')
        key = str(Path(temporary) / 'privkey.pem')
        subprocess.run(['openssl', 'x509', '-in', cert, '-checkend', '86400', '-noout'], check=True, stdout=subprocess.DEVNULL)
        cert_public = subprocess.check_output(['openssl', 'x509', '-in', cert, '-pubkey', '-noout'])
        key_public = subprocess.check_output(['openssl', 'pkey', '-in', key, '-pubout'], stderr=subprocess.DEVNULL)
        if cert_public != key_public:
            raise RuntimeError('Certificate key mismatch')
        # The dedicated container runs with the same group as these files.
        for name in content:
            os.chown(Path(temporary) / name, 0, 65534)
            os.replace(Path(temporary) / name, DESTINATION / name)
    os.chown(DESTINATION, 0, 65534)
    os.chmod(DESTINATION, 0o750)
    running = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', 'velostream-turn'], capture_output=True, text=True)
    if running.returncode == 0 and running.stdout.strip() == 'true':
        subprocess.run(['docker', 'kill', '--signal=USR2', 'velostream-turn'], check=True, stdout=subprocess.DEVNULL)
    print('VELOSTREAM certificate refreshed')


if __name__ == '__main__':
    sync()
