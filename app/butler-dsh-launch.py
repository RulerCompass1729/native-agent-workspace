"""Inherited environment only. No credential argument, copy, log or config read."""
import json
import os
import sys

if sys.argv[1:] == ['--presence']:
    print(json.dumps({'credentialPresent': bool(os.environ.get('DEEPSEEK_API_KEY'))}))
else:
    executable, script, home = sys.argv[1:4]
    # Inspect names only. Preserve the provider's inherited environment entries;
    # the DSH provider, not the parent app, resolves the credential by its name.
    keep = {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'DEEPSEEK_API_KEY'}
    for name in list(os.environ):
        if name not in keep:
            del os.environ[name]
    os.environ['HOME'] = home
    os.environ['DSH_HOME'] = home
    os.environ['ELECTRON_RUN_AS_NODE'] = '1'
    os.chdir(home)
    os.execv(executable, [executable, '--disable-sigusr1', script, home])
